import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { gitLines, gitOut, isRepository, currentBranch, descriptionOf } from './git.js';
import { TtlCache } from './cache.js';
import { languageFor, isReadme } from './languages.js';
import { languages as repoLanguages } from './repo.js';
import { NotFoundError, assertRepoName } from './validate.js';

const cache = new TtlCache(config.cache);

/** owner/name -> { name, owner, path, root } */
const registry = new Map();

function ownerFromRoot(root) {
  return path.basename(root);
}

function key(owner, name) {
  return `${owner}/${name}`;
}

/**
 * Walk `dir` looking for git repositories, without descending into
 * `.git`, `node_modules` or other noise directories.
 */
async function discover(dir, depth, seen, out) {
  if (depth > 3) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasGitDir = entries.some(
    (entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()),
  );

  if (hasGitDir) {
    out.push(dir);
    // Do not recurse into a repository: nested repos are not hosted here.
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'repos') {
      continue;
    }
    await discover(path.join(dir, entry.name), depth + 1, seen, out);
  }
}

/** Read a config value from the repository's own git config. */
async function configValue(dir, key_) {
  try {
    return await gitOut(dir, ['config', '--get', key_]);
  } catch {
    return '';
  }
}

/**
 * Build the summary shown on the index page. Everything here is best effort:
 * a repository that fails one of these lookups should still be listed.
 */
async function summarise(dir) {
  const [isBare] = await Promise.all([
    gitOut(dir, ['rev-parse', '--is-bare-repository']).catch(() => 'false'),
  ]);

  const defaultBranch =
    (await gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      .then((ref) => ref.replace(/^origin\//, ''))
      .catch(() => '')) ||
    (await currentBranch(dir).catch(() => null)) ||
    (await gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) ||
    'main';

  const headRef = await currentBranch(dir);
  const [remote, description, homepage] = await Promise.all([
    configValue(dir, 'remote.origin.url'),
    descriptionOf(dir),
    configValue(dir, 'homepage'),
  ]);

  const [
    lastCommitLines,
    branchesOut,
    tagsOut,
    contributorsOut,
    rootFiles,
    sizeOut,
  ] = await Promise.all([
    gitLines(dir, ['log', '-1', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D', defaultBranch]).catch(() => []),
    gitOut(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => ''),
    gitOut(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).catch(() => ''),
    gitOut(dir, ['shortlog', '-sne', '--all', '--no-merges']).catch(() => ''),
    gitLines(dir, ['ls-tree', '--name-only', defaultBranch]).catch(() => []),
    gitOut(dir, ['count-objects', '-vH']).catch(() => ''),
  ]);

  const lastCommit = lastCommitLines[0] ? parseCommitLine(lastCommitLines[0]) : null;

  const branches = branchesOut ? branchesOut.split('\n').filter(Boolean) : [];
  const tags = tagsOut ? tagsOut.split('\n').filter(Boolean) : [];
  const contributors = contributorsOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*?)\s*<([^>]+)>\s*$/);
      return match
        ? { commits: Number(match[1]), name: match[2], email: match[3] }
        : { commits: 0, name: line.trim(), email: '' };
    })
    .sort((a, b) => b.commits - a.commits);

  let size = 0;
  const sizeMatch = sizeOut.match(/size-pack:\s*([\d.]+)\s*(\w+)/i);
  if (sizeMatch) {
    const unit = sizeMatch[2].toLowerCase();
    const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit] ?? 1;
    size = Math.round(Number(sizeMatch[1]) * factor);
  }

  const readmePath = rootFiles.find((f) => isReadme(f)) || null;

  return {
    name: path.basename(dir),
    path: dir,
    bare: isBare === 'true',
    defaultBranch,
    headRef,
    remote: remote || null,
    description: description || null,
    homepage: homepage || null,
    lastCommit,
    branchCount: branches.length,
    tagCount: tags.length,
    contributors,
    rootFiles,
    readmePath,
    size,
  };
}

function parseCommitLine(line) {
  const [sha, name, email, date, subject, refs] = line.split('\x1f');
  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorName: name,
    authorEmail: email,
    date,
    subject: subject || '',
    refs: (refs || '').trim(),
  };
}

/**
 * Rescan every configured root and rebuild the registry. Cheap enough to run
 * on boot and from the "refresh" button.
 */
export async function scan() {
  const found = [];

  for (const root of config.repoRoots) {
    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    if (await isRepository(root)) {
      found.push(root);
      continue;
    }
    const nested = [];
    await discover(root, 0, new Set(), nested);
    found.push(...nested);
  }

  registry.clear();
  for (const dir of found) {
    const name = assertRepoName(path.basename(dir));
    const owner = ownerFromRoot(path.dirname(dir));
    registry.set(key(owner, name), { name, owner, path: dir, root: path.dirname(dir) });
  }

  // Index each repository's default branch and language mix so that filtering
  // and sorting on the index page do not need a git call per request.
  await Promise.allSettled(
    [...registry.values()].map(async (record) => {
      const meta = await ensureDefaultBranch(record);
      record.languages = await languageNames(record, meta.defaultBranch);
    }),
  );

  return list();
}

/** The branch a repository's index card should describe. */
async function ensureDefaultBranch(record) {
  const defaultBranch =
    (await gitOut(record.path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      .then((ref) => ref.replace(/^origin\//, ''))
      .catch(() => '')) ||
    (await currentBranch(record.path).catch(() => null)) ||
    (await gitOut(record.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) ||
    'main';
  record.defaultBranch = defaultBranch;
  return { defaultBranch };
}

async function languageNames(record, ref) {
  try {
    const stats = await repoLanguages(record, ref);
    return stats.map((entry) => entry.language);
  } catch {
    return [];
  }
}

/** Has the registry been populated? */
export function isScanned() {
  return registry.size > 0;
}

/**
 * Resolve an `owner/name` (or bare `name`) identifier to a repository record.
 * @throws {NotFoundError}
 */
export function resolve(identifier) {
  if (!isScanned()) throw new NotFoundError('repository index is not ready yet');

  const raw = String(identifier || '').replace(/^\/+|\/+$/g, '');
  if (!raw) throw new NotFoundError('repository name is required');

  const direct = registry.get(raw.toLowerCase());
  if (direct) return direct;

  const parts = raw.split('/');
  if (parts.length === 2) {
    const found = registry.get(key(parts[0].toLowerCase(), parts[1].toLowerCase()));
    if (found) return found;
  }

  // Allow `name` or `name.git` to resolve when unique.
  const candidates = [...registry.values()].filter(
    (repo) => repo.name === parts[parts.length - 1] || `${repo.name}.git` === parts[parts.length - 1],
  );
  if (candidates.length === 1) return candidates[0];

  throw new NotFoundError(`repository not found: ${raw}`);
}

/** Full identifier, e.g. `local/ccbgit`. */
export function identifierOf(repo) {
  return key(repo.owner, repo.name);
}

function searchableText(repo) {
  return [repo.name, repo.owner, repo.description, repo.homepage, ...(repo.rootFiles || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * List repositories with optional filtering/sorting/pagination.
 */
export function list({
  q = '',
  language = '',
  sort = 'updated',
  order = 'desc',
  page = 1,
  pageSize = 12,
} = {}) {
  let items = [...registry.values()];

  if (q) {
    const needle = String(q).toLowerCase().trim();
    const terms = needle.split(/\s+/).filter(Boolean);
    items = items.filter((repo) => {
      const haystack = searchableText(repo);
      return terms.every((term) => haystack.includes(term));
    });
  }

  if (language) {
    items = items.filter((repo) => (repo.languages || []).includes(language));
  }

  const direction = order === 'asc' ? 1 : -1;
  const comparators = {
    name: (a, b) => a.name.localeCompare(b.name),
    created: (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')),
    updated: (a, b) =>
      String(a.lastCommit?.date || '').localeCompare(String(b.lastCommit?.date || '')),
    commits: (a, b) => (a.commitCount || 0) - (b.commitCount || 0),
    size: (a, b) => (a.size || 0) - (b.size || 0),
  };
  const comparator = comparators[sort] || comparators.updated;
  items.sort((a, b) => comparator(a, b) * direction);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * pageSize;

  return {
    total,
    totalPages,
    page: current,
    pageSize,
    items: items.slice(start, start + pageSize).map(decorate),
    all: items.map((repo) => ({ id: identifierOf(repo), name: repo.name, owner: repo.owner })),
  };
}

function decorate(record) {
  return {
    id: identifierOf(record),
    name: record.name,
    owner: record.owner,
    ...record,
  };
}

/**
 * Ensure the summary for a repository is loaded (lazy + cached), so listing is
 * not blocked by stat-ing every repository on each request.
 */
export async function ensureSummary(repo) {
  return cache.wrap(`summary:${identifierOf(repo)}`, () => summarise(repo.path));
}

export { languageFor, cache };
export default { scan, list, resolve, ensureSummary, identifierOf, isScanned, cache };
