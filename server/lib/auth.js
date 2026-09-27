import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { ValidationError, NotFoundError } from './validate.js';

/* ------------------------------------------------------------- password */

// scrypt parameters. N=16384/r=8/p=1 is the interactive-login recommendation
// from the OWASP password storage cheat sheet.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Hash a password. The format carries its own parameters so the cost can be
 * raised later without invalidating existing hashes:
 *
 *   scrypt$N$r$p$<salt base64>$<key base64>
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time password check. Returns false for any malformed record. */
export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- store */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

function dataDir() {
  return config.auth.dataDir;
}

function usersFile() {
  return path.join(dataDir(), 'users.json');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // A corrupt store must not silently disable authentication.
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file); // atomic swap, so a crash cannot truncate the store
}

let cache = { at: 0, value: { users: [] } };

/** All users, cached briefly so a page render does not re-read the file. */
export async function allUsers({ fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < 5000 && cache.value) return cache.value.users;
  const value = await readJson(usersFile(), { users: [] });
  const users = Array.isArray(value.users) ? value.users : [];
  cache = { at: Date.now(), value: { users } };
  return users;
}

export async function findUser(username) {
  const wanted = String(username || '').toLowerCase();
  const users = await allUsers();
  return users.find((user) => user.username.toLowerCase() === wanted) || null;
}

export function assertUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    throw new ValidationError(
      'username must be 2-32 characters of letters, digits, dot, dash or underscore',
    );
  }
  return value.toLowerCase();
}

export function assertPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new ValidationError('password must be at least 8 characters');
  if (value.length > MAX_PASSWORD_LENGTH) throw new ValidationError('password is too long');
  return value;
}

/**
 * Create a user.
 *
 * The very first account becomes an admin, which is how a fresh install gets
 * its administrator without a bootstrap step. Set ALLOW_SIGNUP=false once the
 * accounts you need exist.
 */
export async function createUser({ username, password, displayName, role }) {
  const name = assertUsername(username);
  assertPassword(password);
  if (await findUser(name)) throw new ValidationError('that username is already taken');

  const users = await allUsers({ fresh: true });
  const resolvedRole = role || (users.length === 0 ? 'admin' : 'user');

  const user = {
    username: name,
    displayName: (displayName && String(displayName).trim().slice(0, 64)) || name,
    role: resolvedRole === 'admin' ? 'admin' : 'user',
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await writeJson(usersFile(), { users });
  cache = { at: Date.now(), value: { users } };
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isAdmin: user.role === 'admin',
  };
}

export async function setPassword(username, password) {
  const users = await allUsers({ fresh: true });
  const user = users.find((entry) => entry.username === username);
  if (!user) throw new NotFoundError('no such user');
  user.password = hashPassword(password);
  await writeJson(usersFile(), { users });
  cache = { at: Date.now(), value: { users } };
  return user;
}

/* --------------------------------------------------------------- session */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE = 'ccbgit_session';

/**
 * The signing secret. `SESSION_SECRET` is used when set; otherwise a random one
 * is generated and persisted so sessions survive a restart. If the data
 * directory is not writable we fall back to a process-local secret, which just
 * means everyone is logged out on restart.
 */
let secretCache = null;

function sessionSecret() {
  if (config.sessionSecret) return Buffer.from(config.sessionSecret, 'utf8');
  if (secretCache) return secretCache;

  const file = path.join(dataDir(), 'session.key');
  try {
    secretCache = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (secretCache.length >= 32) return secretCache;
  } catch { /* generate below */ }

  const generated = crypto.randomBytes(48);
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
  } catch { /* in-memory only */ }
  secretCache = generated;
  return secretCache;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const index = token.lastIndexOf('.');
  const body = token.slice(0, index);
  const mac = token.slice(index + 1);

  const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest();
  let given;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(expected, given)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, payload) {
  res.cookie(COOKIE, sign(payload), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/* ------------------------------------------------------------ middleware */

/**
 * Attach `req.user` when a valid session cookie is present. Never rejects.
 *
 * An anonymous visitor is also given a session, carrying nothing but a CSRF
 * token: the sign-in and registration forms need one, and they are reachable
 * before authentication exists.
 */
export async function attachUser(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = unsign(cookies[COOKIE]);

  if (payload && payload.sub) {
    const user = await findUser(payload.sub);
    if (user) {
      req.user = user;
      req.session = { ...payload, csrf: payload.csrf || crypto.randomBytes(24).toString('base64url') };
      return next();
    }
  }

  // No usable session: mint an anonymous one so forms can be rendered.
  if (payload && payload.csrf && !payload.sub) {
    req.session = { ...payload, sub: null };
    return next();
  }

  const csrf = newCsrfToken();
  req.session = { sub: null, csrf, exp: Date.now() + SESSION_TTL_MS };
  setSessionCookie(res, req.session);
  next();
}

/** Reject anonymous requests. For pages, sends a redirect; for the API, 401. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'authentication required', status: 401 });
  const next_ = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(302, `/login?next=${next_}`);
}

export function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role !== 'admin') {
    if (wantsJson(req)) return res.status(403).json({ error: 'administrator access required', status: 403 });
    return res.status(403).render('error', {
      title: 'Not allowed',
      status: 403,
      message: 'This page is for administrators.',
      detail: '',
    });
  }
  return next();
}

function wantsJson(req) {
  return req.path.startsWith('/api/')
    || (req.headers.accept || '').includes('application/json');
}

/**
 * Verify the CSRF token carried by a form submission against the one in the
 * session. Session cookies alone do not stop cross-site POSTs; SameSite=Strict
 * helps, but the token is what actually enforces it.
 */
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Forms carry the token in a hidden field; fetch() calls carry it in a
  // header, because there is no form to put a field in.
  const submitted = (req.body && req.body._csrf) || req.get('X-CSRF-Token');
  const expected = req.session && req.session.csrf;

  const reject = () => {
    if (wantsJson(req)) {
      return res.status(403).json({ error: 'invalid or missing CSRF token', status: 403 });
    }
    return res.status(403).render('error', {
      title: 'Request rejected',
      status: 403,
      message: 'This form has expired. Go back, reload the page and try again.',
      detail: '',
    });
  };

  if (!expected || !submitted) return reject();

  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(submitted));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reject();

  return next();
}

export function newCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/* -------------------------------------------------------- basic auth */

/**
 * Extract credentials from an `Authorization: Basic` header.
 *
 * git cannot follow a redirect to a sign-in form, so it needs to authenticate
 * on the request itself. Basic is the mechanism git speaks out of the box,
 * over a credential helper or `http.extraHeader`.
 *
 * @returns {{username: string, password: string} | null}
 */
export function parseBasicAuth(req) {
  const header = req.headers.authorization;
  if (!header || !/^basic\s/i.test(header)) return null;

  let decoded;
  try {
    decoded = Buffer.from(header.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const index = decoded.indexOf(':');
  if (index === -1) return null;

  return {
    username: decoded.slice(0, index),
    password: decoded.slice(index + 1),
  };
}

/**
 * Authenticate a request that carries Basic credentials, and remember the
 * result for the rest of the request.
 *
 * Failures are counted against the same throttle as the sign-in form, so this
 * cannot be used to guess passwords through git any more easily than through
 * the browser.
 */
export async function attachBasicAuth(req, res, next) {
  const credentials = parseBasicAuth(req);
  if (!credentials) return next();

  const throttle = loginThrottle(req, credentials.username);
  if (!throttle.allowed) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CCBGit", charset="UTF-8"');
    res.setHeader('Retry-After', String(throttle.retryInMinutes * 60));
    return res.status(429).end('Too many failed authentication attempts. Try again later.\n');
  }

  const user = await findUser(credentials.username);
  const ok = user
    ? verifyPassword(credentials.password, user.password)
    : verifyPassword(credentials.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

  if (!user || !ok) {
    // Re-challenging is how git learns to prompt for credentials.
    res.setHeader('WWW-Authenticate', 'Basic realm="CCBGit", charset="UTF-8"');
    return res.status(401).end('Authentication required.\n');
  }

  clearLoginThrottle(req, credentials.username);
  req.user = user;
  if (!req.session) {
    req.session = { sub: user.username, role: user.role, csrf: newCsrfToken() };
  }
  return next();
}

/* ------------------------------------------------------ login throttling */

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/** Simple fixed-window limiter, keyed by IP + submitted username. */
export function loginThrottle(req, username) {
  const key = `${req.ip}:${String(username || '').toLowerCase()}`;
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.until) {
    attempts.set(key, { count: 1, until: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_ATTEMPTS - 1 };
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    return { allowed: false, retryInMinutes: Math.ceil((entry.until - now) / 60000) };
  }
  return { allowed: true, remaining: MAX_ATTEMPTS - entry.count };
}

export function clearLoginThrottle(req, username) {
  attempts.delete(`${req.ip}:${String(username || '').toLowerCase()}`);
}

export { COOKIE as SESSION_COOKIE, SESSION_TTL_MS };
