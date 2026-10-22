# Group chat in the T3 fork plan

The GC2 section's verify boxes, in the layout of the real plan, for the merge gate's tests.

## Add the Group chat section shell (GC1)

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] A GC1 box that GC2's verdict does not need.

## Port the engine onto the in-process thread port (GC2)

**Depends on.** GC1.

**Build.**

- [ ] A build box, which a verdict does not list.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `envelope.test.ts` and `rounds.test.ts` carry the standalone app's cases.
- [ ] `service.test.ts` ports the standalone app's service cases onto `testkit.ts`.
  - [ ] Port these cases with their new meaning in process.
  - [ ] Run `vp test run apps/server/src/groupChat/service.test.ts`.
- [ ] `engine.test.ts` ports the standalone app's engine cases, including discussions, Stop and sign-off.
- [ ] `integration.test.ts` builds the runtime layer, the project service and the module.
  - [ ] Run `vp test run apps/server/src/groupChat/integration.test.ts`.
- [ ] Run the thread workflow seam suite from `FORK.md`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `codex/gpt-6.1-sol` at the PR head, per the boot recipe.

- [ ] Lane 1. Scenario 1. Save `gc2-l1.png`. Pass when it holds.
- [ ] Lane 2. Scenario 2. Save `gc2-l2.png`. Pass when it holds.
- [ ] Lane 3. Scenario 3. Save `gc2-l3.png`. Pass when it holds.
- [ ] Lane 4. Scenario 4. Save `gc2-l4.png`. Pass when it holds.
- [ ] Lane 5. Scenario 5. Save `gc2-l5.png`. Pass when it holds.
- [ ] Lane 6. Scenario 6. Save `gc2-l6.png`. Pass when it holds.
- [ ] Lane 7. Scenario 7. Save `gc2-l7.png`. Pass when it holds.
- [ ] Lane 8. Scenario 8. Save `gc2-l8.png`. Pass when it holds.
- [ ] Lane 9. Scenario 9. Save `gc2-l9.png`. Pass when it holds.
- [ ] Lane 10. Scenario 10. Save `gc2-l10.png`. Pass when it holds.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Idle server CPU and API latency.
- [ ] Probe. Three interleaved windows per side.
- [ ] Baseline. Record the trunk values first.
- [ ] Rule. Fail on more than 0.5 points of CPU.

**Review gate.** None. GC2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.

## Close the program
