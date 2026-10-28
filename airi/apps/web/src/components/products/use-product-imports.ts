"use client";

import { useRealtime } from "@/hooks/use-realtime";
import type {
  ProductVideoImportRecord,
  ProductVideoImportsResponse,
} from "@/lib/products/types";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { useEffect, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  fetchProductImports,
  productImportsUrl,
  productImportUrl,
  productsApiUrl,
} from "./products-client";

// The import job announces each step on the workspace's realtime channel. The
// page also asks again on its own while an import runs, since a lost event
// would otherwise leave it waiting.
export const PRODUCT_IMPORT_POLL_MS = 10_000;
const REALTIME_DEBOUNCE_MS = 400;
const NO_IMPORTS: ProductVideoImportRecord[] = [];

export function isImportRunning(
  record: Pick<ProductVideoImportRecord, "status">
) {
  return record.status === "queued" || record.status === "processing";
}

/**
 * The imports the Products page shows, kept live: the list, and each
 * import's own products, refresh when the job reports a step; the shelf
 * too when products were checked, on this device or another.
 */
export function useProductImports(workspaceId: string) {
  const { data, error, mutate } = useSWR<ProductVideoImportsResponse>(
    productImportsUrl(workspaceId),
    fetchProductImports,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      refreshInterval: latest =>
        latest?.imports.some(isImportRunning) ? PRODUCT_IMPORT_POLL_MS : 0,
    }
  );
  const { mutate: mutateKey } = useSWRConfig();
  const scope = useMemo(
    () => ({ kind: "workspace" as const, workspaceId }),
    [workspaceId]
  );
  const { channel, isConnected } = useRealtime(scope);

  // Steps reported while the connection was down are asked for on its return.
  const wasConnected = useRef(isConnected);
  useEffect(() => {
    const before = wasConnected.current;
    wasConnected.current = isConnected;
    if (isConnected && !before) void mutate();
  }, [isConnected, mutate]);

  useEffect(() => {
    if (!channel) return;
    const changed = new Set<string>();
    let reviewed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (event: RealtimeEventEnvelope) => {
      if (event.workspaceId !== workspaceId) return;
      const { importId, reason } = event.payload;
      if (typeof importId === "string") changed.add(importId);
      if (reason === "review") reviewed = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void mutate();
        for (const id of changed)
          void mutateKey(productImportUrl(workspaceId, id));
        changed.clear();
        if (reviewed) void mutateKey(productsApiUrl(workspaceId));
        reviewed = false;
      }, REALTIME_DEBOUNCE_MS);
    };
    channel.bind("products.changed", onChange);
    return () => {
      channel.unbind("products.changed", onChange);
      if (timer) clearTimeout(timer);
    };
  }, [channel, workspaceId, mutate, mutateKey]);

  return {
    imports: data?.imports ?? NO_IMPORTS,
    /** Whether the list was asked for at least once; a failed list shows nothing. */
    settled: data !== undefined || error !== undefined,
    refresh: mutate,
  };
}
