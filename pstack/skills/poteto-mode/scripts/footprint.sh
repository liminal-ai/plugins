#!/usr/bin/env bash
# Records what is running and present on this machine, so cleanup can see what a run added.
#
#   footprint.sh snapshot <run-dir> <before|after> [repo ...]
#   footprint.sh diff <run-dir>
#
# snapshot writes <run-dir>/footprint-<label>.txt. diff prints the lines only in
# footprint-after.txt (added during the run) and only in footprint-before.txt (gone).
# A line names a resource, never a value, so the files hold no secrets.
set -euo pipefail

usage() { echo "usage: footprint.sh snapshot <run-dir> <before|after> [repo ...] | footprint.sh diff <run-dir>" >&2; exit 2; }

section() { awk -v tag="$1" '{print tag "\t" $0}'; }

# Keeps a route's scheme, host, port and path, and drops userinfo, query and fragment, which can carry tokens.
scrub() { sed -E 's#://[^/@ ]*@#://#g; s#[?\#][^ ]*##g'; }

ports() {
	if command -v ss >/dev/null 2>&1; then
		ss -Hltnp 2>/dev/null | awk '{p=$6; sub(/.*\(\("/, "", p); sub(/".*/, "", p); print $4 "\t" p}' || true
	elif command -v lsof >/dev/null 2>&1; then
		{ lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR > 1 {print $9 "\t" $1}'
	fi | sort -u
}

units() {
	if command -v systemctl >/dev/null 2>&1; then
		{ systemctl --user list-units --type=service,timer --state=running,active --no-legend --plain 2>/dev/null || true; } | awk '{print $1}'
	elif command -v launchctl >/dev/null 2>&1; then
		{ launchctl list 2>/dev/null || true; } | awk 'NR > 1 && $3 !~ /^com\.apple\./ {print $3}'
	fi | sort -u
}

routes() {
	command -v tailscale >/dev/null 2>&1 || return 0
	{ tailscale serve status 2>/dev/null || true; } | grep -E 'https?://|tcp://|\|--' | scrub || true
	{ tailscale funnel status 2>/dev/null || true; } | grep -E 'https?://|tcp://|\|--' | scrub | sed 's/^/funnel /' || true
}

containers() {
	command -v docker >/dev/null 2>&1 || return 0
	docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | sort || true
}

tmux_sessions() {
	command -v tmux >/dev/null 2>&1 || return 0
	tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true
}

tmp_entries() {
	find /tmp -mindepth 1 -maxdepth 1 -user "$(id -u)" 2>/dev/null | sort
}

repo_state() {
	local repo=$1
	git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "$repo	not a git repo"; return 0; }
	git -C "$repo" worktree list --porcelain | awk '/^worktree /{print "worktree\t" $2}'
	git -C "$repo" for-each-ref --format='branch	%(refname:short)' refs/heads
	git -C "$repo" stash list --format='stash	%gd %h' 2>/dev/null || true
}

snapshot() {
	local dir=$1 label=$2; shift 2
	case "$label" in before|after) ;; *) usage ;; esac
	mkdir -p "$dir"
	local out="$dir/footprint-$label.txt"
	{
		ports | section port
		units | section unit
		routes | section route
		containers | section container
		tmux_sessions | section tmux
		tmp_entries | section tmp
		local repo
		for repo in "$@"; do repo_state "$repo" | section "repo $repo"; done
	} > "$out"
	echo "$out"
}

diff_run() {
	local dir=$1 before="$1/footprint-before.txt" after="$1/footprint-after.txt"
	[ -f "$before" ] || { echo "error: no $before; take the before snapshot at the start of the run" >&2; exit 1; }
	[ -f "$after" ] || { echo "error: no $after; run: footprint.sh snapshot $dir after <repo ...>" >&2; exit 1; }
	echo "# added during the run"
	comm -13 <(sort "$before") <(sort "$after") | sed 's/^/+ /'
	echo "# gone during the run"
	comm -23 <(sort "$before") <(sort "$after") | sed 's/^/- /'
}

case "${1:-}" in
	snapshot) [ $# -ge 3 ] || usage; shift; snapshot "$@" ;;
	diff) [ $# -eq 2 ] || usage; diff_run "$2" ;;
	*) usage ;;
esac
