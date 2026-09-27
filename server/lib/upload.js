import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { git, gitOut } from './git.js';
import { looksBinary } from './binary.js';
import { safeRepoPath, ValidationError, NotFoundError } from './validate.js';

/**
 * Writing to a repository from the browser.
 *
 * Every change goes through a real commit, so the history a browser edit
 * produces is indistinguishable from one produced by `git push` - same author
 * format, same message, same ref update. Nothing is written to the working
 * tree, so a bare repository is treated exactly like a worktree.
 */

/** A single upload is bounded; a repository of these is still browsable. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_LENGTH = 500;

/** Branch that receives browser edits unless a commit names another. */
const DEFAULT_BRANCH = 'main';

function refuseTooLarge(size) {
  throw new ValidationError(
    `file is ${formatSize(size)}, which is over the ${formatSize(MAX_UPLOAD_BYTES)} limit`,
  );
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Reject a commit message that git itself would reject, before we try. */
export function assertMessage(message) {
  const value = String(message || '').trim();
  if (!value) throw new ValidationError('a commit message is required');
  if (value.length > MAX_MESSAGE_LENGTH) throw new ValidationError('commit message is too long');
  // `--cleanup=whitespace` would trim these anyway; refuse them explicitly so
  // the reason is obvious.
  if (/^\s*$/.test(value.split('\n')[0])) throw new ValidationError('commit message is empty');
  return value;
}

/** Identity recorded on commits made through the browser. */
function authorEnv(user) {
  const name = user.displayName || user.username;
  const email = user.email || `${user.username}@localhost`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Resolve the ref a change should be based on.
 *
 * When the caller named a branch explicitly, that branch is used or the write
 * fails - falling back to the default would silently put a commit somewhere the
 * user did not ask for. Only an unnamed request falls back.
 */
async function targetRef(repo, requested) {
  if (requested) {
    const wanted = newRefName(requested);
    const sha = await gitOut(repo.path, ['rev-parse', '--verify', '--quiet', `${wanted}^{commit}`])
      .catch(() => '');
    // A branch that does not exist yet is created by this commit, which is how
    // a new branch is started from the browser.
    return { ref: wanted, sha: sha || null };
  }

  for (const candidate of [DEFAULT_BRANCH, 'HEAD']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const sha = await gitOut(repo.path, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      if (!sha) continue;
      // eslint-disable-next-line no-await-in-loop
      const full = await gitOut(repo.path, ['rev-parse', '--symbolic-full-name', sha]);
      return { ref: full || `refs/heads/${candidate}`, sha };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** The ref a brand new branch should be created under. */
function newRefName(requested) {
  const name = String(requested || DEFAULT_BRANCH).replace(/^refs\/heads\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..')) {
    throw new ValidationError(`"${requested}" is not a valid branch name`);
  }
  return `refs/heads/${name}`;
}

/**
 * Build a commit from a set of tree edits, without touching the working tree.
 *
 * The index is redirected to a temporary file via GIT_INDEX_FILE, so a
 * worktree repository's own index is never disturbed and a bare repository
 * works the same way.
 */
async function commitEdits(repo, { ref, sha, edits, message, user, allowEmpty = false }) {
  const env = authorEnv(user);
  const run = (args, extra = {}, stdin) => git(repo.path, args, { env: { ...env, ...extra }, stdin });

  const indexFile = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'ccbgit-index-')),
    'index',
  );

  const cleanup = () => fsp.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {});

  try {
    const withIndex = { GIT_INDEX_FILE: indexFile };

    if (sha) {
      // Start from the current tip so the new commit is that tree plus the
      // edits, without ever touching a working tree.
      await run(['read-tree', sha], withIndex);
    }

    for (const edit of edits) {
      // Validated once here so no edit can slip through the plumbing unchecked.
      const target = writablePath(edit.path);

      if (edit.delete) {
        // Mode 0000 is how --index-info spells "remove this path". The
        // --force-remove and --remove flags both insist on a working tree, which
        // a bare repository does not have - and a bare repository is exactly
        // what you push to.
        await run(['update-index', '--index-info'], withIndex,
          `0 ${'0'.repeat(40)}\t${target}\n`);
        continue;
      }

      const content = Buffer.isBuffer(edit.content) ? edit.content : Buffer.from(String(edit.content), 'utf8');
      if (content.length > MAX_UPLOAD_BYTES) refuseTooLarge(content.length);

      // `hash-object` writes the blob and prints its sha. The content goes in
      // on stdin: as an argument it would land in the process list.
      const { stdout } = await run(
        ['hash-object', '-w', '--stdin', '--path', target],
        withIndex,
        content,
      );
      const blob = stdout.toString('utf8').trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) {
        throw new Error(`could not store ${target} in the object database`);
      }

      // --index-info both adds and replaces, and works without a working tree.
      await run(['update-index', '--index-info'], withIndex, `100644 ${blob}\t${target}\n`);
    }

    const { stdout: treeOut } = await run(['write-tree'], withIndex);
    const tree = treeOut.toString('utf8').trim();

    if (sha && !allowEmpty) {
      // Catching a no-op here gives a better message than a confusing
      // "nothing to commit" from git after the fact.
      const { stdout: parentTreeOut } = await run(['rev-parse', `${sha}^{tree}`]);
      if (parentTreeOut.toString('utf8').trim() === tree) {
        throw new ValidationError('nothing to commit: that change would not alter the tree');
      }
    }

    const parentArgs = sha ? ['-p', sha] : [];
    const { stdout: commitOut } = await run([
      'commit-tree', tree, ...parentArgs, '-m', message,
    ]);
    const commit = commitOut.toString('utf8').trim();

    // Move the branch. Passing the old value makes this a compare-and-swap, so
    // two people editing at once produces a clear failure rather than one
    // silently overwriting the other.
    const updateArgs = sha
      ? ['update-ref', '-m', `browser: ${firstLine(message)}`, ref, commit, sha]
      : ['update-ref', '-m', `browser: ${firstLine(message)}`, ref, commit];

    await run(updateArgs);

    return { commit, tree, ref };
  } finally {
    await cleanup();
  }
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 60);
}

/**
 * Write a set of files in one commit.
 *
 * A batch is the natural unit for a multi-file upload: someone dropping in five
 * files expects one commit in the history, not five.
 */
export async function writeFiles(repo, { edits, message, branch, user }) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new ValidationError('no files to write');
  }

  const current = await targetRef(repo, branch);
  const ref = current ? current.ref : newRefName(branch);

  const normalised = edits.map((edit) => ({ ...edit, path: writablePath(edit.path) }));
  for (const edit of normalised) {
    if (!edit.path) throw new ValidationError('a file path is required');
  }

  // Reject an overwrite of a directory with a file, and vice versa, before
  // anything is written.
  if (current) {
    for (const edit of normalised) {
      // eslint-disable-next-line no-await-in-loop
      const clash = await pathClash(repo, current.sha, edit.path);
      if (clash) throw new ValidationError(clash);
    }
  }

  const result = await commitEdits(repo, {
    ref,
    sha: current ? current.sha : null,
    edits: normalised,
    message,
    user,
  });

  return { ...result, paths: normalised.map((edit) => edit.path) };
}

/**
 * Would writing `target` collide with something already in the tree?
 *
 * Git refuses both directions ("cannot create ... : file exists"), but the
 * message it produces does not say which file the user typed, so this checks
 * first and names the path.
 */
async function pathClash(repo, sha, target) {
  const kindOf = async (path) => {
    try {
      return await gitOut(repo.path, ['cat-file', '-t', `${sha}:${path}`]);
    } catch {
      return null; // does not exist
    }
  };

  // A file cannot replace a directory.
  if (await kindOf(target) === 'tree') {
    return `${target} is a directory; a file cannot replace it`;
  }

  // A file cannot be created inside another file.
  const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  if (parent) {
    const parentKind = await kindOf(parent);
    if (parentKind && parentKind !== 'tree') {
      return `${target} cannot be created: ${parent} is a file, not a directory`;
    }
  }
  return null;
}

/**
 * Paths git reserves. Writing to these fails deep inside git with a confusing
 * error, and `.git` in particular must never be reachable from a web form.
 */
const RESERVED_SEGMENTS = new Set(['.git', '.hg', '.svn', '.gitmodules.lock']);

/** A repository-relative path that is safe to write. */
function writablePath(input) {
  const target = safeRepoPath(input);
  if (!target) throw new ValidationError('a file path is required');

  for (const segment of target.split('/')) {
    if (RESERVED_SEGMENTS.has(segment)) {
      throw new ValidationError(`"${segment}" is reserved by git and cannot be written to`);
    }
  }
  if (target.endsWith('/')) throw new ValidationError('a file path cannot end with a slash');
  return target;
}

/** Create a new file, or replace an existing one. */
export async function writeFile(repo, { path: filePath, content, message, branch, user }) {
  const target = writablePath(filePath);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buffer.length > MAX_UPLOAD_BYTES) refuseTooLarge(buffer.length);

  const current = await targetRef(repo, branch);
  const existed = current ? await fileExists(repo, current.sha, target) : false;

  const clash = current ? await pathClash(repo, current.sha, target) : null;
  if (clash) throw new ValidationError(clash);

  const result = await writeFiles(repo, {
    edits: [{ path: target, content: buffer }],
    message,
    branch,
    user,
  });

  return { ...result, path: result.paths[0], created: !existed, binary: looksBinary(buffer) };
}

/** Remove a file. */
export async function deleteFile(repo, { path: filePath, message, branch, user }) {
  const target = writablePath(filePath);

  const current = await targetRef(repo, branch);
  if (!current) throw new ValidationError('this repository has no commits yet');
  if (!(await fileExists(repo, current.sha, target))) {
    throw new NotFoundError(`no such file: ${target}`);
  }

  const result = await commitEdits(repo, {
    ref: current.ref,
    sha: current.sha,
    edits: [{ path: target, delete: true }],
    message,
    user,
  });

  return { ...result, path: target, deleted: true };
}

/** Does `path` exist in the tree of `sha`? */
async function fileExists(repo, sha, target) {
  try {
    const out = await gitOut(repo.path, ['ls-tree', '--name-only', sha, '--', target]);
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Create a directory by committing a `.gitkeep` in it. */
export async function createDirectory(repo, { path: dirPath, message, branch, user }) {
  const dir = writablePath(dirPath);

  const keep = `${dir}/.gitkeep`;
  const current = await targetRef(repo, branch);
  const ref = current ? current.ref : newRefName(branch);

  const result = await commitEdits(repo, {
    ref,
    sha: current ? current.sha : null,
    edits: [{ path: keep, content: '' }],
    message,
    user,
  });

  return { ...result, path: dir };
}

/**
 * Turn an uploaded file into an edit.
 *
 * Kept separate from the commit so the size and binary checks can be tested
 * without a repository, and so the route stays readable.
 */
export function editFromUpload(file) {
  if (!file || !file.originalname) {
    throw new ValidationError('no file was uploaded');
  }
  if (file.size > MAX_UPLOAD_BYTES) refuseTooLarge(file.size);

  const target = writablePath(decodeUploadName(file.originalname));

  return { path: target, content: file.buffer };
}

/**
 * Recover a usable path from a multipart filename.
 *
 * Browsers send the client's filename, which may be a full path (older IE) or
 * carry a traversal sequence, so only the basename is kept and the result goes
 * through the normal path validation.
 */
export function decodeUploadName(name) {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  // Re-decode a percent-encoded name the way a browser would have sent it.
  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch { /* not encoded */ }
  return decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

