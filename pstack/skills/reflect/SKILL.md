---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect. Use only when the user or another skill names it.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript. It is this T3 thread, whose ID `t3_thread_list` returns as `currentThreadId`. Reviewers read it with `t3_thread_read` with `view: "activity"`, following `nextPosition` and, for long items, `nextTextOffset` to the end. Do not read threads outside this project. `t3_thread_read` accepts any thread ID, so that scope is yours to keep. If the thread cannot be read, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three `delegate_task` calls (`mode: "async"`), each in a read-only role (no file writes, no external mutation, as its template says). Reviewers keep their MCP tools to look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer name a role line in the role file (`~/lim-v2/AGENTS.md` or `~/lim-v2/CLAUDE.md`) and a default. Set `delegate_task`'s `target` to that line's entry, or to the default if the file or the line is missing. Omit `target` when the value is `auto` or `inherit-parent`. If `delegate_task` rejects an entry, use the default and say so. If it rejects the default, use the closest model of the same family that `orchestrator_capabilities` lists. Pick each subagent's effort for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default `target` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `claudeAgent/claude-opus-5-5 effort=xhigh` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `cursor/grok-4.7 reasoning_effort=xhigh fastMode=true` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `claudeAgent/claude-opus-5-5 effort=xhigh` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the thread ID or digest where marked. Each reviewer's findings are its final message, which `task_status` returns.

## 3. Synthesize

One `delegate_task` call, `target` from the `reflect judgment, divergent, synthesizer` line (default `claudeAgent/claude-opus-5-5 effort=xhigh`), in a read-only role like the reviewers. It keeps its MCP tools to spot-verify citations. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Save

Everything this reflect produced goes in this thread's home in the pstack store. `node ~/.agents/skills/reflect/scripts/retro.mjs reflect <thread-id> --title "<thread title>" --project <project>` creates a folder there for this reflect and prints its path. Write each reviewer's output in it as `judgment.md`, `tooling.md` and `divergent.md`, the synthesizer's as `synthesis.md`, and the Backlog items as `backlog.md`. Then run `retro.mjs register <thread-id> --reflected <that folder>`, adding `--trail <path>` for each decision log or process record this thread kept. The script copies a trail that could vanish into the home and links one that is safe.

## 6. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply. Write the user's decisions, in their own words, to `decisions.md` in the reflect's folder.

Backlog items need no approval. They are already in `backlog.md`, so tell the user its path. Nothing files tickets.

Apply each approved edit where the skill's source lives, never only in the installed copy, which a reinstall overwrites. A pstack skill changes through a PR to `liminal-ai/pstack-lim` against `lim`, then a reinstall per that repo's `FORK.md`. pstack-lim does not own a vendor skill or the user's own draft that exists only in `~/.agents/skills`. Name the owner to the user and leave that edit to them.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to Cursor's built-in `create-skill` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `create-skill` and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to `create-skill`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 7. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Saved to `<reflect folder>`. Backlog in its `backlog.md`: `<item title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.

## Retro rounds

A retro round reviews several threads' reflects together. `retro.mjs status` writes `REGISTRY.md` in the store's `retro/` folder and says whether a round is due. `retro.mjs open` copies the homes of the threads with waiting reflects into a new round folder, whose `README.md` lists every input. Read them, then write `synthesis.md`, the user's decisions in their own words as `decisions.md`, and `merge-gate.md` on how the merge gate script has done since the last round. `retro.mjs close <round>` refuses until all three exist. Before you close the round, file each backlog item it kept as a Linear backlog issue in team LH, in the project that owns it: "pstack fork", "T3 fork" or "limhealth-next". Search for a matching issue first, and add each issue id to `decisions.md`.
