export interface PlanLine {
	readonly n: number;
	readonly text: string;
	readonly code: boolean;
}

export interface PlanSection {
	readonly title: string;
	readonly n: number;
	readonly lines: readonly PlanLine[];
}

export interface PlanBlock {
	readonly name: string;
	readonly n: number;
	readonly rest: string;
	readonly lines: readonly PlanLine[];
}

export interface PlanBox {
	readonly n: number;
	readonly text: string;
	readonly nested: boolean;
}

export const SUB_BLOCKS: readonly string[];
export const MODEL_BLOCK: string;
export const VERIFY_BLOCKS: Readonly<Record<string, string>>;
export function planLines(raw: readonly string[], from?: number): PlanLine[];
export function blocks(sectionLines: readonly PlanLine[], names: readonly string[]): PlanBlock[];
export function boxes(lines: readonly PlanLine[]): PlanBox[];
export function verifyBoxIds(sectionLines: readonly PlanLine[]): string[];
export function prSections(text: string, prId: string): PlanSection[];
