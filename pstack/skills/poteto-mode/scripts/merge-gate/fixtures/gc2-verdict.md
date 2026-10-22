pstack-verdict: PASS+NOTES head=4681db933eb4587f61af7e160101626bcd644b50 base=4f12d1a694007d2af1e68ab3c8794285e18c26ac by=codex/gpt-6.1-sol

Independent final-head verification of GC2, written by Claude. The previous P1 and duplicated FORK rows are closed. No new correctness finding in this pass. This is the requested targeted verification; the inherited performance evidence limitation below remains.

I read the named autopilot/shipping steps, repository instructions, FORK.md, GC2, Appendix C and the boot recipe. I created `/tmp/verify-gc2-46/wt` detached at this exact head and ran `vp i`. Checks ran one at a time under bounded systemd scopes. `gh` was used because the Origin CLI was unavailable. The live PR still had this head; its merge base with the current GitHub base was independently confirmed as the base above.

Checks run here:

- Group-chat module: **113/113** tests, one worker, no file parallelism.
- Server and contracts package typechecks: exit 0, no TypeScript errors. Changed-file lint: exit 0.
- Knip for `apps/server` and `packages/contracts`, restricted to the 22 changed paths before the repository's schema preprocessor: **no issues**, exit 0. The first unrestricted-preprocessor attempt exhausted Node's default heap; the successful pass retained the 3 GiB scope limit and used a 2304 MiB Node heap. Both logs and the filtering script are retained.
- Workflow seam suite and contracts HTTP test: **282/282** tests across 14 files (281 workflow seam tests plus the contracts HTTP test).
- Worker-13 P1 probes: **3/3 pass**, including the real orchestration graph and the reopened-SQLite probe. The retained in-flight cancel survives deletion and cancels the envelope after acceptance/recovery. The legacy probe's `openDeliveries` read is not cancellation completion: I replaced that wait with the actual port cancellation milestone. The original asynchronous-wait failures are retained as excluded harness results.
- New independent durability matrix: **16/16 pass**, using the module's integration harness with the real orchestration graph, stubbed provider execution, file-backed core SQLite, and a separately scoped group-chat SQLite connection that is closed/reopened at each boundary. No sleeps or timed polling in the matrix; Deferred and persisted-operation milestones control the boundaries.

Durability outcomes (cancel events are persisted `run.updated` events, not successful port return values):

| Crash boundary | Stop: envelope / cancel calls / cancel events | Delete: envelope / cancel calls / cancel events | Pending rows after recovery |
|---|---|---|---|
| before-row | cancelled, never started / 1 / 1 | cancelled, never started / 1 / 1 | 0 / 0 |
| after-row | cancelled, never started / 1 / 1 | cancelled, never started / 1 / 1 | 0 / 0 |
| before-accept | not accepted / 0 / 0 | not accepted / 0 / 0 | 0 / 0 |
| after-accept | cancelled, never started / 1 / 1 | cancelled, never started / 1 / 1 | 0 / 0 |
| before-cancel | cancelled, never started / 1 / 1 | cancelled, never started / 1 / 1 | 0 / 0 |
| after-cancel | cancelled, never started / 2 / 1 | cancelled, never started / 2 / 1 | 0 / 0 |
| before-settle | cancelled, never started / 2 / 1 | cancelled, never started / 2 / 1 | 0 / 0 |
| after-settle | cancelled, never started / 1 / 1 | cancelled, never started / 1 / 1 | 0 / 0 |

`before-row` interrupts the uncommitted withdrawal transaction; both withdrawal and cancel intent roll back together. The test replays that unacknowledged command after reopening, before engine activation. It does not claim an uncommitted request survives a crash. `after-row` means the transaction has committed. `after-cancel` and `before-settle` retry the same deterministic cancel command: two calls produce **one** cancellation event. All accepted withdrawn envelopes remain cancelled with `startedAt = null`; every pending cancel row is removed. Before acceptance, the interrupted send has created no envelope.

Live proof used the supplied `4681db933e` release on **127.0.0.1:14346**, fresh data under `/tmp/verify-gc2-46/data`, and only two `claude-haiku-5-5` / low / full-access threads in one group. Stop cancelled alpha's queued envelope. I issued a subsequent send and deleted the group while that HTTP send was still outstanding, then stopped and restarted only `verify-gc2-46-t3.service`. After restart: **0 groups, 0 pending cancels, all 3 accepted envelopes from the successful trial cancelled without ever starting, and 0 group-envelope starts after deletion**. One recipient's last delivery was withdrawn before T3 accepted it. The exact pre-acceptance crash window is covered deterministically by the source probes/matrix; live HTTP concurrency alone does not establish that internal window. Screenshot: `/tmp/verify-gc2-46/live.png`; actual SQLite assertions: `live-summary.py`, `live-verification.json`. The initial sleep-based fixture finished before Stop and is explicitly excluded; the successful retry used immediately dispatched busy turns on the same two threads.

FORK audit: **0 duplicated full table rows**. Against `v0.1.1-nightly.20261017.3238`, all 22 files GC2 touches are covered by the existing group-chat directory/contracts entry, the explicit `environmentHttp.ts` entry, and FORK.md itself (`fork-stat.txt`, `fork-audit.json`).

Coverage carried by the requested scope: **live lanes 1–4, 7 and 8 rest on the `91abeac` swarm** (`/tmp/swarm-18b/report.md`); **5, 6, 9 and 10 rest on the `752ad69` swarm** (`/tmp/swarm-18c/report.md`). They were not rerun in full here. The `752ad69` stream-frame receipt remains the prior under-4-KiB evidence. I did not rerun the CPU/latency/send benchmark: the earlier reports did not certify an isolated comparison, so this verdict does not fill that performance coverage gap. Appendix C's accepted Stop/lane-release race is unchanged and is not reported as a new defect.

Memory: counted anon/shmem/unreclaimable admission before live **4,808,156,336 B**, expected 2 GiB plus 4 GiB reserve, below MemoryHigh **19,327,352,832 B**; `some avg10=0.00`. Only two test Haiku threads; three other Haiku provider processes were observed before starting them. Slice high events stayed **80524 → 80524 during live**, oom/oom_kill stayed 0. The earlier gate admission-to-live period saw other-host high events change **80524 → 80524**; no pressure threshold was exceeded at live admissions. The GC3 swarm was left alone.

Cleanup: both test threads settled; own server stopped; own browser tab closed; no owned units remain; clean detached worktree removed. No code changes, branch writes, push, merge, production agent/thread/runtime changes, `gchat-*`, `gc-19*`, `gc-20*` unit operation, or `~/.t3/userdata` access. Evidence and rerunnable probes remain under `/tmp/verify-gc2-46/` (recreate the detached worktree at the same path and install dependencies to rerun).

Codex GPT-6.1-sol through the Codex harness in T3 Code.

