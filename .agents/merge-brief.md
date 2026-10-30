# Merge brief: liminal-ai/pstack-lim

- Merge with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/pstack-lim --pr <n>`. The default squash merge is right here. PRs target `lim`.
- The verdict comes from the counterpart of the author's model family (Codex for Claude-written changes). This repo has no app, so the verdict runs the changed skill or script the way an agent would, plus the checks below.
- CI only validates plugin manifests, so run these yourself at the head before the verdict: `node scripts/check-t3-port.mjs`, `node --test scripts/check-t3-port.test.mjs`, `node scripts/check-pstack-docs.mjs`, and `bun test` in `pstack/skills/poteto-mode/scripts`. Run `npm install --no-package-lock && npm test` in `pstack/skills/statechart/scripts` when statechart changes, with `TLA2TOOLS` and `JAVA` set so the TLC tests run.
- An upstream sync follows `FORK.md`, "Syncing upstream", with one `FORK-SYNC-LOG.md` row per upstream commit.
- `AGENTS.md` and `CLAUDE.md` change only with Lee's approval of the exact text.
- After the merge, reinstall per `FORK.md`, "Deploying". A merge changes nothing until the reinstall. The steps, with [lim-v2 #6](https://github.com/liminal-ai/lim-v2/pull/6) as the precedent:
  1. A lim-v2 PR moves `PSTACK_LIM_COMMIT` in `~/lim-v2/manifest.env` to the new `lim` commit. The T3 lead moves pins in the same file, so agree the order with it.
  2. Once that merges, pull `~/lim-v2` and run `~/lim-v2/bin/lim-setup` on lim-builder.
  3. Run `bin/lim-fleet`, then `bin/lim-fleet m5-macbook-pro`. The M5 is `"fleet": "manual"` in `config/environments.json`, so it runs only when named. Finish with `bin/lim-fleet --check`.
- Until `lim-setup` installs a merged gate change, the installed gate lacks its flags. #37 and #38 needed #36's `--accept-shortcut` before then, so they merged with `lim`'s gate: pull the main checkout, `~/lim-v2/code/liminal-plugins/pstack-lim`, to `origin/lim` and run its `pstack/skills/poteto-mode/scripts/merge-gate/merge-gate`.
- A `retro.mjs` storage change reaches every box before any box writes with it. #35 shipped that way, then ran `retro.mjs migrate-paths` once.
