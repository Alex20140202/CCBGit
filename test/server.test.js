import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/**
 * Build a throwaway git repository in a temp directory and point the server at
 * it. Doing this here rather than against ./repos keeps the suite hermetic.
 */
function makeFixtureRepo(base) {
  const dir = path.join(base, 'acme', 'widget');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, '.git', 'description'), 'A widget library.\n');

  fs.writeFileSync(path.join(dir, 'README.md'), '# Widget\n\nHello <script>alert(1)</script>\n');
  fs.writeFileSync(path.join(dir, 'src/index.js'), 'export const answer = 42;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');

  fs.writeFileSync(path.join(dir, 'src/extra.js'), 'export const extra = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add extra module');

  git('tag', 'v1.0.0');
  git('checkout', '-q', '-b', 'feature/more');
  fs.writeFileSync(path.join(dir, 'src/more.js'), 'export const more = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add more module');
  git('checkout', '-q', 'main');

  return dir;
}

let server;
let baseUrl;
let tmp;
let cookie = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-test-'));
  makeFixtureRepo(tmp);

  process.env.REPO_ROOTS = tmp;
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.SESSION_SECRET = 'test-secret-value-for-deterministic-sessions';
  process.env.CACHE_TTL = '0'; // always fresh, so tests cannot see stale data
  process.env.SITE_TITLE = 'TestGit';

  const { createApp, bootstrap } = await import('../server/app.js');
  await bootstrap({ silent: true });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Everything behind the login gate, so register the first account: it becomes
  // the administrator.
  await rawRequest('GET', '/register');
  const csrf = await readCsrf('/register');
  await rawRequest('POST', '/register', {
    _csrf: csrf,
    username: 'tester',
    password: 'a-good-long-password',
    displayName: 'Test Admin',
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fetch without attaching the session cookie, and remember any it sets. */
async function rawRequest(method, route, fields, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (cookie) headers.cookie = cookie;
  if (fields) headers['content-type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(baseUrl + route, {
    method,
    headers,
    body: fields ? new URLSearchParams(fields).toString() : undefined,
    redirect: 'manual',
  });

  for (const line of response.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    if (pair.startsWith('ccbgit_session=') && !pair.endsWith('=')) cookie = pair;
  }
  return response;
}

async function readCsrf(route) {
  const body = await (await rawRequest('GET', route)).text();
  return (body.match(/name="_csrf" value="([^"]+)"/) || [])[1] || '';
}

// Redirects are never followed, so the redirect *is* the assertion in the
// test that checks one.
const get = (route) => rawRequest('GET', route);
const text = async (route) => (await rawRequest('GET', route)).text();
const json = async (route) => (await rawRequest('GET', route)).json();

/** Owner is the immediate parent directory name of the repository. */
const REPO = '/acme/widget';

describe('index', () => {
  test('lists the discovered repository', async () => {
    const body = await text('/');
    assert.match(body, /widget/);
    assert.match(body, /A widget library/);
  });

  test('filters by query', async () => {
    assert.match(await text('/?q=widget'), /widget/);
    assert.match(await text('/?q=does-not-exist'), /Nothing found/);
  });

  test('serves the JSON api', async () => {
    const data = await json('/api/repos');
    assert.equal(data.total, 1);
    assert.equal(data.items[0].name, 'widget');
  });
});

describe('repository pages', () => {
  test('home page lists the file tree and readme', async () => {
    const body = await text(REPO);
    assert.match(body, /README\.md/);
    assert.match(body, /class="tree-row"/);
    assert.match(body, /Widget/); // rendered README heading
  });

  test('readme raw HTML is escaped, not executed', async () => {
    const body = await text(`${REPO}/blob/main/README.md`);
    assert.equal(body.includes('<script>alert(1)</script>'), false);
  });

  test('blob view highlights source and numbers lines', async () => {
    const body = await text(`${REPO}/blob/main/src/index.js`);
    assert.match(body, /hljs-number/); // 42
    assert.match(body, /code-gutter/);
  });

  test('directory view lists its children', async () => {
    const body = await text(`${REPO}/tree/main/src`);
    assert.match(body, /index\.js/);
    assert.match(body, /extra\.js/);
  });

  test('asking for a file as a directory redirects to the blob view', async () => {
    // fetch follows redirects by default; here the redirect *is* the assertion.
    const response = await get(`${REPO}/tree/main/README.md`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /\/blob\/main\/README\.md$/);
  });

  test('the push command points at the directory on disk', async () => {
    const body = await text(REPO);
    assert.match(body, /git push [^<]*acme[/\\]widget/);
    // The site must not advertise an HTTP git endpoint it does not serve.
    assert.equal(/acme\/widget\.git/.test(body), false);
  });
});

describe('history', () => {
  test('commit list', async () => {
    const body = await text(`${REPO}/commits`);
    assert.match(body, /Add extra module/);
    assert.match(body, /Initial commit/);
  });

  test('commit list scoped to a path', async () => {
    const body = await text(`${REPO}/commits?path=src/extra.js`);
    assert.match(body, /Add extra module/);
    assert.equal(body.includes('Initial commit'), false);
  });

  test('commit detail renders a diff', async () => {
    const body = await text(`${REPO}/commit/HEAD`);
    // HEAD on main is the commit that adds src/extra.js.
    assert.match(body, /diff-hunk/);
    assert.match(body, /Add extra module/);
    assert.match(body, /extra\.js/);
  });

  test('commit detail for a short sha', async () => {
    const list = await json(`/api/repos/acme/widget/commits?ref=main`);
    const sha = list.items[0].shortSha;
    const response = await get(`${REPO}/commit/${sha}`);
    assert.equal(response.status, 200);
  });

  test('compare two refs', async () => {
    const body = await text(`${REPO}/compare/main...feature/more`);
    assert.match(body, /more\.js/);
  });

  test('compare identical refs', async () => {
    const body = await text(`${REPO}/compare/main...main`);
    assert.match(body, /same commit/);
  });

  test('branch and tag are both browsable', async () => {
    assert.equal((await get(`${REPO}?ref=feature/more`)).status, 200);
    assert.equal((await get(`${REPO}/blob/v1.0.0/README.md`)).status, 200);
  });
});

describe('search', () => {
  test('finds a literal match and marks it', async () => {
    const body = await text(`${REPO}/search?q=extra`);
    assert.match(body, /<mark>extra<\/mark>/);
    assert.match(body, /src\/extra\.js/);
  });

  test('reports no matches without failing', async () => {
    const body = await text(`${REPO}/search?q=zzzznotpresent`);
    assert.match(body, /No matches/);
  });

  test('an empty query renders the prompt, not an error', async () => {
    assert.match(await text(`${REPO}/search`), /Search this repository/);
  });
});

describe('downloads', () => {
  test('raw file', async () => {
    const response = await get(`${REPO}/raw/main/src/index.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer = 42/);
  });

  test('tar.gz archive', async () => {
    const response = await get(`${REPO}/archive/tar.gz`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment; filename=/);
    const bytes = Buffer.from(await response.arrayBuffer());
    // gzip magic number
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
  });

  test('zip archive', async () => {
    const response = await get(`${REPO}/archive/zip`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  });
});

describe('api', () => {
  test('status', async () => {
    const data = await json('/api/status');
    assert.equal(data.ok, true);
    assert.equal(data.repositories, 1);
    assert.match(data.git, /git version/);
  });

  test('metadata includes the on-disk path and commit counts', async () => {
    const data = await json('/api/repos/acme/widget');
    assert.equal(data.meta.commitCount, 2);
    assert.equal(data.meta.branchCount, 2);
    assert.equal(data.meta.tagCount, 1);
    // The push target is the directory on disk, not an HTTP git endpoint.
    assert.match(data.meta.cloneUrls.local, /acme\/widget$/);
  });

  test('refs', async () => {
    const data = await json(`/api/repos/acme/widget/refs`);
    assert.deepEqual(
      data.branches.map((b) => b.name).sort(),
      ['feature/more', 'main'],
    );
    assert.deepEqual(data.tags.map((t) => t.name), ['v1.0.0']);
  });

  test('tree', async () => {
    const data = await json(`/api/repos/acme/widget/tree?ref=main&path=src`);
    assert.deepEqual(data.entries.map((e) => e.name), ['extra.js', 'index.js']);
  });

  test('tree at the repository root', async () => {
    const data = await json(`/api/repos/acme/widget/tree?ref=main`);
    // Directories are listed before files.
    assert.deepEqual(data.entries.map((e) => e.name), ['src', 'README.md']);
    assert.equal(data.entries.find((e) => e.name === 'src').isDir, true);
  });

  test('tree for a file reports isFile rather than listing', async () => {
    const data = await json(`/api/repos/acme/widget/tree?ref=main&path=README.md`);
    assert.equal(data.isFile, true);
  });

  test('blob', async () => {
    const data = await json(`/api/repos/acme/widget/blob?ref=main&path=src/index.js`);
    assert.match(data.content, /answer = 42/);
    assert.equal(data.language, 'javascript');
  });

  test('languages', async () => {
    const data = await json(`/api/repos/acme/widget/languages?ref=main`);
    assert.ok(data.languages.length > 0);
    assert.ok(data.languages.some((l) => l.language === 'javascript'));
  });

  test('refresh endpoint', async () => {
    // A JSON call carries the CSRF token in a header, not a form field.
    const csrf = await readCsrf('/');
    const response = await rawRequest('POST', '/api/repos/refresh', undefined, { 'x-csrf-token': csrf });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).count, 1);
  });

  test('a state-changing POST without the token is refused', async () => {
    const response = await rawRequest('POST', '/api/repos/refresh');
    assert.equal(response.status, 403);
  });

  test('unknown endpoint is a 404 json', async () => {
    const response = await get('/api/nope');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.status, 404);
    assert.equal(typeof body.error, 'string');
  });
});

describe('error handling', () => {
  test('unknown repository is a 404 page', async () => {
    const response = await get('/nope/missing');
    assert.equal(response.status, 404);
    assert.match(await response.text(), /Not found/);
  });

  test('unknown ref is a 404, not a 500', async () => {
    const response = await get(`${REPO}?ref=no-such-branch`);
    assert.equal(response.status, 404);
  });

  test('unknown path inside a repository is a 404', async () => {
    const response = await get(`${REPO}/blob/main/nope.js`);
    assert.equal(response.status, 404);
  });

  test('stack traces are not exposed to clients by default', async () => {
    const body = await text('/nope/missing');
    assert.equal(body.includes('at Object.'), false);
    assert.equal(body.includes('node:internal'), false);
  });
});

describe('hostile input', () => {
  test('path traversal cannot escape the repository', async () => {
    for (const target of [
      `${REPO}/raw/main/../../../../etc/passwd`,
      `${REPO}/blob/main/..%2F..%2F..%2Fetc%2Fpasswd`,
      `${REPO}/tree/main/../../../../etc`,
    ]) {
      const response = await get(target);
      assert.ok(response.status === 400 || response.status === 404, `${target} -> ${response.status}`);
      const body = await response.text();
      assert.equal(body.includes('root:x:'), false, `${target} leaked /etc/passwd`);
    }
  });

  test('option-like refs are rejected', async () => {
    for (const ref of ['--upload-pack=evil', 'main..HEAD', 'HEAD^', '-x']) {
      const response = await get(`${REPO}?ref=${encodeURIComponent(ref)}`);
      assert.ok(response.status === 400 || response.status === 404, `${ref} -> ${response.status}`);
    }
  });

  test('a search term cannot become a git option', async () => {
    const response = await get(`${REPO}/search?q=${encodeURIComponent('--all')}`);
    // Either a clean "no matches" or a rejection - never a repository listing.
    const body = await response.text();
    assert.equal(body.includes('/etc/'), false);
    assert.ok([200, 400, 404].includes(response.status));
  });

  test('an absurdly long search term is rejected', async () => {
    const response = await get(`${REPO}/search?q=${'a'.repeat(500)}`);
    assert.equal(response.status, 400);
  });

  test('security headers are present', async () => {
    const response = await get('/');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});

describe('bare repositories', () => {
  test('a bare repository is indexed and browsable', async () => {
    // git refuses to push into a checked-out branch, so a bare repository is
    // the only layout you can actually push to. It has no .git directory, which
    // is why discovery has to recognise the HEAD/objects/refs layout.
    const bare = path.join(tmp, 'acme', 'pushed');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-push-'));
    execFileSync('git', ['init', '-q', '-b', 'main', scratch]);
    fs.writeFileSync(path.join(scratch, 'README.md'), '# Pushed\n\nFrom a real push.\n');
    execFileSync('git', ['add', '-A'], { cwd: scratch });
    execFileSync('git', [
      '-c', 'user.name=Push', '-c', 'user.email=push@example.com',
      'commit', '-q', '-m', 'pushed a file',
    ], { cwd: scratch });
    execFileSync('git', ['push', '-q', bare, 'main'], { cwd: scratch });

    const csrf = await readCsrf('/');
    const refreshed = await rawRequest('POST', '/api/repos/refresh', undefined, { 'x-csrf-token': csrf });
    assert.equal(refreshed.status, 200);
    assert.ok(
      (await refreshed.json()).names.some((entry) => entry.name === 'pushed'),
      'the bare repository should appear in the index',
    );

    const meta = await json('/api/repos/acme/pushed/meta');
    assert.equal(meta.bare, true);

    assert.equal((await get('/acme/pushed')).status, 200);
    const blob = await json('/api/repos/acme/pushed/blob?ref=main&path=README.md');
    assert.match(blob.content, /From a real push/);

    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('a rescan surfaces content pushed since the last read', async () => {
    // The rescan used to rebuild the repository list but leave every cached
    // tree and blob pointing at the previous state, so the button did nothing
    // until the TTL expired. The suite runs with CACHE_TTL=0, so this asserts
    // that refresh() is what makes new state visible.
    const target = path.join(tmp, 'acme', 'widget');
    const before = await json('/api/repos/acme/widget/commits?ref=main');

    // Clone first: pushing unrelated history would be rejected as
    // non-fast-forward. The target is a worktree repository, so git refuses to
    // update the branch it has checked out unless this is set - the same
    // setting a real deployment needs.
    execFileSync('git', ['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: target });

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-rescan-'));
    execFileSync('git', ['clone', '-q', target, scratch]);
    execFileSync('git', ['config', 'user.name', 'Push'], { cwd: scratch });
    execFileSync('git', ['config', 'user.email', 'push@example.com'], { cwd: scratch });
    fs.writeFileSync(path.join(scratch, 'added.md'), '# Added later\n');
    execFileSync('git', ['add', '-A'], { cwd: scratch });
    execFileSync('git', ['commit', '-q', '-m', 'a brand new commit'], { cwd: scratch });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: scratch });

    const csrf = await readCsrf('/');
    const refreshed = await rawRequest('POST', '/api/repos/refresh', undefined, { 'x-csrf-token': csrf });
    assert.equal(refreshed.status, 200);

    const after = await json('/api/repos/acme/widget/commits?ref=main');
    assert.equal(after.items.length, before.items.length + 1);
    assert.equal(after.items[0].subject, 'a brand new commit');

    const blob = await json('/api/repos/acme/widget/blob?ref=main&path=added.md');
    assert.match(blob.content, /Added later/);

    fs.rmSync(scratch, { recursive: true, force: true });
  });
});

describe('static assets', () => {
  test('stylesheet and scripts are served', async () => {
    assert.equal((await get('/css/style.css')).status, 200);
    assert.equal((await get('/js/app.js')).status, 200);
  });
});
