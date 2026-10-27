"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  DASHBOARD_TEMPLATE_IDS,
  normalizeStoredDashboardBoard,
  type DashboardBoardState,
  type DashboardTemplateId,
} from "./dashboard-board-model";

const STORAGE_PREFIX = "airi:analytics-dashboards:v1";
const CHANGE_EVENT = "airi:analytics-dashboards-memory";

/**
 * Per-browser convenience only: the saved layout stays in the preference API.
 * Storage may be unavailable (private mode, blocked site data), so every access
 * is guarded and an empty memory is always a valid answer.
 */
export type DashboardBoardMemory = {
  /** Dashboard last opened by this member in this browser. */
  viewId: string | null;
  /** Last layout the server confirmed; shown read-only while the next read runs. */
  board: DashboardBoardState | null;
  /** Last recommended starting template for a member without a saved layout. */
  templateId: DashboardTemplateId | null;
};

const EMPTY_MEMORY: DashboardBoardMemory = {
  viewId: null,
  board: null,
  templateId: null,
};

function storageKey(workspaceId: string, memberId: string) {
  return `${STORAGE_PREFIX}:${workspaceId}:${memberId}`;
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function parseDashboardBoardMemory(
  raw: string | null
): DashboardBoardMemory {
  if (!raw) return EMPTY_MEMORY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return EMPTY_MEMORY;
    const record = value as Record<string, unknown>;
    return {
      viewId:
        typeof record.viewId === "string" && record.viewId.length <= 80
          ? record.viewId
          : null,
      board:
        record.board == null
          ? null
          : normalizeStoredDashboardBoard(record.board),
      templateId:
        DASHBOARD_TEMPLATE_IDS.find(id => id === record.templateId) ?? null,
    };
  } catch {
    return EMPTY_MEMORY;
  }
}

export function writeDashboardBoardMemory(
  workspaceId: string,
  memberId: string,
  patch: Partial<DashboardBoardMemory>
) {
  const key = storageKey(workspaceId, memberId);
  try {
    const current = readRaw(key);
    const next = JSON.stringify({
      ...parseDashboardBoardMemory(current),
      ...patch,
    });
    if (next === current) return;
    window.localStorage.setItem(key, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Remembering is optional; the in-session selection still works.
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Server renders see no memory, so hydration matches before storage is read. */
export function useDashboardBoardMemory(
  workspaceId: string,
  memberId: string
): DashboardBoardMemory {
  const key = storageKey(workspaceId, memberId);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null
  );
  return useMemo(() => parseDashboardBoardMemory(raw), [raw]);
}
