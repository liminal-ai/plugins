### Autopilot-stack

Run the Autopilot-full playbook, but do not merge.

1. **In place of step 5, stop at verified.** Stop when each PR is verified and green at its current head, then hand the PRs to the operator. After the handoff, nobody pushes without the operator's go. Every loop tick prompt names this file and re-reads it from trunk (`git -C ~/lim-v2/code/liminal-plugins/pstack-lim show origin/lim:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`), so each tick sees the no-merge rule.
2. **Stack a PR only when it builds on another PR.** This is the one exception to step 3. Base the PR on the other PR's branch in place of trunk, per **Size and stacks** in `playbooks/opening-a-pr.md`. In place of step 2's rebase onto trunk, each PR rebases onto its parent PR's branch, and the stack root rebases onto trunk. A new head on the lower PR restacks the PRs above it, and a PR whose diff the restack leaves unchanged under the diff rule in `playbooks/shipping.md` step 3, taken against its parent branch, keeps its verdict.

**Reply:** list each PR with its verdict, in place of what merged.
