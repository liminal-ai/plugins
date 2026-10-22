import { readFileSync } from "node:fs";
import { prSections, verifyBoxIds } from "../plan-boxes.mjs";
import type { PlanBoxes } from "./gate.ts";
import { ReadError } from "./git.ts";

/** The required verify boxes of one PR's section, read with the same rules check-plan.mjs prints them by. */
export function readPlanBoxes(path: string, pr: string): PlanBoxes {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ReadError(
      `the plan ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const sections = prSections(text, pr);
  if (sections.length !== 1)
    throw new ReadError(
      `the plan ${path} has ${sections.length === 0 ? "no section" : `${sections.length} sections`} whose title ends with "(${pr})"`
    );
  const ids = verifyBoxIds(sections[0].lines);
  if (ids.length === 0)
    throw new ReadError(
      `the plan section "${sections[0].title}" in ${path} has no verify boxes`
    );
  return { path, pr, ids };
}
