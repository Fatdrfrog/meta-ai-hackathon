"use client";

import { type FormattedRequest as RequestRow } from "@/features/panel/requests/formatting";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
export type { RequestRow };

type RowUpdateOptions = {
  highlight?: boolean;
};

interface RequestsRealtimeContextValue {
  addNewRow: (row: RequestRow, options?: RowUpdateOptions) => void;
  updateRow: (row: RequestRow, options?: RowUpdateOptions) => void;
  patchRow: (id: string, patch: Partial<RequestRow>) => void;
  patchRows: (ids: string[], patch: Partial<RequestRow>) => void;
  updatedRowIds: Set<string>;
  realtimeRows: RequestRow[];
}

const RequestsRealtimeContext =
  createContext<RequestsRealtimeContextValue | null>(null);

function getRowVersionKey(row: RequestRow): string {
  return JSON.stringify({
    id: row.id,
    dateValue: row.dateValue,
    source: row.source,
    status: row.status,
    client: row.client,
    rename: row.rename ?? null,
    request: row.request,
    category: row.category,
    action: row.action,
    channel: row.channel,
    lastInboundMessageAt: row.lastInboundMessageAt ?? null,
    avatarUrl: row.avatarUrl ?? null,
    lastMessageText: row.lastMessageText ?? null,
    lastMessageAuthor: row.lastMessageAuthor ?? null,
    lastMessageDirection: row.lastMessageDirection ?? null,
    lastMessageThreadId: row.lastMessageThreadId ?? null,
    lastMessages: row.lastMessages ?? [],
    chatType: row.chatType ?? null,
    awaitingCsat: row.awaitingCsat === true,
    customerSatisfactionScore: row.customerSatisfactionScore ?? null,
    airiLastReplied: row.airiLastReplied === true,
    isReadByManager: row.isReadByManager === true,
    isInstagramCommentThread: row.isInstagramCommentThread === true,
    instagramMeta: row.instagramMeta ?? null,
    internalLabels: row.internalLabels ?? [],
  });
}

function rowsAreEquivalent(previous: RequestRow, next: RequestRow): boolean {
  return getRowVersionKey(previous) === getRowVersionKey(next);
}

export function useRequestsRealtime() {
  const context = useContext(RequestsRealtimeContext);
  if (!context) {
    throw new Error(
      "useRequestsRealtime must be used within RequestsRealtimeProvider"
    );
  }
  return context;
}

export function RequestsRealtimeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [realtimeRows, setRealtimeRows] = useState<RequestRow[]>([]);
  const realtimeRowsRef = useRef<RequestRow[]>([]);
  const [updatedRowIds, setUpdatedRowIds] = useState<Set<string>>(new Set());
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const commitRealtimeRows = useCallback((nextRows: RequestRow[]) => {
    realtimeRowsRef.current = nextRows;
    setRealtimeRows(nextRows);
  }, []);

  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach(timeout => {
        clearTimeout(timeout);
      });
      timeoutsRef.current.clear();
    };
  }, []);

  const markRowUpdated = useCallback((rowId: string) => {
    setUpdatedRowIds(prev => {
      if (prev.has(rowId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });

    const existing = timeoutsRef.current.get(rowId);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      setUpdatedRowIds(prev => {
        if (!prev.has(rowId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
      timeoutsRef.current.delete(rowId);
    }, 2000);

    timeoutsRef.current.set(rowId, timeout);
  }, []);

  const addNewRow = useCallback(
    (newRow: RequestRow, options: RowUpdateOptions = {}) => {
      const previousRows = realtimeRowsRef.current;
      const exists = previousRows.some(row => row.id === newRow.id);
      if (exists) return;

      commitRealtimeRows([newRow, ...previousRows]);

      if (options.highlight !== false) {
        markRowUpdated(newRow.id);
      }
    },
    [commitRealtimeRows, markRowUpdated]
  );

  const updateRow = useCallback(
    (updatedRow: RequestRow, options: RowUpdateOptions = {}) => {
      const previousRows = realtimeRowsRef.current;
      const index = previousRows.findIndex(row => row.id === updatedRow.id);
      if (index === -1) {
        commitRealtimeRows([updatedRow, ...previousRows]);
      } else {
        const existingRow = previousRows[index];
        if (rowsAreEquivalent(existingRow, updatedRow)) {
          return;
        }

        const nextRows = previousRows.filter(row => row.id !== updatedRow.id);
        commitRealtimeRows([updatedRow, ...nextRows]);
      }

      if (options.highlight !== false) {
        markRowUpdated(updatedRow.id);
      }
    },
    [commitRealtimeRows, markRowUpdated]
  );

  const patchRow = useCallback(
    (id: string, patch: Partial<RequestRow>) => {
      const previousRows = realtimeRowsRef.current;
      let changed = false;
      const nextRows = previousRows.map(row => {
        if (row.id !== id) return row;

        const nextRow = { ...row, ...patch };
        if (rowsAreEquivalent(row, nextRow)) return row;

        changed = true;
        return nextRow;
      });

      if (changed) {
        commitRealtimeRows(nextRows);
      }
    },
    [commitRealtimeRows]
  );

  const patchRows = useCallback(
    (ids: string[], patch: Partial<RequestRow>) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const previousRows = realtimeRowsRef.current;
      let changed = false;
      const nextRows = previousRows.map(row => {
        if (!idSet.has(row.id)) return row;

        const nextRow = { ...row, ...patch };
        if (rowsAreEquivalent(row, nextRow)) return row;

        changed = true;
        return nextRow;
      });

      if (changed) {
        commitRealtimeRows(nextRows);
      }
    },
    [commitRealtimeRows]
  );

  const value: RequestsRealtimeContextValue = useMemo(
    () => ({
      addNewRow,
      updateRow,
      patchRow,
      patchRows,
      updatedRowIds,
      realtimeRows,
    }),
    [addNewRow, patchRow, patchRows, updateRow, updatedRowIds, realtimeRows]
  );

  return (
    <RequestsRealtimeContext.Provider value={value}>
      {children}
    </RequestsRealtimeContext.Provider>
  );
}
