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

export const VERIFY_BLOCKS: Readonly<Record<string, string>>;
export function planLines(raw: readonly string[], from?: number): PlanLine[];
export function verifyBoxIds(sectionLines: readonly PlanLine[]): string[];
export function prSections(text: string, prId: string): PlanSection[];
