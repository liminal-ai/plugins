#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent T3 thread bound
# to it. Emits a table sorted by size with a suggested bucket. Never deletes
# anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [--threads <tsv>] [repo-path]   (defaults to the current repo)
# The threads TSV has the header worktree, thread, status, updated: one row per
# T3 thread, with its worktreePath, threadId, status and ISO-8601 updatedAt.
set -u

threads=""
if [ "${1:-}" = "--threads" ]; then
	threads="${2:-}"
	[ -r "$threads" ] || { echo "cannot read threads TSV: $threads" >&2; exit 1; }
	shift 2
fi

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')

# origin/main drives the merge check. Best-effort; stale is fine for a first pass.
git fetch origin main --quiet 2>/dev/null || echo "warn: could not fetch origin/main; merged column may be stale" >&2

# PR state by branch, fetched once. Empty if gh is unavailable.
prs=$(mktemp)
gh pr list --author "@me" --state all --limit 1000 \
	--json number,state,headRefName 2>/dev/null > "$prs" || echo "[]" > "$prs"

[ -z "$threads" ] && echo "warn: no --threads export; LAST_CHAT is unknown for every worktree" >&2
now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	# Squash-merged branches are not ancestors of main, so PR state is the
	# real signal; merge-base only catches fast-forward/rebase merges.
	git merge-base --is-ancestor "$head" origin/main 2>/dev/null && merged=YES || merged=no

	# Distinguish real WIP (tracked edits) from disposable untracked scratch.
	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
		dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
	else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if [ -z "$branch" ]; then remote=detached
	elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
		[ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
			&& remote=pushed \
			|| remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
	else remote=no-remote; fi

	pr=$([ -n "$branch" ] && jq -r --arg b "$branch" \
		'.[] | select(.headRefName==$b) | "#\(.number)/\(.state)"' "$prs" 2>/dev/null | head -1)
	[ -z "$pr" ] && pr="-"

	# Most recent T3 thread bound to this worktree. Exact path match, so
	# glint-482 does not match glint-482-r37. A thread still in a run counts
	# as recent however old its last update.
	last="-"; last_ts=0; active=no
	if [ -n "$threads" ]; then
		row=$(awk -F'\t' -v w="$wt" 'NR > 1 && $1 == w {print $4 "\t" $3}' "$threads" | sort -r | head -1)
		if [ -n "$row" ]; then
			last_ts=$(date -d "${row%%$'\t'*}" +%s 2>/dev/null || echo 0)
			last=$(date -d "@$last_ts" '+%Y-%m-%d' 2>/dev/null || echo "?")
			awk -F'\t' -v w="$wt" 'NR > 1 && $1 == w {print $3}' "$threads" \
				| grep -qxE 'preparing|queued|starting|running|waiting' && active=yes
		fi
	fi
	recent=$({ [ "$active" = yes ] || { [ "$last_ts" -gt 0 ] 2>/dev/null && [ $(( (now - last_ts) / 86400 )) -le 4 ]; }; } && echo yes || echo no)

	case "$dirty" in wip:*) bucket=hold-wip ;; *)
		case "$pr" in *OPEN*) bucket=hold-open-pr ;; *)
			if [ "$recent" = yes ]; then bucket=verify-recent-chat
			elif [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
			else bucket=review; fi ;;
		esac ;;
	esac

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh

rm -f "$prs"
