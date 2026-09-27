import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const root = here;

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  root,
  /**
   * Note: 6665-6669 are on Chrome's blocked "unsafe ports" list (IRC range), so
   * 6666 answers curl but shows ERR_UNSAFE_PORT in the browser. 6600 is close by
   * and not blocked.
   */
  port: int(process.env.PORT, 6600),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  /** morgan format: terse in development, apache-style everywhere else. */
  logFormat: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'combined' : 'dev'),

  /** Directories that are scanned for git repositories. */
  repoRoots: (process.env.REPO_ROOTS || path.join(root, 'repos'))
    .split(path.delimiter)
    .map((entry) => path.resolve(entry.trim()))
    .filter(Boolean),

  site: {
    title: process.env.SITE_TITLE || 'CCBGit',
    tagline: process.env.SITE_TAGLINE || 'A home for every repository on this machine.',
    owner: process.env.SITE_OWNER || 'local',
  },

  auth: {
    /** Where the user database, request queue and session key live. */
    dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
    /**
     * Signing key for session cookies. When unset a random key is generated and
     * persisted in dataDir, which keeps sessions valid across restarts.
     */
    sessionSecret: process.env.SESSION_SECRET || '',
    /** Allow self-registration. The first account is always an admin. */
    allowSignup: bool(process.env.ALLOW_SIGNUP, true),
    /** Send session cookies only over HTTPS. Enable behind a TLS proxy. */
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    /** Set `secure` from the request protocol automatically. */
    trustProxy: bool(process.env.TRUST_PROXY, false),
  },

  git: {
    binary: process.env.GIT_BINARY || 'git',
    timeout: int(process.env.GIT_TIMEOUT, 15000),
    /** Hard cap on bytes returned for a single blob. */
    maxBlobSize: int(process.env.MAX_BLOB_SIZE, 2 * 1024 * 1024),
    /** Commits per page. */
    pageSize: int(process.env.PAGE_SIZE, 30),
    maxPageSize: 100,
  },

  cache: {
    enabled: bool(process.env.CACHE_ENABLED, true),
    ttl: int(process.env.CACHE_TTL, 15000),
    max: int(process.env.CACHE_MAX, 500),
  },

  security: {
    /** Allow repositories outside of repoRoots to be opened. */
    allowExternal: bool(process.env.ALLOW_EXTERNAL, false),
    /** Render stack traces on error pages. Off unless explicitly requested. */
    showStacks: bool(process.env.SHOW_STACKS, false),
  },
};

export default config;
