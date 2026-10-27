import { readDate } from "@icecore/shared/lib/value-utils";

/** Preserve the observed Mongo value, including a genuinely absent revision. */
export function scenarioRevisionFilter(
  updatedAt: unknown
): Record<string, unknown> {
  return updatedAt === undefined
    ? { updatedAt: { $exists: false } }
    : { updatedAt };
}

export const normalizeScenarioRevision = readDate;

export function nextRevisionDate(previousRevision: Date): Date {
  return new Date(Math.max(Date.now(), previousRevision.getTime() + 1));
}
