import { createHash } from "node:crypto";

export function serializeStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeStableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${serializeStableJson(entry)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createStableJsonSha256(value: unknown): string {
  return createHash("sha256").update(serializeStableJson(value)).digest("hex");
}

function normalizeContentHashValue(
  value: unknown,
  path: readonly string[] = []
): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => normalizeContentHashValue(entry, path));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (path.length === 0 && key === "campaignId") {
        return [key, "{campaignId}"];
      }
      if (path.length === 0 && key === "sentByUserId") {
        return [key, "{sentByUserId}"];
      }
      if (
        key === "unsubscribeUrl" &&
        ((path.length === 2 &&
          path[0] === "recipient" &&
          path[1] === "variables") ||
          (path.length === 1 && path[0] === "templateModel"))
      ) {
        return [key, "{unsubscribeUrl}"];
      }
      return [key, normalizeContentHashValue(entry, [...path, key])];
    })
  );
}

export function createPreparedBulkCampaignContentHash(
  snapshots: Array<{
    recipientHash: string;
    snapshotOrdinal?: number;
    dispatchSnapshot: Record<string, unknown>;
  }>
): string {
  const stableSnapshots = snapshots
    .map(snapshot => ({
      recipientHash: snapshot.recipientHash,
      ...(Number.isInteger(snapshot.snapshotOrdinal) &&
      Number(snapshot.snapshotOrdinal) >= 0
        ? { snapshotOrdinal: Number(snapshot.snapshotOrdinal) }
        : {}),
      dispatchSnapshot: normalizeContentHashValue(snapshot.dispatchSnapshot),
    }))
    .sort((left, right) => {
      if (
        left.snapshotOrdinal !== undefined &&
        right.snapshotOrdinal !== undefined
      ) {
        return left.snapshotOrdinal - right.snapshotOrdinal;
      }
      if (left.snapshotOrdinal !== undefined) return -1;
      if (right.snapshotOrdinal !== undefined) return 1;
      return left.recipientHash.localeCompare(right.recipientHash);
    });
  return createStableJsonSha256(stableSnapshots);
}
