// Reads a multi-phase plan the way check-plan.mjs and the merge gate both need it: which lines are code,
// which H2 section belongs to a PR id, and the ids of that section's required verify boxes.

const openingFence = (text) => {
	const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
	return { char: match[1][0], length: match[1].length };
};
const closingFence = (text, opening) => {
	const match = text.match(/^ {0,3}(`+|~+)[ \t]*$/);
	return Boolean(match && match[1][0] === opening.char && match[1].length >= opening.length);
};

/** Every line from `from` on, numbered from 1 and marked `code` when it sits in a fenced block, fences included. */
export function planLines(raw, from = 0) {
	const lines = [];
	let fence = null;
	for (let i = from; i < raw.length; i++) {
		const text = raw[i];
		let code = Boolean(fence);
		if (fence && closingFence(text, fence)) {
			code = false;
			fence = null;
		} else if (!fence) {
			fence = openingFence(text);
			code = Boolean(fence);
		}
		lines.push({ n: i + 1, text, code });
	}
	return lines;
}

export const VERIFY_BLOCKS = { "Verify, unit.": "unit", "Verify, live.": "live", "Verify, perf.": "perf", "Verify, model.": "model" };
const TOP_BOX = /^- \[[ x]\] (.*)$/;
const BOLD_HEAD = /^\*\*([^*]+)\*\*/;

/**
 * The required boxes of one PR section, in order: unit-<n>, live-<lane>, perf, model-<n>.
 * Nested boxes are sub-steps of the box above them, and the perf block is one measurement, so neither adds an id.
 */
export function verifyBoxIds(sectionLines) {
	const ids = [];
	const counts = { unit: 0, live: 0, model: 0 };
	let kind = null;
	for (const l of sectionLines) {
		if (l.code) continue;
		const head = l.text.match(BOLD_HEAD);
		if (head) {
			kind = VERIFY_BLOCKS[head[1]] ?? null;
			continue;
		}
		const box = kind && l.text.match(TOP_BOX);
		if (!box) continue;
		if (kind === "perf") {
			if (!ids.includes("perf")) ids.push("perf");
		} else if (kind === "live") {
			counts.live++;
			const lane = box[1].match(/^Lane (\d+)\. /);
			ids.push(`live-${lane ? lane[1] : counts.live}`);
		} else {
			ids.push(`${kind}-${++counts[kind]}`);
		}
	}
	return ids;
}

/** The H2 sections whose title ends with "(<prId>)". A plan names each PR once, so more than one is a broken plan. */
export function prSections(text, prId) {
	const lines = planLines(text.split(/\r?\n/));
	const found = [];
	for (const l of lines) {
		if (!l.code && l.text.startsWith("## ")) {
			const title = l.text.slice(3).trim();
			found.push({ title, n: l.n, lines: [], mine: title.endsWith(`(${prId})`) });
		} else if (found.length) found.at(-1).lines.push(l);
	}
	return found.filter((s) => s.mine).map(({ title, n, lines: body }) => ({ title, n, lines: body }));
}
