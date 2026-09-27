import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../../config.js';
import { ValidationError, NotFoundError } from './validate.js';
import { languageFor } from './languages.js';

/**
 * Repository name rules.
 *
 * This is the input that decides where on disk a directory gets created, so it
 * is deliberately narrow: a single path segment, no traversal, no leading
 * dash (which git would read as an option), and no characters that are awkward
 * in a URL or a shell.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,48}$/;
const RESERVED = new Set(['.', '..', 'new', 'login', 'logout', 'register', 'admin', 'api', 'static']);

/**
 * Device names Windows refuses to create. macOS and Linux accept them happily,
 * so a repository named "con" would be created here and then break the moment
 * the volume is shared or the project is cloned elsewhere.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const NAME_RULES = [
  '2-49 characters',
  'letters, digits, dot, dash and underscore only',
  'must start with a letter or digit',
  'no path separators, and not a reserved word',
];

export function assertRepoRequestName(input) {
  const name = String(input || '').trim();

  if (!name) throw new ValidationError('a repository name is required');
  if (name.length > 49) throw new ValidationError('repository name is too long');
  if (name.includes('/') || name.includes('\\')) {
    throw new ValidationError('repository name cannot contain a path separator');
  }
  if (name.includes('..')) throw new ValidationError('repository name cannot contain ".."');
  if (name.startsWith('-')) throw new ValidationError('repository name cannot start with a dash');
  if (name !== name.trim()) throw new ValidationError('repository name has leading or trailing whitespace');
  if (RESERVED.has(name.toLowerCase())) {
    throw new ValidationError(`"${name}" is reserved, pick another name`);
  }
  if (WINDOWS_DEVICE.test(name)) {
    throw new ValidationError(`"${name}" is a reserved device name on Windows`);
  }
  if (!NAME_RE.test(name)) throw new ValidationError('repository name has characters that are not allowed');

  return name;
}

function storeFile() {
  return path.join(config.auth.dataDir, 'requests.json');
}

let cache = { at: 0, value: [] };

async function readAll() {
  if (Date.now() - cache.at < 3000 && cache.value) return cache.value;
  let entries = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    entries = Array.isArray(parsed.requests) ? parsed.requests : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot read requests store: ${error.message}`);
  }
  cache = { at: Date.now(), value: entries };
  return entries;
}

async function writeAll(entries) {
  await fsp.mkdir(config.auth.dataDir, { recursive: true });
  const temp = `${storeFile()}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify({ requests: entries }, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, storeFile());
  cache = { at: Date.now(), value: entries };
}

export function invalidate() {
  cache = { at: 0, value: null };
}

/** File extensions offered as a starting point when creating a repository. */
const TEMPLATES = [
  { id: 'empty', label: 'Empty repository', files: () => [] },
  {
    id: 'node',
    label: 'Node.js project',
    files: () => [
      ['package.json', '{\n  "name": "NAME",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": {}\n}\n'],
      ['.gitignore', 'node_modules/\n*.log\n.DS_Store\n'],
      ['README.md', '# NAME\n\nDescribe the project here.\n'],
    ],
  },
  {
    id: 'python',
    label: 'Python project',
    files: () => [
      ['README.md', '# NAME\n\nDescribe the project here.\n'],
      ['.gitignore', '__pycache__/\n*.py[cod]\n.venv/\n'],
      ['main.py', 'def main() -> None:\n    print("hello")\n\n\nif __name__ == "__main__":\n    main()\n'],
    ],
  },
  {
    id: 'notes',
    label: 'Notes / documentation',
    files: () => [
      ['README.md', '# NAME\n\nDescribe the project here.\n'],
    ],
  },
];

export const templates = TEMPLATES.map(({ id, label }) => ({ id, label }));

function assertTemplate(id) {
  const wanted = String(id || 'empty');
  if (!TEMPLATES.some((template) => template.id === wanted)) {
    throw new ValidationError('unknown starting template');
  }
  return wanted;
}

/** Submit a request. Returns the stored record. */
export async function submit({ name, description, template, requestedBy }) {
  const repoName = assertRepoRequestName(name);
  const templateId = assertTemplate(template);
  const entries = await readAll();

  const taken = entries.find(
    (entry) => entry.name.toLowerCase() === repoName.toLowerCase() && entry.status !== 'rejected',
  );
  if (taken) {
    throw new ValidationError(
      taken.status === 'pending'
        ? `"${repoName}" already has a request awaiting review`
        : `"${repoName}" already exists`,
    );
  }

  const record = {
    id: crypto.randomUUID(),
    name: repoName,
    description: String(description || '').trim().slice(0, 200),
    template: templateId,
    status: 'pending',
    requestedBy: requestedBy.username,
    requestedByName: requestedBy.displayName,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    note: '',
  };

  await writeAll([...entries, record]);
  return record;
}

export async function list({ status, requestedBy } = {}) {
  let entries = await readAll();
  if (status) entries = entries.filter((entry) => entry.status === status);
  if (requestedBy) entries = entries.filter((entry) => entry.requestedBy === requestedBy);

  // Pending first, then newest.
  const rank = { pending: 0, approved: 1, rejected: 2 };
  return [...entries].sort((a, b) => {
    const order = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    return order !== 0 ? order : b.createdAt.localeCompare(a.createdAt);
  });
}

export async function get(id) {
  const entries = await readAll();
  const record = entries.find((entry) => entry.id === id);
  if (!record) throw new NotFoundError('no such request');
  return record;
}

/** Mark a request approved or rejected. */
export async function decide(id, status, decidedBy, note = '') {
  if (!['approved', 'rejected'].includes(status)) {
    throw new ValidationError('a decision must be approved or rejected');
  }
  const entries = await readAll();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) throw new NotFoundError('no such request');
  if (entries[index].status !== 'pending') {
    throw new ValidationError(`this request was already ${entries[index].status}`);
  }

  entries[index] = {
    ...entries[index],
    status,
    decidedAt: new Date().toISOString(),
    decidedBy: decidedBy.username,
    note: String(note || '').trim().slice(0, 200),
  };
  await writeAll(entries);
  return entries[index];
}

/** The files a template would create, with NAME substituted. */
export function templateFiles(templateId, name) {
  const template = TEMPLATES.find((entry) => entry.id === templateId) || TEMPLATES[0];
  return template.files().map(([file, content]) => [file, content.split('NAME').join(name)]);
}

export { languageFor };
