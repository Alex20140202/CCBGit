import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../../config.js';
import { git } from './git.js';
import { templateFiles } from './requests.js';
import { ValidationError, isInside } from './validate.js';
import * as registry from './repos.js';

/**
 * Where approved repositories are created. The requirement is that this is a
 * fixed directory, so the first configured root is used and nothing else.
 */
export function targetRoot() {
  const root = config.repoRoots[0];
  if (!root) throw new ValidationError('no REPO_ROOTS configured, cannot create repositories');
  return root;
}

/**
 * Resolve a validated repository name to an absolute path inside the target
 * root, refusing anything that would land outside it.
 */
export function resolveTarget(name) {
  const root = targetRoot();
  const dir = path.resolve(root, name);

  if (path.dirname(dir) !== path.resolve(root)) {
    throw new ValidationError('repository name resolves outside the target directory');
  }
  if (!isInside(root, dir) || dir === path.resolve(root)) {
    throw new ValidationError('repository name resolves outside the target directory');
  }
  return { root, dir };
}

export async function exists(name) {
  try {
    await fs.stat(resolveTarget(name).dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the repository: `git init`, optional template files, an initial
 * commit, and a description an admin can edit later via `.git/description`.
 */
export async function create({ name, description, template, author }) {
  const { dir } = resolveTarget(name);

  if (await exists(name)) {
    throw new ValidationError(`repos/${name} already exists on disk`);
  }

  await fs.mkdir(dir, { recursive: true });

  const env = {
    GIT_AUTHOR_NAME: author.displayName || author.username,
    GIT_AUTHOR_EMAIL: author.email || `${author.username}@localhost`,
    GIT_COMMITTER_NAME: author.displayName || author.username,
    GIT_COMMITTER_EMAIL: author.email || `${author.username}@localhost`,
  };

  const run = (args) => git(dir, args, { env });

  try {
    await run(['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(dir, '.git', 'description'), `${description || name}\n`, 'utf8');

    const files = templateFiles(template, name);
    for (const [file, content] of files) {
      const target = path.join(dir, file);
      // templateFiles returns fixed literals, but re-check anyway: this is the
      // last point before a write with user-influenced data.
      if (!isInside(dir, path.resolve(target))) {
        throw new ValidationError(`refusing to write outside the repository: ${file}`);
      }
      await fs.writeFile(target, content, 'utf8');
    }

    await run(['add', '-A']);
    await run(['commit', '-q', '--allow-empty', '-m', `Initial commit from CCBGit`]);

    // Default to not tracking anything unexpected if a template wrote a
    // .gitignore; everything created above is already committed.
  } catch (error) {
    // Do not leave a half-built directory behind for the next attempt to trip
    // over.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // Make the new repository browsable immediately.
  await registry.scan();

  const record = registry.resolve(`/${path.basename(targetRoot())}/${name}`);
  return { name, path: dir, id: registry.identifierOf(record) };
}
