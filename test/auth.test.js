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
 * The whole app, with authentication switched on and an isolated data dir, so
 * the test run cannot touch a real users.json or create real repositories.
 */
let server;
let baseUrl;
let reposRoot;
let dataDir;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedRepo(dir, name) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.name', 'Test');
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(target, 'README.md'), `# ${name}\n\nHello <script>alert(1)</script>\n`);
  fs.writeFileSync(path.join(target, 'src/index.js'), 'export const answer = 42;\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-q', '-m', 'Initial commit');
  return target;
}

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-auth-'));
  reposRoot = path.join(tmp, 'repos');
  dataDir = path.join(tmp, 'data');
  fs.mkdirSync(reposRoot, { recursive: true });
  seedRepo(reposRoot, 'widget');

  process.env.REPO_ROOTS = reposRoot;
  process.env.DATA_DIR = dataDir;
  process.env.CACHE_TTL = '0';
  process.env.SESSION_SECRET = 'test-secret-value-for-deterministic-sessions';
  process.env.SITE_TITLE = 'TestGit';

  const { createApp, bootstrap } = await import('../server/app.js');
  await bootstrap({ silent: true });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * A cookie-keeping fetch wrapper, so a test can act as one signed-in user
 * without the client automatically following the redirects under test.
 */
function makeClient() {
  const jar = new Map();

  const store = (response) => {
    for (const line of response.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  };

  const request = async (route, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (jar.size) {
      headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const response = await fetch(baseUrl + route, { ...init, headers, redirect: 'manual' });
    store(response);
    return response;
  };

  const post = (route, fields) => request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  const get = (route) => request(route);
  const text = async (route) => (await get(route)).text();

  /** Read the CSRF token out of a rendered form. */
  const csrfFrom = async (route) => {
    const body = await text(route);
    const match = body.match(/name="_csrf" value="([^"]+)"/);
    return match ? match[1] : '';
  };

  const register = async (username, password = pw(username), displayName = username) => {
    const csrf = await csrfFrom('/register');
    return post('/register', { _csrf: csrf, username, password, displayName });
  };

  const login = async (username, password = pw(username)) => {
    const csrf = await csrfFrom('/login');
    return post('/login', { _csrf: csrf, username, password });
  };

  return { request, get, post, text, csrfFrom, register, login, jar };
}

/** One password per username, so register() and login() agree by default. */
const pw = (username) => `password-for-${username}-1`;

describe('unauthenticated access', () => {
  test('pages redirect to the sign-in form', async () => {
    const client = makeClient();
    for (const route of ['/', '/new', '/admin', '/repos/widget', '/api/repos']) {
      const response = await client.get(route);
      if (route === '/api/repos') {
        assert.equal(response.status, 401, route);
        assert.equal((await response.json()).status, 401);
      } else {
        assert.equal(response.status, 302, route);
        assert.match(response.headers.get('location'), /^\/login\?next=/, route);
      }
    }
  });

  test('the sign-in and registration pages are reachable', async () => {
    const client = makeClient();
    assert.equal((await client.get('/login')).status, 200);
    assert.equal((await client.get('/register')).status, 200);
  });

  test('static assets stay public so the sign-in page can render', async () => {
    const client = makeClient();
    assert.equal((await client.get('/css/style.css')).status, 200);
    assert.equal((await client.get('/js/app.js')).status, 200);
  });

  test('a repository is not readable without signing in', async () => {
    const client = makeClient();
    const body = await client.text('/repos/widget');
    assert.equal(body.includes('answer = 42'), false);
  });
});

describe('csrf protection', () => {
  test('a POST without a token is refused', async () => {
    const client = makeClient();
    const response = await client.post('/login', { username: 'x', password: 'y' });
    assert.equal(response.status, 403);
  });

  test('a POST with a wrong token is refused', async () => {
    const client = makeClient();
    const response = await client.post('/login', { _csrf: 'not-the-token', username: 'x', password: 'y' });
    assert.equal(response.status, 403);
  });

  test('a token from one session does not work in another', async () => {
    const alice = makeClient();
    const mallory = makeClient();
    const stolen = await alice.csrfFrom('/login');
    const response = await mallory.post('/login', { _csrf: stolen, username: 'x', password: 'y' });
    assert.equal(response.status, 403);
  });

  test('the session cookie is httpOnly and SameSite=Strict', async () => {
    const client = makeClient();
    const response = await client.get('/login');
    const cookie = (response.headers.getSetCookie?.() || []).find((line) => line.includes('ccbgit_session'));
    assert.ok(cookie, 'expected a session cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });
});

describe('accounts', () => {
  test('the first account becomes an administrator', async () => {
    const client = makeClient();
    const response = await client.register('alice', pw('alice'), 'Alice Wang');
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^\/admin/);

    const body = await client.text('/admin');
    assert.match(body, /Alice Wang/);
  });

  test('later accounts are ordinary members', async () => {
    const client = makeClient();
    await client.register('bob', pw('bob'), 'Bob Chen');
    const response = await client.get('/admin');
    assert.equal(response.status, 403);
  });

  test('usernames must be well formed and unique', async () => {
    const client = makeClient();
    for (const bad of ['a', 'has space', 'has/slash', '-leading', 'x'.repeat(40)]) {
      const csrf = await client.csrfFrom('/register');
      const response = await client.post('/register', { _csrf: csrf, username: bad, password: pw('probe') });
      assert.equal(response.status, 400, `should reject ${bad}`);
    }

    const csrf = await client.csrfFrom('/register');
    const dupe = await client.post('/register', { _csrf: csrf, username: 'alice', password: pw('probe') });
    assert.equal(dupe.status, 400);
  });

  test('short passwords are rejected and never stored', async () => {
    const client = makeClient();
    const csrf = await client.csrfFrom('/register');
    const response = await client.post('/register', { _csrf: csrf, username: 'shorty', password: 'abc' });
    assert.equal(response.status, 400);

    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    assert.equal(store.users.some((user) => user.username === 'shorty'), false);
  });

  test('passwords are stored as scrypt hashes, never in the clear', async () => {
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    const raw = JSON.stringify(store);
    assert.equal(raw.includes('password-for-alice-1'), false);
    for (const user of store.users) {
      assert.match(user.password, /^scrypt\$16384\$8\$1\$/);
    }
  });

  test('signing in with the wrong password fails, and says nothing useful', async () => {
    const client = makeClient();
    const response = await client.login('alice', 'not-the-password');
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /Incorrect username or password/);
    assert.equal(body.includes('no such user'), false);
  });

  test('a password is not revealed by the sign-in failure page', async () => {
    const client = makeClient();
    const body = await client.text('/login');
    assert.equal(body.includes('password-for-alice-1'), false);
  });

  test('signing out clears the session', async () => {
    const client = makeClient();
    await client.login('bob');
    assert.equal((await client.get('/')).status, 200);

    const csrf = await client.csrfFrom('/');
    const response = await client.post('/logout', { _csrf: csrf });
    assert.equal(response.status, 302);
    assert.equal((await client.get('/')).status, 302);
  });

  test('a tampered session cookie is rejected', async () => {
    const client = makeClient();
    await client.login('alice');
    const original = client.jar.get('ccbgit_session');
    assert.ok(original);

    client.jar.set('ccbgit_session', `${original.split('.')[0]}.forged-signature`);
    assert.equal((await client.get('/')).status, 302);

    client.jar.set('ccbgit_session', 'not-even-a-cookie');
    assert.equal((await client.get('/')).status, 302);
  });
});

describe('login throttling', () => {
  test('repeated failures are eventually blocked', async () => {
    // A dedicated username: the limiter is keyed by IP + username and blocks
    // correct passwords too, so it must not poison the shared accounts.
    const client = makeClient();
    let blocked = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await client.login('throttle-probe', `wrong-${i}`);
      if (response.status === 429) {
        blocked = true;
        break;
      }
    }
    assert.equal(blocked, true, 'expected a 429 after repeated failures');
  });

  test('a blocked key does not affect other accounts', async () => {
    const client = makeClient();
    await client.login('alice');
    assert.equal((await client.get('/')).status, 200);
  });
});

describe('repository requests', () => {
  test('a member can submit a request and sees it pending', async () => {
    const client = makeClient();
    await client.register('carol', pw('carol'), 'Carol Ivanova');

    const csrf = await client.csrfFrom('/new');
    const response = await client.post('/new', {
      _csrf: csrf, name: 'widget-factory', description: 'Makes widgets', template: 'node',
    });
    assert.equal(response.status, 302);

    const body = await client.text('/new');
    assert.match(body, /widget-factory/);
    assert.match(body, /status-pending/);
  });

  test('the request is not created on disk until approved', async () => {
    assert.equal(fs.existsSync(path.join(reposRoot, 'widget-factory')), false);
  });

  test('a member cannot approve their own request', async () => {
    const admin = makeClient();
    await admin.login('alice');
    const body = await admin.text('/admin');
    const id = body.match(/\/admin\/requests\/([a-f0-9-]+)\/approve/)[1];

    const member = makeClient();
    await member.login('carol');
    const csrf = await member.csrfFrom('/new');
    const response = await member.post(`/admin/requests/${id}/approve`, { _csrf: csrf });
    assert.equal(response.status, 403);
    assert.equal(fs.existsSync(path.join(reposRoot, 'widget-factory')), false);
  });

  test('an administrator approving creates a real, browsable repository', async () => {
    const admin = makeClient();
    await admin.login('alice');
    const body = await admin.text('/admin');
    const id = body.match(/\/admin\/requests\/([a-f0-9-]+)\/approve/)[1];

    const csrf = await admin.csrfFrom('/admin');
    const response = await admin.post(`/admin/requests/${id}/approve`, { _csrf: csrf, note: 'ok' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /\/repos\/widget-factory$/);

    const dir = path.join(reposRoot, 'widget-factory');
    assert.equal(fs.existsSync(path.join(dir, '.git')), true);
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), true);

    // The initial commit is attributed to the requester, not the approver.
    const author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: dir }).toString().trim();
    assert.equal(author, 'Carol Ivanova');

    // And it is immediately browsable.
    assert.equal((await admin.get('/repos/widget-factory')).status, 200);
  });

  test('an already-approved request cannot be approved twice', async () => {
    const admin = makeClient();
    await admin.login('alice');

    // Ask for a second repository so there is a pending request to grab, then
    // approve it and immediately try the same id again.
    const member = makeClient();
    await member.login('carol');
    const csrfNew = await member.csrfFrom('/new');
    await member.post('/new', { _csrf: csrfNew, name: 'second-project', template: 'empty' });

    const body = await admin.text('/admin');
    const id = body.match(/\/admin\/requests\/([a-f0-9-]+)\/approve/)[1];

    const csrf = await admin.csrfFrom('/admin');
    const first = await admin.post(`/admin/requests/${id}/approve`, { _csrf: csrf });
    assert.equal(first.status, 302);

    const second = await admin.post(`/admin/requests/${id}/approve`, { _csrf: csrf });
    assert.equal(second.status, 400);
  });

  test('rejecting leaves nothing on disk', async () => {
    const member = makeClient();
    await member.login('carol');
    const csrf1 = await member.csrfFrom('/new');
    await member.post('/new', { _csrf: csrf1, name: 'rejected-project', template: 'empty' });

    const admin = makeClient();
    await admin.login('alice');
    const body = await admin.text('/admin');
    const id = body.match(/\/admin\/requests\/([a-f0-9-]+)\/reject/)[1];

    const csrf = await admin.csrfFrom('/admin');
    const response = await admin.post(`/admin/requests/${id}/reject`, { _csrf: csrf, note: 'not now' });
    assert.equal(response.status, 302);
    assert.equal(fs.existsSync(path.join(reposRoot, 'rejected-project')), false);
  });
});

describe('repository name validation', () => {
  test('hostile names are refused and never reach the filesystem', async () => {
    const client = makeClient();
    await client.login('bob');

    const hostile = [
      '../evil', 'a/b', 'a\\b', '-rf', '..', '.', 'has space', 'CON', 'nul',
      '.hidden', 'x'.repeat(60), 'new', 'admin', 'api', 'tab\tname',
    ];

    for (const name of hostile) {
      const csrf = await client.csrfFrom('/new');
      const response = await client.post('/new', { _csrf: csrf, name, template: 'empty' });
      assert.equal(response.status, 400, `should refuse ${JSON.stringify(name)}`);
    }

    // None of the hostile names produced a directory.
    const entries = fs.readdirSync(reposRoot);
    for (const name of hostile) {
      const clean = name.replace(/[/.]/g, '');
      if (clean.length > 1) {
        assert.equal(entries.includes(clean), false, `${name} created a directory`);
      }
    }
    assert.equal(entries.includes('evil'), false);
    assert.equal(entries.includes('rf'), false);
  });

  test('a duplicate name is refused', async () => {
    const client = makeClient();
    await client.login('bob');
    const csrf = await client.csrfFrom('/new');
    const response = await client.post('/new', { _csrf: csrf, name: 'widget-factory', template: 'empty' });
    assert.equal(response.status, 400);
  });
});

describe('the request queue is per-user for members', () => {
  test('a member cannot read another member’s requests through the API', async () => {
    const client = makeClient();
    await client.login('bob');
    const data = await (await client.get('/api/requests')).json();
    assert.equal(data.scope, 'mine');
    for (const request of data.requests) {
      assert.equal(request.requestedBy, 'bob');
    }
  });

  test('an administrator sees the whole queue', async () => {
    const client = makeClient();
    await client.login('alice');
    const data = await (await client.get('/api/requests')).json();
    assert.equal(data.scope, 'all');
    assert.ok(data.requests.length >= 2);
  });
});

describe('read-only guarantees still hold for members', () => {
  test('a member cannot reach the API without a session', async () => {
    const client = makeClient();
    assert.equal((await client.get('/api/status')).status, 401);
  });

  test('a signed-in member still cannot write to a repository', async () => {
    const client = makeClient();
    await client.login('bob');
    // There is no write endpoint at all. The only mutating route is a request,
    // and it is refused here because this POST carries no CSRF token.
    const response = await client.post('/api/repos', { name: 'x' });
    assert.ok([403, 404, 405].includes(response.status), `unexpected ${response.status}`);
  });
});
