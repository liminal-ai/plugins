# Upstream sync log

One table per sync. One row per upstream commit that touches `pstack/` or the copied cursor-team-kit skills. `take` means merged as is, `adapt` means ported with a T3 change (name the FORK.md row), `skip` means left out on purpose. A `skip` stays skipped in later syncs unless upstream reworks the change.

## Sync 1: 11713c6 to 101b274 (pstack 0.15.17 to 0.15.25)

| Upstream | Subject | Decision | PR | Reason |
|---|---|---|---|---|
| `ea32d95` | feat(pstack): show /ketchup decisions as before/after visuals (#570) | adapt | D | diagrams and charts on an html_preview-checked html_render page instead of Mermaid and generated images, version bump left out (Visuals row) |
| `08bd59b` | refactor(pstack): cut unneeded sections from seven skills (#571) | adapt | D | cuts taken. worktree-cleanup drops only its intro paragraph and keeps the fork's T3 thread-export steps, which no row names but which replace Cursor's chat scan. Version bump left out |
| `de2dba6` | fix(pstack): rename Comment Sicko agent id so Grok can spawn it (#486) | take | B | agent file and README renamed, no-comments already spawns by file |
| `87c8103` | fix(pstack): respect fenced code blocks in plan checks (#536) | adapt | B | test fixture re-reads origin/lim, not origin/main (Trunk row). The drift check caught it |
| `ff8f83d` | fix(watch-pr): paginate review threads instead of reading only the first 100 (#484) | take | B | cherry-picked unchanged |
| `bc697d0` | fix(pstack): drop "Must always apply." from unslop description (#572) | take | B | applied by hand, the fork keeps its named-only sentence |
| `cf9a111` | fix(pstack): worktree-audit checks MERGED against the default branch, not origin/main (#574) | adapt | B | merged with --threads. The base comes from GitHub's default branch, then origin/HEAD, because origin/HEAD here still says main. Upstream's origin/main and origin/master guesses are removed on purpose, so with neither lookup available the script stops and asks for -b (Trunk row) |
| `2bd5dd4` | fix(pstack): make the /poteto-mode chat the runner, poteto-agent a delegate (#575) | adapt | B | runner and delegate wording in poteto-mode, poteto-agent and README, with delegate_task and absolute paths (Subagents and Install rows) |
| `e5a02f8` | feat(pstack): add Agent Plugins v1 root manifest (#576) | skip |  | Cursor marketplace manifest, the fork installs per user (Install row) |
| `c49b37a` | fix(pstack): create-verification-skill readiness means the app is usable (#573) | take | B | applied by hand onto the fork's .agents/skills paths |
| `1b6d44f` | chore(pstack): bump to 0.15.20 (#581) | skip |  | version bump, versions are not used by the per-user install |
| `364a77e` | fix(pstack): tell agents where bundled leaf skills live (#577) | adapt | B | leaf paths given as ~/.agents/skills/<name>/SKILL.md instead of ../<name> (Install row) |
| `997ffc7` | chore(pstack): bump to 0.15.21 (#584) | skip |  | version bump |
| `b93e811` | fix(pstack): let poteto-agent find poteto-mode, drop ignored frontmatter, document the / menu (#597) | adapt | B | poteto-agent wording taken. Plugin-folder search skipped (Install row). The fork never had the mode and reminder keys. The slash-menu README line is Cursor-only |
| `7d8d909` | feat(pstack): add /in-your-own-words to play back the goal before work (#602) | adapt | B | visible and named-only (Skill visibility row) |
| `d00ba6e` | feat(pstack): shorten /ketchup replies and build them on real visuals (#595) | adapt | D | html_render page in place of Mermaid, /visualize and generated images (Visuals row), description keeps the named-only ending (Skill visibility row) |
| `36cecbf` | feat(pstack): propose a cheap always-on signal after a deep debugging dig (#604) | take | B | cherry-picked unchanged |
| `3177dab` | chore(pstack): bump to 0.15.22 (#605) | skip |  | version bump |
| `dbf4981` | refactor(pstack): reword /in-your-own-words around goals and the problem (#606) | adapt | B | taken with 7d8d909, version bump left out |
| `c86f349` | refactor(pstack): make /ketchup read like /bro in 150 words (#609) | adapt | D | same T3 visuals wording (Visuals row), description keeps the named-only ending (Skill visibility row) |
| `ce649c0` | feat(pstack): match subagent effort to the job, drop Graphite from orchestrate, and cut playbooks to principles (#613) | adapt | C | effort rule lower-only with no fast clause (Effort and Speed rows), verifiers and owners as delegate_task children (Subagents and Model per role rows), watch_pull_request plus heartbeat and origin/lim re-reads in shipping and the autopilots (Waking and Trunk rows), owner trails under autopilot/<run-slug>/<repo>/<branch>/ in the pstack store with a cloud owner's rows relayed through marked PR comments because its VM cannot reach the store, and owners that poll with watch-pr and report CODE-READY by PR comment while the root holds the watch (Todo list, Subagents and Waking rows), Graphite out with the orch frontier on gh or origin and the remote's HEAD as trunk (Trunk row). Fork fixes on top of upstream's frontier resolver: open children are listed with --state open and an explicit --limit that fails when filled, where upstream's --state all with gh's default 30 rows dropped an open child past the first page, and a branch anchors on its unique open PR with --prs to pick among several merged or closed ones, where upstream rejected any branch with two PRs. Owners poll without watch_pull_request: a local owner runs the installed watch-pr, a cloud owner polls gh pr view and the reviewThreads GraphQL query because its VM has no pstack, and reports reach the root by t3_thread_send or a 10-minute poll |
| `8043881` | pstack: autopilot loops catch the operator up with /ketchup (#616) | adapt | C | taken inside the autopilot rewrite, whose T3 steps follow the Waking and Trunk rows |
| `79afd75` | feat(pstack): add /sharpen (#615) | adapt | B | visible and named-only (Skill visibility row) |
| `1e5c90a` | chore(pstack): bump to 0.15.24 (#617) | skip |  | version bump |
| `afd51cf` | feat(pstack): have /ketchup explain changes with screenshots, videos, and diagrams (#628) | adapt | D | screenshots from the control skill or preview_snapshot save: true, recordings from preview_recording_start and stop, embedded as ![alt](path), drawn choices on the html_render page above the reply (Visuals row) |
| `6ce45c5` | chore(pstack): bump to 0.15.25 (#614) | skip |  | version bump |
| `e5136d8` | pstack: restate four overspecified principles as reasoning, not rules (#633) | adapt | D | upstream text taken, the three rewritten descriptions keep the named-only ending without disable-model-invocation (Skill visibility row) |
| `99743e9` | refactor(pstack): cut marginal sections from four skills (#634) | adapt | D | cuts taken. swarm keeps the fork's role-file and delegate_task worker step (Model per role and Subagents rows), type-system description keeps the named-only ending (Skill visibility row). Fork fix on top of upstream's cut: swarm's step 3, which sets N, is restored, because without it a bare "swarm this" has no worker count |
| `182f2ce` | feat(pstack): install pstack in Claude Code from a generated tree (#637) | skip |  | Claude Code plugin and generated harness trees replace the per-user install and hide skills from Codex (Install and Skill visibility rows) |

## Sync 2: 101b274 to f2bad52 (pstack 0.15.25 to 0.15.29)

All in PR #24. Lee's call in the 2026-10-20 retro: take everything, sharpen included.

| Upstream | Subject | Decision | PR | Reason |
|---|---|---|---|---|
| `0317eb8` | fix(pstack): make a brand with a type guard, not as (#700) | take | #24 | applied unchanged |
| `a968159` | fix(pstack): name every skill after its folder (#702) | take | #24 | already true in the fork, nothing to apply. The generator check it adds lives in the harness tree generator the fork does not ship (Install row) |
| `1b80080` | fix(pstack): close three gaps in the Claude Code plugin (#705) | skip |  | Claude Code plugin doc and README install text. The fork installs per user from ~/.agents/skills (Install row) |
| `019a6a2` | pstack: refresh the docs and add a docs-vs-tree check (#704) | adapt | #24 | guide and README wording taken, scripts/check-pstack-docs.mjs taken as is. Claude Code install and custom-mode text and the generated harness tree left out (Install row). The check found control-cli, control-ui and deslop missing from the README table, so the table now lists them |
| `16541c6` | fix(pstack): list every waiting item so each ketchup call is decidable (#692) | adapt | #24 | taken with the fork's inline screenshots and recordings and html_render page in place of Mermaid and /visualize (Visuals row). Description keeps the named-only ending (Skill visibility row) |
| `bc14437` | fix(pstack): say outright that ketchup never cuts items to stay under a word count (#708) | take | #24 | applied with 16541c6 |
| `4382e68` | feat(pstack): add /create-formal-verification-skill (#709) | adapt | #24 | description ends with the named-only sentence, no disable-model-invocation (Skill visibility row) |
| `0b8e952` | chore(pstack): bump to 0.15.26 (#710) | skip |  | version bump |
| `75fabac` | pstack: drop the rewritten-prompt ban from sharpen (#712) | take | #24 | superseded by 88d4751, which the fork takes whole |
| `0148b78` | chore(pstack): bump to 0.15.27 (#713) | skip |  | version bump |
| `f9be7aa` | pstack: offer formal verification in setup, sync help and guide (#715) | adapt | #24 | setup-pstack step 8 taken. poteto-help keeps the fork's per-user install steps and T3 note, with the formal verification offer added to its step 2. The guide's Claude Code install line is left out (Install row) |
| `6b78e9f` | fix(pstack): add TLA+ default and no-verifier fallback to create-formal-verification-skill (#721) | take | #24 | applied unchanged |
| `7b353f7` | pstack: add maintain-formal-verification-skill (#716) | adapt | #24 | description ends with the named-only sentence, no disable-model-invocation (Skill visibility row) |
| `d457567` | chore(pstack): bump to 0.15.28, sync guide with create-formal-verification-skill (#724) | adapt | #24 | guide line taken, version bump left out |
| `88d4751` | pstack: restore /sharpen to the original prompt, return only the rewrite (#729) | adapt | #24 | sharpen replaced with upstream's rewrite-the-prompt version over the fork's do-the-work version. Description keeps the named-only ending (Skill visibility row). Version bump left out |

## Sync 3: f2bad52 to ab69380 (pstack 0.15.29 to 0.15.32)

Decided in retro round 2026-10-26, stop 9. Upstream `main` was `ab69380` at the sync. Its last commit under `pstack/` is `e73df47`. Upstream's `harness/` copies are left out (Install row).

| Upstream | Subject | Decision | PR | Reason |
|---|---|---|---|---|
| `eb4db2b` | feat(pstack): add the statechart skill to draw TLA+ models as charts (#741) | adapt | this | skill taken at upstream's tip with 7698375, 4ec7ffa and 076f4b2. Visible, the description ends with the named-only sentence, no disable-model-invocation (Skill visibility row). The hand-off embeds each PNG as `![alt](path)` (Visuals row). README, guide 06 and poteto-help rows taken. Upstream's CI step that runs `pstack/skills/*/scripts/test/*.test.mjs` is replaced by a line in FORK.md's checks, because the fork's CI only validates plugin manifests |
| `7698375` | fix(pstack): bring the statechart skill up to date with six fixes (#776) | take | this | taken with eb4db2b at upstream's tip |
| `4ec7ffa` | refactor(pstack): delete statechart comments that repeat the code, and rename helpers (#779) | take | this | taken with eb4db2b at upstream's tip |
| `076f4b2` | feat(pstack): bring the statechart skill up to date, with the Pele renderer (#791) | take | this | taken with eb4db2b at upstream's tip |
| `642289e` | chore(pstack): bump to 0.15.31 (#792) | skip |  | version bump |
| `00d5dec` | feat(pstack): tell generated verify skills to read each model-check result with /statechart (#794) | take | this | paragraph added to create-formal-verification-skill unchanged |
| `3c0fdb4` | feat(pstack): add the ketchup-video skill (#797) | skip |  | Lee's round 2026-10-26 list leaves it out. README, guide 10 and poteto-help rows left out with it |
| `b1a1298` | chore(pstack): bump to 0.15.32 (#798) | skip |  | version bump |
| `7054003` | fix(pstack): route reflect edits out of the plugin cache (#800) | skip |  | the fork's reflect records only and applies nothing. The retro round edits the source per FORK.md |
| `96dec8e` | fix(watch-pr): distinguish fork heads during stack discovery (#801) | take | this | applied to `pstack/` unchanged |
| `fe096ef` | fix(watch-pr): cap polling sleeps at the deadline (#802) | take | this | applied to `pstack/` unchanged |
| `86c2448` | fix(pstack): recognize matching inline code delimiters (#803) | take | this | check-plan.mjs unchanged. Its two tests sit after the fork's record-of-done tests |
| `3c596e7` | fix(orch): prefer active PR over branch history (#804) | adapt | this | the fork's resolver from sync 1 already prefers the unique open PR and falls back to `--prs` among merged or closed ones, so store.ts keeps the fork's code. Upstream's two tests are taken and pass. The duplicate-open test expects the fork's message, "several open pull requests" |
| `f83fbe6` | fix(pstack): read transcript mtimes with GNU stat and date in worktree-audit (#805) | skip |  | the fork's worktree-audit reads T3 thread rows from `--threads` with `date -d`, not transcript mtimes with `stat`, so the code it fixes is not in the fork |
| `a0b0ad9` | docs(pstack): note Claude Code auto-update is off for third-party marketplaces (#806) | skip |  | Claude Code marketplace install text (Install row) |
| `e73df47` | fix(pstack): renumber swarm's Phase A and fix its dangling table reference (#807) | adapt | this | the fork's Phase A already runs 1 to 5 with step 3 restored in sync 1, and Phase B already points at step 4. Only Phase D's "a result table" is taken |

## Sync 4: ab69380 to 4dd1d05 (pstack 0.15.32 to 0.15.36)

Retro round 2026-10-29. Lee: "we're just uptaking." Upstream `main` was `4dd1d05` at the sync. Its last commit under `pstack/` is `c742dd6`. Upstream's `harness/` copies are left out (Install row).

| Upstream | Subject | Decision | PR | Reason |
|---|---|---|---|---|
| `34b1b7c` | feat(pstack): port the statechart compiler (#977) | adapt | this | skill and scripts taken at upstream's tip with 740d2c0 and 519d36a. The description ends with the named-only sentence, no disable-model-invocation (Skill visibility row). Scratch work goes in the run folder's `scratch/` (Scratch row). The skill shows each chart as its Pele SVG on an `html_render` page, with the Mermaid text on the same page, in place of a bare `mermaid` block or a raw SVG, in SKILL.md, `references/render.md` and guide 06 (Visuals row). Guide 06, README, poteto-help and create-formal-verification-skill lines taken. Upstream's CI step for the TypeScript tests on Node 22 with fast-check becomes FORK.md's `npm test` line and the merge brief's, because the fork's CI only validates plugin manifests |
| `7c7bde7` | chore(pstack): bump to 0.15.33 (#978) | skip |  | version bump |
| `740d2c0` | fix(pstack): keep qualified action names in property traces (#982) | take | this | taken with 34b1b7c at upstream's tip |
| `164ced1` | chore(pstack): bump to 0.15.34 (#983) | skip |  | version bump |
| `519d36a` | test(pstack): wait for the reap in the statechart SIGKILL view test (#981) | take | this | taken with 34b1b7c at upstream's tip |
| `ab1f702` | feat(pstack): port recent skill updates (#986) | adapt | this | poteto-mode's first-message goal restatement, the Explain the Number entry and the Autopilot-stack entry taken. The rejected-slug fallback chain is taken for `delegate_task` targets, with `orchestrator_capabilities` in place of the error's slug list (Subagents and Model per role rows). The background steer and resume clause is left out, because `t3_thread_send` never holds the turn (Subagents row). interrogate taken whole, adversaries proving each finding with a run and its reviewer and rubric references deleted, with "no read-only role" in place of `generalPurpose` and the named-only description (Subagents and Skill visibility rows). arena's dropped-seat refill and a cross-judge never from the parent's family taken on `delegate_task` targets (Model per role row). Autopilot-full's blocking rule, push each finished unit, and the concurrent-change rebase taken, keeping the owner polling and trail ports (Waking and Subagents rows). Its wording-only change with no verifier is adapted in autopilot-full and multi-phase-plan (PR #36). It gets a counterpart verifier that may shorten its check (Shipping step 3), because Lee's call in retro 2026-10-29 is that verification is never skipped, and the merge gate needs a verdict on the exact code. Autopilot-stack taken as Autopilot-full without the merge. Its tick re-reads the file from `origin/lim` (Trunk row), and a restacked PR keeps its verdict under the fork's whole-PR diff rule in shipping step 3 in place of `git patch-id`, the fork fix from PR #10. multi-phase-plan, babysit, opening-a-pr, autonomous-run, principle-explain-the-number, setup-pstack, guides and README taken, keeping the fork's T3 wording. ketchup-video, poteto-help and guide 10 ketchup-video lines left out, since the fork skipped that skill in sync 3. The `scripts/orch/store.ts` hunk lapses with c742dd6 |
| `c742dd6` | feat(pstack): make Orchestrate agentic and delete the orch scripts (#1043) | adapt | this | playbook taken, `scripts/orch/` and its test entry deleted, overnight guide line taken. The fork's orch ports lapse with the scripts: the `preferences.md` standing-orders register and its "append the line before you act", the store layout, `units.tsv` task and thread ids, the frontier resolver fixes, and the T3 restart and drain steps. Workers spawn with `delegate_task`, on the `cloud workers` line unless they need this machine (Subagents row). State lives in the thread workflow and `orchestrate/<project-slug>/` in the pstack store (Todo list row). PRs are watched with `watch_pull_request` and a heartbeat (Waking row). In place of a fork, new work that needs a worker's built state goes to a fresh worker pointed at that state (Subagents row). The fork's routing sentence, work you would do yourself is not a program and work split across unit owners is, stays in the playbook and guide 07 to match poteto-mode's Orchestrate entry. Version bump left out |
