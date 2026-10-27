"use client";

import { listBulkPrimaryWhatsAppTemplateIds } from "@/lib/scenarios/flow-structure-validation";
import {
  buildWhatsAppTemplateFormSnapshotPatch,
  readLoadableWhatsAppTemplateFormFlowId,
  type WhatsAppTemplateFormRemovedAnswer,
} from "@/lib/scenarios/whatsapp-template-form-snapshot";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { ScenarioWhatsAppTemplateForm } from "@icecore/scenario-contracts";
import { useCallback, useMemo, useState } from "react";
import type {
  ScenarioGraphEditor,
  ScenarioGraphSnapshot,
} from "./graph/controller-utils";
import { useLatestRef } from "./use-latest-ref";

/**
 * Why a template step's form fields are read: its template was picked, or
 * the user loads them, or updates them after the form changed in WhatsApp.
 */
export type ScenarioTemplateFormLoadReason = "pick" | "load" | "update";

export type ScenarioTemplateFormLoadOptions = {
  reason: ScenarioTemplateFormLoadReason;
  /** Saves an update even when it removes answers AI prompts read. */
  confirmRemovals?: boolean;
};

export type ScenarioTemplateFormLoadResult =
  | {
      status: "saved";
      fieldCount: number;
      coverage: ScenarioWhatsAppTemplateForm["coverage"];
      newlyUnavailable: WhatsAppTemplateFormRemovedAnswer[];
    }
  | { status: "unchanged" }
  /** An update would remove answers AI prompts read; nothing was saved. */
  | {
      status: "needs_confirmation";
      newlyUnavailable: WhatsAppTemplateFormRemovedAnswer[];
    }
  /** The Flow couldn't be read, or its fields can't be saved. */
  | { status: "unavailable" }
  /** The workspace's WhatsApp account has no such Flow. */
  | { status: "missing" }
  /** The step has no form to load, or changed while the Flow was read. */
  | { status: "skipped" };

export type LoadWhatsAppTemplateForm = (
  nodeId: string,
  options: ScenarioTemplateFormLoadOptions
) => Promise<ScenarioTemplateFormLoadResult>;

/** One running read: a step read twice at once stays loading until both end. */
type TemplateFormLoad = Readonly<{ ownerKey: string; nodeId: string }>;

/**
 * The Flow whose fields a step reads. A bulk send's template reads none: it
 * has no Form submitted route, by the same rule that hides and refuses it.
 */
function readStepFormFlowId(
  { nodes, edges }: ScenarioGraphSnapshot,
  nodeId: string
): string | null {
  const flowId = readLoadableWhatsAppTemplateFormFlowId(
    nodes.find(node => node.id === nodeId)?.data
  );
  if (!flowId) return null;
  return listBulkPrimaryWhatsAppTemplateIds({ nodes, edges }).has(nodeId)
    ? null
    : flowId;
}

/**
 * Reads the fields of the form a template step's FLOW button opens from
 * WhatsApp, and saves them on the step. Only a pick or a user's Load or
 * Update calls it; opening a step never does. The step is written only when
 * the same scenario visit is loaded and the step still opens that Flow, so a
 * late read after another pick, an Undo or a scenario switch is dropped.
 */
export function useScenarioTemplateFormLoader({
  workspaceId,
  graphEditor,
  sessionOwnerKey,
  ownsLoadedSession,
}: {
  workspaceId: string;
  graphEditor: ScenarioGraphEditor;
  sessionOwnerKey: string;
  ownsLoadedSession: (ownerKey: string) => boolean;
}) {
  const graphEditorRef = useLatestRef(graphEditor);
  const [loads, setLoads] = useState<readonly TemplateFormLoad[]>([]);

  const loadWhatsAppTemplateForm = useCallback<LoadWhatsAppTemplateForm>(
    async (nodeId, { reason, confirmRemovals = false }) => {
      const ownerKey = sessionOwnerKey;
      if (!ownsLoadedSession(ownerKey)) return { status: "skipped" };
      const flowId = readStepFormFlowId(graphEditorRef.current.read(), nodeId);
      if (!flowId) return { status: "skipped" };

      const load: TemplateFormLoad = { ownerKey, nodeId };
      setLoads(current => [...current, load]);
      try {
        // Forced: the server keeps Flow reads for 10 minutes.
        const facts = (
          await fetchTemplateFlowFacts({
            workspaceId,
            flowIds: [flowId],
            force: true,
          })
        )[flowId];
        if (facts?.state === "missing") return { status: "missing" };
        if (facts?.state !== "found" || !isRecord(facts.answerSchema)) {
          return { status: "unavailable" };
        }
        const schema = facts.answerSchema;

        let result: ScenarioTemplateFormLoadResult = { status: "skipped" };
        graphEditorRef.current.edit(({ nodes, edges }) => {
          if (
            !ownsLoadedSession(ownerKey) ||
            readStepFormFlowId({ nodes, edges }, nodeId) !== flowId
          ) {
            return null;
          }
          const built = buildWhatsAppTemplateFormSnapshotPatch({
            nodes,
            edges,
            nodeId,
            flowId,
            schema,
            readAt: facts.checkedAt,
          });
          if (!built) {
            result = { status: "unavailable" };
            return null;
          }
          if ("unchanged" in built) {
            result = { status: "unchanged" };
            return null;
          }
          if (
            reason === "update" &&
            built.newlyUnavailable.length > 0 &&
            !confirmRemovals
          ) {
            result = {
              status: "needs_confirmation",
              newlyUnavailable: built.newlyUnavailable,
            };
            return null;
          }
          result = {
            status: "saved",
            fieldCount: built.snapshot.fields.length,
            coverage: built.snapshot.coverage,
            newlyUnavailable: built.newlyUnavailable,
          };
          return {
            nodes: nodes.map(node =>
              node.id === nodeId
                ? { ...node, data: { ...node.data, ...built.patch } }
                : node
            ),
            edges,
            // A pick's own history entry already undoes it.
            history: reason === "pick" ? "skip" : "record",
          };
        });
        return result;
      } finally {
        setLoads(current => current.filter(item => item !== load));
      }
    },
    [graphEditorRef, ownsLoadedSession, sessionOwnerKey, workspaceId]
  );

  const loadingTemplateFormNodeIds = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        loads
          .filter(load => load.ownerKey === sessionOwnerKey)
          .map(load => load.nodeId)
      ),
    [loads, sessionOwnerKey]
  );

  return { loadWhatsAppTemplateForm, loadingTemplateFormNodeIds };
}
