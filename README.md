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

The first account you register becomes an administrator. Open
`/register`, sign up, and you land on the admin page.

## Getting content in

**There is no web upload, and no HTTP git endpoint.** The site reads git's output;
it is not a git remote, and it does not accept pushes over HTTP. The UI does not
pretend otherwise — it shows the push command for the repository's location on
disk rather than a `.git` URL that would fail.

So the way to submit files is to push to the directory:

```bash
# a brand new repository
git init --bare repos/my-project
git clone repos/my-project my-project      # if you want to keep a working copy
# ... or, from an existing checkout:
cd ~/code/my-project
git remote add ccbgit ~/Projects/CCBGit/repos/my-project
git push ccbgit main
```

Then press **Rescan** on the home page (or wait out `CACHE_TTL`, 15s by
default). The rescan clears the cached tree, blob and commit lookups, so new
commits appear immediately.

Two things worth knowing:

- **A worktree repository refuses pushes to its checked-out branch.** That is
  git's rule, not this site's: it would leave the working tree inconsistent with
  `HEAD`. Either set `receive.denyCurrentBranch=updateInstead` on the
  repository, or make it bare with `git init --bare`. Bare repositories are
  indexed and browsed like any other.
- **The three seeded repositories and the ones created through the approval
  flow are worktrees**, so they need the `updateInstead` setting before you can
  push to them.

To get files *out*, use the tar.gz/zip download on any repository page, or read
the files in the browser.

### If you want real `git push` over HTTP

That needs a git HTTP backend (`git http-backend`, or a server like
`git-http-backend`/`go-git` in front of it), which means accepting unauthenticated
or authenticated POST bodies that stream packfiles. It is a meaningful addition
rather than a setting, and it changes the security model of the whole site — say
the word and I will add it, but it deserves its own design discussion rather
than being smuggled in.

## Access model

The site is private: every page and every API endpoint requires a signed-in
session, and redirects anonymous visitors to `/login`. Only the sign-in and
registration pages and the static assets are public.

There are two roles:

| Role         | Can do                                                          |
| ------------ | --------------------------------------------------------------- |
| **member**   | browse every repository, search, request a new repository        |
| **admin**    | everything a member can, plus approve or reject requests         |

### Requesting a repository

Nobody creates a repository directly. A member submits a request with a name, an
optional description and a starting template; the repository does not exist on
disk until an administrator approves it. Approval runs `git init` in the target
directory, writes the template files, and makes an initial commit attributed to
**the requester**, not to the approver. Rejection leaves nothing behind, and
the requester sees the note the admin left.

The target is fixed: the first directory in `REPO_ROOTS`. A repository name has
to be a single path segment, so it cannot escape that directory.

```
        member                        admin
          │                            │
  POST /new (name, template)            │
          │                            │
          ├──▶ queue (pending) ─────────┤
          │                            │ POST /admin/requests/:id/approve
          │                            ├──▶ git init repos/<name>
          │                            │     initial commit as the requester
          │                            ├──▶ queue: approved
          ◀────────────────────────────┘
        sees status + the note
```

Set `ALLOW_SIGNUP=false` once the accounts you need exist; only an
administrator can then create further accounts.

## Features

**Browse**

- Repository index with search, language filter, and sorting by last update,
  name, commit count, size or creation date
- File tree, with directory history and file sizes
- Blob view with server-side syntax highlighting, a line-number gutter and
  `#L42` line anchors
- Markdown files rendered to HTML, with hover permalinks on headings and a
  table of contents for long documents
- Raw file download and `tar.gz` / `zip` archive of any ref
- Bare and worktree repositories are both indexed

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
- Responsive down to a phone, and a print stylesheet that drops the chrome
- Language statistics per repository
- Contributor list with per-person commit counts

**Accounts**

- Session-cookie sign-in; the first account registered is the administrator
- Request a new repository by name, with a starting template
- Administrator review queue: approve (which creates the repository) or reject
  with a note the requester can read
- A member sees only their own requests; an admin sees the whole queue

## Configuration

Everything is environment driven, with defaults that work out of the box. See
[`.env.example`](.env.example) for the full list; the ones you are most likely
to touch:

| Variable    | Default        | Meaning                                       |
| ----------- | -------------- | --------------------------------------------- |
| `PORT`      | `6666`         | Listen port                                    |
| `REPO_ROOTS`| `./repos`      | Directories to scan; the first is also where new repositories are created |
| `DATA_DIR`  | `./data`       | User accounts, request queue, session key      |
| `ALLOW_SIGNUP` | `true`      | Set false to close registration                 |
| `MAX_BLOB_SIZE` | `2097152`  | Largest file previewed in the browser          |

> 6665–6669 are on Chrome's blocked-port list, so avoid that range if you want
> the site to open in a browser.

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
| GET    | `/api/requests`                          | the request queue (own, or all for admins) |
| GET    | `/api/status`                            | versions, cache hit rate, uptime     |

Every route requires a session cookie. A `POST` also needs the CSRF token,
either as `_csrf` in a form body or as an `X-CSRF-Token` header.

Errors come back as `{ "error": "...", "status": 404 }`.

## Security notes

Repository content is untrusted input, so it is treated that way:

- **Nothing is public.** Every page and API endpoint requires a session;
  anonymous requests are redirected to the sign-in form (or get a 401 from the
  API). Static assets are the only exception, because the sign-in page needs
  them.
- **Passwords are scrypt-hashed** (N=16384, r=8, p=1) with a per-user salt, and
  the parameters are stored alongside the hash so the cost can be raised later.
  A failed sign-in runs a hash comparison even for an unknown username, so the
  two cases take a similar amount of time.
- **Sessions are HMAC-signed and stateless.** The cookie is `HttpOnly` and
  `SameSite=Strict`, and a tampered or expired token is rejected outright.
- **Every POST is CSRF-checked**, in a global middleware rather than per route.
  Forms send `_csrf`; `fetch()` calls send an `X-CSRF-Token` header, which the
  page exposes in a `<meta>` tag. The token is minted per session, including
  for anonymous visitors so the sign-in form can render.
- **Login attempts are throttled** per IP + username: 8 failures, then a
  15-minute block. Throttling also blocks the correct password, which is the
  point.
- **Creating a repository is the only write path**, and it is deliberately
  narrow: a fixed target directory, a single-segment name, and a request that
  an administrator must approve before anything touches the disk. Windows
  device names (`con`, `nul`, …) are refused so a repository created here still
  works if the volume is shared. If `git init` fails, the half-built directory
  is removed rather than left behind.
- **Repository browsing stays read-only** for everyone. There is no endpoint
  that writes to a repository, pushes, or deletes one.
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
  through an `escapeHtml` helper and emit it with `<%-` (unescaped by EJS) —
  the helper does the escaping, so the two never both run and mangle the text.
  The only other unescaped output is HTML from `renderMarkdown` or `highlight`.
- **A strict CSP** is sent on every response, alongside `nosniff`,
  `X-Frame-Options` and `Referrer-Policy`.

The test suite asserts these properties directly, including attempts to read
`/etc/passwd` through path traversal, to smuggle shell options through refs and
search terms, to approve one's own request, to reuse another session's CSRF
token, to forge a session cookie, and to get a repository created without an
administrator's approval.

Stack traces are hidden from error pages unless `SHOW_STACKS=true`.

Behind a TLS proxy, set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

## Language support

Detection is a three-step cascade, cheapest first:

1. **Filename** — 94 exact matches (`Dockerfile`, `go.mod`, `CMakeLists.txt`,
   `.bashrc`, `build.gradle`) plus a stem rule for suffixed variants
   (`dockerfile.prod`, `makefile.am`).
2. **Extension** — 155 mappings covering the languages highlight.js ships a
   grammar for, resolved through the suffix chain so compound names work:
   `types.d.ts` → `.d.ts` → `.ts`, `view.blade.php` → `.blade.php` → `.php`.
3. **Content** — only when the first two come up empty, the file is sampled and
   a grammar is guessed.

That last step is deliberately conservative, because a wrong label is worse
than an honest one:

- The candidate set excludes obscure grammars (ABNF, lasso, DOS batch) that
  outscore real languages on short samples.
- A guess must clear a relevance threshold of 15. Measured on real files, a
  genuine match scores ~22 while the mis-detections score 5–11, so the
  threshold separates them cleanly.
- The same threshold applies to rendering, so a file that cannot be identified
  is shown as plain text rather than highlighted as something it is not.

Where highlight.js has no grammar at all (Zig, Terraform/HCL, fish, sed), the
file reports plain text instead of borrowing a misleading grammar. Where a
close proxy exists it is used and it is a defensible one: CUDA → C++, GDScript
and `.p` → Python, OpenCL → C, EJS → JavaScript, darcs patches → diff.

The language statistics use the same detector on a bounded sample (the 25
largest unrecognised files), so an unlisted language does not silently merge
into "plain text" — but a file that cannot be identified confidently stays
plain text rather than being miscounted.

Two size guards keep this from becoming a denial of service against yourself:
highlighting a known grammar is skipped above 512 KB, and content sniffing
above 24 KB (64 KB for the statistics), because `highlightAuto` runs every
candidate grammar over its input. Diff lines are never sniffed — that would
run the detector once per line.

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

126 cases across five files, using only `node:test`:

- `test/validate.test.js` — ref, path, and repository-name validation
- `test/render.test.js` — markdown rendering, XSS, diff parsing
- `test/languages.test.js` — the detection cascade, the confidence threshold,
  the size guards, and the claim that every mapped id is a grammar that exists
- `test/auth.test.js` — accounts, sessions, CSRF, role boundaries, and the
  whole request → approve → repository-on-disk flow
- `test/server.test.js` — the real app against a throwaway repository built in
  a temp directory: every page, the whole API, archives, and hostile input

The server suites each build their own repositories and data directory in a
temp folder, so a test run never touches your real `repos/` or `data/`.

## Layout

```
config.js              environment-driven configuration
server/
  index.js             entry point, graceful shutdown
  app.js               express app, security headers, the auth gate
  lib/
    auth.js            passwords, sessions, CSRF, throttling, role checks
    requests.js        repository request queue and name validation
    provision.js       creating the repository once a request is approved
    git.js             git process wrapper, typed errors
    repo.js            everything you can do to one repository
    repos.js           discovery, indexing, search over the registry
    render.js          markdown, syntax highlighting, escaping, sniffing
    view-helpers.js    the `h` object every template uses
    validate.js        input validation and HTTP status mapping
    cache.js           TTL + LRU cache
    languages.js       the detection cascade
  routes/
    auth.js            sign in, register, sign out
    manage.js          request a repository, review requests
    pages.js           HTML routes
    api.js             JSON routes
views/                 EJS templates and partials
public/                stylesheet, client-side JS, favicon
bin/seed.js            creates the sample repositories
repos/                 where repositories are looked for (gitignored)
data/                  accounts, request queue, session key (gitignored)
```

## Requirements

Node.js 20 or newer, and `git` on the `PATH`. No database, no build step.
