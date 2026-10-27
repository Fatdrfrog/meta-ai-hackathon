"use client";

import { useRealtime } from "@/hooks/use-realtime";
import { useLazyRef } from "@/hooks/use-lazy-ref";
import {
  formatConversationToRequest,
  type FormattedRequest,
  type RawConversation,
} from "@/features/panel/requests/formatting";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import {
  compareProjectionGenerations,
  compareSourceWatermarks,
} from "@icecore/shared/types/requests-realtime";
import { playConversationNotificationSound } from "@/lib/notifications/conversation-sound";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRequestsRealtime } from "./requests-realtime-provider";

interface RequestsRealtimeProps {
  workspaceId: string;
}

type RequestsApiResponse = {
  data?: RawConversation[];
};

const NOTIFICATION_SOUND_CACHE_LIMIT = 200;
const REALTIME_CATCH_UP_LIMIT = 50;
const REALTIME_CATCH_UP_MIN_INTERVAL_MS = 3000;

function getNotificationSoundKey(row: FormattedRequest): string | null {
  if (row.lastMessageDirection !== "inbound") return null;
  if (row.isReadByManager === true) return null;

  const latestAt = row.dateValue || row.lastInboundMessageAt || "";
  const latestText = row.lastMessageText || "";
  if (!latestAt && !latestText) return null;

  return `${row.id}:${latestAt}:${latestText}`;
}

function rememberNotificationKey(
  playedKeys: Set<string>,
  soundKey: string
): boolean {
  if (playedKeys.has(soundKey)) return false;
  playedKeys.add(soundKey);

  while (playedKeys.size > NOTIFICATION_SOUND_CACHE_LIMIT) {
    for (const key of playedKeys) {
      playedKeys.delete(key);
      break;
    }
  }

  return true;
}

export function RequestsRealtime({ workspaceId }: RequestsRealtimeProps) {
  const { updateRow } = useRequestsRealtime();
  const pendingIdsRef = useLazyRef(() => new Set<string>());
  const playedNotificationKeysRef = useLazyRef(() => new Set<string>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCatchUpAtRef = useRef(0);
  const catchUpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const catchUpRetryDelayRef = useRef(REALTIME_CATCH_UP_MIN_INTERVAL_MS);
  const catchUpInFlightRef = useRef<object | null>(null);
  const lifecycleRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const retryDelayRef = useRef(1000);
  const activeRequestsRef = useLazyRef(() => new Set<AbortController>());
  const appliedVersionsRef = useLazyRef(
    () =>
      new Map<
        string,
        {
          sequence: number;
          generation?: string;
          readStateWatermark?: string;
        }
      >()
  );
  const scope = useMemo(
    () => ({ kind: "workspace" as const, workspaceId }),
    [workspaceId]
  );
  const { channel, isConnected } = useRealtime(scope);
  const previousConnectedRef = useRef(false);

  const clearFlushTimer = useCallback(() => {
    const timer = flushTimerRef.current;
    flushTimerRef.current = null;
    if (timer) {
      clearTimeout(timer);
    }
  }, []);

  const hydrateRows = useCallback(
    async (url: string, options?: { playSound?: boolean }) => {
      const lifecycle = lifecycleRef.current;
      const sequence = ++requestSequenceRef.current;
      const controller = new AbortController();
      activeRequestsRef.current.add(controller);
      const deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "x-airi-realtime-hydration": "1",
          },
        });
        if (!response.ok) return false;
        const payload = (await response.json()) as RequestsApiResponse;
        if (controller.signal.aborted || lifecycle !== lifecycleRef.current)
          return false;
        let shouldPlaySound = false;

        for (const row of payload.data || []) {
          const formattedRow = formatConversationToRequest(row);
          const previous = appliedVersionsRef.current.get(formattedRow.id);
          if (previous) {
            const generationOrder =
              previous.generation && formattedRow.projectionGeneration
                ? compareProjectionGenerations(
                    formattedRow.projectionGeneration,
                    previous.generation
                  )
                : 0;
            if (generationOrder < 0) continue;
            if (generationOrder === 0) {
              const readOrder =
                previous.readStateWatermark && formattedRow.readStateWatermark
                  ? compareSourceWatermarks(
                      formattedRow.readStateWatermark,
                      previous.readStateWatermark
                    )
                  : 0;
              if (
                readOrder < 0 ||
                (readOrder === 0 && sequence < previous.sequence)
              )
                continue;
            }
          }
          appliedVersionsRef.current.delete(formattedRow.id);
          appliedVersionsRef.current.set(formattedRow.id, {
            sequence,
            generation: formattedRow.projectionGeneration,
            readStateWatermark: formattedRow.readStateWatermark,
          });
          if (appliedVersionsRef.current.size > 2000) {
            const oldest = appliedVersionsRef.current.keys().next().value;
            if (oldest !== undefined) appliedVersionsRef.current.delete(oldest);
          }
          updateRow(formattedRow, {
            highlight: options?.playSound !== false,
          });

          const soundKey = getNotificationSoundKey(formattedRow);
          if (
            options?.playSound !== false &&
            soundKey &&
            rememberNotificationKey(playedNotificationKeysRef.current, soundKey)
          ) {
            shouldPlaySound = true;
          }
        }

        if (shouldPlaySound) {
          playConversationNotificationSound();
        }
        return true;
      } catch {
        // Keep pending row IDs for retry; socket delivery does not guarantee
        // the subsequent authenticated HTTP request can reach the server.
        return false;
      } finally {
        clearTimeout(deadline);
        activeRequestsRef.current.delete(controller);
      }
    },
    [
      activeRequestsRef,
      appliedVersionsRef,
      playedNotificationKeysRef,
      updateRow,
    ]
  );

  const hydrateRecentRows = useCallback(async () => {
    if (document.visibilityState !== "visible" || catchUpInFlightRef.current)
      return;
    const now = Date.now();
    if (now - lastCatchUpAtRef.current < REALTIME_CATCH_UP_MIN_INTERVAL_MS) {
      return;
    }
    lastCatchUpAtRef.current = now;
    if (catchUpRetryTimerRef.current)
      clearTimeout(catchUpRetryTimerRef.current);
    catchUpRetryTimerRef.current = null;
    const lifecycle = lifecycleRef.current;
    const request = {};
    catchUpInFlightRef.current = request;

    const params = new URLSearchParams({
      workspaceId,
      page: "1",
      limit: String(REALTIME_CATCH_UP_LIMIT),
      includeChannels: "false",
    });
    const succeeded = await hydrateRows(`/api/requests?${params.toString()}`, {
      playSound: false,
    });
    if (catchUpInFlightRef.current === request)
      catchUpInFlightRef.current = null;
    if (lifecycle !== lifecycleRef.current) return;
    if (succeeded) {
      catchUpRetryDelayRef.current = REALTIME_CATCH_UP_MIN_INTERVAL_MS;
    } else {
      const delay = catchUpRetryDelayRef.current;
      catchUpRetryDelayRef.current = Math.min(30_000, delay * 2);
      catchUpRetryTimerRef.current = setTimeout(() => {
        catchUpRetryTimerRef.current = null;
        void hydrateRecentRows();
      }, delay);
    }
  }, [hydrateRows, workspaceId]);

  const flushPendingIds = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const ids = Array.from(pendingIdsRef.current).slice(0, 100);
    ids.forEach(id => pendingIdsRef.current.delete(id));
    clearFlushTimer();
    if (ids.length === 0) return;

    const params = new URLSearchParams({
      workspaceId,
      includeChannels: "false",
      conversationIds: ids.join(","),
      limit: String(ids.length),
    });
    const succeeded = await hydrateRows(`/api/requests?${params.toString()}`);
    if (lifecycle !== lifecycleRef.current) return;
    if (!succeeded) ids.forEach(id => pendingIdsRef.current.add(id));
    const delay = succeeded ? 100 : retryDelayRef.current;
    retryDelayRef.current = succeeded ? 1000 : Math.min(30_000, delay * 2);
    if (pendingIdsRef.current.size > 0 && !flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        void flushPendingIds();
      }, delay);
    }
  }, [clearFlushTimer, hydrateRows, pendingIdsRef, workspaceId]);

  useEffect(() => {
    const wasConnected = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;

    if (!wasConnected && isConnected) {
      void hydrateRecentRows();
    }
  }, [hydrateRecentRows, isConnected]);

  useEffect(() => {
    const catchUpIfVisible = () => {
      if (document.visibilityState === "visible") {
        void hydrateRecentRows();
      }
    };

    document.addEventListener("visibilitychange", catchUpIfVisible);
    window.addEventListener("focus", catchUpIfVisible);

    return () => {
      document.removeEventListener("visibilitychange", catchUpIfVisible);
      window.removeEventListener("focus", catchUpIfVisible);
    };
  }, [hydrateRecentRows]);

  const scheduleHydration = useCallback(
    (conversationId: string) => {
      pendingIdsRef.current.add(conversationId);
      if (flushTimerRef.current) return;
      flushTimerRef.current = setTimeout(() => {
        void flushPendingIds();
      }, 100);
    },
    [flushPendingIds, pendingIdsRef]
  );

  useEffect(() => {
    if (!channel) return undefined;

    const onRowChanged = (event: RealtimeEventEnvelope) => {
      const conversationId =
        typeof event.payload.conversationId === "string"
          ? event.payload.conversationId
          : event.conversationId || null;
      if (!conversationId) return;
      scheduleHydration(conversationId);
    };

    channel.bind("conversation.row.changed", onRowChanged);
    return () => {
      channel.unbind("conversation.row.changed", onRowChanged);
    };
  }, [channel, scheduleHydration]);

  useEffect(() => {
    const pendingIds = pendingIdsRef.current;
    const appliedVersions = appliedVersionsRef.current;
    const playedNotificationKeys = playedNotificationKeysRef.current;
    const activeRequests = activeRequestsRef.current;
    return () => {
      lifecycleRef.current += 1;
      clearFlushTimer();
      pendingIds.clear();
      appliedVersions.clear();
      playedNotificationKeys.clear();
      activeRequests.forEach(controller => controller.abort());
      activeRequests.clear();
      lastCatchUpAtRef.current = 0;
      if (catchUpRetryTimerRef.current)
        clearTimeout(catchUpRetryTimerRef.current);
      catchUpRetryTimerRef.current = null;
      catchUpInFlightRef.current = null;
      catchUpRetryDelayRef.current = REALTIME_CATCH_UP_MIN_INTERVAL_MS;
      previousConnectedRef.current = false;
      retryDelayRef.current = 1000;
    };
  }, [
    activeRequestsRef,
    appliedVersionsRef,
    clearFlushTimer,
    pendingIdsRef,
    playedNotificationKeysRef,
    workspaceId,
  ]);

  return null;
}
