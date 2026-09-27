import express from 'express';
import busboy from 'busboy';
import * as access from '../lib/access.js';
import * as upload from '../lib/upload.js';
import * as registry from '../lib/repos.js';
import * as repoLib from '../lib/repo.js';
import * as auth from '../lib/auth.js';
import { ValidationError, NotFoundError, safeRepoPath } from '../lib/validate.js';

const router = express.Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Only a signed-in user may attempt a write at all. */
router.use(auth.requireAuth);

/**
 * Resolve the repository and confirm the caller may write to it.
 *
 * Every mutation goes through this, so there is exactly one place where write
 * access is decided.
 */
async function writableRepo(req) {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const denial = await access.explainWriteDenial(req.user, record);
  if (denial) {
    const error = new ValidationError(denial);
    error.status = 403;
    throw error;
  }
  return record;
}

/** The branch an edit is based on, defaulting to the main branch. */
function branchOf(req) {
  const requested = String(req.body.branch || req.query.branch || '').trim();
  return requested || null;
}

/** The file currently shown, for prefilling the editor. */
async function currentFile(record, ref, filePath) {
  try {
    return await repoLib.blob(record, ref, filePath);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the editor */

router.get('/edit/:ref/*', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const filePath = safeRepoPath(req.params[0]);
  const meta = await repoLib.repoMeta(record);
  const ref = req.params.ref || meta.defaultBranch;
  const permissions = await access.writeAccess(req.user, record);

  const file = await currentFile(record, ref, filePath);
  if (file && file.isDir) throw new ValidationError('that is a directory, not a file');

  // The editor is its own page, so it needs the same locals the repository
  // pages get, including the ones the breadcrumb and header partials expect.
  res.locals.record = record;
  res.locals.repo = { id: registry.identifierOf(record), name: record.name, owner: record.owner, path: record.path };
  res.locals.meta = meta;
  res.locals.ref = ref;
  res.locals.refEncoded = encodeURIComponent(ref);
  res.locals.writeAccess = permissions;

  res.render('edit', {
    title: file ? `Editing ${file.name}` : 'New file',
    file: file || { path: filePath, name: filePath.split('/').pop(), content: '', size: 0, language: 'plaintext' },
    filePath,
    ref,
    mode: file ? 'edit' : 'create',
    canWrite: permissions.canWrite,
    reason: permissions.canWrite ? null : await access.explainWriteDenial(req.user, record),
    binary: Boolean(file && file.binary),
    maxBytes: upload.MAX_UPLOAD_BYTES,
  });
}));

/* --------------------------------------------------- create / edit / delete */

router.post('/edit/:ref/*', wrap(async (req, res) => {
  const record = await writableRepo(req);

  const filePath = safeRepoPath(req.params[0]);
  if (!filePath) throw new ValidationError('a file path is required');

  const message = upload.assertMessage(req.body.message);
  const result = await upload.writeFile(record, {
    path: filePath,
    content: req.body.content ?? '',
    message,
    branch: branchOf(req),
    user: req.user,
  });

  repoLib.invalidateAll();
  return res.redirect(302, `/${registry.identifierOf(record)}/commit/${result.commit}`);
}));

router.post('/delete/:ref/*', wrap(async (req, res) => {
  const record = await writableRepo(req);

  const filePath = safeRepoPath(req.params[0]);
  const message = upload.assertMessage(req.body.message);
  const result = await upload.deleteFile(record, {
    path: filePath,
    message,
    branch: branchOf(req),
    user: req.user,
  });

  repoLib.invalidateAll();
  return res.redirect(302, `/${registry.identifierOf(record)}/commit/${result.commit}`);
}));

/* ------------------------------------------------------------ file upload */

/** Overhead allowed for the form fields that travel alongside the files. */
const FIELD_ALLOWANCE = 128 * 1024;

/**
 * Read a multipart upload.
 *
 * busboy streams each part to disk-free buffers while enforcing `limits`, so a
 * file over the cap is refused mid-flight rather than after the whole body has
 * been buffered. This parser replaced a hand-written one, which corrupted
 * files whose contents happened to contain boundary-like bytes.
 */
function readUpload(req, { maxFiles = 20, maxBytes = upload.MAX_UPLOAD_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let bus;
    try {
      bus = busboy({
        headers: req.headers,
        limits: {
          files: maxFiles,
          fields: 20,
          fieldSize: 64 * 1024,
          fileSize: maxBytes,
        },
      });
    } catch (error) {
      reject(new ValidationError(`could not read the upload: ${error.message}`));
      return;
    }

    const fields = {};
    const files = [];
    let aborted = null;

    bus.on('field', (name, value) => { fields[name] = value; });

    bus.on('file', (name, stream, info) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          // Stop accumulating; the limit event below turns this into an error.
          tooBig = true;
          stream.resume();
          return;
        }
        chunks.push(chunk);
      });

      stream.on('limit', () => { tooBig = true; });

      stream.on('end', () => {
        if (tooBig) {
          aborted = new ValidationError(
            `"${info.filename}" is over the ${Math.round(maxBytes / 1024 / 1024)} MB limit`,
          );
          return;
        }
        files.push({
          field: name,
          originalname: info.filename,
          type: info.mimeType,
          buffer: Buffer.concat(chunks),
          size,
        });
      });
    });

    bus.on('filesLimit', () => {
      aborted = new ValidationError(`at most ${maxFiles} files can be uploaded at once`);
    });

    bus.on('error', (error) => reject(new ValidationError(`malformed upload: ${error.message}`)));

    bus.on('close', () => {
      if (aborted) reject(aborted);
      else if (!files.length) reject(new ValidationError('no file was selected'));
      else resolve({ fields, files });
    });

    req.pipe(bus);
  });
}

router.post('/upload', wrap(async (req, res) => {
  const record = await writableRepo(req);
  const { fields, files } = await readUpload(req);

  const message = upload.assertMessage(fields.message);
  const targetDir = fields.path ? safeRepoPath(fields.path) : '';
  const branch = fields.branch ? String(fields.branch) : branchOf(req);

  // One commit for the whole batch: someone dropping in five files expects one
  // commit in the history, not five.
  const edits = files.map((file) => {
    const edit = upload.editFromUpload(file);
    return {
      path: targetDir ? `${targetDir}/${edit.path}` : edit.path,
      content: edit.content,
    };
  });

  const result = await upload.writeFiles(record, {
    edits,
    message: files.length > 1
      ? `${message}\n\nAdded: ${edits.map((edit) => edit.path).join(', ')}`
      : message,
    branch,
    user: req.user,
  });

  repoLib.invalidateAll();

  if (fields.json === '1') return res.json({ ok: true, files: result.paths, commit: result.commit });

  return res.redirect(302, `/${registry.identifierOf(record)}/tree/${encodeURIComponent(branch || '')}`);
}));

/* ------------------------------------------------------------------ API */

router.post('/api/upload', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const denial = await access.explainWriteDenial(req.user, record);
  if (denial) return res.status(403).json({ error: denial, status: 403 });

  const filePath = safeRepoPath(req.body.path);
  if (!filePath) return res.status(400).json({ error: 'a path is required', status: 400 });

  const result = await upload.writeFile(record, {
    path: filePath,
    content: Buffer.from(String(req.body.content ?? ''), 'utf8'),
    message: upload.assertMessage(req.body.message),
    branch: String(req.body.branch || '') || null,
    user: req.user,
  });

  repoLib.invalidateAll();
  return res.json({ ok: true, ...result, path: result.path });
}));

router.post('/api/delete', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const denial = await access.explainWriteDenial(req.user, record);
  if (denial) return res.status(403).json({ error: denial, status: 403 });

  const result = await upload.deleteFile(record, {
    path: safeRepoPath(req.body.path),
    message: upload.assertMessage(req.body.message),
    branch: String(req.body.branch || '') || null,
    user: req.user,
  });

  repoLib.invalidateAll();
  return res.json({ ok: true, ...result });
}));

/** Who may write here, and why not if nobody may. */
router.get('/api/permissions', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  res.json(await access.writeAccess(req.user, record));
}));

export default router;
export { NotFoundError };
