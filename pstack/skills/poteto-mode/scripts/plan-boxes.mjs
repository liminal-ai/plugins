// Reads a multi-phase plan the way check-plan.mjs and the merge gate both need it: which lines are code,
// which H2 section belongs to a PR id, its blocks and boxes, and the ids of its required verify boxes.

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

export const SUB_BLOCKS = [
	"Depends on.",
	"Files.",
	"Build.",
	"You see.",
	"Verify, unit.",
	"Verify, live.",
	"Verify, perf.",
	"Review gate.",
	"Merge.",
];
export const MODEL_BLOCK = "Verify, model.";
export const VERIFY_BLOCKS = { "Verify, unit.": "unit", "Verify, live.": "live", "Verify, perf.": "perf", [MODEL_BLOCK]: "model" };
const HEAD = /^\*\*([^*]+)\*\*(.*)$/;
const ITEM = /^([ \t]*)- (.*)$/;
const BOX = /^\[[ x]\] (.*)$/;
const width = (indent) => indent.replace(/\t/g, "    ").length;

/** The blocks of a section, each opened by one of `names` in bold at the start of a line. Other bold text stays in its block. */
export function blocks(sectionLines, names) {
	const found = [];
	for (const l of sectionLines) {
		if (l.code) continue;
		const head = l.text.match(HEAD);
		if (head && names.includes(head[1])) found.push({ name: head[1], n: l.n, rest: head[2].trim(), lines: [] });
		else if (found.length) found.at(-1).lines.push(l);
	}
	return found;
}

/**
 * The boxes in a run of lines, in order. As in Markdown, a box indented at least two columns past the list item
 * above it is nested in that item, and a line of prose back at the item's indent ends the item.
 */
export function boxes(lines) {
	const found = [];
	let parent = null;
	for (const l of lines) {
		if (l.code || l.text.trim() === "") continue;
		const indent = width(l.text.match(/^[ \t]*/)[0]);
		const nested = parent !== null && indent >= parent + 2;
		const item = l.text.match(ITEM);
		if (!nested) parent = item ? indent : null;
		const box = item?.[2].match(BOX);
		if (box) found.push({ n: l.n, text: box[1], nested });
	}
	return found;
}

/**
 * The required boxes of one PR section, in order: unit-<n>, live-<lane>, perf, model-<n>.
 * Nested boxes are sub-steps of the box above them, and the perf block is one measurement, so neither adds an id.
 */
export function verifyBoxIds(sectionLines) {
	const ids = [];
	const counts = { unit: 0, live: 0, model: 0 };
	for (const block of blocks(sectionLines, [...SUB_BLOCKS, MODEL_BLOCK])) {
		const kind = VERIFY_BLOCKS[block.name];
		if (!kind) continue;
		for (const box of boxes(block.lines)) {
			if (box.nested) continue;
			if (kind === "perf") {
				if (!ids.includes("perf")) ids.push("perf");
			} else if (kind === "live") {
				counts.live++;
				const lane = box.text.match(/^Lane (\d+)\. /);
				ids.push(`live-${lane ? lane[1] : counts.live}`);
			} else {
				ids.push(`${kind}-${++counts[kind]}`);
			}
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
