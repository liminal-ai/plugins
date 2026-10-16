# Fork maintenance: liminal-ai/pstack-lim

Fork of `cursor/plugins`, default branch `lim`. Fork point: upstream `11713c6` (pstack 0.15.17). Install only from `pstack/`, never the repo root; for the `/orchestrate` name clash see `poteto-help`. Role-file setup lives in `setup-pstack`.

## Upstream drift

```bash
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/cursor/plugins.git
git fetch --multiple upstream origin
git log --oneline 11713c6..upstream/main -- pstack cursor-team-kit/skills   # upstream commits since fork
git show upstream/main:pstack/.cursor-plugin/plugin.json | rg version        # upstream pstack version
comm -12 <(git diff --name-only 11713c6 upstream/main -- pstack | sort) \
         <(git diff --name-only 11713c6 origin/lim -- pstack | sort)        # changed on both sides
```

## Copied cursor-team-kit skills

| Skill in pstack-lim | Upstream path | Matching upstream commit | Local edits |
|---|---|---|---|
| `pstack/skills/deslop/SKILL.md` | `cursor-team-kit/skills/deslop/SKILL.md` | `b21ab16`, byte-identical | none |
| `pstack/skills/control-cli/SKILL.md` | `cursor-team-kit/skills/control-cli/SKILL.md` | `d018dc4`, byte-identical | none |
| `pstack/skills/control-ui/SKILL.md` | `cursor-team-kit/skills/control-ui/SKILL.md` | `d018dc4`, byte-identical at the copy | drops the `verify-this` pointer, counts T3's browser preview tools |

Check: `git log --oneline <commit>..upstream/main -- cursor-team-kit/skills/<name>` and `git diff upstream/main:cursor-team-kit/skills/<name>/SKILL.md origin/lim:pstack/skills/<name>/SKILL.md`. To refresh, `git show upstream/main:...` over the copy, re-apply the control-ui edit, put the source commit in the commit message and update this table.

## Syncing upstream

Always a branch and a PR into `lim`, never a direct push. If many files changed on both sides, expect a re-port rather than a merge. Triage each file by the port rule: assume upstream already handles the concern, and keep a port change only where T3 needs it (`delegate_task`, the role file, `origin/lim`, the pstack store, the wake mechanism, todo-file placement). Then check:

```bash
rg -n "show origin/lim:" pstack/skills/poteto-mode/scripts/check-plan.mjs
rg -n "~/lim-v2/AGENTS.md" pstack/skills/setup-pstack/SKILL.md
(cd pstack/skills/poteto-mode/scripts && bun install --frozen-lockfile && bun test)
```

## Deploying

Installs are copies, so a merge changes nothing until a reinstall. Only the hourly audit ticks in autopilot-full, autopilot-stack and multi-phase-plan re-read playbooks from `origin/lim` (`check-plan.mjs` requires plans to include that re-read), so a merge without a reinstall splits running programs between new playbooks and old skills and scripts. Merge, then reinstall at once for each user with the install steps in `poteto-help` (rsync `pstack/skills/*` into `~/.agents/skills`, link `~/.claude/skills/<name>`, copy `pstack/agents`). Verify: `diff -r pstack/skills/<name> ~/.agents/skills/<name>`.

## bun

Installed for leemoore at `~/.bun/bin/bun`, on `PATH` only through `~/.bash_profile`. The running `t3 serve` process's `PATH` doesn't include it, so shells that skip login init can't find it. Check with `command -v bun` in the shell that will run orchestrate.
