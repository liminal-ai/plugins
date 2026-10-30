import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const checker = join(import.meta.dir, "check-plan.mjs");
const rule =
	"Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";

const recordOfDone = "This plan is the record of done.";

const validPlan = `# Demo

## How to read this
One box is one unit of work and names the evidence. Check a box only when its evidence exists. See playbooks/.
${rule}
${recordOfDone}

## Program checklist
### Arm the program
### Spawn owners
### PR mechanics
### Verdict and merge
### Boot recipe
\`git show origin/lim:\` \`schedule_task\` status message

## PR 1
**Depends on.** None.
**Files.**
- [ ] Do the thing.
**Build.**
- [ ] Do the thing.
**You see.**
- [ ] Do the thing.
**Verify, unit.** ${rule}
- [ ] Check the thing.
**Verify, live.** ${rule} Lanes on \`example-model\` at the PR head, driven through \`verify-example\`.
${Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. Save \`lane-${i + 1}.png\`. Pass when evidence exists.`).join("\n")}
**Verify, perf.** ${rule}
- [ ] Metric. Recorded.
- [ ] Probe. Recorded.
- [ ] Baseline. Recorded.
- [ ] Rule. Recorded.
**Review gate.** None.
**Merge.**
- [ ] Merge when approved.

## Close the program
File a ticket for each Owed item. Name each scope cut. Delete the \`schedule_task\`.

## Appendix Prototype evidence
Recorded.

## Appendix. Later work and scope cuts
**Scope cuts.**
None.
**Decided no.**
- A mobile layout. No, because the app has no mobile users.
**Owed.**
- A retry button.
`;

const runPlan = (example: string, expectedExit: number) => runText(validPlan + example, expectedExit);

const runText = (text: string, expectedExit: number) => {
	const directory = mkdtempSync(join(tmpdir(), "check-plan-test-"));
	const file = join(directory, "plan.md");
	writeFileSync(file, text);
	try {
		const result = spawnSync("node", [checker, file], { encoding: "utf8" });
		expect(result.status).toBe(expectedExit);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

test("accepts ordinary, indented, and longer closing fences", () => {
	for (const indent of ["", " ", "  ", "   "])
		runPlan(`${indent}\`\`\`markdown\n## Example only\n${indent}\`\`\`\n`, 0);
	runPlan("```markdown\n## Example only\n````\n", 0);
});

test("accepts nested backticks and tilde info strings", () => {
	runPlan("````markdown\n```markdown\n## Example only\n```\n````\n", 0);
	runPlan("~~~markdown `info`\n## Example only\n ~~~\n", 0);
});

test("keeps mismatched, shorter, and suffixed closers inside the fence", () => {
	runPlan("````markdown\n~~~\n## Example only\n````\n", 0);
	runPlan("````markdown\n```\n## Example only\n````\n", 0);
	runPlan("````markdown\n``` info\n## Example only\n````\n", 0);
});

test("rejects headings and prose outside a proper close", () => {
	for (const suffix of ["  ", "\t"]) {
		const heading = runPlan(`\`\`\`markdown\n## Example only\n\`\`\`${suffix}\n## Example only\n`, 1);
		expect(heading.stderr).toContain('"## Example only" after Close the program is not an appendix');
	}

	const prose = runPlan("```markdown\nThis prose has a mid-sentence colon: inside code\n```\nThis prose has a mid-sentence colon: bad.\n", 1);
	expect(prose.stderr).toContain("mid-sentence colon");
});

test("rejects backtick info strings containing a backtick", () => {
	const result = runPlan("```markdown `invalid`\n## Example only\n```\n", 1);
	expect(result.stderr).toContain('"## Example only" after Close the program is not an appendix');
});

test("prints the verdict box ids of each PR", () => {
	const result = runPlan("", 0);
	expect(result.stdout).toContain("verdict boxes: unit-1 live-1 live-2 live-3 live-4 live-5 live-6 live-7 live-8 live-9 live-10 perf\n");
});

const allIds = "verdict boxes: unit-1 live-1 live-2 live-3 live-4 live-5 live-6 live-7 live-8 live-9 live-10 perf\n";
const lane = (n: number) => `- [ ] Lane ${n}. Save \`lane-${n}.png\`. Pass when evidence exists.`;

test("gives indented top-level boxes the ids it checks them as", () => {
	for (const indent of [" ", "  ", "   "]) {
		const result = runText(validPlan.replaceAll(/^- \[ \] Lane/gm, `${indent}- [ ] Lane`), 0);
		expect(result.stdout).toContain(allIds);
	}
});

test("reads a box indented under another as its sub-step, with no id of its own", () => {
	const result = runText(validPlan.replace(lane(3), `${lane(3)}\n  - [ ] Open the app first.`), 0);
	expect(result.stdout).toContain(allIds);
});

test("keeps a verify block's boxes across bold text that is not a block heading", () => {
	const result = runText(validPlan.replace(lane(6), `**Linux.**\n${lane(6)}`), 0);
	expect(result.stdout).toContain(allIds);
});

const modelBlock = "**Verify, model.** Run the formal verification skill.\n- [ ] A stopped envelope never starts. Pass when it holds.\n";

test("accepts a Verify, model block after the perf block and gives its boxes ids", () => {
	const result = runText(validPlan.replace("**Review gate.** None.", `${modelBlock}**Review gate.** None.`), 0);
	expect(result.stdout).toContain("live-10 perf model-1\n");
});

test("rejects a Verify, model block out of place or without a box", () => {
	const early = runText(validPlan.replace("**Verify, perf.**", `${modelBlock}**Verify, perf.**`), 1);
	expect(early.stderr).toContain("with an optional Verify, model. after Verify, perf.");
	const empty = runText(validPlan.replace("**Review gate.** None.", "**Verify, model.** Run it.\n**Review gate.** None."), 1);
	expect(empty.stderr).toContain("Verify, model. has no box");
});

test("requires the later-work appendix, with a reason for each decided no", () => {
	const later = validPlan.indexOf("## Appendix. Later work");
	expect(runText(validPlan.slice(0, later), 1).stderr).toContain("Later work and scope cuts");
	expect(runText(validPlan.replace("No, because the app has no mobile users.", "Not now."), 1).stderr).toContain("a Decided no item gives no reason");
	expect(runText(validPlan.replace("**Scope cuts.**\nNone.\n", "**Scope cuts.**\n"), 1).stderr).toContain('Scope cuts. lists nothing. Write "None."');
});

test("requires close-out to read back the owed list, the scope cuts, and the wake", () => {
	const result = runText(validPlan.replace("File a ticket for each Owed item. Name each scope cut. Delete the `schedule_task`.", "Close."), 1);
	for (const marker of ["Owed", "scope cut", "schedule_task"]) expect(result.stderr).toContain(`Close the program lacks "${marker}"`);
});

test("requires the role file's wake mechanism, not a Claude-only loop", () => {
	const result = runText(validPlan.replace("`schedule_task` status message", "/loop 1h status message"), 1);
	expect(result.stderr).toContain('Program checklist lacks "schedule_task"');
});

const playbook = readFileSync(join(import.meta.dir, "..", "playbooks", "multi-phase-plan.md"), "utf8");
const skeleton = playbook.slice(playbook.indexOf("````markdown\n") + 12, playbook.lastIndexOf("````"));

test("the template opts in to the record of done", () => {
	const later = skeleton.indexOf("## Appendix. Later work and scope cuts");
	expect(later).toBeGreaterThan(-1);
	expect(runText(skeleton.slice(0, later), 1).stderr).toContain('no "## Appendix. Later work and scope cuts" section');
});

test("a plan written before the record of done keeps the checks it had", () => {
	const legacy = validPlan
		.replace(`${recordOfDone}\n`, "")
		.replace("`schedule_task` status message", "/loop 1h status message")
		.replace("File a ticket for each Owed item. Name each scope cut. Delete the `schedule_task`.", "Close.")
		.replace(/## Appendix\. Later work[\s\S]*$/, "## Appendix E. Reserved calls\nThe operator's calls.\n");
	const result = runText(legacy, 0);
	expect(result.stderr).toBe("");
	expect(runText(legacy.replace("/loop 1h status message", "status message"), 1).stderr).toContain('Program checklist lacks "schedule_task"');
});

test("an opted-in plan's own Appendix E does not stand in for the Later work appendix", () => {
	const result = runText(validPlan.replace(/## Appendix\. Later work[\s\S]*$/, "## Appendix E. Later work the operator reserved\nThe operator's calls.\n"), 1);
	expect(result.stderr).toContain('no "## Appendix. Later work and scope cuts" section');
});

test("ignores prose punctuation inside matching multi-backtick code spans", () => {
	for (const count of [2, 3, 4]) {
		const delimiter = "`".repeat(count);
		runPlan(`Use ${delimiter}echo \`x\`: “quoted” — example${delimiter}.\n`, 0);
	}
});

test("checks prose following a multi-backtick span and unmatched delimiters", () => {
	const outside = runPlan("Use ``echo `x`: y``. Bad: prose.\n", 1);
	expect(outside.stderr).toContain("mid-sentence colon");
	const unmatched = runPlan("Use ``unclosed: bad` here.\n", 1);
	expect(unmatched.stderr).toContain("mid-sentence colon");
});

test("sizes the live lanes to the PR, numbered 1 to n with no gap", () => {
	const three = validPlan.replace(/(- \[ \] Lane 3\..*\n)(?:- \[ \] Lane \d+\..*\n)+/, "$1");
	expect(runText(three, 0).stdout).toContain("verdict boxes: unit-1 live-1 live-2 live-3 perf\n");
	const gap = runText(validPlan.replace(`${lane(4)}\n`, ""), 1);
	expect(gap.stderr).toContain("lanes are [1,2,3,5,6,7,8,9,10], expected 1 to 9 with no gap or repeat");
});

test("takes any evidence file a lane names and flags a lane with no evidence or no pass predicate", () => {
	expect(runText(validPlan.replace(lane(2), "- [ ] Lane 2. Save `lane-2.txt`. Pass when evidence exists."), 0).stderr).toBe("");
	expect(runText(validPlan.replace(lane(2), "- [ ] Lane 2. Pass when evidence exists."), 1).stderr).toContain("lane 2 names no evidence file");
	expect(runText(validPlan.replace(lane(2), "- [ ] Lane 2. Save `lane-2.txt`."), 1).stderr).toContain("lane 2 has no pass predicate");
});

test("the template leaves the evidence form to the verify skill", () => {
	expect(skeleton.split("\n").filter((l) => /Lane |lane-<n>/.test(l) && l.includes(".png"))).toEqual([]);
});

test("requires the live block to name its model and the verify skill that drives it", () => {
	const unnamed = runText(validPlan.replace(", driven through `verify-example`.", "."), 1);
	expect(unnamed.stderr).toContain("driven through");
	const legacy = runText(validPlan.replace("Lanes on `example-model` at the PR head, driven through `verify-example`.", "Ten lanes on `example-model` at the PR head."), 0);
	expect(legacy.stderr).toBe("");
});
