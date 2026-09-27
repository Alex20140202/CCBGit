import path from 'node:path';
import fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import config from '../../config.js';
import { NotFoundError } from './validate.js';

/**
 * Who may write to which repository.
 *
 * Reading is open to any signed-in user; writing is not. A repository can be
 * pushed to by the account that requested it and by administrators, and by
 * nobody else. Ownership is recorded when a request is approved, so the rule
 * survives a restart and does not depend on directory names.
 */

const storeFile = () => path.join(config.auth.dataDir, 'owners.json');

let cache = { at: 0, value: {} };
const TTL = 5000;

async function read() {
  if (Date.now() - cache.at < TTL && cache.value) return cache.value;
  let owners = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    owners = parsed.owners && typeof parsed.owners === 'object' ? parsed.owners : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`cannot read ownership store: ${error.message}`);
    }
  }
  cache = { at: Date.now(), value: owners };
  return owners;
}

async function write(owners) {
  await fsp.mkdir(config.auth.dataDir, { recursive: true });
  const temp = `${storeFile()}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify({ owners }, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, storeFile());
  cache = { at: Date.now(), value: owners };
}

/** Record `username` as the owner of the repository called `name`. */
export async function setOwner(name, username) {
  const owners = { ...(await read()) };
  owners[name] = { username, at: new Date().toISOString() };
  await write(owners);
}

/** The account that owns a repository, or null if nobody claimed it. */
export async function ownerOf(name) {
  const owners = await read();
  return owners[name] ? owners[name].username : null;
}

export async function allOwners() {
  return { ...(await read()) };
}

/** Release a claim. Used when a repository disappears from disk. */
export async function clearOwner(name) {
  const owners = { ...(await read()) };
  if (!(name in owners)) return;
  delete owners[name];
  await write(owners);
}

/**
 * May this user push to this repository?
 *
 * Administrators may write anywhere. Otherwise the repository must have an
 * owner and it must be this user: an unclaimed repository (for example one of
 * the seeded samples) is read-only until somebody claims it.
 */
export async function canWrite(user, repo) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const owner = await ownerOf(repo.name);
  return owner !== null && owner === user.username;
}

/** Convenience for views: a plain yes/no plus the owning username. */
export async function writeAccess(user, repo) {
  const owner = await ownerOf(repo.name);
  return {
    canWrite: await canWrite(user, repo),
    owner,
    unclaimed: owner === null,
  };
}

/** Why a push was refused, for a message the client can actually read. */
export async function explainWriteDenial(user, repo) {
  if (!user) return 'authentication required';
  const owner = await ownerOf(repo.name);
  if (user.role === 'admin') return null;
  if (owner === null) {
    return `repository "${repo.name}" is not claimed by anyone, so it is read-only; `
      + 'an administrator can assign it to you';
  }
  if (owner !== user.username) {
    return `you do not have write access to "${repo.name}"`;
  }
  return null;
}

export { NotFoundError, fs };
