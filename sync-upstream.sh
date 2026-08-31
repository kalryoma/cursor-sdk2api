#!/usr/bin/env bash

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash changes before syncing." >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Switch to main before syncing upstream." >&2
  exit 1
fi

readonly service="gui/$(id -u)/com.kalryoma.cursor-sdk2api"
readonly build_stamp="$HOME/Library/Application Support/cursor-sdk2api/build-input.sha256"

if ! launchctl print "$service" >/dev/null 2>&1; then
  echo "The cursor-sdk2api LaunchAgent is not loaded." >&2
  exit 1
fi

git fetch origin
git fetch upstream

origin_main=$(git rev-parse origin/main)
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "origin/main has commits missing from local main; reconcile them first." >&2
  exit 1
fi

if git merge-base --is-ancestor upstream/main HEAD; then
  echo "main is already up to date with upstream/main."
  exit 0
fi

git rebase upstream/main
git push --force-with-lease="refs/heads/main:$origin_main" origin main

rm -f "$build_stamp"
launchctl kickstart -k "$service"
echo "Rebuild and background restart started through launchd."
