"use client";

import { useEffect, useMemo, useState } from "react";
import { parseFlowJsonToWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-json-parser";
import { projectFlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import { MAX_FLOW_SCREENS } from "@/components/scenarios/builders/whatsapp/flow-validation";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  fetchWhatsAppFlowDetails,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";
import type { FlowGalleryPreviewModel } from "./flow-gallery-preview";

export type FlowGalleryPreviewState =
  | { status: "idle" | "queued" | "loading" }
  | { status: "ready"; model: FlowGalleryPreviewModel }
  | { status: "error"; error: string };

type GalleryScopeParams = {
  workspaceId: string;
  sourceId: string;
  revision?: string | number;
};

type PreviewFlow = Pick<WhatsAppFlowSummary, "id" | "name" | "status">;
type GalleryScope = {
  ownerKey: string;
  disposed: boolean;
  states: Map<string, FlowGalleryPreviewState>;
  load: (flow: WhatsAppFlowSummary) => void;
  retry: (flow: WhatsAppFlowSummary) => void;
  activate: () => void;
  dispose: () => void;
};

const IDLE: FlowGalleryPreviewState = { status: "idle" };
const EMPTY_PREVIEWS: ReadonlyMap<string, FlowGalleryPreviewState> = new Map();
const MAX_CONCURRENT_PREVIEWS = 3;
// This is a cache budget, not a Flow validity rule. Larger forms remain available
// in the editor and use the bounded read-only projection for gallery display.
const MAX_VISUAL_PREVIEW_CHARS = 256 * 1024;
const MAX_SUMMARY_TEXT_CHARS = 160;
const PREVIEW_UNAVAILABLE = "Flow preview is unavailable.";
// The details service uses this exact response when /assets has no Flow JSON.
const MISSING_DRAFT_ASSET_ERROR = "Flow JSON asset not found";

function summaryText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length <= MAX_SUMMARY_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_SUMMARY_TEXT_CHARS)}…`;
}

function projectPreview(
  flowJson: unknown,
  flow: PreviewFlow
): FlowGalleryPreviewModel {
  if (flowJson == null) return { kind: "empty" };
  const config = parseFlowJsonToWhatsAppFlowConfig({
    flowJson,
    flowId: flow.id,
    flowName: flow.name,
    flowStatus: flow.status,
  });
  if (config && JSON.stringify(config).length <= MAX_VISUAL_PREVIEW_CHARS) {
    return { kind: "visual", config };
  }
  const preview = projectFlowJsonPreview(flowJson);
  if (preview) return { kind: "document", preview };

  const rawScreens =
    typeof flowJson === "object" &&
    !Array.isArray(flowJson) &&
    "screens" in flowJson &&
    Array.isArray(flowJson.screens)
      ? flowJson.screens
      : [];
  const screens = rawScreens.slice(0, MAX_FLOW_SCREENS).flatMap(screen => {
    if (!screen || typeof screen !== "object" || Array.isArray(screen))
      return [];
    return [{ id: summaryText(screen.id), title: summaryText(screen.title) }];
  });
  return {
    kind: "advanced",
    screens,
    ...(rawScreens.length > MAX_FLOW_SCREENS
      ? { totalScreens: rawScreens.length }
      : {}),
  };
}

function createGalleryScope(
  {
    workspaceId,
    sourceId,
    ownerKey,
  }: GalleryScopeParams & { ownerKey: string },
  onChange: (scope: GalleryScope) => void
): GalleryScope {
  const states = new Map<string, FlowGalleryPreviewState>();
  const queue: PreviewFlow[] = [];
  const active = new Map<string, AbortController>();
  const scope: GalleryScope = {
    ownerKey,
    disposed: false,
    states,
    load,
    retry(flow) {
      if (states.get(flow.id)?.status !== "error") return;
      states.delete(flow.id);
      load(flow);
    },
    activate() {
      scope.disposed = false;
      pump();
      onChange(scope);
    },
    dispose() {
      scope.disposed = true;
      for (const controller of active.values()) controller.abort();
      active.clear();
      queue.length = 0;
      states.clear();
    },
  };

  function load(flow: WhatsAppFlowSummary) {
    if (!workspaceId || !sourceId || !flow.id || states.has(flow.id)) return;
    states.set(flow.id, { status: "queued" });
    queue.push({ id: flow.id, name: flow.name, status: flow.status });
    // Effect replay may enqueue child cards before this scope is reactivated.
    // A disposed scope never starts requests; activation drains that queue.
    if (!scope.disposed) {
      pump();
      onChange(scope);
    }
  }

  function pump() {
    while (
      !scope.disposed &&
      active.size < MAX_CONCURRENT_PREVIEWS &&
      queue.length
    ) {
      const flow = queue.shift()!;
      const controller = new AbortController();
      active.set(flow.id, controller);
      states.set(flow.id, { status: "loading" });
      void readPreview(flow, controller);
    }
  }

  async function readPreview(flow: PreviewFlow, controller: AbortController) {
    const ownsRequest = () =>
      !scope.disposed &&
      !controller.signal.aborted &&
      active.get(flow.id) === controller;
    try {
      const result = await fetchWhatsAppFlowDetails({
        workspaceId,
        sourceId,
        flowId: flow.id,
        includeJson: true,
        signal: controller.signal,
      });
      if (!ownsRequest()) return;
      const missingDraftAsset =
        result.data?.flow?.status === "DRAFT" &&
        result.data.flowJson == null &&
        result.data.flowJsonError === MISSING_DRAFT_ASSET_ERROR;
      if (
        !result.ok ||
        !result.data ||
        result.data.error ||
        (result.data.flowJsonError && !missingDraftAsset)
      ) {
        throw new Error(
          result.data?.flowJsonError ||
            result.data?.error ||
            PREVIEW_UNAVAILABLE
        );
      }
      const metadata = result.data.flow || flow;
      states.set(flow.id, {
        status: "ready",
        model: projectPreview(result.data.flowJson, metadata),
      });
    } catch (error) {
      if (!ownsRequest()) return;
      states.set(flow.id, {
        status: "error",
        error: error instanceof Error ? error.message : PREVIEW_UNAVAILABLE,
      });
    } finally {
      if (ownsRequest()) {
        active.delete(flow.id);
        pump();
        onChange(scope);
      }
    }
  }

  return scope;
}

/**
 * The list cache contains metadata, the linked preview hook keeps full assets,
 * and the editor hook owns mutation state. This gallery scheduler reuses their
 * details client and bounded read-only projection for content outside editing
 * support, while retaining only compact projections.
 */
export function useFlowGalleryPreviews(params: GalleryScopeParams) {
  const { workspaceId, sourceId, revision = 0 } = params;
  const ownerKey = useTransitionOwnerKey(
    JSON.stringify([workspaceId, sourceId, revision])
  );
  const [snapshot, setSnapshot] = useState<{
    scope: GalleryScope;
    previews: ReadonlyMap<string, FlowGalleryPreviewState>;
  } | null>(null);
  const scope = useMemo(
    () =>
      createGalleryScope({ workspaceId, sourceId, ownerKey }, changedScope => {
        setSnapshot(previous => {
          if (
            changedScope.disposed ||
            (previous &&
              previous.scope !== changedScope &&
              !previous.scope.disposed)
          ) {
            return previous;
          }
          return {
            scope: changedScope,
            previews: new Map(changedScope.states),
          };
        });
      }),
    [workspaceId, sourceId, ownerKey]
  );

  useEffect(() => {
    scope.activate();
    return () => scope.dispose();
  }, [scope]);

  const previews =
    snapshot?.scope === scope ? snapshot.previews : EMPTY_PREVIEWS;
  return {
    previews,
    get: (flowId: string): FlowGalleryPreviewState =>
      previews.get(flowId) ?? IDLE,
    load: scope.load,
    retry: scope.retry,
  };
}
