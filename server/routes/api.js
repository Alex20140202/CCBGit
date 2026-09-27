import express from 'express';
import * as registry from '../lib/repos.js';
import * as repo from '../lib/repo.js';
import * as requests from '../lib/requests.js';
import { gitOut } from '../lib/git.js';
import { NotFoundError, ValidationError, parsePage, safeRepoPath } from '../lib/validate.js';
import config from '../../config.js';

const router = express.Router();

/** Wrap an async handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Every /api/repo/... route starts by resolving the repository. */
async function loadRepo(req) {
  const record = registry.resolve(req.params.owner ? `${req.params.owner}/${req.params.name}` : req.params.name);
  return record;
}

function paging(req) {
  return {
    page: parsePage(req.query.page, 1, 100000),
    pageSize: parsePage(req.query.pageSize, config.git.pageSize, config.git.maxPageSize),
  };
}

/* ------------------------------------------------------------- discovery */

router.get('/repos', wrap(async (req, res) => {
  if (!registry.isScanned()) await registry.scan();

  const result = registry.list({
    q: req.query.q || '',
    language: req.query.language || '',
    sort: req.query.sort || 'updated',
    order: req.query.order || 'desc',
    ...paging(req),
  });

  res.json({
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    items: await Promise.all(result.items.map(async (item) => {
      try {
        return { ...item, meta: await repo.repoMeta({ owner: item.owner, name: item.name, path: item.path }) };
      } catch {
        return item;
      }
    })),
  });
}));

router.post('/repos/refresh', wrap(async (_req, res) => {
  const repos = await registry.scan();
  res.json({ ok: true, count: repos.total, names: repos.all });
}));

/* ---------------------------------------------------------------- detail */

router.get('/repos/:owner/:name', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const meta = await repo.repoMeta(record);
  const [branches, tags, history] = await Promise.all([
    repo.branches(record),
    repo.tags(record),
    repo.commits(record, meta.defaultBranch, { page: 1, pageSize: 10 }),
  ]);
  res.json({ id: registry.identifierOf(record), name: record.name, owner: record.owner, meta, branches, tags, commits: history.items });
}));

router.get('/repos/:owner/:name/meta', wrap(async (req, res) => {
  res.json(await repo.repoMeta(await loadRepo(req)));
}));

router.get('/repos/:owner/:name/refs', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const [branches, tags] = await Promise.all([repo.branches(record), repo.tags(record)]);
  res.json({ ...branches, tags });
}));

/* ------------------------------------------------------------------ tree */

/** `/tree?ref=<ref>&path=<dir>` - the same shape as the blob endpoint. */
router.get('/repos/:owner/:name/tree', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const ref = await repo.resolveRef(record, req.query.ref);
  const dirPath = safeRepoPath(req.query.path || '');
  const result = await repo.tree(record, ref, dirPath);
  if (result.isFile) {
    return res.json({ ref, path: result.path, isFile: true, entry: result.entry, entries: [] });
  }
  res.json({ ref, ...result, languages: await repo.languages(record, ref) });
}));

router.get('/repos/:owner/:name/languages', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const ref = await repo.resolveRef(record, req.query.ref);
  res.json({ ref, languages: await repo.languages(record, ref) });
}));

/* ------------------------------------------------------------------ blob */

router.get('/repos/:owner/:name/blob', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const ref = await repo.resolveRef(record, req.query.ref);
  const filePath = safeRepoPath(req.query.path);
  if (!filePath) throw new ValidationError('`path` query parameter is required');
  res.json({ ref, ...(await repo.blob(record, ref, filePath)) });
}));

/* --------------------------------------------------------------- commits */

router.get('/repos/:owner/:name/commits', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const ref = await repo.resolveRef(record, req.query.ref);
  const result = await repo.commits(record, ref, {
    ...paging(req),
    path: safeRepoPath(req.query.path || ''),
  });
  res.json({ ref, ...result });
}));

router.get('/repos/:owner/:name/commits/:sha', wrap(async (req, res) => {
  res.json(await repo.commit(await loadRepo(req), req.params.sha));
}));

/* ---------------------------------------------------------------- search */

router.get('/repos/:owner/:name/search', wrap(async (req, res) => {
  const record = await loadRepo(req);
  const ref = await repo.resolveRef(record, req.query.ref);
  res.json(await repo.search(record, ref, req.query.q, {
    limit: parsePage(req.query.limit, 100, 500),
    caseSensitive: req.query.case === 'sensitive',
    regex: req.query.regex === '1',
  }));
}));

/* ----------------------------------------------------------------- misc */

router.get('/repos/:owner/:name/contributors', wrap(async (req, res) => {
  res.json({ contributors: (await repo.repoMeta(await loadRepo(req))).contributors });
}));

router.get('/requests', wrap(async (req, res) => {
  // A regular user only ever sees their own queue; an admin sees everything
  // unless they ask for their own.
  // `req.user` is the stored record, which carries `role` but not the
  // `isAdmin` convenience flag that publicUser() adds for templates.
  const scopeMine = req.query.scope === 'mine' || req.user.role !== 'admin';
  const list = await requests.list(scopeMine ? { requestedBy: req.user.username } : {});
  res.json({ requests: list, scope: scopeMine ? 'mine' : 'all' });
}));

/** Health/diagnostic payload, handy for the status bar in the UI. */
router.get('/status', wrap(async (_req, res) => {
  const gitVersion = await gitOut(process.cwd(), ['--version']).catch(() => 'git not found');
  res.json({
    ok: true,
    site: config.site.title,
    git: gitVersion,
    node: process.version,
    roots: config.repoRoots,
    repositories: registry.isScanned() ? registry.list({ pageSize: 1 }).total : 0,
    cache: registry.cache.stats(),
    uptime: Math.round(process.uptime()),
  });
}));

/** Unknown API endpoints answer in the same shape as every other API error. */
router.use((_req, _res, next) => next(new NotFoundError('unknown API endpoint')));

export default router;
export { NotFoundError };
