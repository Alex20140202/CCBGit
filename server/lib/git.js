import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';

const execFileAsync = promisify(execFile);

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
export async function git(cwd, args, { timeout = config.git.timeout, maxBuffer = 32 * 1024 * 1024, env: extraEnv } = {}) {
  const started = process.hrtime.bigint();
  try {
    const { stdout, stderr } = await execFileAsync(config.git.binary, args, {
      cwd,
      timeout,
      maxBuffer,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
        ...extraEnv,
      },
    });
    return {
      stdout,
      stderr,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } catch (error) {
    if (error.killed) {
      throw new GitError(`git ${args[0]} timed out after ${timeout}ms`, { code: 'ETIMEDOUT' });
    }
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    const detail = stderr || stdout || error.message;
    throw new GitError(detail || 'git command failed', { code: error.code, stderr: detail });
  }
}

/** Run git and return trimmed stdout. */
export async function gitOut(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return stdout.trim();
}

/** Run git and return stdout as an array of lines (empty lines preserved). */
export async function gitLines(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return stdout.split('\n').filter((line) => line.length > 0);
}

/** Run git and return raw stdout bytes as a Buffer. */
export async function gitBuffer(cwd, args, options) {
  const { stdout } = await git(cwd, args, options);
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

/**
 * Is `dir` the root of a git repository?
 *
 * The presence of a `.git` entry is the test, deliberately *not*
 * `rev-parse --is-inside-work-tree`: a plain directory that merely sits inside
 * some other repository would answer "true" to the latter and get registered
 * as a repository of its own.
 */
export async function isRepository(dir) {
  try {
    const stat = await fs.stat(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
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
    const { stdout: gitDirOut } = await git(dir, ['rev-parse', '--absolute-git-dir']);
    const file = path.join(gitDirOut.trim(), 'description');
    const text = await fs.readFile(file, 'utf8');
    const first = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
    return UNNAMED.test(first) ? '' : first;
  } catch {
    return '';
  }
}
