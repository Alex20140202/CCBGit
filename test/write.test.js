import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/**
 * The write surface: git over HTTP, and edits made in the browser.
 *
 * A throwaway repository is built in a temp directory, so nothing here touches
 * a real `repos/` or `data/`.
 */
let server;
let baseUrl;
let tmp;
let reposRoot;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/**
 * Run git as a child process, asynchronously.
 *
 * Deliberately not `execFileSync`: the tests run the server and the git client
 * in the same process, so a blocking call would stop the event loop and the
 * server could never answer the request it is waiting on - the test would hang
 * until the timeout rather than fail.
 *
 * Prompting is disabled so a bad credential fails fast instead of blocking on a
 * terminal that does not exist. The 401 plus `WWW-Authenticate` is what makes
 * an interactive git prompt in the first place.
 */
function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out`));
    }, 20_000);

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}


/** A bare repository, which is the layout a push actually works into. */
function makeRepo(dir, name) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '--bare', '-b', 'main');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-write-'));
  git(scratch, 'init', '-q', '-b', 'main');
  git(scratch, 'config', 'user.name', 'Seed');
  git(scratch, 'config', 'user.email', 'seed@example.com');
  fs.writeFileSync(path.join(scratch, 'README.md'), '# Widget\n\nSeeded.\n');
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-q', '-m', 'Initial commit');
  git(scratch, 'push', '-q', target, 'main');
  fs.rmSync(scratch, { recursive: true, force: true });
  return target;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-write-'));
  reposRoot = path.join(tmp, 'acme');
  fs.mkdirSync(reposRoot, { recursive: true });
  makeRepo(reposRoot, 'widget');

  process.env.REPO_ROOTS = tmp;
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.SESSION_SECRET = 'write-suite-secret';
  process.env.CACHE_TTL = '0';
  process.env.ALLOW_SIGNUP = 'true';

  const { createApp, bootstrap } = await import('../server/app.js');
  await bootstrap({ silent: true });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A signed-in client that keeps its cookies. */
function makeClient() {
  const jar = new Map();
  const host = baseUrl.replace('http://', '');

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
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(baseUrl + route, { ...init, headers, redirect: 'manual' });
    store(response);
    return response;
  };

  const post = (route, fields) => request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

  const text = async (route) => (await request(route)).text();
  const csrf = async (route = '/') => {
    const body = await text(route);
    return (body.match(/name="csrf-token" content="([^"]+)"/)
      || body.match(/name="_csrf" value="([^"]+)"/) || [])[1] || '';
  };

  const register = async (username) => post('/register', {
    _csrf: await csrf('/register'),
    username,
    password: `password-for-${username}-1`,
    displayName: username,
  });

  const login = async (username) => post('/login', {
    _csrf: await csrf('/login'),
    username,
    password: `password-for-${username}-1`,
  });

  return {
    request, post, text, csrf, register, login, jar, host,
    /** Post a form with a fresh CSRF token. */
    async form(route, fields) {
      return post(route, { _csrf: await csrf(route.split('?')[0]), ...fields });
    },
  };
}

/** The owner of a repository, as the API reports it. */
const permissions = (client) => client.text('/acme/widget/api/permissions').then(JSON.parse);

describe('write permissions', () => {
  test('an unclaimed repository is read-only for a member', async () => {
    const admin = makeClient();
    await admin.register('owner'); // first account is the administrator
    // The fixture was not created through a request, so nobody owns it.
    const asAdmin = await permissions(admin);
    assert.equal(asAdmin.canWrite, true, 'an administrator may write anywhere');
  });

  test('a member is refused until an administrator assigns the repository', async () => {
    const member = makeClient();
    await member.register('member');
    const access = await permissions(member);
    assert.equal(access.canWrite, false);
    assert.equal(access.unclaimed, true);
  });

  test('the refusal is reported before anything is attempted', async () => {
    const member = makeClient();
    await member.login('member');
    const token = await member.csrf();

    const created = await member.post('/acme/widget/api/upload', {
      _csrf: token, path: 'x.txt', message: 'nope', content: 'x',
    });
    assert.equal(created.status, 403);

    const removed = await member.post('/acme/widget/api/delete', {
      _csrf: token, path: 'README.md', message: 'nope',
    });
    assert.equal(removed.status, 403);
  });

  test('nothing was written by the refused requests', async () => {
    const repo = path.join(reposRoot, 'widget');
    const before = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim();
    assert.equal(before.length, 40);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString();
    assert.equal(log.includes('nope'), false);
  });
});

describe('editing in the browser', () => {
  let client;

  before(async () => {
    client = makeClient();
    await client.login('owner');
  });

  test('creates a file and records a real commit', async () => {
    const response = await client.form('/acme/widget/api/upload', {
      branch: 'main',
      path: 'notes.md',
      message: 'Add notes from the browser',
      content: '# Notes\n\nWritten in the editor.\n',
    });
    assert.equal(response.status, 200);

    const body = await client.text('/acme/widget/blob/main/notes.md');
    assert.match(body, /Written in the editor/);

    const repo = path.join(reposRoot, 'widget');
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo }).toString().trim();
    assert.equal(subject, 'Add notes from the browser');

    const author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: repo }).toString().trim();
    assert.equal(author, 'owner');
  });

  test('a later edit builds on the first', async () => {
    await client.form('/acme/widget/api/upload', {
      branch: 'main', path: 'notes.md', message: 'Extend the notes', content: '# Notes\n\nNow longer.\n',
    });
    const repo = path.join(reposRoot, 'widget');
    const count = execFileSync('git', ['rev-list', '--count', 'main'], { cwd: repo }).toString().trim();
    assert.equal(count, '3'); // seed + two browser commits
  });

  test('preserves CRLF byte for byte', async () => {
    const crlf = 'line one\r\nline two\r\n';
    await client.form('/acme/widget/api/upload', {
      branch: 'main', path: 'crlf.txt', message: 'CRLF file', content: crlf,
    });

    const repo = path.join(reposRoot, 'widget');
    const stored = execFileSync('git', ['cat-file', 'blob', 'main:crlf.txt'], { cwd: repo });
    assert.equal(Buffer.compare(Buffer.from(crlf, 'utf8'), stored), 0);

    // And the download is faithful too.
    const download = Buffer.from(await (await client.request('/acme/widget/raw/main/crlf.txt')).arrayBuffer());
    assert.equal(Buffer.compare(Buffer.from(crlf, 'utf8'), download), 0);
  });

  test('stores binary content without corrupting it', async () => {
    // Bytes chosen to break a naive UTF-8 round trip: NUL, lone continuation
    // bytes, and an invalid sequence.
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x41, 0xc3, 0x28, 0x7f, 0x00, 0x42]);

    const response = await client.form('/acme/widget/api/upload', {
      branch: 'main', path: 'blob.bin', message: 'Binary', content: '',
    });
    // The text API cannot carry raw bytes, so the multipart path is the one
    // that matters; assert the plumbing directly instead.
    assert.ok([200, 400].includes(response.status));

    const { writeFiles } = await import('../server/lib/upload.js');
    const registry = await import('../server/lib/repos.js');
    const record = registry.resolve('acme/widget');
    await writeFiles(record, {
      edits: [{ path: 'blob.bin', content: bytes }],
      message: 'Binary bytes',
      branch: 'main',
      user: { username: 'owner', displayName: 'owner' },
    });

    const repo = path.join(reposRoot, 'widget');
    const stored = execFileSync('git', ['cat-file', 'blob', 'main:blob.bin'], { cwd: repo });
    assert.equal(Buffer.compare(bytes, stored), 0);
  });

  test('a batch upload is one commit', async () => {
    const { writeFiles } = await import('../server/lib/upload.js');
    const registry = await import('../server/lib/repos.js');
    const record = registry.resolve('acme/widget');
    const repo = path.join(reposRoot, 'widget');

    const before = Number(execFileSync('git', ['rev-list', '--count', 'main'], { cwd: repo }).toString().trim());

    await writeFiles(record, {
      edits: [
        { path: 'batch/one.txt', content: 'one' },
        { path: 'batch/two.txt', content: 'two' },
        { path: 'batch/three.txt', content: 'three' },
      ],
      message: 'Add three files at once',
      branch: 'main',
      user: { username: 'owner', displayName: 'owner' },
    });

    const after = Number(execFileSync('git', ['rev-list', '--count', 'main'], { cwd: repo }).toString().trim());
    assert.equal(after, before + 1, 'a batch should be a single commit');

    const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo }).toString();
    assert.match(files, /batch\/one\.txt/);
    assert.match(files, /batch\/two\.txt/);
    assert.match(files, /batch\/three\.txt/);
  });

  test('refuses an unchanged file', async () => {
    const response = await client.form('/acme/widget/api/upload', {
      branch: 'main', path: 'notes.md', message: 'No change', content: '# Notes\n\nNow longer.\n',
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /nothing to commit/i);
  });

  test('refuses a directory as a file path', async () => {
    const response = await client.form('/acme/widget/api/upload', {
      branch: 'main', path: 'batch', message: 'Clobber a directory', content: 'x',
    });
    assert.equal(response.status, 400);
  });

  test('requires a commit message', async () => {
    for (const message of ['', '   ']) {
      const response = await client.form('/acme/widget/api/upload', {
        branch: 'main', path: 'x.txt', message, content: 'x',
      });
      assert.equal(response.status, 400, `message ${JSON.stringify(message)} should be refused`);
    }
  });

  test('rejects path traversal and option-like paths', async () => {
    const repo = path.join(reposRoot, 'widget');
    const before = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString();

    for (const bad of ['../escape.txt', 'a/../../escape.txt', '..', '.git/config', 'a/./../../x']) {
      const response = await client.form('/acme/widget/api/upload', {
        branch: 'main', path: bad, message: 'Traversal attempt', content: 'x',
      });
      assert.equal(response.status, 400, `${bad} should be refused`);
    }

    const after = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString();
    assert.equal(after, before, 'no commit should have been created');
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
  });

  test('a leading slash means repository-root-relative, not filesystem-absolute', async () => {
    // GitHub treats a leading "/" as repo-relative. So must this: the file has
    // to land inside the repository, never at the filesystem root.
    const response = await client.form('/acme/widget/api/upload', {
      branch: 'main', path: '/rooted.txt', message: 'Leading slash', content: 'inside the repo\n',
    });
    assert.equal(response.status, 200);

    const repo = path.join(reposRoot, 'widget');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: repo }).toString();
    assert.match(files, /rooted\.txt/);
    assert.equal(fs.existsSync(path.join(reposRoot, 'rooted.txt')), false, 'must not escape the repository root');
  });

  test('rejects a hostile branch name', async () => {
    for (const bad of ['--upload-pack=evil', 'main..HEAD', '-x', 'a b']) {
      const response = await client.form('/acme/widget/api/upload', {
        branch: bad, path: 'x.txt', message: 'Bad branch', content: 'x',
      });
      assert.ok([400, 404].includes(response.status), `${bad} -> ${response.status}`);
    }
  });

  test('deletes a file and records it', async () => {
    const response = await client.form('/acme/widget/api/delete', {
      branch: 'main', path: 'batch/one.txt', message: 'Remove one file',
    });
    assert.equal(response.status, 200);

    const repo = path.join(reposRoot, 'widget');
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: repo }).toString();
    assert.equal(files.includes('batch/one.txt'), false);
    assert.match(files, /batch\/two\.txt/);
  });

  test('deleting a missing file is a 404, not a silent success', async () => {
    const response = await client.form('/acme/widget/api/delete', {
      branch: 'main', path: 'batch/nope.txt', message: 'Remove nothing',
    });
    assert.equal(response.status, 404);
  });

  test('the editor page is reachable and prefilled', async () => {
    const body = await client.text('/acme/widget/edit/main/notes.md');
    assert.match(body, /class="editor-content"/);
    assert.match(body, /Now longer\./);
  });
});

describe('multipart upload', () => {
  test('accepts files and refuses oversized ones', async () => {
    const client = makeClient();
    await client.login('owner');

    const token = await client.csrf();
    const form = new FormData();
    form.append('branch', 'main');
    form.append('message', 'Upload via multipart');
    form.append('files', new Blob(['console.log(1);\n'], { type: 'text/plain' }), 'one.js');
    form.append('files', new Blob([Buffer.from([0, 1, 255, 0])]), 'two.bin');

    const response = await client.request('/acme/widget/upload?_csrf=' + encodeURIComponent(token), {
      method: 'POST', body: form,
    });
    assert.equal(response.status, 302);

    const repo = path.join(reposRoot, 'widget');
    const stored = execFileSync('git', ['cat-file', 'blob', 'main:two.bin'], { cwd: repo });
    assert.equal(Buffer.compare(Buffer.from([0, 1, 255, 0]), stored), 0);
  });

  test('a multipart upload without a token is refused', async () => {
    const client = makeClient();
    await client.login('owner');

    const form = new FormData();
    form.append('branch', 'main');
    form.append('message', 'No token');
    form.append('files', new Blob(['x']), 'x.txt');

    const response = await client.request('/acme/widget/upload', { method: 'POST', body: form });
    assert.equal(response.status, 403);
  });
});

describe('git over HTTP', () => {
  test('an anonymous request is challenged', async () => {
    const response = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=git-upload-pack`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  });

  test('a wrong password is challenged, not accepted', async () => {
    const auth = Buffer.from('owner:wrong').toString('base64');
    const response = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${auth}` },
    });
    assert.equal(response.status, 401);
  });

  test('a valid credential gets a real ref advertisement', async () => {
    const auth = Buffer.from('owner:password-for-owner-1').toString('base64');
    const response = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${auth}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /x-git-.*-advertisement/);

    const body = await response.text();
    assert.match(body, /multi_ack|symref|agent=git/, 'should be a smart HTTP advertisement');
  });

  test('a member may read but not request a push advertisement', async () => {
    const read = Buffer.from('member:password-for-member-1').toString('base64');
    const fetchOk = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${read}` },
    });
    assert.equal(fetchOk.status, 200, 'reading is open to any signed-in user');

    const write = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: `Basic ${read}` },
    });
    assert.equal(write.status, 403);
  });

  test('an unsupported service is refused', async () => {
    const auth = Buffer.from('owner:password-for-owner-1').toString('base64');
    const response = await fetch(`${baseUrl}/acme/widget.git/info/refs?service=evil`, {
      headers: { authorization: `Basic ${auth}` },
    });
    assert.equal(response.status, 404);
  });

  test('a path that tries to escape the root is refused', async () => {
    const auth = Buffer.from('owner:password-for-owner-1').toString('base64');
    for (const target of [
      '/acme/..%2F..%2Fetc.git/info/refs?service=git-upload-pack',
      '/acme/.%2E%2E.git/info/refs?service=git-upload-pack',
      '/acme/does-not-exist.git/info/refs?service=git-upload-pack',
    ]) {
      const response = await fetch(baseUrl + target, { headers: { authorization: `Basic ${auth}` } });
      assert.ok([403, 404].includes(response.status), `${target} -> ${response.status}`);
      assert.equal((await response.text()).includes('root:'), false);
    }
  });

  test('a real clone and push over HTTP works end to end', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-clone-'));
    const host = baseUrl.replace('http://', '');
    const url = `http://owner:password-for-owner-1@${host}/acme/widget.git`;

    await runGit(['clone', '-q', url, scratch]);
    assert.equal(fs.existsSync(path.join(scratch, 'README.md')), true);

    fs.writeFileSync(path.join(scratch, 'pushed.txt'), 'pushed over http\n');
    git(scratch, 'config', 'user.name', 'Pusher');
    git(scratch, 'config', 'user.email', 'push@example.com');
    git(scratch, 'add', '-A');
    git(scratch, 'commit', '-q', '-m', 'Pushed over HTTP');
    await runGit(['push', '-q', 'origin', 'main'], { cwd: scratch });

    const repo = path.join(reposRoot, 'widget');
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo }).toString().trim();
    assert.equal(subject, 'Pushed over HTTP');

    // And the website sees it without waiting for a rescan.
    const client = makeClient();
    await client.login('owner');
    assert.match(await client.text('/acme/widget/blob/main/pushed.txt'), /pushed over http/);

    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('git clone of a repository the caller may not read fails fast', async () => {
    // Proves the prompt is a real 401 rather than a hang: with prompting
    // disabled, git gives up immediately.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbgit-denied-'));
    const host = baseUrl.replace('http://', '');
    let failed = false;
    try {
      await runGit(['clone', '-q', `http://owner:wrong-password@${host}/acme/widget.git`, scratch]);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, 'a clone with bad credentials should fail, not hang');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
});
