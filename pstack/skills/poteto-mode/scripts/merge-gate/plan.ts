import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { prSections, verifyBoxIds } from "../plan-boxes.mjs";
import type { PlanBoxes, PlanFact, PlanRef } from "./gate.ts";
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

const expand = (path: string): string =>
  path.replace(/^~(?=\/|$)/, homedir());

/**
 * The plan a run checks. A passed plan must be the declared one: the same PR id, and the same file
 * on disk. A relative path resolves from `cwd`. A path suffix is no proof of identity, because a
 * stale copy in another checkout ends the same way and can list fewer boxes.
 */
export function resolvePlan(
  passed: PlanRef | null,
  declared: PlanRef | null,
  cwd: string
): PlanFact {
  const where = (ref: PlanRef): string => resolve(cwd, expand(ref.path));
  if (passed !== null && declared !== null) {
    const real = (ref: PlanRef): string | null =>
      existsSync(where(ref)) ? realpathSync(where(ref)) : null;
    const samePlan = real(declared) !== null && real(declared) === real(passed);
    if (!samePlan || passed.pr !== declared.pr)
      return { kind: "mismatch", declared, passed };
  }
  const ref = passed ?? declared;
  if (ref === null) return { kind: "none" };
  if (passed === null && !existsSync(where(ref)))
    return { kind: "declared-missing", declared: ref };
  return {
    kind: "read",
    boxes: readPlanBoxes(where(ref), ref.pr),
    declared: passed === null,
  };
}
