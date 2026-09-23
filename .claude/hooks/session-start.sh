#!/bin/bash
# Bring a fresh cloud session up to date before work starts: the working
# branches fetched, the checked-out branch fast-forwarded, and the Node test
# dependencies present. Cloud sessions only; a local checkout is left alone.
#
# Nothing here may fail the session. A network error or a diverged branch is
# reported and the session starts on what it has.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

if ! git fetch --quiet origin pilot-working tab5-working; then
  echo "session-start: fetch failed; working from the existing checkout."
fi

# Fast-forward only, and only a clean tree: never merge, rebase or disturb
# work in progress. A detached HEAD or a branch without a remote is skipped.
branch=$(git symbolic-ref --quiet --short HEAD || true)
if [ -n "$branch" ] && git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
  before=$(git rev-parse --short HEAD)
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "session-start: $branch has local changes; not updated."
  elif git merge --ff-only --quiet "origin/$branch" 2>/dev/null; then
    after=$(git rev-parse --short HEAD)
    [ "$before" != "$after" ] && echo "session-start: $branch fast-forwarded $before -> $after."
  else
    echo "session-start: $branch has diverged from origin/$branch; not updated."
  fi
fi

# npm ci only when the installed tree is missing or older than the lockfile.
# npm records what it installed in node_modules/.package-lock.json.
if [ -f package-lock.json ]; then
  installed=node_modules/.package-lock.json
  if [ ! -f "$installed" ] || [ package-lock.json -nt "$installed" ]; then
    if npm ci --no-audit --no-fund --loglevel=error >/dev/null; then
      echo "session-start: npm dependencies installed."
    else
      echo "session-start: npm ci failed; run it by hand before npm test."
    fi
  fi
fi

exit 0
