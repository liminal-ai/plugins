#!/usr/bin/env bash
# Prints a hash of the whole-PR change from <merge-base> to <head>, for Shipping step 3's
# verdict reuse. Two hashes match only when every changed path has the same blob ids.
# Exits non-zero, printing nothing on stdout, when it cannot vouch for the hash.
# Usage: verdict-hash.sh <merge-base> <head>
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: verdict-hash.sh <merge-base> <head>" >&2; exit 2; }

# Replace refs and grafts can make one commit read as another.
export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null

base=$(git rev-parse --verify --quiet "$1^{commit}") || { echo "error: not a commit: $1" >&2; exit 1; }
head=$(git rev-parse --verify --quiet "$2^{commit}") || { echo "error: not a commit: $2" >&2; exit 1; }

# diff-tree is plumbing, so textconv, diff.relative and diff.ignoreSubmodules do not apply.
change=$(git diff-tree -r --no-renames --full-index --abbrev=40 "$base" "$head")
[ -n "$change" ] || { echo "error: no change between $base and $head" >&2; exit 1; }

printf '%s\n' "$change" | sha256sum | cut -d' ' -f1
