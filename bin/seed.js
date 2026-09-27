#!/usr/bin/env node
/**
 * Create a few sample repositories under `repos/` so a fresh clone of this
 * project has something to browse. Safe to re-run: existing directories are
 * left untouched unless `--force` is passed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reposDir = path.join(root, 'repos');
const force = process.argv.includes('--force');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function write(dir, file, content) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo, message, { author } = {}) {
  const env = {};
  if (author) {
    env.GIT_AUTHOR_NAME = author.name;
    env.GIT_AUTHOR_EMAIL = author.email;
    env.GIT_COMMITTER_NAME = author.name;
    env.GIT_COMMITTER_EMAIL = author.email;
  }
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=CCBGit Seed', '-c', 'user.email=seed@ccbgit.local', 'commit', '-m', message);
}

const REPOS = [
  {
    name: 'hello-node',
    description: 'A tiny REST API built on the bare Node.js standard library — no dependencies.',
    files(dir) {
      write(dir, 'README.md', `# hello-node

A deliberately small HTTP service that shows how far you can get with **zero
dependencies**. It uses only modules that ship with Node itself.

> Not production software. A teaching example, and a fixture for this site.

## Features

- [x] Router with method + path matching
- [x] JSON body parsing with a size limit
- [x] Structured logging
- [x] Graceful shutdown

## Usage

\`\`\`bash
node src/index.js
curl localhost:3000/api/health
\`\`\`

## Layout

| Path            | Purpose                       |
| --------------- | ----------------------------- |
| \`src/index.js\`   | process entry point            |
| \`src/router.js\`  | path matcher                   |
| \`test/router.test.js\` | unit tests              |

## API

| Method | Path            | Response                  |
| ------ | --------------- | ------------------------- |
| GET    | /api/health     | \`{ ok: true }\`            |
| POST   | /api/echo       | echoes the posted JSON    |
`);

      write(dir, 'src/index.js', `import http from 'node:http';
import { createRouter } from './router.js';

const router = createRouter();

router.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

router.post('/api/echo', (req, res) => {
  res.json({ received: req.body });
});

const server = http.createServer(router.handle());

server.listen(process.env.PORT || 3000, () => {
  console.log(\`listening on \${server.address().port}\`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(\`\${signal} received\`);
    server.close(() => process.exit(0));
  });
}
`);

      write(dir, 'src/router.js', `/**
 * A minimal path matcher: converts "/users/:id" into a regexp and keeps the
 * parameter names around so handlers can read them off the request.
 */
export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const names = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return segment.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        names.push(segment.slice(1));
        return '([^/]+)';
      })
      .join('/');
    routes.push({ method, regexp: new RegExp(\`^\${source}$\`), names, handler });
  };

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    handle() {
      return async (req, res) => {
        const url = new URL(req.url, \`http://\${req.headers.host}\`);
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const match = route.regexp.exec(url.pathname);
          if (!match) continue;
          req.params = Object.fromEntries(
            route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]),
          );
          res.json = (payload, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          };
          return route.handler(req, res);
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      };
    },
  };
}
`);

      write(dir, 'test/router.test.js', `import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';

test('matches a static path', () => {
  const router = createRouter();
  let hit = false;
  router.get('/api/health', () => { hit = true; });
  router.handle()({ method: 'GET', url: '/api/health', headers: {} });
  assert.equal(hit, true);
});

test('extracts parameters', () => {
  const router = createRouter();
  let captured;
  router.get('/users/:id', (req) => { captured = req.params; });
  router.handle()({ method: 'GET', url: '/users/42', headers: {} })();
  assert.deepEqual(captured, { id: '42' });
});
`);

      write(dir, 'package.json', JSON.stringify({
        name: 'hello-node',
        version: '1.0.0',
        type: 'module',
        scripts: { start: 'node src/index.js', test: 'node --test test/' },
      }, null, 2) + '\n');

      write(dir, '.gitignore', 'node_modules/\n*.log\n.DS_Store\n');
    },
    commits(dir) {
      commit(dir, 'Initial commit: router and health endpoint', {
        author: { name: 'Ada Wang', email: 'ada@example.com' },
      });
      write(dir, 'src/logger.js', `export function log(level, message, extra = {}) {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...extra });
  process.stdout.write(\`\${line}\\n\`);
}

export const info = (m, e) => log('info', m, e);
export const error = (m, e) => log('error', m, e);
`);
      commit(dir, 'Add a structured logger', { author: { name: 'Ada Wang', email: 'ada@example.com' } });
      write(dir, 'src/router.js', readFile(dir, 'src/router.js') + '\n// TODO: support wildcards\nexport const VERSION = 2;\n');
      commit(dir, 'Bump router version and leave a note', { author: { name: 'Bo Chen', email: 'bo@example.com' } });
      git(dir, 'tag', 'v1.0.0');
      git(dir, 'checkout', '-b', 'feature/body-limit');
      write(dir, 'src/router.js', readFile(dir, 'src/router.js').replace(
        '// TODO: support wildcards',
        'const MAX_BODY = 1_048_576;',
      ));
      commit(dir, 'Reject bodies over 1 MiB', { author: { name: 'Bo Chen', email: 'bo@example.com' } });
      git(dir, 'checkout', '-');
    },
  },
  {
    name: 'quantum-notes',
    description: 'Reading notes and annotated papers on quantum computing.',
    files(dir) {
      write(dir, 'README.md', `# quantum-notes

Personal study notes. Not a textbook — just the parts I had to look up twice.

## Contents

- [Shor's algorithm](notes/shor.md) — period finding and why it threatens RSA
- [Bell's theorem](notes/bell.md) — the experiment, without the philosophy
- \`glossary.md\` — terms I kept forgetting

## Status

Reading through *Nielsen & Chuang* chapter by chapter. Chapter 2 is the one
that actually matters.
`);
      write(dir, 'notes/shor.md', `# Shor's algorithm

## The problem

Given an integer \\(N\\\), find its prime factors. Factoring is believed to be
hard classically; it is in \\(\\mathrm{BQP}\\).

## Outline

1. Pick \\(a\\) coprime to \\(N\\)
2. Find the period r of a^x mod N
3. If r is even and a^(r/2) != -1 (mod N), we have the factors

The period is found with the quantum Fourier transform, in polynomial time.

## Why it matters

RSA security depends on factoring being hard. Shor's algorithm makes it
tractable, so a large enough quantum computer breaks RSA-2048.

\`\`\`python
def period(a, N):
    \"\"\"Classical check, exponential - the quantum part is what makes it fast.\"\"\"
    x, seen = 1, {}
    while x not in seen:
        seen[x] = len(seen)
        x = (x * a) % N
    return len(seen) - seen[x]
\`\`\`

> The quantum part is the interesting bit. The classical loop above is included
> only to show what is being replaced.
`);
      write(dir, 'notes/bell.md', `# Bell's theorem

## The claim

No local hidden-variable theory reproduces all quantum predictions.

## The inequality

\\[
|C(a,b) - C(a,c)| \\le 1 + C(b,c)
\\]

Any theory satisfying locality and realism must obey this. Quantum mechanics
predicts violations of up to \\(2\\sqrt{2}\\).

## The experiment

Aspect, Grangier, Roger (1982) measured a correlation of \\(2.0 \\pm 0.1\\),
against a Bell limit of about \\(1.76\\).

## What is *not* settled

Whether the experiment closes every loophole at once. The detection and
communication loopholes were closed separately over the following two decades.
`);
      write(dir, 'glossary.md', `# Glossary

| Term                | Meaning                                             |
| ------------------- | --------------------------------------------------- |
| **qubit**           | a two-level quantum system                           |
| **superposition**   | a linear combination of basis states                 |
| **entanglement**    | a joint state that is not a product of single states |
| **decoherence**     | loss of phase information to the environment         |
| **BEP** / **QEC**   | quantum error correction                              |
`);
      write(dir, 'refs.bib', `@book{nielsen2010,
  title     = {Quantum Computation and Quantum Information},
  author    = {Nielsen, Michael A. and Chuang, Isaac L.},
  year      = {2010},
  publisher = {Cambridge University Press}
}

@article{aspect1982,
  title   = {Experimental Realization of Einstein-Podolsky-Rosen Gedanken Experiment},
  author  = {Aspect, Alain and Grangier, Jean and Roger, Georges},
  journal = {Physical Review Letters},
  year    = {1982}
}
`);
    },
    commits(dir) {
      commit(dir, 'Start the reading notes', { author: { name: 'Mei Lin', email: 'mei@example.com' } });
      write(dir, 'notes/decoherence.md', `# Decoherence

Interaction with the environment is the dominant error channel.

## Timescales

| System          | Coherence time |
| --------------- | -------------- |
| Nuclear spin    | seconds        |
| Superconducting | ~100 µs        |
| Trapped ion     | seconds        |

The gap between the first and third row is why hardware choices matter.
`);
      commit(dir, 'Notes on decoherence timescales', { author: { name: 'Mei Lin', email: 'mei@example.com' } });
      write(dir, 'glossary.md', readFile(dir, 'glossary.md').replace('**QEC**', '**QEC** (surface, colour, lattice)'));
      commit(dir, 'Expand the glossary with error correction codes', { author: { name: 'Kai Zhao', email: 'kai@example.com' } });
      git(dir, 'tag', 'notes-2024');
      git(dir, 'checkout', '-b', 'draft/shor-figures');
      write(dir, 'notes/figures.md', '# Figures\n\n(captions to be written)\n');
      commit(dir, 'Add a placeholder for Shor figures', { author: { name: 'Kai Zhao', email: 'kai@example.com' } });
      git(dir, 'checkout', '-');
    },
  },
  {
    name: 'dotfiles',
    description: 'Shell, editor and git configuration I keep re-typing on every new machine.',
    files(dir) {
      write(dir, 'README.md', `# dotfiles

Everything here is safe to symlink into a fresh account.

\`\`\`bash
git clone <this repo> ~/dotfiles
cd ~/dotfiles && ./install.sh
\`\`\`

## Layout

- \`install.sh\` — symlink farm
- \`shell/\` — zsh + aliases
- \`git/\` — global gitconfig fragments
- \`nvim/\` — editor config

## Note

The git aliases assume a fork of \`hub\` is installed.
`);
      write(dir, 'install.sh', `#!/usr/bin/env bash
set -euo pipefail

link() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  ln -sfn "$PWD/$src" "$dest"
  echo "linked $src -> $dest"
}

link shell/.zshrc        "$HOME/.zshrc"
link shell/.aliases      "$HOME/.aliases"
link git/gitconfig       "$HOME/.gitconfig"
link nvim/init.vim       "$HOME/.config/nvim/init.vim"

echo "done"
`);
      write(dir, 'shell/.zshrc', `export EDITOR=nvim
export PAGER=less
export LESS='-R'

# history
HISTSIZE=100000
SAVEHIST=100000
setopt SHARE_HISTORY

# navigation
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search

source "$HOME/.aliases"
`);
      write(dir, 'shell/.aliases', `alias ll='ls -lah'
alias la='ls -A'
alias ..='cd ..'
alias g='git'
alias gs='git status -sb'
alias gl='git log --oneline --graph --decorate -20'
alias gd='git diff'
alias dc='docker compose'
alias k='kubectl'
`);
      write(dir, 'git/gitconfig', `[user]
    name = Your Name
    email = you@example.com

[alias]
    st = status -sb
    lg = log --oneline --graph --decorate -20
    last = log -1 HEAD --stat
    unstage = restore --staged

[push]
    default = current
    autoSetupRemote = true

[init]
    defaultBranch = main

[pull]
    rebase = true

[core]
    editor = nvim
    autocrlf = input
`);
      write(dir, 'nvim/init.vim', `set number
set relativenumber
set expandtab
set shiftwidth=2
set softtabstop=2
set ignorecase
set smartcase
set clipboard^=unnamed,unnamedplus

" find with transparency
set transparency=15
`);
      write(dir, '.editorconfig', `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
`);
    },
    commits(dir) {
      commit(dir, 'Import shell and git config', { author: { name: 'Ravi Patel', email: 'ravi@example.com' } });
      write(dir, 'nvim/lua/plugins.lua', `return {
  { 'folke/telescope.nvim', opts = { pickers = { find_files = false } } },
  { 'nvim-treesitter/nvim-treesitter', opts = { ensure_installed = { 'markdown', 'json', 'bash' } } },
}
`);
      commit(dir, 'Add a treesitter + telescope plugin list', { author: { name: 'Ravi Patel', email: 'ravi@example.com' } });
      write(dir, 'git/gitconfig', readFile(dir, 'git/gitconfig').replace(
        '[core]',
        '[merges]\n    conflictstyle = zdiff3\n\n[core]',
      ));
      commit(dir, 'Prefer zdiff3 for conflict markers', { author: { name: 'Sofia Marek', email: 'sofia@example.com' } });
      git(dir, 'tag', 'v0.3.0');
    },
  },
];

function readFile(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

fs.mkdirSync(reposDir, { recursive: true });

for (const spec of REPOS) {
  const dir = path.join(reposDir, spec.name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    console.log(`skip ${spec.name} (already exists — pass --force to recreate)`);
    continue;
  }
  if (force && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'CCBGit Seed');
  git(dir, 'config', 'user.email', 'seed@ccbgit.local');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // gitweb-style: the human description lives in .git/description, not config.
  write(dir, '.git/description', `${spec.description}\n`);

  spec.files(dir);
  spec.commits(dir);

  const log = git(dir, 'log', '--oneline', '-1').trim();
  console.log(`created ${spec.name}  (${log})`);
}

console.log(`\n${REPOS.length} sample repositories ready in ${path.relative(process.cwd(), reposDir)}/`);
console.log('Run `npm start` and open http://localhost:6600\n');
