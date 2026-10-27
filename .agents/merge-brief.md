# Merge brief: liminal-ai/pstack-lim

- Merge with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/pstack-lim --pr <n>`. The default squash merge is right here. PRs target `lim`.
- The verdict comes from the counterpart of the author's model family (Codex for Claude-written changes). This repo has no app, so the verdict runs the changed skill or script the way an agent would, plus the checks below.
- CI only validates plugin manifests, so run these yourself at the head before the verdict: `node scripts/check-t3-port.mjs`, `node --test scripts/check-t3-port.test.mjs`, `node scripts/check-pstack-docs.mjs`, and `bun test` in `pstack/skills/poteto-mode/scripts`. Run `node --test pstack/skills/statechart/scripts/test/*.test.mjs` when statechart changes.
- An upstream sync follows `FORK.md`, "Syncing upstream", with one `FORK-SYNC-LOG.md` row per upstream commit.
- `AGENTS.md` and `CLAUDE.md` change only with Lee's approval of the exact text.
- After the merge, reinstall per `FORK.md`, "Deploying". A merge changes nothing until the reinstall.
