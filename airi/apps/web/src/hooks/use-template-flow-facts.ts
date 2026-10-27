"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import {
  isWhatsAppFlowGraphId,
  type TemplateFlowFacts,
} from "@/lib/whatsapp/flows/template-flow-health";

type FactsMap = Record<string, TemplateFlowFacts>;

function newerFacts(
  current: TemplateFlowFacts | undefined,
  candidate: TemplateFlowFacts
): TemplateFlowFacts {
  if (!current) return candidate;
  return Date.parse(candidate.checkedAt) >= Date.parse(current.checkedAt)
    ? candidate
    : current;
}

/**
 * Facts about the Flows that template buttons open, for the template Flow
 * checks. Facts load once per set of Flow ids; `refresh` re-reads Meta for
 * the Flows one "Check again" covers.
 */
export function useTemplateFlowFacts(params: {
  workspaceId?: string | null;
  sourceId?: string;
  flowIds: readonly string[];
  enabled?: boolean;
}) {
  const { workspaceId, sourceId, enabled = true } = params;
  const flowIdsKey = useMemo(
    () =>
      Array.from(new Set(params.flowIds.filter(isWhatsAppFlowGraphId)))
        .sort()
        .join(","),
    [params.flowIds]
  );
  const requestKey =
    enabled && workspaceId && flowIdsKey
      ? `${workspaceId}|${sourceId ?? ""}|${flowIdsKey}`
      : "";

  const [loaded, setLoaded] = useState<{ requestKey: string; facts: FactsMap }>(
    { requestKey: "", facts: {} }
  );
  const [checkedAgain, setCheckedAgain] = useState<FactsMap>({});
  const [refreshingFlowIds, setRefreshingFlowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    if (!requestKey || !workspaceId) return;
    let cancelled = false;
    void fetchTemplateFlowFacts({
      workspaceId,
      sourceId,
      flowIds: flowIdsKey.split(","),
    }).then(facts => {
      if (cancelled) return;
      // Keep earlier answers for Flows that dropped out of view; a template
      // list that shrinks and grows again doesn't flash its warnings.
      setLoaded(previous => ({
        requestKey,
        facts: { ...previous.facts, ...facts },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [flowIdsKey, requestKey, sourceId, workspaceId]);

  const factsByFlowId = useMemo(() => {
    const merged: FactsMap = { ...loaded.facts };
    for (const facts of Object.values(checkedAgain)) {
      merged[facts.flowId] = newerFacts(merged[facts.flowId], facts);
    }
    return merged;
  }, [checkedAgain, loaded.facts]);

  const refresh = useCallback(
    async (flowIds: readonly string[]) => {
      const ids = flowIds.filter(isWhatsAppFlowGraphId);
      if (!workspaceId || ids.length === 0) return;
      setRefreshingFlowIds(previous => new Set([...previous, ...ids]));
      try {
        const facts = await fetchTemplateFlowFacts({
          workspaceId,
          sourceId,
          flowIds: ids,
          force: true,
        });
        setCheckedAgain(previous => ({ ...previous, ...facts }));
      } finally {
        setRefreshingFlowIds(previous => {
          const next = new Set(previous);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [sourceId, workspaceId]
  );

  const isRefreshing = useCallback(
    (flowIds: readonly string[]) =>
      flowIds.some(flowId => refreshingFlowIds.has(flowId)),
    [refreshingFlowIds]
  );

  return {
    factsByFlowId,
    loading: requestKey !== "" && loaded.requestKey !== requestKey,
    refresh,
    isRefreshing,
  };
}
