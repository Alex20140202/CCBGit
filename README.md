# CCBGit

A self-hosted git repository website, built with Node.js at both ends: an
Express server renders the pages with EJS and serves a JSON API; the browser
gets a small, dependency-free layer of JavaScript for the parts that should not
wait for a round trip.

It reads the repositories already on your disk. It does not manage them, and it
does not need a database.

```
┌── browser ────────────┐        ┌── node server ──────────┐        ┌── git ──┐
│  theme, file sizes,   │  HTTP  │  EJS views              │  argv  │  one    │
│  copy buttons,        │ ─────► │  JSON API               │ ─────► │  process│
│  branch switcher      │        │  TTL cache              │        │  per    │
└───────────────────────┘        └─────────────────────────┘        │  query  │
                                                                └─────────┘
```

## Quick start

```bash
npm install
npm run seed     # creates three sample repositories under ./repos
npm start        # http://localhost:6600
```

`npm run dev` does the same with `--watch` for auto-restart.

## Features

**Browse**

- Repository index with search, language filter, and sorting by last update,
  name, commit count, size or creation date
- File tree, with directory history and file sizes
- Blob view with server-side syntax highlighting, a line-number gutter and
  `#L42` line anchors
- Markdown files rendered to HTML, with a table of contents for long documents
- Raw file download and `tar.gz` / `zip` archive of any ref

**History**

- Commit list, optionally scoped to a single path
- Commit detail with a per-file diff, +/- counts, and collapse/expand
- Branch, tag and remote-ref switcher that keeps you on the same file
- Compare any two refs (`/compare/main...feature/x`)

**Search**

- `git grep` across the tree of a ref, literal or regex, with matches marked
- `/` focuses the search box

**Everywhere**

- Light / dark / follow-system themes, remembered in `localStorage`
- Responsive layout, keyboard accessible, `prefers-reduced-motion` respected
- Language statistics per repository
- Contributor list with per-person commit counts

## Configuration

Everything is environment driven, with defaults that work out of the box. See
[`.env.example`](.env.example) for the full list; the ones you are most likely
to touch:

| Variable    | Default        | Meaning                                       |
| ----------- | -------------- | --------------------------------------------- |
| `PORT`      | `6600`         | Listen port                                    |
| `REPO_ROOTS`| `./repos`      | Directories to scan for repositories           |
| `BASE_URL`  | —              | Public URL, used to build the clone URLs shown |
| `MAX_BLOB_SIZE` | `2097152`  | Largest file previewed in the browser          |

```bash
REPO_ROOTS=/srv/git:/home/me/code npm start
```

A repository is addressed as `<parent-directory>/<name>`, so
`/srv/git/hello-node` is browsable at `/srv/hello-node`. Repositories are
discovered up to three directories deep, and a repository is never indexed
twice — once one is found, the scan does not descend into it.

## HTTP API

Every page has a JSON counterpart under `/api`.

| Method | Path                                     | Returns                              |
| ------ | ---------------------------------------- | ------------------------------------ |
| GET    | `/api/repos`                             | repository index (filterable)        |
| POST   | `/api/repos/refresh`                     | rescan the configured roots          |
| GET    | `/api/repos/:owner/:name`                | metadata, branches, tags, commits    |
| GET    | `/api/repos/:owner/:name/refs`           | branches, remotes, tags              |
| GET    | `/api/repos/:owner/:name/tree?ref=&path=`| directory listing + language stats   |
| GET    | `/api/repos/:owner/:name/blob?ref=&path=`| file contents and metadata           |
| GET    | `/api/repos/:owner/:name/commits?ref=`   | paginated commit list                |
| GET    | `/api/repos/:owner/:name/commits/:sha`   | one commit with its diff             |
| GET    | `/api/repos/:owner/:name/search?ref=&q=`  | `git grep` results                   |
| GET    | `/api/repos/:owner/:name/languages?ref=` | language breakdown                   |
| GET    | `/api/status`                            | versions, cache hit rate, uptime     |

Errors come back as `{ "error": "...", "status": 404 }`.

## Security notes

Repository content is untrusted input, so it is treated that way:

- **git is never given a shell.** Commands run through `execFile`/`spawn` with
  an argument array, so nothing in a ref or path can be interpreted as shell
  syntax.
- **Refs are validated before use.** Anything containing `..`, `^`, `~`, `@{`,
  a leading `-`, or a colon is rejected outright, which closes off option
  injection (`--upload-pack=…`) and revision ranges alike.
- **Paths cannot escape the repository.** Repository-relative paths are split
  into segments and any `..` is refused; a `NUL` byte is refused too.
- **Markdown is escaped, not sanitised by pattern-matching.** `marked`'s raw
  HTML token stream is escaped, so only markup the parser itself produced ever
  reaches the page. `javascript:` links are dropped and external links get
  `rel="noopener"`.
- **Output is escaped at the template boundary.** Views print untrusted strings
  through an `escapeHtml` helper; the two places that emit pre-rendered HTML use
  EJS's unescaped `<%-` deliberately and only ever with output from
  `renderMarkdown` or `highlight`.
- **A strict CSP** is sent on every response, alongside `nosniff`,
  `X-Frame-Options` and `Referrer-Policy`.

The test suite asserts these properties directly, including attempts to read
`/etc/passwd` through path traversal and to smuggle shell options through refs
and search terms.

Stack traces are hidden from error pages unless `SHOW_STACKS=true`.

## Performance

Git output is cached per repository with a short TTL (`CACHE_TTL`, 15s by
default) and an LRU bound, keyed by repository and ref. A ref switch, a page
turn, or a re-render therefore usually costs nothing. `GET /api/status` reports
the hit rate.

Blob reads are bounded by `MAX_BLOB_SIZE`; anything larger renders as a
download link rather than being buffered. Archives are streamed from `git
archive` straight to the socket instead of being held in memory.

## Tests

```bash
npm test
```

71 cases across three files, using only `node:test`:

- `test/validate.test.js` — ref, path, and repository-name validation
- `test/render.test.js` — markdown rendering, XSS, diff parsing
- `test/server.test.js` — the real app against a throwaway repository built in
  a temp directory: every page, the whole API, archives, and hostile input

## Layout

```
config.js              environment-driven configuration
server/
  index.js             entry point, graceful shutdown
  app.js               express app, security headers, error handling
  lib/
    git.js             git process wrapper, typed errors
    repo.js            everything you can do to one repository
    repos.js           discovery, indexing, search over the registry
    render.js          markdown, syntax highlighting, escaping
    validate.js        input validation and HTTP status mapping
    cache.js           TTL + LRU cache
    languages.js       language detection and formatting
  routes/
    pages.js           HTML routes
    api.js             JSON routes
views/                 EJS templates and partials
public/                stylesheet, client-side JS, favicon
bin/seed.js            creates the sample repositories
repos/                 where repositories are looked for (gitignored)
```

## Requirements

Node.js 20 or newer, and `git` on the `PATH`. No database, no build step.
