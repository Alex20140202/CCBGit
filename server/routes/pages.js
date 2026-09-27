import express from 'express';
import config from '../../config.js';
import * as registry from '../lib/repos.js';
import * as repo from '../lib/repo.js';
import * as access from '../lib/access.js';
import { renderMarkdown, tableOfContents, highlight } from '../lib/render.js';
import { ValidationError, assertSafeRef, safeRepoPath, parsePage } from '../lib/validate.js';

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ index */

router.get('/', wrap(async (req, res) => {
  if (!registry.isScanned()) await registry.scan();

  const page = parsePage(req.query.page, 1, 10000);
  const pageSize = parsePage(req.query.pageSize, 12, 100);
  const listing = registry.list({
    q: req.query.q || '',
    language: req.query.language || '',
    sort: req.query.sort || 'updated',
    order: req.query.order || 'desc',
    page,
    pageSize,
  });

  const items = await Promise.all(listing.items.map(async (item) => {
    const record = { owner: item.owner, name: item.name, path: item.path };
    try {
      const meta = await repo.repoMeta(record);
      const langs = await repo.languages(record, meta.defaultBranch).catch(() => []);
      return { ...item, meta, languages: langs, defaultBranch: meta.defaultBranch };
    } catch (error) {
      return { ...item, meta: null, languages: [], error: error.message };
    }
  }));

  const languages = await allLanguages();

  res.render('index', {
    title: 'Repositories',
    items,
    listing,
    filters: { q: req.query.q || '', language: req.query.language || '', sort: req.query.sort || 'updated', order: req.query.order || 'desc' },
    languages,
  });
}));

/**
 * Every language present anywhere in the index, for the filter dropdown.
 *
 * Derived from the repositories themselves rather than from the current page,
 * so the options do not change as you page through results. Memoised for a
 * minute because it costs one `ls-tree` per repository.
 */
let facetCache = { at: 0, values: [] };
const FACET_TTL = 60_000;

async function allLanguages() {
  if (Date.now() - facetCache.at < FACET_TTL) return facetCache.values;

  const records = registry.list({ pageSize: 10000 }).items.map((entry) => ({
    owner: entry.owner,
    name: entry.name,
    path: entry.path,
  }));

  const found = new Set();
  const results = await Promise.allSettled(records.map(async (record) => {
    const meta = await repo.repoMeta(record);
    return repo.languages(record, meta.defaultBranch);
  }));

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const language of result.value) found.add(language.language);
  }

  facetCache = { at: Date.now(), values: [...found].sort() };
  return facetCache.values;
}


/* ------------------------------------------------------------------ repo */

/** Resolve repository + meta for every /:owner/:name page. */
async function repoContext(req, res, next) {
  try {
    const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
    const meta = await repo.repoMeta(record);
    const id = registry.identifierOf(record);

    res.locals.record = record;
    res.locals.repo = { id, name: record.name, owner: record.owner, path: record.path };
    res.locals.meta = meta;

    // Who may write here, and the URLs that actually work.
    const writeAccess = await access.writeAccess(req.user, record);
    res.locals.writeAccess = writeAccess;

    const host = req.headers.host || `localhost:${config.port}`;
    const http = `http://${host}/${id}.git`;
    res.locals.git = {
      http,
      short: `${record.owner}/${record.name}`,
      path: record.path,
      urls: { http },
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Resolve the ref for a request and publish it on `res.locals`.
 *
 * This cannot live in `repoContext`: middleware runs before route matching, so
 * `req.params.ref` is still undefined there. A ref in the path wins over the
 * `?ref=` query parameter, which is what pages without a ref segment use.
 */
async function withRef(req, res) {
  const ref = await repo.resolveRef(res.locals.record, req.params.ref || req.query.ref);
  res.locals.ref = ref;
  res.locals.refEncoded = encodeURIComponent(ref);
  res.locals.shortRef = ref === res.locals.meta.defaultBranch ? res.locals.meta.defaultBranch : ref;
  return ref;
}

const repoRoutes = express.Router({ mergeParams: true });
repoRoutes.use(repoContext);

// Repository home: the file tree at `ref`.
repoRoutes.get('/', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const ref = await withRef(req, res);
  const [entries, langs, history, readme] = await Promise.all([
    repo.tree(record, res.locals.ref, ''),
    repo.languages(record, res.locals.ref),
    repo.commits(record, res.locals.ref, { page: 1, pageSize: 12 }),
    readmeFor(record, res.locals.ref),
  ]);

  res.render('repo', {
    title: record.name,
    tree: entries,
    languages: langs,
    commits: history.items,
    commitTotal: history.total,
    readme,
    path: '',
    file: null,
    mode: 'tree',
  });
}));

// `/tree/<ref>` has no path component; normalise it to the repository home.
repoRoutes.get('/tree/:ref', (req, res) => {
  res.redirect(302, `/${req.params.owner}/${req.params.name}?ref=${encodeURIComponent(req.params.ref)}`);
});

// A directory inside the tree.
repoRoutes.get('/tree/:ref/*', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const ref = await withRef(req, res);
  const dirPath = safeRepoPath(req.params[0] || '');
  const [entries, langs, history, readme] = await Promise.all([
    repo.tree(record, ref, dirPath),
    repo.languages(record, ref),
    repo.commits(record, ref, { page: 1, pageSize: 8, path: dirPath }),
    readmeFor(record, ref, dirPath),
  ]);

  if (entries.isFile) {
    return res.redirect(302, `/${registry.identifierOf(record)}/blob/${encodeURIComponent(ref)}/${entries.path}`);
  }

  res.render('repo', {
    title: `${record.name}/${dirPath}`,
    tree: entries,
    languages: langs,
    commits: history.items,
    commitTotal: history.total,
    readme,
    path: dirPath,
    file: null,
    mode: 'tree',
  });
}));

// A single file.
repoRoutes.get('/blob/:ref/*', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const ref = await withRef(req, res);
  const filePath = safeRepoPath(req.params[0]);
  const file = await repo.blob(record, ref, filePath);

  if (file.isDir) {
    return res.redirect(302, `/${registry.identifierOf(record)}/tree/${encodeURIComponent(ref)}/${file.path}`);
  }

  let rendered = null;
  let toc = [];
  let highlighted = null;
  if (!file.binary && !file.tooLarge && !file.isSubmodule && file.content != null) {
    // Render from a CRLF-normalised copy; `file.content` itself stays
    // byte-faithful for the raw download and the editor.
    const display = repo.forDisplay(file.content);
    if (file.isMarkdown) {
      rendered = renderMarkdown(display);
      toc = tableOfContents(display);
    } else {
      highlighted = highlight(display, file.language);
    }
  }

  const history = file.path
    ? await repo.commits(record, ref, { page: 1, pageSize: 10, path: file.path }).catch(() => ({ items: [], total: 0 }))
    : { items: [], total: 0 };

  res.render('repo', {
    title: `${record.name}/${file.name}`,
    tree: null,
    languages: [],
    commits: history.items,
    commitTotal: history.total,
    readme: null,
    path: filePath,
    file: { ...file, rendered, highlighted, toc },
    mode: 'blob',
  });
}));

// Commit history, optionally scoped to a path.
repoRoutes.get('/commits', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const ref = await withRef(req, res);
  const filePath = safeRepoPath(req.query.path || '');
  const page = parsePage(req.query.page, 1, 10000);
  const history = await repo.commits(record, ref, { page, pageSize: 25, path: filePath });
  const [langs] = await Promise.all([repo.languages(record, ref)]);

  res.render('commits', {
    title: 'Commits',
    commits: history.items,
    page: history.page,
    hasMore: history.hasMore,
    total: history.total,
    scope: filePath,
    languages: langs,
  });
}));

// A single commit with its diff.
repoRoutes.get('/commit/:sha', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  // The sidebar needs a ref to render its branch list, same as every other
  // repository page.
  await withRef(req, res);
  const details = await repo.commit(record, req.params.sha);
  res.render('commit', { title: details.subject, commit: details, mode: 'commit' });
}));

// Compare two refs. The spec is parsed by hand because Express's pattern
// syntax has no notion of the "base...head" convention.
repoRoutes.get('/compare/*', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const spec = String(req.params[0] || '');
  const parts = spec.split(/\.{2,3}|\.\.\./).filter(Boolean);
  if (parts.length !== 2) {
    throw new ValidationError('expected a range of the form <base>...<head>');
  }
  const [baseRaw, headRaw] = parts;
  const base = assertSafeRef(baseRaw, { allowEmpty: false });
  const head = assertSafeRef(headRaw, { allowEmpty: false });

  // For the sidebar's branch list only; the comparison itself uses base/head.
  await withRef(req, res);

  const [ahead, behind, log, patch] = await Promise.all([
    gitCount(record, `${base}..${head}`),
    gitCount(record, `${head}..${base}`),
    // Only meaningful when the refs actually differ; otherwise listing `head`
    // would show unrelated history.
    repo.commits(record, head, { page: 1, pageSize: 50 }),
    comparePatch(record, base, head),
  ]);

  const identical = ahead === 0 && behind === 0;

  res.render('compare', {
    title: `Comparing ${base}...${head}`,
    base,
    head,
    ahead,
    behind,
    identical,
    mode: 'compare',
    commits: identical ? [] : log.items,
    patch,
  });
}));

// In-repository code search.
repoRoutes.get('/search', wrap(async (req, res) => {
  const record = registry.resolve(`${req.params.owner}/${req.params.name}`);
  const ref = await withRef(req, res);
  const term = String(req.query.q || '').trim();
  const result = term
    ? await repo.search(record, ref, term, {
      caseSensitive: req.query.case === 'sensitive',
      regex: req.query.regex === '1',
    })
    : { term: '', results: [], truncated: false, total: 0 };
  res.render('search', {
    title: term ? `Search: ${term}` : 'Search',
    result,
    term,
    // Echoed back into the form so a re-search does not silently lose the
    // options the previous search was run with.
    caseSensitive: req.query.case === 'sensitive',
    useRegex: req.query.regex === '1',
  });
}));

async function gitCount(record, range) {
  const { gitOut } = await import('../lib/git.js');
  const out = await gitOut(record.path, ['rev-list', '--count', range]).catch(() => '0');
  return Number(out) || 0;
}

async function comparePatch(record, base, head) {
  const { gitBuffer } = await import('../lib/git.js');
  const raw = await gitBuffer(record.path, [
    'diff', '--patch', '--no-color', '--find-renames', '--unified=3', `${base}...${head}`,
  ], { maxBuffer: 16 * 1024 * 1024 }).catch(() => Buffer.alloc(0));
  return repo.parsePatch(raw.toString('utf8'));
}

/* --------------------------------------------------------------- readme */

async function readmeFor(record, ref, dirPath = '') {
  try {
    const entries = await repo.tree(record, ref, dirPath);
    if (entries.isFile) return null;
    const readme = entries.entries.find((entry) => !entry.isDir && entry.name.toLowerCase().startsWith('readme'));
    if (!readme) return null;
    const file = await repo.blob(record, ref, readme.path);
    if (file.binary || !file.content) return null;
    return {
      name: readme.name,
      html: renderMarkdown(file.content),
      sizeText: file.sizeText,
    };
  } catch {
    return null;
  }
}

router.use('/:owner/:name', repoRoutes);

/* -------------------------------------------------------------- archive */

router.get('/:owner/:name/archive/:format', wrap(async (req, res) => {
  const record = res.locals.record;
  const ref = await repo.resolveRef(record, req.query.ref);
  const target = repo.archiveFormat(req.params.format);

  res.setHeader('Content-Type', target.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${record.name}-${ref.replace(/[^\w.-]+/g, '_')}.${target.ext}"`,
  );

  try {
    await repo.archiveStream(record, ref, res, { format: req.params.format });
  } catch (error) {
    if (!res.headersSent) res.status(500);
    res.end();
    if (!error.message) throw error;
  }
}));

// Raw file download.
/**
 * Raw download. Byte-faithful, binary included: this is the route a script or a
 * browser "Save as" uses, so a UTF-8 round trip here would corrupt anything
 * that is not text.
 */
router.get('/:owner/:name/raw/:ref/*', wrap(async (req, res) => {
  const record = res.locals.record;
  const ref = await repo.resolveRef(record, req.params.ref);
  const file = await repo.blobBytes(record, ref, safeRepoPath(req.params[0]));

  const guessed = mimeFor(file.name);
  res.setHeader('Content-Type', guessed || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/["\\]/g, '_')}"`);
  res.end(file.buffer);
}));

/** A small extension table, enough to make a download open sensibly. */
const MIME_TYPES = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
};

function mimeFor(name) {
  const dot = String(name).lastIndexOf('.');
  return dot === -1 ? '' : (MIME_TYPES[String(name).slice(dot).toLowerCase()] || '');
}

export default router;
