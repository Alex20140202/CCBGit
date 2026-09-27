import path from 'node:path';
import { GitError } from './git.js';

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{4,64}$/i;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * A repository is addressed as `<owner>/<name>`. Names may only contain the
 * characters git itself allows in a directory, and must not be `.`/`..`.
 */
export function assertRepoName(name) {
  if (typeof name !== 'string' || !REPO_NAME_RE.test(name) || name.startsWith('.')) {
    throw new ValidationError(`invalid repository name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Validate a user supplied ref (branch, tag, sha...). Rejecting anything that
 * could be read as an option (`--upload-pack=...`) or a revision range
 * (`a..b`, `a^`, `@{-1}`) is the cheapest way to keep `git` invocations inert.
 */
export function assertSafeRef(ref, { allowEmpty = true } = {}) {
  if (ref === undefined || ref === null || ref === '') {
    if (allowEmpty) return '';
    throw new ValidationError('a ref is required');
  }
  if (typeof ref !== 'string' || ref.length > 255) {
    throw new ValidationError('invalid ref');
  }
  if (ref.startsWith('-') || ref.includes('..') || ref.includes('^') || ref.includes('~') ||
      ref.includes(' ') || ref.includes(':') || ref.includes('?') || ref.includes('[') ||
      ref.includes('*') || ref.includes('\\') || ref.includes('@{') || ref.includes('//')) {
    throw new ValidationError(`unsafe ref: ${ref}`);
  }
  if (!REF_RE.test(ref)) {
    throw new ValidationError(`invalid ref: ${ref}`);
  }
  return ref;
}

/** A partial or full commit sha. */
export function assertSha(sha) {
  if (!SHA_RE.test(String(sha || ''))) {
    throw new ValidationError(`invalid commit sha: ${sha}`);
  }
  return String(sha).toLowerCase();
}

/**
 * A commit-ish: either a sha or a safe ref. Used for `/commit/<id>` so that
 * `HEAD`, `main` and a full sha all work while option-like or range-like input
 * is still rejected.
 */
export function assertCommitish(value) {
  const raw = String(value ?? '').trim();
  if (SHA_RE.test(raw)) return raw.toLowerCase();
  return assertSafeRef(raw, { allowEmpty: false });
}

/**
 * Normalise a repository-relative path.
 *
 * Returns POSIX-style path segments with no `.`/`..` and no leading slash, so
 * the result can never escape the repository root when joined for display or
 * passed to git as a pathspec.
 */
export function safeRepoPath(input) {
  const raw = String(input ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  const out = [];
  for (const segment of raw) {
    if (segment === '..') {
      throw new ValidationError('path traversal is not allowed');
    }
    if (segment.includes('\0')) {
      throw new ValidationError('invalid path segment');
    }
    out.push(segment);
  }
  return out.join('/');
}

/** Clamp a pagination value. */
export function parsePage(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * Is `candidate` contained in `parent`? Used to stop a symlink or
 * `..` escape from reaching outside the configured repository roots.
 */
export function isInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Map a git failure onto the right HTTP status code. */
export function statusForGitError(error) {
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof GitError) {
    if (/unknown revision|bad revision|not a valid object name|ambiguous/i.test(error.message)) {
      return 404;
    }
    if (/ambiguous argument|unknown option|usage:/i.test(error.message)) return 400;
    return 500;
  }
  return 500;
}
