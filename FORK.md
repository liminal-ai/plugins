# Fork maintenance: liminal-ai/pstack-lim

Read this file before you merge from upstream, push, open a PR, or merge one.

Fork of `cursor/plugins`, default branch `lim`. Fork point: upstream `11713c6` (pstack 0.15.17). Last synced: upstream `4dd1d05` (pstack 0.15.36), recorded in `FORK-SYNC-LOG.md`. Install only from `pstack/`, never the repo root; for the `/orchestrate` name clash see `poteto-help`. Role-file setup lives in `setup-pstack`.

## Upstream drift

```bash
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/cursor/plugins.git
git fetch --multiple upstream origin
SYNC=4dd1d05   # last synced upstream commit; set it to the new tip after each sync
git log --oneline $SYNC..upstream/main -- pstack cursor-team-kit/skills     # upstream commits since the last sync
git show upstream/main:pstack/.cursor-plugin/plugin.json | rg version        # upstream pstack version
comm -12 <(git diff --name-only $SYNC upstream/main -- pstack | sort) \
         <(git diff --name-only 11713c6 origin/lim -- pstack | sort)        # changed upstream since the sync and in the fork
```

## Copied cursor-team-kit skills

| Skill in pstack-lim | Upstream path | Matching upstream commit | Local edits |
|---|---|---|---|
| `pstack/skills/deslop/SKILL.md` | `cursor-team-kit/skills/deslop/SKILL.md` | `b21ab16`, byte-identical | none |
| `pstack/skills/control-cli/SKILL.md` | `cursor-team-kit/skills/control-cli/SKILL.md` | `d018dc4`, byte-identical at the copy | keeps the harness in the run folder, not `/tmp` (Scratch row) |
| `pstack/skills/control-ui/SKILL.md` | `cursor-team-kit/skills/control-ui/SKILL.md` | `d018dc4`, byte-identical at the copy | drops the `verify-this` pointer, counts T3's browser preview tools, saves screenshots in the run folder (Scratch row) |

Check: `git log --oneline <commit>..upstream/main -- cursor-team-kit/skills/<name>` and `git diff upstream/main:cursor-team-kit/skills/<name>/SKILL.md origin/lim:pstack/skills/<name>/SKILL.md`. To refresh, `git show upstream/main:...` over the copy, re-apply the control-ui edit, put the source commit in the commit message and update this table.

## T3 port intent

pstack upstream is written for Cursor. This fork runs it from T3 Code, where one lead thread delegates across providers (Claude, Codex, Cursor) through T3's own tools. The skills are rewritten in place for T3, not translated at runtime, so an agent reading a skill sees only T3 instructions. Each row is a difference the fork keeps on purpose. When upstream changes text in one of these areas, keep upstream's new idea and express it the fork's way. `scripts/check-t3-port.mjs` enforces the rows it can.

| Area | Upstream says | The fork says | Why |
|---|---|---|---|
| Subagents | Cursor `Task` with `subagent_type`, `readonly`, `environment` | a T3 `delegate_task` child, `mode: "async"`, with an explicit `target` (omitted only when the role line says `auto` or `inherit-parent`) | Only T3's tool reaches every provider from one lead. A child's task ends with its turn, so its brief tells it never to end the turn to wait. |
| Model per role | `~/.cursor/rules/pstack-models.mdc`, slugs such as `grok-4.7-xhigh-fast` | the pstack roles block in `~/lim-v2/AGENTS.md`, entries `<providerInstanceId>/<model> <option>=<value>` | Every harness under `~/lim-v2` reads that one file, and T3 takes provider, model and options as separate fields. |
| Speed | a `-fast` slug, used when the job is urgent | Grok and GPT may run fast freely. Claude fast mode only on work the operator names in the session, and only that work. Retries, reviewers, verifiers and later tasks are covered only if the operator names them too. | Grok usage is plentiful. Claude fast mode spends rate limit fast, and a broad reading of one approval gets out of hand. |
| Effort | each spawn raises or lowers the role's effort for the job, up to max | each spawn keeps the role line's effort for judgment, review and design, may lower it for routine work, and never raises it above the role line | A raise spends Claude rate limit per spawn, and the `hardest tasks` line already covers the hardest work, so the role file stays the single source of model choice. |
| Waking | Cursor background agents and polling scripts | T3 `watch_pull_request`, child-completion wakes, and a fallback heartbeat per "Waking and polling" in `~/lim-v2/AGENTS.md` | A T3 lead that ends its turn is woken only by an event. A heartbeat covers what the watch misses. |
| Todo list | the harness's todo tool | a T3 thread workflow, fitted to the task in a handful of steps and ending in a cleanup step, when thread workflows are on. Otherwise the harness's todo tool if it has one, or a checklist file under `todos/` in the pstack store, named in the first message | The operator watches a thread's workflow in T3, and it survives a pause and a pickup. T3's Claude harness has no todo tool, and a file also survives a pause and a pickup. |
| Trunk | `origin/main` | `origin/lim` for pstack itself, the repo's default branch elsewhere | The fork's default branch is `lim`. Hourly audit ticks re-read playbooks from `origin/lim`. |
| Skill visibility | `disable-model-invocation: true` on leaf skills | every skill visible, its description ending "Use only when the user or another skill names it." The exceptions are `control-cli`, `control-ui`, `deslop` and `setup-pstack`, which load from the user's own wording on purpose. | Hidden skills made Claude's Skill tool refuse them even when poteto-mode named them. |
| Install | Cursor plugin, or a generated Claude Code or Codex tree | one per-user copy in `~/.agents/skills`, linked from `~/.claude/skills`, agents in `~/.agents/agents` | One install serves every provider T3 runs. Skills point at those absolute paths. |
| Visuals | Mermaid diagrams, `/visualize` charts and canvases, generated images, screenshots and videos from Cursor's tools | charts and diagrams on a self-contained HTML page checked with `html_preview` and published with `html_render`, screenshots from the control skill or `preview_snapshot` with `save: true`, recordings from `preview_recording_start` and `preview_recording_stop`, embedded as `![alt](path)` | T3 renders an `html_render` page above the reply and embeds local images and videos by path. It has no `/visualize` or image tool. |
| Scratch | `/tmp` paths for scratch, harnesses, candidate output and screenshots | `<project>/.pstack/runs/<run>/` in the project's main checkout, with `scratch/` and `proof/`, ignored by git; cleanup runs `references/cleanup-protocol.md` against it | `/tmp` filled with tens of gigabytes that nothing tracked, and verdicts cited reports there. A folder per run in the project gives cleanup one place to look and keeps proof out of worktrees. |
| Fix target | upstream issues | a PR to `liminal-ai/pstack-lim` against `lim`, then a reinstall | A broken skill gets fixed in this fork, never worked around. |

## Syncing upstream

Always a branch and a PR into `lim`, never a direct push. If many files changed on both sides, expect a re-port rather than a merge. Steps:

1. List upstream's commits since the last sync point (`SYNC` above) in a new `FORK-SYNC-LOG.md` table, one row each, marked take, adapt or skip with a reason. A row skipped in an earlier sync stays skipped unless upstream reworked it. After the last PR merges, set `SYNC` and the "Last synced" line to the new tip.
2. Port by the table above. Assume upstream already handles the concern, keep upstream's new behavior, and change only what a row requires.
3. Run the checks. The drift check fails with a message that names the fix. If the check is wrong, fix the check in the same PR and say why.
4. For each upstream commit, confirm every behavior it claims is in the fork, adapted with the row named, or dropped with the reason logged.
5. Have a reviewer from the other model family read the diff against this section before merging.

```bash
node scripts/check-t3-port.mjs
node --test scripts/check-t3-port.test.mjs
node scripts/check-pstack-docs.mjs
(cd pstack/skills/poteto-mode/scripts && bun install --frozen-lockfile && bun test)
(cd pstack/skills/statechart/scripts && npm install --no-package-lock && npm test)   # Node 22.18+; the first run installs TLC and Java with mise
```

## Deploying

Installs are copies, so a merge changes nothing until a reinstall. Only the hourly audit ticks in autopilot-full, autopilot-stack and multi-phase-plan re-read playbooks from `origin/lim` (`check-plan.mjs` requires plans to include that re-read), so a merge without a reinstall splits running programs between new playbooks and old skills and scripts. Merge through the merge gate (`merge-gate --repo liminal-ai/pstack-lim --pr <n>`, per poteto-mode's Shipping playbook), then reinstall at once for each user with the install steps in `poteto-help` (rsync `pstack/skills/*` into `~/.agents/skills`, link `~/.claude/skills/<name>`, copy `pstack/agents`). Verify: `diff -r pstack/skills/<name> ~/.agents/skills/<name>`.

## bun

Installed for leemoore at `~/.bun/bin/bun`, on `PATH` only through `~/.bash_profile`. The running `t3 serve` process's `PATH` doesn't include it, so shells that skip login init can't find it. Check with `command -v bun` in the shell that will run `watch-pr` or `merge-gate`.
