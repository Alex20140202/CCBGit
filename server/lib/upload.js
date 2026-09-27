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

/** Resolve the ref a change should be based on, defaulting to the main branch. */
async function targetRef(repo, requested) {
  const candidates = [requested, DEFAULT_BRANCH, 'HEAD'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const sha = await gitOut(repo.path, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      if (sha) return { ref: candidate, sha };
    } catch { /* try the next candidate */ }
  }
  return null;
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
      const target = safeRepoPath(edit.path);
      if (!target) throw new ValidationError('a file path is required');

      if (edit.delete) {
        await run(['update-index', '--force-remove', '--', target], withIndex);
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
      const blob = stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) {
        throw new Error(`could not store ${target} in the object database`);
      }

      // --add is needed for a path that is not in the tree yet.
      await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${target}`], withIndex);
    }

    const { stdout: treeOut } = await run(['write-tree'], withIndex);
    const tree = treeOut.trim();

    if (sha && !allowEmpty) {
      // Catching a no-op here gives a better message than a confusing
      // "nothing to commit" from git after the fact.
      const { stdout: parentTreeOut } = await run(['rev-parse', `${sha}^{tree}`]);
      if (parentTreeOut.trim() === tree) {
        throw new ValidationError('nothing to commit: that change would not alter the tree');
      }
    }

    const parentArgs = sha ? ['-p', sha] : [];
    const { stdout: commitOut } = await run([
      'commit-tree', tree, ...parentArgs, '-m', message,
    ]);
    const commit = commitOut.trim();

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

/** Create a new file, or replace an existing one. */
export async function writeFile(repo, { path: filePath, content, message, branch, user }) {
  const target = safeRepoPath(filePath);
  if (!target) throw new ValidationError('a file path is required');

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buffer.length > MAX_UPLOAD_BYTES) refuseTooLarge(buffer.length);

  const current = await targetRef(repo, branch);
  const existed = current ? await fileExists(repo, current.sha, target) : false;

  const ref = current ? current.ref : (branch || DEFAULT_BRANCH);
  const result = await commitEdits(repo, {
    ref,
    sha: current ? current.sha : null,
    edits: [{ path: target, content: buffer }],
    message,
    user,
  });

  return {
    ...result,
    path: target,
    created: !existed,
    binary: looksBinary(buffer),
  };
}

/** Remove a file. */
export async function deleteFile(repo, { path: filePath, message, branch, user }) {
  const target = safeRepoPath(filePath);
  if (!target) throw new ValidationError('a file path is required');

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
  const dir = safeRepoPath(dirPath);
  if (!dir) throw new ValidationError('a directory name is required');

  const keep = `${dir}/.gitkeep`;
  const current = await targetRef(repo, branch);
  const ref = current ? current.ref : (branch || DEFAULT_BRANCH);

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

  const target = safeRepoPath(decodeUploadName(file.originalname));
  if (!target) throw new ValidationError('the uploaded file has no usable name');

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

