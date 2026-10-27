---
name: reflect
description: Spawn three parallel review subagents over the active transcript, record what happened with evidence and a classification, and save it for the next retro round. Applies nothing. Use when the user says reflect. Use only when the user or another skill names it.
---

# Reflect

Record what happened in the current conversation, with evidence, for the next retro round. Reflect applies nothing. A retro round reads several threads' reflects together before anything changes, so changes rest on a broader view than one thread.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial or off-topic.

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

One `delegate_task` call, `target` from the `reflect judgment, divergent, synthesizer` line (default `claudeAgent/claude-opus-5-5 effort=xhigh`), in a read-only role like the reviewers. It keeps its MCP tools to spot-verify citations. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns the merged observations, each with its evidence and classification, and any decision that cannot wait for the round.

## 4. Save

Everything this reflect produced goes in this thread's home in the pstack store. `node ~/.agents/skills/reflect/scripts/retro.mjs reflect <thread-id> --title "<thread title>" --project <project>` creates a folder there for this reflect and prints its path. Write each reviewer's output in it as `judgment.md`, `tooling.md` and `divergent.md`, and the synthesizer's as `synthesis.md`. Then run `retro.mjs register <thread-id> --reflected <that folder>`, adding `--trail <path>` for each decision log or process record this thread kept, and `--model <provider>/<model>@run-<ordinal>` for each model the thread ran on, from the first run on that model in `t3_thread_read`'s `recentRuns` (raise `runLimit` to 50). When the thread has more runs than that, give the earlier changes by date (`@<YYYY-MM-DD>`). The script copies a trail that could vanish into the home and links one that is safe. The store's `retro/` folder is a git repo backed up to the private repo `liminal-ai/pstack-retros`. The script commits and pushes it after each write, so never commit or push it yourself.

## 5. Summarize for the user

In a few lines, say what the reflect found and where it is saved (`<reflect folder>`). List the gaps it found in the project's verify skill and merge brief. The thread's closing upkeep pass (poteto-mode's Playbooks section) fixes those in the project. Raise a decision only when it is a product or ops call that cannot wait for the next round, such as a running service to stop or data at risk. Everything else waits for the round. Propose no pstack skill edits, ask for no approvals, and file nothing.

## Retro rounds

A retro round reviews several threads' reflects together. `retro.mjs status` writes `REGISTRY.md` in the store's `retro/` folder and says whether a round is due. `retro.mjs open` copies the homes of the threads with waiting reflects into a new round folder, whose `README.md` lists every input. Read them, then write `synthesis.md`, the user's decisions in their own words as `decisions.md`, and `merge-gate.md` on how the merge gate script has done since the last round. The round proposes the changes, and the user approves each one. `retro.mjs close <round>` refuses until all three files exist.

Apply each approved edit where the skill's source lives, never only in the installed copy, which a reinstall overwrites. A pstack skill changes through a PR to `liminal-ai/pstack-lim` against `lim`, then a reinstall per that repo's `FORK.md`. pstack-lim does not own a vendor skill or the user's own draft that exists only in `~/.agents/skills`. Name the owner to the user and leave that edit to them.

Before you close the round, file the follow-ups the user kept in Linear as a few tickets grouped by body of work, never one per item, each in the project that the owning repo's AGENTS.md names (Retro rounds for process items). Read the project's open tickets first and add to a matching grouped ticket. Add each issue id to `decisions.md`.
