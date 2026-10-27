import { createHash, randomUUID } from "node:crypto";
import { cache } from "@icecore/shared/lib/cache";
import type { BulkSqlDeliveryReceipt } from "./whatsapp-delivery-reconciliation";

export class BulkAnalyticsQueryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503
  ) {
    super(message);
  }
}

export type BulkAnalyticsSnapshot = {
  workspaceId: string;
  filterKey: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  receipts: BulkSqlDeliveryReceipt[];
};

export function bulkAnalyticsFilterKey(
  workspaceId: string,
  params: URLSearchParams
) {
  const entries = Array.from(params.entries())
    .filter(
      ([name]) =>
        ![
          "view",
          "cursor",
          "limit",
          "refresh",
          "snapshotToken",
          "observedAt",
          "compare",
          "minRunSize",
        ].includes(name)
    )
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return createHash("sha256")
    .update(JSON.stringify([workspaceId, entries]))
    .digest("hex");
}

export async function readBulkAnalyticsSnapshot(
  token: string,
  workspaceId: string,
  filterKey: string
): Promise<BulkAnalyticsSnapshot> {
  if (!/^[0-9a-f-]{36}$/i.test(token))
    throw new BulkAnalyticsQueryError(
      "SNAPSHOT_INVALID",
      "Invalid analytics snapshot",
      409
    );
  const snapshot = await cache.get<BulkAnalyticsSnapshot>(
    `bulk-analytics:snapshot:${token}`
  );
  if (!snapshot)
    throw new BulkAnalyticsQueryError(
      "SNAPSHOT_EXPIRED",
      "Analytics observation expired or its cache is unavailable. Refresh and restart the export.",
      410
    );
  if (snapshot.workspaceId !== workspaceId || snapshot.filterKey !== filterKey)
    throw new BulkAnalyticsQueryError(
      "SNAPSHOT_FILTER_MISMATCH",
      "Analytics filters changed during export",
      409
    );
  // Redis JSON serialization changes dates into strings. Restore receipt dates.
  for (const row of snapshot.receipts) {
    for (const field of [
      "sentAt",
      "deliveredAt",
      "readAt",
      "failedAt",
    ] as const) {
      const value = row.delivery[field];
      row.delivery[field] = value
        ? new Date(value instanceof Date ? value.getTime() : String(value))
        : null;
    }
  }
  return snapshot;
}

export async function saveBulkAnalyticsSnapshot(
  snapshot: BulkAnalyticsSnapshot
): Promise<string | null> {
  const token = randomUUID();
  await cache.set(`bulk-analytics:snapshot:${token}`, snapshot, 600);
  // Cache writes can be fail-soft. Never promise a token that cannot be read.
  return (await cache.get(`bulk-analytics:snapshot:${token}`)) ? token : null;
}
