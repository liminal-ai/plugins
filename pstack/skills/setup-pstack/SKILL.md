---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes the pstack roles section of the role file, which overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack roles section of the role file, which sets pstack's model per role. The role file is `~/lim-v2/AGENTS.md`. `~/lim-v2/CLAUDE.md`, which Claude Code reads, is a symlink to it. Write `AGENTS.md` by its own path, and never replace the symlink with a regular file. The section is the fenced block under `## pstack roles`. Run this from a v2 thread, so the catalog you detect is v2's.

## Steps

### 1. Detect available models

Call `orchestrator_capabilities`. Every model of a provider instance that can run a child task, with each of its option values, is a target you can pass to `delegate_task`. That is the dependable source. A real entry is `<providerInstanceId>/<model> <option>=<value>`, such as `claudeAgent/claude-opus-5-5 effort=xhigh`. If you cannot detect any, ask the user to paste the entries they have access to. Never write a real entry you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected entries.

### 2. Load current state

The default role-to-model mapping is the block shape shown in step 5 below. If the role file already has the block, read it and treat its `# budget` line and its role values as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it. Two lines are not model roles, so keep them as they are: `cloud workers` (where cloud work runs) and a `counterparts` value (it points at the role file's Counterparts list).

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer the harness's ask-the-user tool over free text, or ask in chat when it has none. Offer these four options with these exact labels, and name the current budget when the rule records one. With no rule, say that `large` matches the skill defaults.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited`, `large`, `medium`, and `small` set the effort option of every real entry, panel entries included, to `max`, `xhigh`, `high`, or `medium`. The effort option is the one the model takes for reasoning (`effort`, `reasoningEffort`, or `reasoning_effort`), on the ladder `max` > `xhigh` > `high` > `medium` > `low`. Other options, such as `fastMode=true`, stay. If the model does not offer the target value, use its highest value at or below the target, else the same family's detected model that does, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `unlimited` turns `claudeAgent/claude-opus-5-5 effort=xhigh` into `effort=max`. A model whose effort tops out at `xhigh` stays at `xhigh` under `unlimited`. `large` keeps both defaults. `small` turns them into `effort=medium` and `reasoning_effort=medium`.

**(c) Show the roles and confirm.** Show every role with its model, marking any real entry not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent thread's model, with no `target`) as the options. Prefer the harness's ask-the-user tool over free text, or ask in chat when it has none. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real entry written must be in the detected set: its provider instance, its model, and each option value. `inherit-parent` and `auto` always pass. If a chosen real entry is not available, stop and ask again.

### 5. Write the block

Write the block into `~/lim-v2/AGENTS.md` only, with a `# budget` line with the chosen label and its target effort, and one line per role, using the same labels poteto-mode uses, then the `cloud workers` line. Replace the whole fenced block so re-runs stay idempotent. Leave the rest of the file as it is, including the notes under the block, and update a note only where it names a value you changed. Shape:

```
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent thread's model (omit `target`). Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh)
feature, refactoring: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
bug-fix: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
perf-issue: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
hillclimb: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh
hardest tasks: claudeAgent/claude-opus-5-5 effort=xhigh
how explorer: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
how explainer: claudeAgent/claude-opus-5-5 effort=xhigh
why investigators: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
why synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
reflect tooling: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
arena runners: claudeAgent/claude-opus-5-5 effort=xhigh, cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
arena cross-judge pool: claudeAgent/claude-opus-5-5 effort=xhigh, cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
swarm workers: cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
architect runners: claudeAgent/claude-opus-5-5 effort=xhigh, cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=xhigh, cursor/grok-4.7 reasoning_effort=xhigh fastMode=true
cloud workers: cursor-cloud
```

### 6. Confirm

Tell the user the role file was written and that the change applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.
