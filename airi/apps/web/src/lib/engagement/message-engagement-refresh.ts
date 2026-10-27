import { ENGAGEMENT_MESSAGE_SELECT } from "./conversation-engagement-metrics";

const inputFields = new Set([
  ...ENGAGEMENT_MESSAGE_SELECT.split(" "),
  "conversation",
]);
function isInput(path: string): boolean {
  return inputFields.has(path.split(".")[0]!);
}

function changesInput(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  return Object.entries(update).some(([operator, fields]) => {
    if (!operator.startsWith("$")) return isInput(operator);
    if (operator === "$replaceRoot" || operator === "$replaceWith") return true;
    if (typeof fields === "string") return isInput(fields);
    if (Array.isArray(fields))
      return fields.some(field => typeof field === "string" && isInput(field));
    if (!fields || typeof fields !== "object") return false;
    return Object.entries(fields).some(
      ([path, value]) =>
        isInput(path) ||
        (operator === "$rename" && typeof value === "string" && isInput(value))
    );
  });
}

/** Query mutations enqueue projection work atomically with the canonical message write. */
export function markEngagementRefreshForQueryUpdate<T>(update: T): T {
  if (Array.isArray(update)) {
    return update.some(changesInput)
      ? ([...update, { $set: { engagementRefreshPending: true } }] as T)
      : update;
  }
  if (!changesInput(update)) return update;
  const fields = update as Record<string, unknown>;
  return {
    ...fields,
    $set: {
      ...(fields.$set as object | undefined),
      engagementRefreshPending: true,
    },
  } as T;
}

/** Shared schema transform covers fresh documents as well as explicitly selected internal state. */
export function stripPrivateEngagementState(
  _document: unknown,
  result: Record<string, unknown>
): Record<string, unknown> {
  delete result.engagementContribution;
  delete result.engagementRefreshPending;
  delete result.engagement_accumulator;
  delete result.engagement_revision;
  return result;
}
