"use client";

import { useRealtime } from "@/hooks/use-realtime";
import {
  CRM_BOARD_REALTIME_DEBOUNCE_MS,
  CRM_BOARD_REALTIME_EVENT_NAMES,
  isCrmRealtimeCacheKey,
} from "@/lib/crm/board-realtime-cache";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSWRConfig } from "swr";

export function CrmWorkspaceRealtime({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { mutate } = useSWRConfig();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scope = useMemo(
    () => ({ kind: "workspace" as const, workspaceId }),
    [workspaceId]
  );
  const { channel, isConnected } = useRealtime(scope);
  const previousConnectedRef = useRef(isConnected);

  const clearDebounce = useCallback(() => {
    const timer = debounceTimerRef.current;
    debounceTimerRef.current = null;
    if (timer) clearTimeout(timer);
  }, []);

  const revalidateCrmViews = useCallback(() => {
    void mutate(
      (key: unknown) => isCrmRealtimeCacheKey(key, workspaceId),
      undefined,
      { revalidate: true }
    );
  }, [mutate, workspaceId]);

  const scheduleRevalidate = useCallback(() => {
    if (debounceTimerRef.current) return;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      revalidateCrmViews();
    }, CRM_BOARD_REALTIME_DEBOUNCE_MS);
  }, [revalidateCrmViews]);

  useEffect(() => {
    const wasConnected = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (!wasConnected && isConnected) {
      revalidateCrmViews();
    }
  }, [isConnected, revalidateCrmViews]);

  useEffect(() => {
    if (!channel) return;

    for (const eventName of CRM_BOARD_REALTIME_EVENT_NAMES) {
      channel.bind(eventName, scheduleRevalidate);
    }
    return () => {
      for (const eventName of CRM_BOARD_REALTIME_EVENT_NAMES) {
        channel.unbind(eventName, scheduleRevalidate);
      }
    };
  }, [channel, scheduleRevalidate]);

  useEffect(() => clearDebounce, [clearDebounce]);

  return null;
}
