import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';

const execFileAsync = promisify(execFile);

/**
 * Await a spawned git process.
 *
 * Resolves with Buffers rather than strings: `cat-file blob` on a binary file
 * must not pass through a UTF-8 decode, which would replace undecodable bytes
 * and corrupt the content. Callers that want text use gitOut/gitLines.
 */
function promiseChild(child) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    // execFile may set an encoding on the streams, so a chunk can arrive as a
    // string on one path and a Buffer on another. Normalise before collecting.
    const collect = (target) => (chunk) => target.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1'));

    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr.toString('utf8').trim() || `git exited with ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderrText = stderr.toString('utf8');
        reject(error);
      }
    });
  });
}

/**
 * Thrown when a git command exits non-zero. Carries a human readable message
 * so routes can map failures onto sensible HTTP status codes.
 */
export class GitError extends Error {
  constructor(message, { code = null, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

let counter = 0;
function nextId() {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return counter;
}

/**
 * Run a git command inside `cwd`.
 *
 * Arguments are passed as an array (never through a shell), so repository
 * names and refs can never be interpreted as shell syntax. Git additionally
 * refuses ambiguous refs itself, but we validate user input before it gets here
 * anyway - see `assertSafeRef` in lib/validate.js.
 */
export async function git(cwd, args, {
  timeout = config.git.timeout,
  maxBuffer = 32 * 1024 * 1024,
  env: extraEnv,
  stdin,
} = {}) {
  const started = process.hrtime.bigint();
  try {
    const child = execFile(config.git.binary, args, {
      cwd,
      timeout,
      maxBuffer,
      // Returning Buffers is the only way to keep `cat-file blob` honest for
      // binary content.
      encoding: 'buffer',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
        ...extraEnv,
      },
    });

    if (stdin !== undefined) {
      // Content has to arrive on stdin: as an argument it would land in the
      // process list, and it would break on anything large.
      child.stdin.end(stdin);
    }

    const { stdout, stderr } = await promiseChild(child);
    return {
      stdout,
      stderr,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } catch (error) {
    if (error.killed) {
      throw new GitError(`git ${args[0]} timed out after ${timeout}ms`, { code: 'ETIMEDOUT' });
    }
    const stderr = (error.stderrText || error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    const detail = stderr || stdout || error.message;
    throw new GitError(detail || 'git command failed', { code: error.code, stderr: detail });
  }
}

/** Run git and return trimmed stdout as text. */
export async function gitOut(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return stdout.toString('utf8').trim();
}

/** Run git and return stdout as an array of lines (empty lines removed). */
export async function gitLines(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return stdout.toString('utf8').split('\n').filter((line) => line.length > 0);
}

/** Run git and return raw stdout bytes as a Buffer. */
export async function gitBuffer(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

/**
 * Is `dir` the root of a git repository?
 *
 * Three layouts count, and all three are in real use:
 *
 * - a working tree: has a `.git` directory
 * - a submodule or a linked worktree: has a `.git` *file* pointing elsewhere
 * - a bare repository: no `.git` at all, but `HEAD`, `objects/` and `refs/`
 *
 * The bare case matters because it is the only layout you can `git push` into
 * without git refusing to overwrite a checked-out branch.
 *
 * Note this deliberately does *not* use `rev-parse --is-inside-work-tree`: a
 * plain directory that merely sits inside some other repository would answer
 * "true" to that and get registered as a repository of its own.
 */
export async function isRepository(dir) {
  try {
    const gitStat = await fs.stat(path.join(dir, '.git'));
    if (gitStat.isDirectory() || gitStat.isFile()) return true;
  } catch { /* no .git: check for a bare layout */ }

  try {
    const [head, objects, refs] = await Promise.all([
      fs.stat(path.join(dir, 'HEAD')),
      fs.stat(path.join(dir, 'objects')),
      fs.stat(path.join(dir, 'refs')),
    ]);
    return head.isFile() && objects.isDirectory() && refs.isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the absolute path of the repository's `.git` directory. */
export async function gitDir(dir) {
  return gitOut(dir, ['rev-parse', '--absolute-git-dir']);
}

/** Current HEAD ref name, or null when detached / unborn. */
export async function currentBranch(dir) {
  try {
    const name = await gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return name || null;
  } catch {
    return null;
  }
}

/** Verify a ref-ish resolves to a commit and return its full sha. */
export async function resolveCommit(dir, ref) {
  const sha = await gitOut(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return sha || null;
}

const UNNAMED = /^(unnamed repository|edit this file 'description')/i;

/**
 * The repository's human description. Git keeps this in `.git/description`
 * rather than in the config, so it has to be read from the file.
 */
export async function descriptionOf(dir) {
  try {
    // gitOut decodes; git() hands back Buffers.
    const gitDir = await gitOut(dir, ['rev-parse', '--absolute-git-dir']);
    const text = await fs.readFile(path.join(gitDir, 'description'), 'utf8');
    const first = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
    return UNNAMED.test(first) ? '' : first;
  } catch {
    return '';
  }
}
