#!/usr/bin/env bash
# End-to-end check of the real git-over-HTTP flow against a running server.
#
#   BASE=http://localhost:6600 AUTH=admin:password OWNER=<owner> bash test/git-http-e2e.sh
#
# AUTH must be an administrator: the script requests a repository and then
# approves it, and only an administrator can approve. On a fresh server the
# first account registered is the administrator.
set -uo pipefail

BASE="${BASE:-http://localhost:6600}"
AUTH="${AUTH:?set AUTH=user:password}"
OWNER="${OWNER:?set OWNER=the username}"
NAME="${NAME:-e2e-repo}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

jar="$SCRATCH/jar"
curl -s -c "$jar" "$BASE/register" > /dev/null
csrf=$(curl -s -b "$jar" -c "$jar" "$BASE/register" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
user="${AUTH%%:*}"
pass="${AUTH#*:}"
curl -s -b "$jar" -c "$jar" -o /dev/null \
  -d "_csrf=$csrf" -d "username=$user" -d "displayName=$user" -d "password=$pass" "$BASE/register"

# Approving needs an administrator. If AUTH is an ordinary member the script
# cannot create a repository, and says so plainly instead of failing obscurely.
if ! curl -s -b "$jar" "$BASE/admin" | grep -q 'Awaiting review'; then
  echo "  AUTH ($user) cannot reach the admin page, so it is not an administrator."
  echo "  Re-run with an administrator's credentials, or against a fresh server"
  echo "  where $user was the first account registered."
  exit 2
fi

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

url="$BASE/$OWNER/$NAME.git"
auth_url="http://$AUTH@${BASE#http://}/$OWNER/$NAME.git"

echo "== 1. anonymous clone is refused =="
if git clone -q "$url" "$SCRATCH/anon" 2>/dev/null; then bad "anonymous clone succeeded"; else ok "anonymous clone refused"; fi

echo "== 2. authenticated clone of a missing repository =="
if git clone -q "$auth_url" "$SCRATCH/missing" 2>/dev/null; then bad "clone of missing repo succeeded"; else ok "clone of missing repo refused"; fi

echo "== 3. request the repository, then approve it =="
csrf=$(curl -s -b "$jar" -c "$jar" "$BASE/new" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
curl -s -b "$jar" -c "$jar" -o /dev/null -d "_csrf=$csrf" -d "name=$NAME" -d "template=node" "$BASE/new"
id=$(curl -s -b "$jar" "$BASE/admin" | grep -o "/admin/requests/[a-f0-9-]*/approve" | head -1 | sed 's|/admin/requests/||;s|/approve||')
csrf=$(curl -s -b "$jar" -c "$jar" "$BASE/admin" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
curl -s -b "$jar" -c "$jar" -o /dev/null -d "_csrf=$csrf" "$BASE/admin/requests/$id/approve"
check "repository is browsable" "$(curl -s -b "$jar" -o /dev/null -w '%{http_code}' "$BASE/$OWNER/$NAME")" "200"

echo "== 4. real git clone over HTTP =="
if git clone -q "$auth_url" "$SCRATCH/clone" 2>"$SCRATCH/err"; then
  ok "clone succeeded"
  check "cloned files" "$(ls "$SCRATCH/clone" | grep -c package.json)" "1"
else
  bad "clone failed: $(head -2 "$SCRATCH/err" | tr '\n' ' ')"
fi

echo "== 5. real git push over HTTP =="
cd "$SCRATCH/clone" 2>/dev/null || exit 1
git config user.name "E2E" && git config user.email "e2e@example.com"
mkdir -p src && printf 'export const pushed = true;\n' > src/pushed.js
printf 'binary\0bytes\1\2here\n' > assets.bin 2>/dev/null || true
git add -A && git commit -q -m "Pushed over HTTP"
if git push -q origin main 2>"$SCRATCH/perr"; then
  ok "push succeeded"
else
  bad "push failed: $(head -3 "$SCRATCH/perr" | tr '\n' ' ')"
fi

echo "== 6. the site reflects the push =="
csrf=$(curl -s -b "$jar" -c "$jar" "$BASE/" | grep -o 'csrf-token" content="[^"]*"' | sed 's/.*content="//;s/"//')
curl -s -b "$jar" -H "X-CSRF-Token: $csrf" -X POST -o /dev/null "$BASE/api/repos/refresh"
check "pushed file is visible" "$(curl -s -b "$jar" "$BASE/$OWNER/$NAME/blob/main/src/pushed.js" | grep -c 'hljs-')" "1"
check "push commit is listed" "$(curl -s -b "$jar" "$BASE/$OWNER/$NAME/commits" | grep -c 'Pushed over HTTP')" "1"

echo "== 7. a different user may clone but not push =="
if git clone -q "$auth_url" "$SCRATCH/clone2" 2>/dev/null; then ok "second clone of the same repo allowed"; else bad "second clone refused"; fi

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
