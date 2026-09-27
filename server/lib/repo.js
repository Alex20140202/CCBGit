import path from 'node:path';
import { spawn } from 'node:child_process';
import config from '../../config.js';
import { GitError, git, gitBuffer, gitLines, gitOut, currentBranch, resolveCommit, descriptionOf } from './git.js';
import { TtlCache } from './cache.js';
import { sniff } from './render.js';
import { looksBinary } from './binary.js';
import {
  NotFoundError,
  ValidationError,
  assertSafeRef,
  assertCommitish,
  safeRepoPath,
} from './validate.js';
import { languageFor, isMarkdown, isReadme, isProbablyText, formatBytes, languageColor } from './languages.js';

const cache = new TtlCache({ ...config.cache, ttl: Math.max(config.cache.ttl, 8000) });

const SEP = '\x1f';

function keyed(repo, ...parts) {
  return [repo.owner, repo.name, ...parts].join(' ');
}

function invalidationKey(repo) {
  return keyed(repo);
}

/** Drop cached data for a repository (used by the refresh endpoint). */
export function invalidate(repo) {
  cache.invalidate(invalidationKey(repo));
}

/**
 * Drop every cached lookup.
 *
 * A rescan has to call this: `registry.scan()` only rebuilds the repository
 * list, so without it a freshly pushed commit stays invisible until the TTL
 * expires - which makes the "Rescan" button silently do nothing.
 */
export function invalidateAll() {
  cache.clear();
}

/* ------------------------------------------------------------------ refs */

/** All branches, with upstream and ahead/behind counts. */
export async function branches(repo) {
  return cache.wrap(keyed(repo, 'branches'), async () => {
    const format = [
      '%(refname:short)',
      '%(objectname)',
      '%(upstream:short)',
      '%(HEAD)',
      '%(committerdate:iso-strict)',
      '%(contents:subject)',
    ].join(SEP);
    const lines = await gitLines(repo.path, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes']);
    const head = await currentBranch(repo.path);
    const list = lines.map((line) => {
      const [name, sha, upstream, isHead, date, subject] = line.split(SEP);
      return {
        name,
        shortName: name.replace(/^origin\//, ''),
        sha,
        shortSha: sha.slice(0, 7),
        upstream: upstream || null,
        isRemote: name.startsWith('origin/'),
        isHead: isHead === '*' || name === head,
        date,
        subject,
      };
    });
    return {
      head,
      branches: list.filter((b) => !b.isRemote),
      remotes: list.filter((b) => b.isRemote),
    };
  });
}

/** All tags, marking annotated vs lightweight. */
export async function tags(repo) {
  return cache.wrap(keyed(repo, 'tags'), async () => {
    const format = [
      '%(refname:short)',
      '%(objectname)',
      '%(objecttype)',
      '%(*objectname)',
      '%(creatordate:iso-strict)',
    ].join(SEP);
    const lines = await gitLines(repo.path, ['for-each-ref', `--format=${format}`, 'refs/tags']);
    return lines.map((line) => {
      const [name, sha, objectType, peeled, date] = line.split(SEP);
      return {
        name,
        sha,
        shortSha: sha.slice(0, 7),
        annotated: objectType === 'tag',
        target: (peeled || sha).slice(0, 7),
        date,
      };
    });
  });
}

/** Validate a user supplied ref and fall back to the default branch. */
export async function resolveRef(repo, requested, { fallback = 'HEAD' } = {}) {
  const ref = assertSafeRef(requested);
  if (!ref) {
    if (fallback === 'HEAD') return 'HEAD';
    const summary = await repoMeta(repo);
    return summary.defaultBranch;
  }
  if (ref === 'HEAD') return 'HEAD';
  // `--` guards against the ref being read as an option or a path.
  const exists = await gitOut(repo.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`, '--'])
    .then((sha) => sha || null)
    .catch(() => null);
  if (!exists) throw new NotFoundError(`ref not found: ${ref}`);
  return ref;
}

/* ------------------------------------------------------------------ meta */

/** Headline stats for a repository page. */
export async function repoMeta(repo) {
  return cache.wrap(keyed(repo, 'meta'), async () => {
    const [meta, branchInfo] = await Promise.all([
      (async () => {
        const isBare = await gitOut(repo.path, ['rev-parse', '--is-bare-repository']).catch(() => 'false');
        const headRef = await currentBranch(repo.path);
        const defaultBranch =
          (await gitOut(repo.path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
            .then((ref) => ref.replace(/^origin\//, ''))
            .catch(() => '')) ||
          headRef ||
          (await gitOut(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) ||
          'main';
        const description = await descriptionOf(repo.path);
        const homepage = await gitOut(repo.path, ['config', '--get', 'homepage']).catch(() => '');
        const remote = await gitOut(repo.path, ['config', '--get', 'remote.origin.url']).catch(() => '');
        return {
          bare: isBare === 'true',
          headRef,
          defaultBranch,
          description: description || null,
          homepage: homepage || null,
          remote: remote || null,
        };
      })(),
      branches(repo),
    ]);

    const [stats, latest, tagList] = await Promise.all([
      statsFor(repo),
      gitLines(repo.path, ['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s', meta.defaultBranch])
        .then((lines) => (lines[0] ? shapeCommit(lines[0].split(SEP), { defaultBranch: meta.defaultBranch }) : null))
        .catch(() => null),
      tags(repo),
    ]);

    return {
      ...meta,
      ...stats,
      latestCommit: latest,
      branchCount: branchInfo.branches.length,
      remoteCount: branchInfo.remotes.length,
      tagCount: tagList.length,
      cloneUrls: cloneUrls(repo, meta),
    };
  });
}

/**
 * How to get content in and out.
 *
 * There is no git HTTP backend, so an `http://…/<owner>/<name>.git` URL would
 * be a lie: git would follow it to the sign-in form and fail. What is true is
 * the path on disk, which is what `git push` needs.
 */
export function cloneUrls(repo, meta = {}) {
  return {
    local: repo.path,
    upstream: meta.remote || null,
  };
}

async function statsFor(repo) {
  const [commitLine, contributorsOut, sizeOut, firstLine] = await Promise.all([
    gitOut(repo.path, ['rev-list', '--count', 'HEAD']).catch(() => '0'),
    gitOut(repo.path, ['shortlog', '-sne', 'HEAD']).catch(() => ''),
    gitOut(repo.path, ['count-objects', '-vH']).catch(() => ''),
    gitOut(repo.path, ['log', '--reverse', '--format=%aI', '--max-count=1']).catch(() => ''),
  ]);

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
    const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[sizeMatch[2].toLowerCase()] ?? 1;
    size = Math.round(Number(sizeMatch[1]) * factor);
  }

  return {
    commitCount: Number(commitLine) || 0,
    contributors,
    contributorCount: contributors.length,
    size,
    createdAt: firstLine || null,
  };
}

/* ------------------------------------------------------------------ tree */

function parseLsTree(buffer) {
  const entries = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const filePath = record.slice(tab + 1);
    const [mode, type, sha, rawSize] = meta;
    entries.push({
      name: filePath.split('/').pop(),
      path: filePath,
      mode,
      type,
      sha,
      size: rawSize && rawSize !== '-' ? Number(rawSize) : 0,
      isDir: type === 'tree',
      isSubmodule: type === 'commit',
      isSymlink: mode === '120000',
    });
  }
  return entries;
}

/** Filesystem entries directly inside `dirPath` at `ref`. */
export async function tree(repo, ref, dirPath = '') {
  const clean = safeRepoPath(dirPath);
  const cacheKey = keyed(repo, 'tree', ref, clean);
  return cache.wrap(cacheKey, async () => {
    const list = async (spec) => {
      const args = ['ls-tree', '-z', '--long', ref, '--'];
      if (spec) args.push(spec);
      try {
        return parseLsTree(await gitBuffer(repo.path, args));
      } catch {
        throw new NotFoundError(`path not found: ${clean || '/'}`);
      }
    };

    let entries = await list(clean);

    // `ls-tree -- dir` echoes the directory itself; asking for `dir/` returns
    // its contents instead. A single entry matching the request is either the
    // file being asked for, or the directory that still needs expanding.
    if (entries.length === 1 && entries[0].path === clean && clean !== '') {
      if (entries[0].isDir) {
        entries = await list(`${clean}/`);
      } else {
        return { path: clean, isFile: true, entry: entries[0], entries: [] };
      }
    }

    // Nested gitlinks and symlinked directories are not traversable via ls-tree.
    entries = entries
      .map((entry) => ({ ...entry, language: entry.isDir ? null : languageFor(entry.name) }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = clean ? path.posix.dirname(clean) : '';
    return {
      path: clean,
      isFile: false,
      entries,
      parent: clean && parent !== clean ? parent : null,
      segments: clean ? clean.split('/') : [],
    };
  });
}

/**
 * How many unrecognised files to sample for content-based language detection.
 *
 * Sniffing costs a `cat-file` per file, so this is bounded. The largest files
 * are sampled first because they carry the strongest signal for a grammar.
 */
const SNIFF_SAMPLE = 25;

/** Read a file and guess its language from the bytes, or null. */
async function sniffLanguage(repo, ref, filePath) {
  try {
    const buffer = await gitBuffer(repo.path, ['cat-file', 'blob', `${ref}:${filePath}`], {
      maxBuffer: 128 * 1024,
    });
    if (looksBinary(buffer)) return null;
    // A guess below the confidence threshold is reported as "plain text"
    // rather than as a wrong language.
    const guess = sniff(buffer.toString('utf8'), { limit: 64 * 1024 });
    return guess ? guess.language : null;
  } catch {
    return null;
  }
}

/** File list for the language statistics bar. */
export async function languages(repo, ref) {
  return cache.wrap(keyed(repo, 'langs', ref), async () => {
    const out = await gitOut(repo.path, ['ls-tree', '-r', '-z', '--long', ref, '--']);
    const stats = new Map();
    const unrecognised = [];

    for (const record of out.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [, type, , size] = record.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;

      const filePath = record.slice(tab + 1);
      const bytes = Number(size) || 0;
      if (!isProbablyText(filePath)) continue;

      const language = languageFor(filePath);
      const current = stats.get(language) || { language, bytes: 0, files: 0 };
      current.bytes += bytes;
      current.files += 1;
      stats.set(language, current);

      if (language === 'plaintext') unrecognised.push({ filePath, bytes });
    }

    // Re-attribute a bounded sample of the files the extension could not
    // place, so an unlisted language does not silently merge into "plaintext".
    if (unrecognised.length) {
      unrecognised.sort((a, b) => b.bytes - a.bytes);
      for (const { filePath, bytes } of unrecognised.slice(0, SNIFF_SAMPLE)) {
        const sniffed = await sniffLanguage(repo, ref, filePath);
        if (!sniffed) continue;

        const from = stats.get('plaintext');
        from.bytes -= bytes;
        from.files -= 1;

        const to = stats.get(sniffed) || { language: sniffed, bytes: 0, files: 0 };
        to.bytes += bytes;
        to.files += 1;
        stats.set(sniffed, to);
      }
      // Drop the bucket if the sample emptied it out.
      if (stats.get('plaintext').bytes <= 0) stats.delete('plaintext');
    }

    const total = [...stats.values()].reduce((sum, item) => sum + item.bytes, 0) || 1;
    return [...stats.values()]
      .map((item) => ({
        ...item,
        percent: Number(((item.bytes / total) * 100).toFixed(1)),
        color: languageColor(item.language),
        size: formatBytes(item.bytes),
      }))
      .filter((item) => item.files > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 12);
  });
}

/* ------------------------------------------------------------------ blob */

/** Read a file at `ref`. Returns metadata plus decoded content. */
export async function blob(repo, ref, filePath) {
  const clean = safeRepoPath(filePath);
  if (!clean) throw new ValidationError('a file path is required');

  const cacheKey = keyed(repo, 'blob', ref, clean);
  return cache.wrap(cacheKey, async () => {
    const spec = `${ref}:${clean}`;

    let type;
    try {
      type = await gitOut(repo.path, ['cat-file', '-t', spec]);
    } catch {
      throw new NotFoundError(`file not found: ${clean}`);
    }

    if (type === 'tree') {
      return { path: clean, isDir: true, entries: null };
    }
    if (type !== 'blob') {
      return { path: clean, isSubmodule: true, type, content: '', size: 0 };
    }

    const size = Number(await gitOut(repo.path, ['cat-file', '-s', spec]).catch(() => 0)) || 0;

    if (size > config.git.maxBlobSize) {
      return {
        path: clean,
        isDir: false,
        tooLarge: true,
        size,
        sizeText: formatBytes(size),
        language: languageFor(clean),
        content: '',
      };
    }

    const buffer = await gitBuffer(repo.path, ['cat-file', 'blob', spec], { maxBuffer: config.git.maxBlobSize });
    const binary = looksBinary(buffer);

    const result = {
      path: clean,
      name: path.posix.basename(clean),
      isDir: false,
      size,
      sizeText: formatBytes(size),
      binary,
      language: languageFor(clean),
      isMarkdown: isMarkdown(clean),
      isReadme: isReadme(clean),
      segments: clean.split('/'),
      parent: path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean),
    };

    if (binary) {
      return { ...result, content: '', truncated: false };
    }

    let text = buffer.toString('utf8');
    let truncated = false;
    if (text.length > config.git.maxBlobSize) {
      text = text.slice(0, config.git.maxBlobSize);
      truncated = true;
    }

    // Line endings are left exactly as stored. The raw download has to be
    // byte-faithful, and normalising here would quietly rewrite a file with
    // CRLF endings on its way out. Anything that renders - the highlighter and
    // the markdown renderer - normalises for itself.

    const lines = text.split('\n');
    return {
      ...result,
      content: text,
      truncated,
      lineCount: lines.length,
      tooLong: lines.length > 5000,
      highlightLines: lines.length > 5000 ? null : lines,
    };
  });
}

/**
 * The raw bytes of a file at `ref`.
 *
 * Used by the download route, which has to be byte-faithful: decoding to a
 * string would corrupt anything that is not valid UTF-8.
 */
export async function blobBytes(repo, ref, filePath) {
  const clean = safeRepoPath(filePath);
  if (!clean) throw new ValidationError('a file path is required');

  let type;
  try {
    type = await gitOut(repo.path, ['cat-file', '-t', `${ref}:${clean}`]);
  } catch {
    throw new NotFoundError(`file not found: ${clean}`);
  }
  if (type === 'tree') throw new ValidationError(`${clean} is a directory`);
  if (type !== 'blob') throw new NotFoundError(`file not found: ${clean}`);

  const size = Number(await gitOut(repo.path, ['cat-file', '-s', `${ref}:${clean}`]).catch(() => 0)) || 0;
  if (size > config.git.maxBlobSize) {
    throw new ValidationError(
      `${clean} is ${formatBytes(size)}, over the ${formatBytes(config.git.maxBlobSize)} download limit`,
    );
  }

  return {
    path: clean,
    name: path.posix.basename(clean),
    size,
    sizeText: formatBytes(size),
    buffer: await gitBuffer(repo.path, ['cat-file', 'blob', `${ref}:${clean}`]),
  };
}

/** CRLF-normalised copy of a blob, for rendering only. */
function forDisplay(text) {
  return String(text).includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

export { forDisplay };


/* --------------------------------------------------------------- commits */

const LOG_FORMAT = [
  '%H', '%h', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%P', '%s', '%b', '%D',
].join(SEP);

function shapeCommit(parts, { withBody = false } = {}) {
  const [sha, shortSha, an, ae, aI, cn, ce, cI, parents, subject, body, refs] = parts;
  const parentsList = parents ? parents.split(' ').filter(Boolean) : [];
  return {
    sha,
    shortSha,
    author: { name: an, email: ae, date: aI },
    committer: { name: cn, email: ce, date: cI },
    parents: parentsList,
    parent: parentsList[0] || null,
    subject,
    body: withBody ? (body || '').trim() : '',
    refs: parseRefs(refs),
  };
}

function parseRefs(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ...rest] = entry.split(' -> ');
      return { name, target: rest[0] || null, kind: name.startsWith('tag:') ? 'tag' : name.includes('/') ? 'remote' : 'branch' };
    });
}

/** Paginated commit list for a ref, optionally filtered by a path. */
export async function commits(repo, ref, { page = 1, pageSize = config.git.pageSize, path: filePath = '', author = '' } = {}) {
  const cleanPath = filePath ? safeRepoPath(filePath) : '';
  const cacheKey = keyed(repo, 'commits', ref, cleanPath, author);

  return cache.wrap(cacheKey, async () => {
    const limit = Math.min(pageSize, config.git.maxPageSize);
    const skip = (Math.max(1, page) - 1) * limit;

    const args = ['log', ref, `--max-count=${limit + 1}`, `--skip=${skip}`, `--format=${LOG_FORMAT}`];
    if (cleanPath) args.push('--follow', '--', cleanPath);
    if (author) args.push(`--author=${assertSafeRef(author)}`);

    const raw = await gitBuffer(repo.path, args).catch(() => Buffer.alloc(0));
    const records = raw.toString('utf8').split('\n').filter((line) => line.length > 0);
    const hasMore = records.length > limit;
    const items = records.slice(0, limit).map((line) => shapeCommit(line.split(SEP)));

    const totalOut = await gitOut(repo.path, ['rev-list', '--count', ref, ...(cleanPath ? ['--', cleanPath] : [])])
      .catch(() => String(items.length));

    return {
      items,
      page: Math.max(1, page),
      pageSize: limit,
      hasMore,
      total: Number(totalOut) || items.length,
    };
  });
}

/** Full details for one commit, including the patch. */
export async function commit(repo, sha) {
  const id = assertCommitish(sha);
  return cache.wrap(keyed(repo, 'commit', id), async () => {
    const full = await resolveCommit(repo.path, id);
    if (!full) throw new NotFoundError(`commit not found: ${sha}`);

    const raw = await gitBuffer(repo.path, ['log', '-1', `--format=${LOG_FORMAT}`, full]);
    const record = raw.toString('utf8').split('\n')[0];
    const details = shapeCommit(record.split(SEP), { withBody: true });

    const [statLines, files, patch] = await Promise.all([
      gitLines(repo.path, ['show', '--stat', '--format=', `--max-count=1`, full]).catch(() => []),
      filesForCommit(repo, full),
      patchFor(repo, full),
    ]);

    const shortStat = statLines
      .map((line) => line.trim())
      .filter((line) => /files? changed/.test(line))
      .pop() || '';

    return {
      ...details,
      shortStat,
      stats: parseShortStat(shortStat),
      files,
      patch,
      statLines: statLines.filter((line) => line.trim() && !/files? changed/.test(line)),
    };
  });
}

function parseShortStat(text) {
  const out = { files: 0, insertions: 0, deletions: 0 };
  const files = text.match(/(\d+) files? changed/);
  const ins = text.match(/(\d+) insertions?\(\+\)/);
  const del = text.match(/(\d+) deletions?\(-\)/);
  if (files) out.files = Number(files[1]);
  if (ins) out.insertions = Number(ins[1]);
  if (del) out.deletions = Number(del[1]);
  return out;
}

async function filesForCommit(repo, sha) {
  const raw = await gitBuffer(repo.path, [
    'show', '--name-status', '-z', '--format=', '--no-renames', sha,
  ]).catch(() => Buffer.alloc(0));

  const fields = raw.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i].trim();
    const filePath = fields[i + 1];
    if (!filePath) continue;
    const code = status.slice(0, 1);
    files.push({
      path: filePath,
      name: filePath.split('/').pop(),
      status: code,
      statusLabel: { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' }[code] || status,
      isBinary: /^[0-9a-f]{40,64}$/.test(status),
    });
  }
  return files;
}

async function patchFor(repo, sha, { context = 3 } = {}) {
  const raw = await gitBuffer(repo.path, [
    'show', '--patch', '--no-color', `--unified=${context}`,
    '--find-renames', '--format=', sha,
  ], { maxBuffer: 16 * 1024 * 1024 }).catch(() => Buffer.alloc(0));

  return parsePatch(raw.toString('utf8'));
}

/** Split a unified diff into per-file structures the view can render. */
export function parsePatch(text) {
  const files = [];
  let current = null;
  let hunk = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        oldPath: match ? match[1] : line,
        newPath: match ? match[2] : line,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false,
        isNew: false,
        isDeleted: false,
      };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.isNew = true;
      current.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      current.isDeleted = true;
      current.status = 'deleted';
    } else if (line.startsWith('rename from') || line.startsWith('rename to')) {
      current.status = 'renamed';
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true;
    } else if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      hunk = {
        header: line,
        oldStart: match ? Number(match[1]) : 0,
        oldLines: match && match[2] ? Number(match[2]) : 1,
        newStart: match ? Number(match[3]) : 0,
        newLines: match && match[4] ? Number(match[4]) : 1,
        section: match ? match[5].trim() : '',
        lines: [],
      };
      current.hunks.push(hunk);
    } else if (hunk) {
      const kind = line[0];
      if (kind === '+') {
        hunk.lines.push({ type: 'add', text: line.slice(1) });
        current.additions += 1;
      } else if (kind === '-') {
        hunk.lines.push({ type: 'del', text: line.slice(1) });
        current.deletions += 1;
      } else if (kind === ' ' || line === '') {
        hunk.lines.push({ type: 'ctx', text: line.slice(1) });
      } else if (line.startsWith('\\')) {
        hunk.lines.push({ type: 'meta', text: line.slice(1) });
      }
    }
  }

  return { files, truncated: text.length > 8 * 1024 * 1024 };
}

/* ---------------------------------------------------------------- search */

/**
 * Full-text search across the tree of a ref using `git grep`.
 * The pattern is passed as its own argument, never interpolated into a shell.
 */
export async function search(repo, ref, term, { limit = 100, caseSensitive = false, regex = false } = {}) {
  const needle = String(term || '').trim();
  if (!needle) throw new ValidationError('a search term is required');
  if (needle.length > 200) throw new ValidationError('search term is too long');

  const cacheKey = keyed(repo, 'search', ref, needle, limit, caseSensitive, regex);
  return cache.wrap(cacheKey, async () => {
    const args = ['grep', '-n', '-I', '--full-name'];
    // `git grep` is case sensitive by default; `-i` relaxes it.
    if (!caseSensitive) args.push('-i');
    if (!regex) args.push('-F');
    args.push('--max-count=20', '-e', needle, ref, '--');

    let raw;
    try {
      raw = await gitBuffer(repo.path, args, { maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      // git grep exits 1 when there are no matches - that is not an error.
      if (error.code === 1 || /no matches|exit code 1/i.test(error.message)) {
        return { term: needle, ref, results: [], truncated: false, total: 0 };
      }
      throw error;
    }

    const results = [];
    // When a rev is given, git prefixes every hit with "<rev>:", so the
    // prefix has to come off before the path can be parsed.
    const prefix = `${ref}:`;
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line) continue;
      const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const match = body.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;
      const [, filePath, lineNo, text] = match;
      const index = text.toLowerCase().indexOf(needle.toLowerCase());
      results.push({
        path: filePath,
        line: Number(lineNo),
        text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
        matchIndex: index,
        matchLength: needle.length,
        language: languageFor(filePath),
      });
      if (results.length >= limit) break;
    }

    return {
      term: needle,
      ref,
      results,
      truncated: results.length >= limit,
      total: results.length,
    };
  });
}

/* --------------------------------------------------------------- archive */

const ARCHIVE_FORMATS = {
  'tar.gz': { gitFormat: 'tar.gz', ext: 'tar.gz', mime: 'application/gzip' },
  tgz: { gitFormat: 'tar.gz', ext: 'tar.gz', mime: 'application/gzip' },
  tar: { gitFormat: 'tar', ext: 'tar', mime: 'application/x-tar' },
  zip: { gitFormat: 'zip', ext: 'zip', mime: 'application/zip' },
};

export function archiveFormat(name) {
  return ARCHIVE_FORMATS[String(name || '').toLowerCase()] || ARCHIVE_FORMATS['tar.gz'];
}

/**
 * Spawn `git archive` and pipe the binary output straight to `destination`,
 * so a large repository never has to be buffered in memory.
 */
export function archiveStream(repo, ref, destination, { format = 'tar.gz' } = {}) {
  const target = archiveFormat(format);
  const args = [
    'archive', `--format=${target.gitFormat}`,
    ref,
    `--prefix=${repo.name}/`,
    '--',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.git.binary, args, {
      cwd: repo.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });

    child.stdout.on('error', (error) => {
      child.kill('SIGKILL');
      reject(error);
    });
    child.on('error', (error) => reject(new GitError(error.message)));

    child.stdout.pipe(destination);

    destination.on('error', (error) => {
      child.kill('SIGKILL');
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) resolve(target);
      else reject(new GitError(stderr.trim() || `git archive exited with ${code}`, { code }));
    });
  });
}

export { languageFor, isMarkdown, isReadme, formatBytes };
export { cache };
