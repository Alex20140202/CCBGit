import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
const REPOS_ROOT = process.env.REPOS_ROOT || join(__dirname, '../../../repos');
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 5000; // 5 seconds
function cacheGet(key) {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now())
        return entry.data;
    cache.delete(key);
    return null;
}
function cacheSet(key, data) {
    cache.set(key, { data, expires: Date.now() + CACHE_TTL });
}
function git(repoPath, args) {
    try {
        return execFileSync('git', ['-C', repoPath, ...args], {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000
        }).trim();
    }
    catch (e) {
        throw new Error(e.stdout || e.stderr || e.message);
    }
}
function isGitRepo(dir) {
    const gitDir = join(dir, '.git');
    if (existsSync(gitDir))
        return true;
    try {
        const entries = readdirSync(dir);
        return entries.some(e => ['HEAD', 'config', 'objects', 'refs'].includes(e));
    }
    catch {
        return false;
    }
}
function getRepos() {
    if (!existsSync(REPOS_ROOT))
        return [];
    return readdirSync(REPOS_ROOT)
        .filter(name => statSync(join(REPOS_ROOT, name)).isDirectory())
        .filter(name => isGitRepo(join(REPOS_ROOT, name)));
}
function getCurrentBranch(repoPath) {
    try {
        const headPath = join(repoPath, 'HEAD');
        if (existsSync(headPath)) {
            const head = readFileSync(headPath, 'utf-8').trim();
            const match = head.match(/ref: refs\/heads\/(.+)/);
            if (match)
                return match[1];
        }
    }
    catch { }
    return 'main';
}
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});
app.get('/api/repos', (_req, res) => {
    const cacheKey = 'repos:list';
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    const repos = getRepos().map(name => ({ name, path: join(REPOS_ROOT, name) }));
    cacheSet(cacheKey, repos);
    res.json(repos);
});
app.get('/api/repos/:name/info', async (req, res) => {
    const cacheKey = `repo:info:${req.params.name}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, req.params.name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const isBare = !existsSync(join(repoPath, '.git'));
        const currentBranch = isBare ? getCurrentBranch(repoPath) : git(repoPath, ['symbolic-ref', '--short', 'HEAD']) || 'main';
        const [branchesOut, remotesOut, logOut] = await Promise.all([
            git(repoPath, ['branch', '-a']),
            git(repoPath, ['remote', '-v']),
            git(repoPath, ['log', '--pretty=format:%H|%an|%ae|%at|%s', '-n', '10'])
        ]);
        const branches = branchesOut.split('\n').filter(Boolean).map(b => b.trim().replace(/^\*\s*/, ''));
        const remotes = remotesOut.split('\n').filter(Boolean).map(line => {
            const [name, url, type] = line.split(/\s+/);
            return { name, url, type };
        });
        const recentCommits = logOut.split('\n').filter(Boolean).map(line => {
            const [hash, author, email, date, ...msgParts] = line.split('|');
            return { hash, author: author || '', email: email || '', date: date ? parseInt(date) * 1000 : Date.now(), message: msgParts.join('|') };
        });
        const result = { name: req.params.name, currentBranch, branches, remotes, recentCommits };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/tree', async (req, res) => {
    const { name } = req.params;
    const ref = req.query.ref || 'HEAD';
    const path = req.query.path || '';
    const cacheKey = `repo:tree:${name}:${ref}:${path}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const args = ['ls-tree', '-l', '-z', ref];
        if (path)
            args.push(path);
        const output = execFileSync('git', ['-C', repoPath, ...args], {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000
        });
        const entries = output.split('\0').filter(Boolean).map(line => {
            const [meta, name] = line.split('\t');
            const [mode, type, hash, size] = meta.split(' ');
            return { mode, type, hash, size: parseInt(size) || 0, name };
        });
        const result = { ref, path, entries };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/blob', async (req, res) => {
    const { name } = req.params;
    const ref = req.query.ref || 'HEAD';
    const path = req.query.path;
    if (!path)
        return res.status(400).json({ error: 'Path required' });
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const content = git(repoPath, ['show', `${ref}:${path}`]);
        res.type('text/plain').send(content);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/commits', async (req, res) => {
    const { name } = req.params;
    const ref = req.query.ref || 'HEAD';
    const path = req.query.path;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = parseInt(req.query.skip) || 0;
    const cacheKey = `repo:commits:${name}:${ref}:${path || ''}:${skip}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const args = ['log', `--skip=${skip}`, `--max-count=${limit}`, '--pretty=format:%H|%an|%ae|%at|%s', ref];
        if (path)
            args.push('--', path);
        const log = git(repoPath, args);
        const commits = log.split('\n').filter(Boolean).map(line => {
            const [hash, author, email, date, ...msgParts] = line.split('|');
            return { hash, author, email, date: parseInt(date) * 1000, message: msgParts.join('|') };
        });
        const result = { commits, ref, path };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/commit/:hash', async (req, res) => {
    const { name, hash } = req.params;
    const cacheKey = `repo:commit:${name}:${hash}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const [show, diff] = await Promise.all([
            git(repoPath, ['show', '--pretty=format:%H|%an|%ae|%at|%s', '-s', hash]),
            git(repoPath, ['diff', `${hash}^`, hash])
        ]);
        const [h, author, email, date, ...msgParts] = show.split('|');
        const result = { hash: h, author, email, date: parseInt(date) * 1000, message: msgParts.join('|'), diff };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/diff', async (req, res) => {
    const { name } = req.params;
    const from = req.query.from || 'HEAD~1';
    const to = req.query.to || 'HEAD';
    const path = req.query.path;
    const cacheKey = `repo:diff:${name}:${from}:${to}:${path || ''}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const args = ['diff', from, to];
        if (path)
            args.push('--', path);
        const diff = git(repoPath, args);
        const result = { from, to, path, diff };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/branches', async (req, res) => {
    const { name } = req.params;
    const cacheKey = `repo:branches:${name}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const output = git(repoPath, ['branch', '-a']);
        const branches = output.split('\n').filter(Boolean).map(b => b.trim().replace(/^\*\s*/, ''));
        const result = { all: branches, current: branches.find(b => b.startsWith('*'))?.replace(/^\*\s*/, '') || 'main' };
        cacheSet(cacheKey, result);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.get('/api/repos/:name/tags', async (req, res) => {
    const { name } = req.params;
    const cacheKey = `repo:tags:${name}`;
    const cached = cacheGet(cacheKey);
    if (cached)
        return res.json(cached);
    try {
        const repoPath = join(REPOS_ROOT, name);
        if (!existsSync(repoPath))
            return res.status(404).json({ error: 'Not found' });
        const tags = git(repoPath, ['tag', '-l']).split('\n').filter(Boolean);
        cacheSet(cacheKey, tags);
        res.json(tags);
    }
    catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});
httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Repos root: ${REPOS_ROOT}`);
});
//# sourceMappingURL=index.js.map