# Upstream sync log

One table per sync. One row per upstream commit that touches `pstack/` or the copied cursor-team-kit skills. `take` means merged as is, `adapt` means ported with a T3 change (name the FORK.md row), `skip` means left out on purpose. A `skip` stays skipped in later syncs unless upstream reworks the change.

## Sync 1: 11713c6 to 101b274 (pstack 0.15.17 to 0.15.25)

| Upstream | Subject | Decision | PR | Reason |
|---|---|---|---|---|
| `ea32d95` | feat(pstack): show /ketchup decisions as before/after visuals (#570) | adapt (planned) | D | /ketchup visuals, rendered with T3 html_render |
| `08bd59b` | refactor(pstack): cut unneeded sections from seven skills (#571) | adapt (planned) | D | section cuts, kept where fork text is T3-specific |
| `de2dba6` | fix(pstack): rename Comment Sicko agent id so Grok can spawn it (#486) | take | B | agent file and README renamed, no-comments already spawns by file |
| `87c8103` | fix(pstack): respect fenced code blocks in plan checks (#536) | adapt | B | test fixture re-reads origin/lim, not origin/main (Trunk row). The drift check caught it |
| `ff8f83d` | fix(watch-pr): paginate review threads instead of reading only the first 100 (#484) | take | B | cherry-picked unchanged |
| `bc697d0` | fix(pstack): drop "Must always apply." from unslop description (#572) | take | B | applied by hand, the fork keeps its named-only sentence |
| `cf9a111` | fix(pstack): worktree-audit checks MERGED against the default branch, not origin/main (#574) | adapt | B | merged with --threads. The base comes from GitHub's default branch, then origin/HEAD, because origin/HEAD here still says main. Upstream's origin/main and origin/master guesses are removed on purpose, so with neither lookup available the script stops and asks for -b (Trunk row) |
| `2bd5dd4` | fix(pstack): make the /poteto-mode chat the runner, poteto-agent a delegate (#575) | adapt | B | runner and delegate wording in poteto-mode, poteto-agent and README, with delegate_task and absolute paths (Subagents and Install rows) |
| `e5a02f8` | feat(pstack): add Agent Plugins v1 root manifest (#576) | skip (planned) |  | Cursor marketplace manifest, the fork installs per user (Install row) |
| `c49b37a` | fix(pstack): create-verification-skill readiness means the app is usable (#573) | take | B | applied by hand onto the fork's .agents/skills paths |
| `1b6d44f` | chore(pstack): bump to 0.15.20 (#581) | skip (planned) |  | version bump, versions are not used by the per-user install |
| `364a77e` | fix(pstack): tell agents where bundled leaf skills live (#577) | adapt | B | leaf paths given as ~/.agents/skills/<name>/SKILL.md instead of ../<name> (Install row) |
| `997ffc7` | chore(pstack): bump to 0.15.21 (#584) | skip (planned) |  | version bump |
| `b93e811` | fix(pstack): let poteto-agent find poteto-mode, drop ignored frontmatter, document the / menu (#597) | adapt | B | poteto-agent wording taken. Plugin-folder search skipped (Install row). The fork never had the mode and reminder keys. The slash-menu README line is Cursor-only |
| `7d8d909` | feat(pstack): add /in-your-own-words to play back the goal before work (#602) | adapt | B | visible and named-only (Skill visibility row) |
| `d00ba6e` | feat(pstack): shorten /ketchup replies and build them on real visuals (#595) | adapt (planned) | D | /ketchup rewrite, T3 visuals |
| `36cecbf` | feat(pstack): propose a cheap always-on signal after a deep debugging dig (#604) | take | B | cherry-picked unchanged |
| `3177dab` | chore(pstack): bump to 0.15.22 (#605) | skip (planned) |  | version bump |
| `dbf4981` | refactor(pstack): reword /in-your-own-words around goals and the problem (#606) | adapt | B | taken with 7d8d909, version bump left out |
| `c86f349` | refactor(pstack): make /ketchup read like /bro in 150 words (#609) | adapt (planned) | D | /ketchup rewrite |
| `ce649c0` | feat(pstack): match subagent effort to the job, drop Graphite from orchestrate, and cut playbooks to principles (#613) | adapt | C | effort rule lower-only with no fast clause (Effort and Speed rows), verifiers and owners as delegate_task children (Subagents and Model per role rows), watch_pull_request plus heartbeat and origin/lim re-reads in shipping and the autopilots (Waking and Trunk rows), owner trails under autopilot/<run-slug>/<repo>/<branch>/ in the pstack store with a cloud owner's rows relayed through marked PR comments because its VM cannot reach the store, and owners that poll with watch-pr and report CODE-READY by PR comment while the root holds the watch (Todo list, Subagents and Waking rows), Graphite out with the orch frontier on gh or origin and the remote's HEAD as trunk (Trunk row). Fork fixes on top of upstream's frontier resolver: open children are listed with --state open and an explicit --limit that fails when filled, where upstream's --state all with gh's default 30 rows dropped an open child past the first page, and a branch anchors on its unique open PR with --prs to pick among several merged or closed ones, where upstream rejected any branch with two PRs |
| `8043881` | pstack: autopilot loops catch the operator up with /ketchup (#616) | adapt | C | taken inside the autopilot rewrite, whose T3 steps follow the Waking and Trunk rows |
| `79afd75` | feat(pstack): add /sharpen (#615) | adapt | B | visible and named-only (Skill visibility row) |
| `1e5c90a` | chore(pstack): bump to 0.15.24 (#617) | skip (planned) |  | version bump |
| `afd51cf` | feat(pstack): have /ketchup explain changes with screenshots, videos, and diagrams (#628) | adapt (planned) | D | /ketchup screenshots and videos via T3 tools |
| `6ce45c5` | chore(pstack): bump to 0.15.25 (#614) | skip (planned) |  | version bump |
| `e5136d8` | pstack: restate four overspecified principles as reasoning, not rules (#633) | adapt (planned) | D | principles as reasoning, keep fork descriptions in sync (Skill visibility row) |
| `99743e9` | refactor(pstack): cut marginal sections from four skills (#634) | adapt (planned) | D | section cuts |
| `182f2ce` | feat(pstack): install pstack in Claude Code from a generated tree (#637) | skip (planned) |  | Claude Code plugin and generated harness trees replace the per-user install and hide skills from Codex (Install and Skill visibility rows) |
