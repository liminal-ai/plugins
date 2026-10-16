# Fork maintenance: liminal-ai/pstack-lim and liminal-ai/t3code-v2

Checked read-only on 2026-10-16. Recommended home: a root `FORK.md` in pstack-lim on branch `lim`, next to `pstack/`, because it covers the whole fork. The pstack plugin folder ships to users, so keep it out of there. The t3code-v2 section can be moved into a `FORK.md` at the root of t3code-v2. Neither repo has a `FORK.md` today; t3code-v2's `fork/` was removed by the revert.

## Facts this doc relies on

| Item | Value |
|---|---|
| Fork | `liminal-ai/pstack-lim`, a GitHub fork of `cursor/plugins`. Default branch `lim`. The old name `liminal-ai/plugins` redirects here. |
| Fork point | upstream `11713c6`, 2026-10-11, pstack 0.15.5 |
| `lim` vs the fork's own `main` | 41 ahead, 0 behind. The fork's `main` is a stale copy of upstream, so this number says nothing about upstream drift. |
| `lim` vs upstream `cursor/plugins` main | upstream is 55 commits past the fork point (head `f713f14`, 2026-10-15). Upstream pstack is now **0.15.25**; `lim` is on 0.15.5. |
| Submodules / registry links | none. Everything pstack needs is in-tree. |

Setup for every command below:

```bash
git clone -b lim https://github.com/liminal-ai/pstack-lim.git && cd pstack-lim
git remote add upstream https://github.com/cursor/plugins.git
git fetch upstream
```

## 1. The copied cursor-team-kit skills

On Oct 11 (12:52 AM ET), commit `3611ea1` "bring deslop, control-ui and control-cli into the pack" copied three skills verbatim from `cursor-team-kit/skills/` into `pstack/skills/`. No source version was recorded. These are the matches found by comparing contents against upstream history:

| Skill in pstack-lim | Upstream path | Matching upstream commit | Local edits since |
|---|---|---|---|
| `pstack/skills/deslop/SKILL.md` | `cursor-team-kit/skills/deslop/SKILL.md` | `b21ab16` (2026-02-17), byte-identical | none |
| `pstack/skills/control-cli/SKILL.md` | `cursor-team-kit/skills/control-cli/SKILL.md` | `d018dc4` (2026-04-30), byte-identical | none |
| `pstack/skills/control-ui/SKILL.md` | `cursor-team-kit/skills/control-ui/SKILL.md` | `d018dc4`, byte-identical at the copy | +1/-2 lines (removes the `verify-this` pointer, counts T3's browser preview tools) |

Those are also the latest upstream commits for all three files, so as of 2026-10-16 the copies are current.

**Check for upstream changes:**

```bash
git fetch upstream
for s in deslop control-ui control-cli; do
  echo "== $s"
  git log --oneline d018dc4..upstream/main -- cursor-team-kit/skills/$s   # control-*
  git log --oneline b21ab16..upstream/main -- cursor-team-kit/skills/$s   # deslop
  git diff upstream/main:cursor-team-kit/skills/$s/SKILL.md lim:pstack/skills/$s/SKILL.md
done
```

No log output means nothing changed upstream. For control-ui the diff should show only the local edit.

**Refresh on purpose:**

```bash
SRC=$(git rev-parse --short upstream/main)
for s in deslop control-cli control-ui; do
  git show $SRC:cursor-team-kit/skills/$s/SKILL.md > pstack/skills/$s/SKILL.md
done
# re-apply the control-ui edit: drop the verify-this pointer, keep the T3 browser preview line
git commit -am "pstack: refresh deslop, control-ui, control-cli from cursor/plugins $SRC"
```

Put the source commit in the commit message and update the table above. Also check whether upstream added files beside `SKILL.md` in those folders (today each folder has only `SKILL.md`).

## 2. The orchestrate name clash

| | pstack's Orchestrate (use this one on T3) | Cursor's orchestrate plugin |
|---|---|---|
| Where | `pstack/skills/poteto-mode/playbooks/orchestrate.md`, plus `pstack/skills/poteto-mode/scripts/orch/` | `orchestrate/` plugin in cursor/plugins (v1.1.0, by Cursor), skill `orchestrate/skills/orchestrate` |
| How it's invoked | through `/poteto-mode`, never as `/orchestrate` | `/orchestrate` slash command |
| What it does | one standing coordinator, `delegate_task` owners, state under `orchestrate/<slug>/` in the pstack store; ported to T3 on Oct 15 | fans work out to Cursor cloud agents through the Cursor SDK |

pstack does not depend on the plugin. Its own `poteto-help` says: "pstack has no `/orchestrate` skill. Orchestrate is a `/poteto-mode` playbook. If the slash menu shows `/orchestrate`, another plugin provides it."

**If both are installed:** `/orchestrate` runs Cursor's SDK plugin, not the T3 port, and it bypasses the role file, `delegate_task` and the pstack store. Don't install the orchestrate plugin per user on T3 machines. To check, look for an `orchestrate` folder in the user skill dirs (`~/.agents/skills`, `~/.claude/skills`). Only `poteto-mode` should carry orchestrate.

The fork's tree still contains `orchestrate/` (it carries all of cursor/plugins). That's harmless unless something installs from the repo root instead of `pstack/`.

## 3. The lim branch and upstream merges

The T3 port reads pstack from the fork itself:
- `pstack/skills/poteto-mode/scripts/check-plan.mjs` requires the marker `show origin/lim:` (changed from `git show origin/main:`).
- The autopilot audit tick re-reads the playbook from `origin/lim` on every tick.

That means a push to `lim` reaches running programs at their next tick, with no install step. Treat every push to `lim` as a deploy.

**Merge upstream** (upstream pstack is 20 releases ahead and touches files the port changed, such as orchestrate, autopilot and ketchup, so expect conflicts):

```bash
git fetch upstream
git log --oneline lim..upstream/main -- pstack cursor-team-kit/skills   # what's coming
git switch -c sync/upstream-$(git rev-parse --short upstream/main) lim
git merge upstream/main          # resolve conflicts in favour of the T3 port's behaviour
# then check:
rg -n "show origin/lim:" pstack/skills/poteto-mode/scripts/check-plan.mjs
rg -n "~/lim-v2/AGENTS.md" pstack/skills/setup-pstack/SKILL.md
rg -n "cursor-team-kit" pstack     # should only appear where intended
(cd pstack/skills/poteto-mode/scripts && bun test)   # orch tests
```

Open the merge as a PR into `lim`. Don't push it straight to `lim`. Note the new upstream base in the PR body. Also rerun the section 1 check, because a merge doesn't touch the copied skills (they live under `pstack/`, the upstream copies under `cursor-team-kit/`).

**When pstack-lim updates:** refresh each user's install (section 5) if it's a copy rather than a link to the checkout. Running programs pick up playbooks from `origin/lim` by themselves.

## 4. bun (deploy prerequisite)

`orch.ts`, `bootstrap.ts`, the `package.json` scripts, the orchestrate and worktree-cleanup playbooks, and the reflect synthesizer all call `bun`.

lim-builder result (2026-10-16, ro-agents): `which bun` finds nothing on ro-agents' PATH, and there's no `/usr/local/bin/bun` or `/opt/*/bun`. `~/.bun` and `~/.local/bin` for leemoore are not readable by ro-agents. **Unverified:** whether bun is installed for leemoore, which is the account T3 runs as.

Before a T3 lead runs Orchestrate or Worktree cleanup, run as the T3 user: `command -v bun && bun --version`. If that fails, install bun for that user first.

## 5. The per-user install

Lee's comment on t3code-v2 (Oct 13): pstack is installed per user in `~/.agents/skills`, linked from `~/.claude/skills`, "as a Cursor plugin would be". The repo keeps only its own generated verify skills.

How the T3 port finds it:
- **Role file:** `~/lim-v2/AGENTS.md`. `~/lim-v2/CLAUDE.md` is a symlink to it; never write it as a regular file.
- **`/setup-pstack`** writes the fenced block under `## pstack roles` into `AGENTS.md` only. The block holds the `# budget` line, one model per role, a `cloud workers` line (default `cursor-cloud`) and a `counterparts` line.
- **Playbooks** read these lines from the role file: `pstack store` (plan files and `orchestrate/<slug>/`), the wake mechanism, and `cloud workers`.

**Unverified on lim-builder:** the actual `~/.agents/skills`, `~/.claude/skills` and `~/lim-v2` for leemoore. ro-agents can't read them. Also unknown: whether the install is a copy or a symlink into a pstack-lim checkout, and which commit it's on. As the T3 user, check:

```bash
ls -la ~/.claude/skills ~/.agents/skills | head
readlink -f ~/.claude/skills
git -C "$(dirname "$(readlink -f ~/.agents/skills/poteto-mode)")" log -1 --oneline 2>/dev/null
```

## 6. t3code-v2

- `liminal-ai/t3code-v2` is upstream T3 nightly (to 2026-10-11) plus the lim artifacts patch series.
- The only merged lim feature is running Cursor threads on Cursor Cloud (Oct 13).
- The vendored-pstack commit was reverted, and the install PR was closed in favour of the per-user install.
- The repo has `.macroscope/` and `.coderabbit.config.ts` from upstream; Codex review runs on PRs.
- Service on lim-builder: `~/lim-v2/service/t3code/prod` (`t3 serve`, 127.0.0.1:13987), seen in the process list only.
- No upstream-sync procedure is written down yet.

## 7. Lim Health (placeholder)

Private repo under `leegmoore`. As of 2026-10-16 it's not visible to the Cursor GitHub app (tried `lim-health` and `limhealth`), so the exact name is unconfirmed. To fill in once access exists: repo name, what the revived initial project is, build/deploy steps, and which pstack version it relies on.
