import express from 'express';
import * as registry from '../lib/repos.js';
import * as repoLib from '../lib/repo.js';
import * as access from '../lib/access.js';
import * as gitHttp from '../lib/git-http.js';
import * as auth from '../lib/auth.js';
import config from '../../config.js';

/**
 * The git HTTP endpoints.
 *
 * Paths look like /<owner>/<name>.git/<service>, which is what `git clone` and
 * `git push` expect. They are mounted before the page routes, which would
 * otherwise treat `<name>.git` as a repository name.
 */
const router = express.Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * git speaks Basic auth, so this authenticates by header as well as by session
 * cookie. No CSRF check applies: git cannot carry a token, and it presents a
 * credential on every request.
 */
router.use(auth.attachBasicAuth);

/** Resolve `/owner/name.git/...` to a repository. */
function resolveRepo(req) {
  const owner = req.params.owner;
  const name = String(req.params.name || '').replace(/\.git$/i, '');
  return registry.resolve(`${owner}/${name}`);
}

const CHALLENGE = `Authentication required.

git needs credentials over HTTP. Either configure a helper:

  git config --global credential.helper store
  git clone http://localhost:${config.port}/<owner>/<repo>.git

and answer the prompt, or put them in the URL:

  git clone http://<username>:<password>@localhost:${config.port}/<owner>/<repo>.git
`;

/** Any signed-in user may read. */
function requireGitUser(req, res, next) {
  if (!req.user) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CCBGit"');
    return res.status(401).type('text/plain').send(CHALLENGE);
  }
  return next();
}

/**
 * Writing additionally requires the repository to belong to the caller, or to
 * an administrator. This is the only place that decision is made.
 */
async function requireGitWrite(req, res, next) {
  if (!req.user) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CCBGit"');
    return res.status(401).type('text/plain').send(CHALLENGE);
  }

  const record = resolveRepo(req);
  const denial = await access.explainWriteDenial(req.user, record);
  if (denial) return res.status(403).type('text/plain').send(`${denial}\n`);

  return next();
}

/** Run the backend for one subpath and stream the exchange through. */
function serve(subpath) {
  return wrap(async (req, res) => {
    const record = resolveRepo(req);
    res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');

    try {
      await gitHttp.proxyGit(req, res, {
        repoPath: record.path,
        subpath,
        remoteUser: req.user.username,
        protocolVersion: req.headers['git-protocol'],
      });
    } finally {
      // A push has just changed what is on disk, so nothing cached about this
      // repository - or about any other - can be trusted.
      repoLib.invalidate(record);
      repoLib.invalidateAll();
    }
  });
}

/**
 * The advertisement endpoint git calls first, for both clone and push.
 *
 * `?service=` decides which protocol follows, so a push is refused here rather
 * than after git has already started sending a packfile.
 */
router.get('/:owner/:name.git/info/refs', requireGitUser, wrap(async (req, res) => {
  const record = resolveRepo(req);
  const service = gitHttp.assertService(String(req.query.service || 'git-upload-pack'));

  if (service === 'git-receive-pack') {
    const denial = await access.explainWriteDenial(req.user, record);
    if (denial) return res.status(403).type('text/plain').send(`${denial}\n`);
  }

  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  try {
    await gitHttp.proxyGit(req, res, {
      repoPath: record.path,
      subpath: '/info/refs',
      remoteUser: req.user.username,
      protocolVersion: req.headers['git-protocol'],
    });
  } finally {
    repoLib.invalidate(record);
    repoLib.invalidateAll();
  }
}));

/** Fetch: clone and pull. */
router.post('/:owner/:name.git/git-upload-pack', requireGitUser, serve('/git-upload-pack'));

/** Send: push. */
router.post('/:owner/:name.git/git-receive-pack', requireGitWrite, serve('/git-receive-pack'));

/** A `.git` path that is not a repository. */
router.use('/:owner/:name.git', (req, res) => {
  res.status(404).type('text/plain').send('Repository not found.\n');
});

export default router;
