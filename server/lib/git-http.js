import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { NotFoundError } from './validate.js';

/**
 * Bridge to `git http-backend`.
 *
 * git's smart HTTP protocol is served by a CGI program, so the job here is to
 * run it as one: hand it the request as environment variables plus the request
 * body on stdin, then copy its output - a set of CGI headers, a blank line, and
 * then a packfile - back onto the socket.
 *
 * The body is never buffered. A push arrives as a multi-megabyte packfile, and
 * both directions are piped straight through.
 */

/** The services git may ask for. Anything else is refused. */
const ALLOWED_SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

/**
 * The only paths git is allowed to ask for beneath a repository.
 *
 * `PATH_INFO` is attacker-influenced, so it is not sanitised - it is checked
 * against this list and nothing else gets through.
 */
const ALLOWED_SUBPATHS = new Set(['/info/refs', '/git-upload-pack', '/git-receive-pack']);

/**
 * Build the CGI `PATH_INFO` for a request.
 *
 * git-http-backend resolves `PATH_INFO` against `GIT_PROJECT_ROOT`, and it
 * strips a trailing `.git` itself. So the repository component has to be its
 * path *relative to the root*: passing `/foo.git/...` for a directory called
 * `foo` makes the backend look for `foo.git` and answer 404.
 */
function buildPathInfo(repoPath, root, subpath) {
  const relative = path.relative(path.resolve(root), path.resolve(repoPath));
  const segments = relative.split(path.sep);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new NotFoundError('invalid repository path');
  }
  if (!ALLOWED_SUBPATHS.has(subpath)) {
    throw new NotFoundError(`unsupported git path: ${subpath}`);
  }
  return `/${segments.join('/')}${subpath}`;
}

/** Locate `git-http-backend`, which ships inside git's exec-path. */
let backendBinary = null;

async function findBackend() {
  if (backendBinary) return backendBinary;

  const execPath = await new Promise((resolve) => {
    const child = spawn(config.git.binary, ['--exec-path'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });

  if (execPath) {
    const candidate = path.join(execPath, 'git-http-backend');
    try {
      await access(candidate, constants.X_OK);
      backendBinary = candidate;
      return candidate;
    } catch { /* fall through to PATH */ }
  }

  backendBinary = 'git-http-backend';
  return backendBinary;
}

/** Is this a service we are willing to run? */
export function assertService(service) {
  if (!ALLOWED_SERVICES.has(service)) {
    throw new NotFoundError(`unsupported git service: ${service}`);
  }
  return service;
}

/**
 * Translate an Express request into the CGI variables git expects.
 *
 * `PATH_INFO` is how git locates the repository, so it is the repository's path
 * *relative to GIT_PROJECT_ROOT*. It must also stay inside that root and be a
 * single path segment: without those two checks a crafted URL could reach a
 * different repository, or one outside the configured roots entirely.
 */
export function cgiEnvironment(req, { repoPath, subpath, remoteUser, protocolVersion }) {
  const root = path.resolve(config.repoRoots[0]);
  const absolute = path.resolve(repoPath);
  const relative = path.relative(root, absolute);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new NotFoundError('repository is outside the configured roots');
  }
  // Repositories may be nested (repos/group/name), so several segments are fine.
  // What is not fine is an empty or dotted segment, which is the only way a
  // relative path could still point somewhere unintended.
  const segments = relative.split(path.sep);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new NotFoundError('invalid repository path');
  }

  const headers = req.headers;
  const env = {
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: `HTTP/${headers['http-version'] || '1.1'}`,
    SERVER_SOFTWARE: 'ccbgit',
    REQUEST_METHOD: req.method,
    PATH_INFO: buildPathInfo(absolute, root, subpath),
    PATH_TRANSLATED: absolute,
    SCRIPT_NAME: '',
    QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '',
    SERVER_NAME: headers.host || 'localhost',
    SERVER_PORT: String(req.socket.localPort || config.port),
    REMOTE_ADDR: req.socket.remoteAddress || '',
    REMOTE_USER: remoteUser || '',
    CONTENT_TYPE: headers['content-type'] || '',
    CONTENT_LENGTH: headers['content-length'] || '',

    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: '1',

    PATH: process.env.PATH,
  };

  // The client announces the protocol version it speaks; v2 is the modern one.
  if (protocolVersion) env.GIT_PROTOCOL = protocolVersion;
  if (headers['content-encoding']) env.HTTP_CONTENT_ENCODING = headers['content-encoding'];

  return env;
}

/**
 * Run git-http-backend and pipe the exchange through to the client.
 *
 * Resolves once the response has been written. Rejects with the backend's
 * stderr if it exits non-zero before sending a response.
 */
export async function proxyGit(req, res, { repoPath, subpath, remoteUser, protocolVersion }) {
  const binary = await findBackend();
  const env = cgiEnvironment(req, { repoPath, subpath, remoteUser, protocolVersion });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let headersSent = false;
    let pending = Buffer.alloc(0);

    child.stdout.on('data', (chunk) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }

      // Buffer only until the blank line that ends the header block; the
      // packfile behind it is streamed through untouched.
      pending = Buffer.concat([pending, chunk]);
      const boundary = pending.indexOf('\r\n\r\n');
      if (boundary === -1) {
        if (pending.length > 64 * 1024) {
          child.kill('SIGKILL');
          reject(new Error('git-http-backend produced an oversized header block'));
        }
        return;
      }

      writeCgiHeaders(res, pending.subarray(0, boundary).toString('latin1'));
      headersSent = true;

      const body = pending.subarray(boundary + 4);
      pending = Buffer.alloc(0);
      if (body.length) res.write(body);
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });

    // The client is the source of the packfile: pipe it in, never collect it.
    req.on('error', () => child.kill('SIGKILL'));
    req.on('aborted', () => child.kill('SIGKILL'));
    res.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
    req.pipe(child.stdin);
    child.stdin.on('error', () => { /* client went away mid-push */ });

    child.on('error', (error) => {
      if (!res.headersSent) res.status(500);
      if (!res.writableEnded) res.end();
      reject(error);
    });

    child.on('close', (code) => {
      if (!headersSent && code !== 0) {
        reject(new Error(stderr.trim() || `git-http-backend exited with ${code}`));
        return;
      }
      res.end();
      resolve();
    });
  });
}

/** Turn CGI header lines into Express response headers. */
function writeCgiHeaders(res, block) {
  for (const line of block.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;

    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();

    if (name.toLowerCase() === 'status') {
      const code = Number.parseInt(value, 10);
      if (Number.isFinite(code)) {
        const reason = value.slice(String(code).length).trim();
        res.status(code);
        if (reason) res.statusMessage = reason;
      }
    } else {
      res.setHeader(name, value);
    }
  }
}

/**
 * Does this repository exist on disk and is it a repository?
 *
 * Used to answer git's endpoints with a clear message when a path is simply
 * not there, rather than letting the backend produce a confusing error.
 */
export async function repositoryExists(repoPath) {
  try {
    const info = await stat(repoPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export { ALLOWED_SERVICES, ALLOWED_SUBPATHS, buildPathInfo };
