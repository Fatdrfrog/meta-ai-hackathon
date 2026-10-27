"use client";

import { useCallback, useSyncExternalStore } from "react";

export type GeneratedCreativeAssetStatus =
  | "queued"
  | "in_progress"
  | "complete"
  | "failed"
  | "nsfw";

export type GeneratedCreativeAssetView = {
  id: string;
  status: GeneratedCreativeAssetStatus;
  url?: string | null;
  error?: string | null;
  fileName?: string | null;
  updatedAt?: string | null;
};

/** How often a queued or running asset is checked again. */
export const GENERATED_ASSET_POLL_INTERVAL_MS = 3_000;
/** Consecutive 5xx/429/network failures tolerated before giving up. */
export const GENERATED_ASSET_MAX_TRANSIENT_FAILURES = 5;
const GENERATED_ASSET_MAX_RETRY_DELAY_MS = 30_000;
/** A generation still unfinished after this long stops being polled. */
export const GENERATED_ASSET_MAX_POLL_DURATION_MS = 10 * 60_000;

function normalizeGeneratedCreativeAssetView(
  value: unknown
): GeneratedCreativeAssetView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status =
    record.status === "queued" ||
    record.status === "in_progress" ||
    record.status === "complete" ||
    record.status === "failed" ||
    record.status === "nsfw"
      ? record.status
      : null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id || !status) return null;
  return {
    id,
    status,
    url: typeof record.url === "string" ? record.url : null,
    error: typeof record.error === "string" ? record.error : null,
    fileName: typeof record.fileName === "string" ? record.fileName : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function isGeneratedCreativeAssetTerminal(
  asset: GeneratedCreativeAssetView | null
): boolean {
  return (
    asset?.status === "complete" ||
    asset?.status === "failed" ||
    asset?.status === "nsfw"
  );
}

function isTransientAssetResponseStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

class TransientAssetRefreshError extends Error {}

/**
 * One poller per workspace asset, shared by every card showing it (a
 * template header can appear in several). It stops when the last card
 * unmounts, so a later mount fetches again: that request also signs a fresh
 * download URL.
 */
type GeneratedAssetPoller = {
  asset: GeneratedCreativeAssetView | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  startedAt: number;
  transientFailures: number;
};

const generatedAssetPollers = new Map<string, GeneratedAssetPoller>();

function generatedAssetPollerKey(workspaceId: string, assetId: string) {
  return `${workspaceId}\u0000${assetId}`;
}

function publishGeneratedAsset(
  poller: GeneratedAssetPoller,
  asset: GeneratedCreativeAssetView | null
) {
  poller.asset = asset;
  poller.listeners.forEach(listener => listener());
}

function failedGeneratedAsset(
  assetId: string,
  error: string
): GeneratedCreativeAssetView {
  return { id: assetId, status: "failed", error };
}

async function pollGeneratedAsset(
  poller: GeneratedAssetPoller,
  workspaceId: string,
  assetId: string
) {
  poller.timer = null;
  const controller = new AbortController();
  poller.controller = controller;
  let nextAsset: GeneratedCreativeAssetView | null = poller.asset;
  let retryDelay: number | null = null;

  try {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`,
      { cache: "no-store", signal: controller.signal }
    );
    if (!response.ok && isTransientAssetResponseStatus(response.status)) {
      throw new TransientAssetRefreshError(
        `Asset refresh failed: ${response.status}`
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      asset?: unknown;
    };
    poller.transientFailures = 0;
    nextAsset = response.ok
      ? normalizeGeneratedCreativeAssetView(payload.asset)
      : failedGeneratedAsset(
          assetId,
          `Asset refresh failed: ${response.status}`
        );
  } catch (error) {
    if (controller.signal.aborted) return;
    // A 5xx, a 429 or a dropped connection is a blip: keep what the card
    // shows and check again later, giving up only after repeated failures.
    poller.transientFailures += 1;
    if (poller.transientFailures >= GENERATED_ASSET_MAX_TRANSIENT_FAILURES) {
      nextAsset = failedGeneratedAsset(
        assetId,
        error instanceof Error ? error.message : "Asset refresh failed"
      );
    } else {
      retryDelay = Math.min(
        GENERATED_ASSET_POLL_INTERVAL_MS * 2 ** poller.transientFailures,
        GENERATED_ASSET_MAX_RETRY_DELAY_MS
      );
    }
  }

  if (poller.controller !== controller || controller.signal.aborted) return;
  poller.controller = null;

  if (
    retryDelay === null &&
    !isGeneratedCreativeAssetTerminal(nextAsset) &&
    Date.now() - poller.startedAt >= GENERATED_ASSET_MAX_POLL_DURATION_MS
  ) {
    nextAsset = failedGeneratedAsset(
      assetId,
      "Generation is taking longer than expected. Reopen this chat to check again."
    );
  }

  if (nextAsset !== poller.asset) publishGeneratedAsset(poller, nextAsset);
  if (isGeneratedCreativeAssetTerminal(nextAsset)) return;
  poller.timer = setTimeout(
    () => void pollGeneratedAsset(poller, workspaceId, assetId),
    retryDelay ?? GENERATED_ASSET_POLL_INTERVAL_MS
  );
}

function subscribeGeneratedAsset(
  workspaceId: string,
  assetId: string,
  listener: () => void
) {
  const key = generatedAssetPollerKey(workspaceId, assetId);
  let poller = generatedAssetPollers.get(key);
  if (!poller) {
    poller = {
      asset: null,
      listeners: new Set(),
      timer: null,
      controller: null,
      startedAt: Date.now(),
      transientFailures: 0,
    };
    generatedAssetPollers.set(key, poller);
    void pollGeneratedAsset(poller, workspaceId, assetId);
  }
  const activePoller = poller;
  activePoller.listeners.add(listener);
  return () => {
    activePoller.listeners.delete(listener);
    if (activePoller.listeners.size > 0) return;
    if (activePoller.timer) clearTimeout(activePoller.timer);
    activePoller.timer = null;
    activePoller.controller?.abort();
    activePoller.controller = null;
    if (generatedAssetPollers.get(key) === activePoller) {
      generatedAssetPollers.delete(key);
    }
  };
}

function subscribeToNothing() {
  return () => undefined;
}

export function useGeneratedCreativeAsset(
  workspaceId: string,
  assetId: string | null | undefined
): GeneratedCreativeAssetView | null {
  const key = assetId ? generatedAssetPollerKey(workspaceId, assetId) : "";
  const subscribe = useCallback(
    (listener: () => void) =>
      assetId
        ? subscribeGeneratedAsset(workspaceId, assetId, listener)
        : subscribeToNothing(),
    [assetId, workspaceId]
  );
  const getSnapshot = useCallback(
    () => (key ? (generatedAssetPollers.get(key)?.asset ?? null) : null),
    [key]
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
