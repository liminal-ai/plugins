# Cleanup protocol

Every workflow's last step. A cleanup agent finds what the run left behind, keeps the proof, removes what is clearly from the run, and lists the rest for the lead. The user sees only what is not clearly from the run.

## At the start of the run

The lead does this in the workflow's first step, before anything is created:

1. Name the run with a short slug and make its folder, `<project>/.pstack/runs/<run>/` with `scratch/` and `proof/`, per poteto-mode's Run folder section.
2. Take the before snapshot: `~/.agents/skills/poteto-mode/scripts/footprint.sh snapshot <run folder> before <each repo the run may touch>`. It records listening ports, user services, Tailscale routes, containers, tmux sessions, the user's top-level `/tmp` entries, and each repo's worktrees, branches and stashes.
3. Record each T3 schedule, preview and thread the run creates as it creates it, in `<run folder>/created.tsv` (kind, id, what it is for). A shell snapshot cannot see T3 state.

## At the end of the run

The lead spawns one cleanup agent, a `delegate_task` child on the `judgment and prose` role line. Its brief names:

- this thread's id, and every subagent's `childThreadId` from the run;
- the run folder, the repos, and the base and head of every branch the run changed;
- each place the run touched outside those, as far as the lead remembers it, such as test data in an app the user uses or a remote box.

The cleanup agent works in this order:

1. **Take the after snapshot and diff it.** Run `footprint.sh snapshot <run folder> after <repos>`, then `footprint.sh diff <run folder>`. Each added line is a candidate.
2. **Read the whole record.** Read this thread and every subagent's thread with `t3_thread_read`, `view: "activity"`, to the end. List everything the run created or started: files and directories, processes and ports, services and schedules (`list_scheduled_tasks`), Tailscale routes, worktrees and branches, T3 threads and projects, test data written to apps the user uses, and every secret value printed in a transcript or a file.
3. **Read the code changes.** In each branch's diff from its base, look for debug leftovers: print and log lines added for a hunt, `debugger` statements, focused or skipped tests, commented-out code, hard-coded local ports, paths or test accounts, temporary flags, and TODOs the run added.
4. **Save the proof.** Move each artifact that a verdict, a PR, a ticket or the reply cites into `<run folder>/proof/` when it is outside it, and fix the citation. Never delete a cited file.
5. **Remove what is clearly from the run.** An item is clearly from the run when the record shows this run created it, nothing cites it, and it holds no state that exists nowhere else. A backup, a copy of a config or of data taken before a change, a database dump, and anything that would undo an edit outside git are never clearly disposable, cited or not. They go on the lead's list. Stop each process and service by the PID or unit the record names, never by matching a name or a path. Remove a worktree only when `git status` shows it clean, and a branch only when it is merged or its PR is closed. Delete schedules by their id. Leave the run folder's `proof/` in place, and delete `scratch/`.
6. **List the rest for the lead.** Everything not clearly from the run goes on the list with its evidence: every backup or pre-change copy, with what it would restore, a dirty worktree, an item the snapshot shows but the record does not explain, data in an app the user uses, a debug leftover inside a PR that is already merged, and every printed secret, which needs rotation because removing the text does not un-print it.

The cleanup agent's final message has three parts. **Removed** names each item with the evidence that it was from the run. **Kept as proof** names each file and where it is cited. **For the lead** lists the rest. The lead removes or checks what it can, and puts only what it cannot settle on the workflow's open-questions list for the user.
