import type { FormattedRequest as RequestItem } from "@/features/panel/requests/formatting";
import {
  compareProjectionGenerations,
  compareSourceWatermarks,
} from "@icecore/shared/types/requests-realtime";

function getRequestTimestamp(row: RequestItem): number | null {
  const timestamp = new Date(row.dateValue).getTime();

  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareDisplayRequests(
  a: RequestItem,
  b: RequestItem,
  updatedRowIds: Set<string>
): number {
  const dateA = getRequestTimestamp(a);
  const dateB = getRequestTimestamp(b);

  if (dateA !== null && dateB !== null && dateA !== dateB) {
    return dateB - dateA;
  }

  if (dateA === null && dateB !== null) return 1;
  if (dateA !== null && dateB === null) return -1;

  const aIsUpdated = updatedRowIds.has(a.id);
  const bIsUpdated = updatedRowIds.has(b.id);

  if (aIsUpdated && !bIsUpdated) return -1;
  if (!aIsUpdated && bIsUpdated) return 1;

  return 0;
}

function applyLocalReadOverride(
  row: RequestItem,
  locallyReadAtByConversation: Map<string, number>
): RequestItem {
  if (row.isReadByManager === true) return row;

  const readAt = locallyReadAtByConversation.get(row.id);
  if (!readAt) return row;

  const rowTimestamp = getRequestTimestamp(row);
  if (rowTimestamp !== null && rowTimestamp > readAt) {
    return row;
  }

  return { ...row, isReadByManager: true };
}

export function mergeDisplayRequests({
  allRequests,
  realtimeRows,
  updatedRowIds,
  hasServerBackedFilter,
  hasUnreadFilter,
  recentlyReadInUnreadView,
  locallyReadAtByConversation = new Map(),
}: {
  allRequests: RequestItem[];
  realtimeRows: RequestItem[];
  updatedRowIds: Set<string>;
  hasServerBackedFilter: boolean;
  hasUnreadFilter: boolean;
  recentlyReadInUnreadView: Set<string>;
  locallyReadAtByConversation?: Map<string, number>;
}): RequestItem[] {
  const rowMap = new Map<string, RequestItem>();
  const loadedIds = new Set(allRequests.map(row => row.id));

  allRequests.forEach(row => {
    rowMap.set(row.id, row);
  });

  realtimeRows.forEach(row => {
    if (hasServerBackedFilter && !loadedIds.has(row.id)) {
      return;
    }

    const previous = rowMap.get(row.id);
    if (previous?.projectionGeneration && row.projectionGeneration) {
      const generationOrder = compareProjectionGenerations(
        row.projectionGeneration,
        previous.projectionGeneration
      );
      if (generationOrder < 0) return;
      if (
        generationOrder === 0 &&
        previous.readStateWatermark &&
        row.readStateWatermark &&
        compareSourceWatermarks(
          row.readStateWatermark,
          previous.readStateWatermark
        ) < 0
      )
        return;
    }

    rowMap.set(row.id, row);
  });

  const merged = Array.from(rowMap.values())
    .map(row => applyLocalReadOverride(row, locallyReadAtByConversation))
    .sort((a, b) => compareDisplayRequests(a, b, updatedRowIds));

  if (hasUnreadFilter) {
    return merged.filter(
      row =>
        row.isReadByManager !== true || recentlyReadInUnreadView.has(row.id)
    );
  }

  return merged;
}
