"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { simulateScenarioStepRequest } from "@/lib/scenarios/client/simulation";
import type {
  ScenarioSimulationContext,
  ScenarioSimulationEvent,
  ScenarioSimulationMessage,
  ScenarioSimulationResult,
} from "@/lib/scenarios/scenario-simulation-types";
import {
  buildScenarioPreviewLogicSignature,
  normalizeScenarioPreviewLogicDraft,
  type ScenarioDraftPreviewInput,
} from "./evaluation";
import { useLatestRef } from "../use-latest-ref";

export type ScenarioSimulationTrace = Pick<
  ScenarioSimulationResult,
  "pathNodeIds" | "pathEdgeIds"
> & { actionNodeId: string | null };
type SimulationChatContent =
  | { kind: "customer"; text: string }
  | { kind: "time"; minutes: number }
  | { kind: "payment" }
  | { kind: "message"; message: ScenarioSimulationMessage };
export type SimulationChatEntry = SimulationChatContent & { id: string };

export function useScenarioSimulation(input: {
  workspaceId: string;
  draftScenario: ScenarioDraftPreviewInput;
  context?: ScenarioSimulationContext;
  onTrace?: (trace: ScenarioSimulationTrace | null) => void;
}) {
  const [entries, setEntries] = useState<SimulationChatEntry[]>([]);
  const [result, setResult] = useState<ScenarioSimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const trace = useLatestRef(input.onTrace);
  const signature = `${input.workspaceId}:${buildScenarioPreviewLogicSignature(input.draftScenario)}:${JSON.stringify(input.context ?? {})}`;
  const signatureRef = useLatestRef(signature);

  const reset = useCallback(() => {
    sequence.current += 1;
    controller.current?.abort();
    setEntries([]);
    setResult(null);
    setLoading(false);
    setError(null);
    trace.current?.(null);
  }, [trace]);
  useEffect(() => {
    const onTrace = trace.current;
    reset();
    return () => {
      sequence.current += 1;
      controller.current?.abort();
      onTrace?.(null);
    };
  }, [signature, reset, trace]);

  const run = async (
    event: ScenarioSimulationEvent,
    customerLabel?: string
  ) => {
    if (loading) return false;
    const requestId = ++sequence.current;
    const requestedSignature = signature;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError(null);
    try {
      const next = await simulateScenarioStepRequest({
        workspaceId: input.workspaceId,
        draftScenario: normalizeScenarioPreviewLogicDraft(input.draftScenario)!,
        event,
        state: event.kind === "start" ? null : result?.state,
        context: input.context,
        signal: abort.signal,
      });
      if (
        requestId !== sequence.current ||
        requestedSignature !== signatureRef.current ||
        abort.signal.aborted
      )
        return false;
      const additions: SimulationChatContent[] = [];
      if (event.kind === "message")
        additions.push({ kind: "customer", text: event.text });
      else if (event.kind === "choice" || event.kind === "flow")
        additions.push({ kind: "customer", text: customerLabel ?? "" });
      else if (event.kind === "advance")
        additions.push({ kind: "time", minutes: event.minutes });
      else if (event.kind === "payment") additions.push({ kind: "payment" });
      if (next.message)
        additions.push({ kind: "message", message: next.message });
      setEntries(current =>
        [
          ...(event.kind === "start" ? [] : current),
          ...additions.map((entry, index) => ({
            ...entry,
            id: `${requestId}:${index}`,
          })),
        ].slice(-200)
      );
      setResult(next);
      trace.current?.({
        pathNodeIds: next.pathNodeIds.length
          ? next.pathNodeIds
          : next.state.actionNodeId
            ? [next.state.actionNodeId]
            : [],
        pathEdgeIds: next.pathEdgeIds,
        actionNodeId: next.state.actionNodeId,
      });
      return true;
    } catch (cause) {
      if (
        requestId === sequence.current &&
        requestedSignature === signatureRef.current &&
        !abort.signal.aborted
      )
        setError(
          cause instanceof Error ? cause.message : "Unable to try this scenario"
        );
      return false;
    } finally {
      if (
        requestId === sequence.current &&
        requestedSignature === signatureRef.current
      )
        setLoading(false);
    }
  };
  return { entries, result, loading, error, run, reset };
}
