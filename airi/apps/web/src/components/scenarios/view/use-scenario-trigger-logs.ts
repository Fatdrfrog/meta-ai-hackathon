"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchScenarioTriggerLogs } from "@/lib/scenarios/client";
import type { TranslateFn } from "../types";
import type { ScenarioTriggerLogEntry } from "@/lib/scenarios/trigger-log-meta";

type UseScenarioTriggerLogsParams = {
  workspaceId: string;
  activeScenarioId: string | null;
  t: TranslateFn;
};

const TRIGGER_LOG_LOOKBACK_DAYS = 14;
const TRIGGER_LOG_PAGE_SIZE = 160;
const EMPTY_TRIGGER_LOGS: ScenarioTriggerLogEntry[] = [];

export function useScenarioTriggerLogs({
  workspaceId,
  activeScenarioId,
  t,
}: UseScenarioTriggerLogsParams) {
  const [showTriggerLogPanel, setShowTriggerLogPanel] = useState(false);
  const [triggerLogs, setTriggerLogs] = useState<ScenarioTriggerLogEntry[]>([]);
  const [triggerLogsNextCursor, setTriggerLogsNextCursor] = useState<
    string | null
  >(null);
  const [triggerLogsHasMore, setTriggerLogsHasMore] = useState(false);
  const [loadingTriggerLogs, setLoadingTriggerLogs] = useState(false);
  const [triggerLogsScenarioId, setTriggerLogsScenarioId] =
    useState(activeScenarioId);
  const triggerLogsRequestTokenRef = useRef(0);
  const triggerLogsScenarioSynced = triggerLogsScenarioId === activeScenarioId;
  const effectiveTriggerLogs = triggerLogsScenarioSynced
    ? triggerLogs
    : EMPTY_TRIGGER_LOGS;
  const effectiveTriggerLogsHasMore = triggerLogsScenarioSynced
    ? triggerLogsHasMore
    : false;
  const effectiveLoadingTriggerLogs = triggerLogsScenarioSynced
    ? loadingTriggerLogs
    : false;

  const resetTriggerLogs = useCallback(() => {
    triggerLogsRequestTokenRef.current += 1;
    setTriggerLogs(EMPTY_TRIGGER_LOGS);
    setTriggerLogsNextCursor(null);
    setTriggerLogsHasMore(false);
    setLoadingTriggerLogs(false);
  }, []);

  if (!triggerLogsScenarioSynced) {
    triggerLogsRequestTokenRef.current += 1;
    setTriggerLogs(EMPTY_TRIGGER_LOGS);
    setTriggerLogsNextCursor(null);
    setTriggerLogsHasMore(false);
    setLoadingTriggerLogs(false);
    setTriggerLogsScenarioId(activeScenarioId);
  }

  const loadTriggerLogs = useCallback(async () => {
    if (!workspaceId || !activeScenarioId) {
      resetTriggerLogs();
      return;
    }

    const requestToken = triggerLogsRequestTokenRef.current + 1;
    triggerLogsRequestTokenRef.current = requestToken;

    try {
      setLoadingTriggerLogs(true);
      const payload = await fetchScenarioTriggerLogs({
        workspaceId,
        scenarioId: activeScenarioId,
        days: TRIGGER_LOG_LOOKBACK_DAYS,
        limit: TRIGGER_LOG_PAGE_SIZE,
      });
      if (triggerLogsRequestTokenRef.current !== requestToken) return;

      setTriggerLogs(payload.logs);
      setTriggerLogsNextCursor(payload.nextCursor);
      setTriggerLogsHasMore(payload.hasMore);
    } catch {
      if (triggerLogsRequestTokenRef.current !== requestToken) return;
      toast.error(t("triggerLogLoadFailed"));
    } finally {
      if (triggerLogsRequestTokenRef.current === requestToken) {
        setLoadingTriggerLogs(false);
      }
    }
  }, [activeScenarioId, resetTriggerLogs, t, workspaceId]);

  const loadMoreTriggerLogs = useCallback(async () => {
    if (!workspaceId || !activeScenarioId || !triggerLogsNextCursor) return;

    const requestToken = triggerLogsRequestTokenRef.current + 1;
    triggerLogsRequestTokenRef.current = requestToken;

    try {
      setLoadingTriggerLogs(true);
      const payload = await fetchScenarioTriggerLogs({
        workspaceId,
        scenarioId: activeScenarioId,
        days: TRIGGER_LOG_LOOKBACK_DAYS,
        limit: TRIGGER_LOG_PAGE_SIZE,
        cursor: triggerLogsNextCursor,
      });
      if (triggerLogsRequestTokenRef.current !== requestToken) return;

      setTriggerLogs(current => [...current, ...payload.logs]);
      setTriggerLogsNextCursor(payload.nextCursor);
      setTriggerLogsHasMore(payload.hasMore);
    } catch {
      if (triggerLogsRequestTokenRef.current !== requestToken) return;
      toast.error(t("triggerLogLoadFailed"));
    } finally {
      if (triggerLogsRequestTokenRef.current === requestToken) {
        setLoadingTriggerLogs(false);
      }
    }
  }, [activeScenarioId, t, triggerLogsNextCursor, workspaceId]);

  const toggleTriggerLogPanel = useCallback(() => {
    setShowTriggerLogPanel(current => !current);
  }, []);

  useEffect(() => {
    if (!showTriggerLogPanel) return;
    void loadTriggerLogs();
  }, [loadTriggerLogs, showTriggerLogPanel]);

  return {
    showTriggerLogPanel,
    setShowTriggerLogPanel,
    toggleTriggerLogPanel,
    triggerLogs: effectiveTriggerLogs,
    triggerLogsHasMore: effectiveTriggerLogsHasMore,
    loadingTriggerLogs: effectiveLoadingTriggerLogs,
    loadTriggerLogs,
    loadMoreTriggerLogs,
  };
}
