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

## Access model

The site is private: every page and every API endpoint requires a signed-in
session, and redirects anonymous visitors to `/login`. Only the sign-in and
registration pages and the static assets are public.

### Who may write

Reading is open to anyone signed in. Writing is not, and the rule is explicit
rather than implied by who happens to own a directory:

- The account that **requested** a repository owns it, and may push to it.
- **Administrators** may write to *any* repository.
- A repository that **nobody has claimed** is read-only — which is the state the
  seeded sample repositories are in, so you have to assign one before anyone can
  change it.

Ownership is recorded in `data/owners.json` when a request is approved, so it
survives a restart. `GET /<owner>/<name>/api/permissions` reports it. Both entry
points — git and the browser — enforce the same check, and both refuse before
anything is written.

### Requesting a repository

Nobody creates a repository directly. A member submits a request with a name, an
optional description and a starting template; the repository does not exist on
disk until an administrator approves it. Approval runs `git init` in the target
directory, writes the template files, makes an initial commit attributed to
**the requester**, and records them as the owner. Rejection leaves nothing
behind, and the requester sees the note the admin left.

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
          │                            │     owner := requester
          │                            ├──▶ queue: approved
          ◀────────────────────────────┘
        sees status + the note
```

Set `ALLOW_SIGNUP=false` once the accounts you need exist; only an
administrator can then create further accounts.

## Getting content in

Two ways, and they produce identical history.

### `git push` and `git clone` over HTTP

The real git smart-HTTP protocol, served by `git http-backend` behind a thin
CGI bridge. The packfile is streamed in both directions and never buffered.

```bash
# once per machine, so git can remember the password
git config --global credential.helper osxkeychain     # macOS
# or: git config --global credential.helper store       # plaintext, be careful

git clone http://<username>@localhost:6600/<owner>/<repo>.git
cd <repo>
git push
```

A 401 with `WWW-Authenticate` is what makes git prompt, so the credential
helper flow works normally. Basic auth failures are throttled on the same
per-IP-plus-username budget as the sign-in form, so this cannot be used to
guess passwords through git more easily than through the browser.

The clone URL is shown on every repository page; the push instructions only
appear for someone who may actually push.

### From the browser

Every repository page has **+ New file**, **Upload files** (with drag and drop),
and per-file **Edit** and **Delete**. Each produces a real commit through git
plumbing — `hash-object`, `update-index --index-info`, `write-tree`,
`commit-tree`, `update-ref` — with the same author format and message shape a
push would, so the history is indistinguishable.

Details that matter:

- A multi-file upload is **one commit**, not one per file.
- Content reaches git on **stdin** and blobs are addressed through a temporary
  index, so nothing is written to a working tree. A bare repository and a
  worktree behave identically, and an interrupted edit cannot leave a
  half-built file behind.
- `update-ref` is called with the previous value, making it a compare-and-swap:
  two people editing at once fails loudly rather than one silently overwriting
  the other.
- Line endings and binary bytes are stored exactly as given. Rendering
  normalises CRLF for display; the download and the editor see the original
  bytes.
- Files are capped at 5 MB, at most 20 per upload, and paths that git reserves
  (`.git`, …) or that try to escape the repository are refused.
- Repositories created through the approval flow get
  `receive.denyCurrentBranch=updateInstead`, so pushing to a worktree repository
  updates the working tree instead of being refused.

To get files *out*, use the tar.gz/zip download on any repository page, or a
file's `raw` link — both byte-faithful.

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

156 cases across six files, using only `node:test`:

- `test/validate.test.js` — ref, path, and repository-name validation
- `test/render.test.js` — markdown rendering, XSS, diff parsing
- `test/languages.test.js` — the detection cascade, the confidence threshold,
  the size guards, and the claim that every mapped id is a grammar that exists
- `test/auth.test.js` — accounts, sessions, CSRF, role boundaries, and the
  whole request → approve → repository-on-disk flow
- `test/write.test.js` — git clone and push over HTTP end to end, browser edits,
  byte fidelity for CRLF and binary content, and the write-permission boundary
- `test/server.test.js` — the real app against a throwaway repository built in
  a temp directory: every page, the whole API, archives, and hostile input

The server suites each build their own repositories and data directory in a
temp folder, so a test run never touches your real `repos/` or `data/`.

`test/git-http-e2e.sh` is a shell-level end-to-end check against a running
server, for when you want to watch a real `git clone` and `git push`:

```bash
npm start &
BASE=http://localhost:6600 AUTH=you:yourpassword OWNER=repos \
  bash test/git-http-e2e.sh
```

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
    git-http.js        the git-http-backend CGI bridge
    upload.js          commits built by the browser
    access.js          who may write to which repository
    binary.js          the text/binary heuristic, shared
    repo.js            everything you can do to one repository
    repos.js           discovery, indexing, search over the registry
    render.js          markdown, syntax highlighting, escaping, sniffing
    view-helpers.js    the `h` object every template uses
    validate.js        input validation and HTTP status mapping
    cache.js           TTL + LRU cache
    languages.js       the detection cascade
  routes/
    auth.js            sign in, register, sign out
    git.js             clone and push over HTTP
    manage.js          request a repository, review requests
    upload.js          the editor, uploads, deletes
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
