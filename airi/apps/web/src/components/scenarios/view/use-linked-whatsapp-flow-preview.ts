"use client";

import type {
  TranslateFn,
  WhatsAppFlowConfig,
} from "@/components/scenarios/types";
import { useLazyRef } from "@/hooks/use-lazy-ref";
import { fetchScenarioWhatsAppFlowDetails } from "@/lib/scenarios/client";
import { getWhatsAppFlowPreviewUrl } from "@/lib/whatsapp/flows/client";
import { useCallback, useRef, useState } from "react";
import type { ScenarioWhatsAppFlowOption } from "../types";
import { parseFlowJsonToWhatsAppFlowConfig } from "../builders/whatsapp/flow-json-parser";

type LinkedWhatsAppFlowPreviewState = {
  workspaceId: string | null;
  open: boolean;
  nodeId: string | null;
  flowId: string | null;
  flowName: string;
  flowStatus: string | null;
  flowAction?: "navigate" | "data_exchange";
  previewUrl: string | null;
  config: WhatsAppFlowConfig | null;
  error: string | null;
  loading: boolean;
};

const EMPTY_LINKED_WHATSAPP_FLOW_PREVIEW: LinkedWhatsAppFlowPreviewState = {
  workspaceId: null,
  open: false,
  nodeId: null,
  flowId: null,
  flowName: "",
  flowStatus: null,
  flowAction: undefined,
  previewUrl: null,
  config: null,
  error: null,
  loading: false,
};

type OpeningLinkedWhatsAppFlowPreviewState = {
  workspaceId: string;
  nodeId: string;
  flowId: string;
};

type UseLinkedWhatsAppFlowPreviewParams = {
  workspaceId: string;
  whatsAppFlows: ScenarioWhatsAppFlowOption[];
  attachWhatsAppFlowProviderReferenceToNode: (params: {
    nodeId: string;
    sourceId: string;
    flowId: string;
  }) => Promise<WhatsAppFlowConfig>;
  t: TranslateFn;
};

export function useLinkedWhatsAppFlowPreview({
  workspaceId,
  whatsAppFlows,
  attachWhatsAppFlowProviderReferenceToNode,
  t,
}: UseLinkedWhatsAppFlowPreviewParams) {
  const linkedFlowPreviewLoadFailedLabel = t("linkedFlowPreviewLoadFailed");
  const linkedFlowPreviewUnavailableLabel = t("linkedFlowPreviewUnavailable");
  const [linkedFlowPreview, setLinkedFlowPreview] =
    useState<LinkedWhatsAppFlowPreviewState>(
      EMPTY_LINKED_WHATSAPP_FLOW_PREVIEW
    );
  const [openingLinkedFlowPreview, setOpeningLinkedFlowPreview] =
    useState<OpeningLinkedWhatsAppFlowPreviewState | null>(null);
  const linkedFlowPreviewRequestTokenRef = useRef(0);
  const flowDetailsCacheRef = useLazyRef(
    () =>
      new Map<
        string,
        Awaited<ReturnType<typeof fetchScenarioWhatsAppFlowDetails>>
      >()
  );
  const flowDetailsInFlightRef = useLazyRef(
    () =>
      new Map<
        string,
        Promise<Awaited<ReturnType<typeof fetchScenarioWhatsAppFlowDetails>>>
      >()
  );
  const effectiveLinkedFlowPreview =
    linkedFlowPreview.workspaceId === workspaceId
      ? linkedFlowPreview
      : EMPTY_LINKED_WHATSAPP_FLOW_PREVIEW;
  const effectiveOpeningLinkedFlowPreview =
    openingLinkedFlowPreview?.workspaceId === workspaceId
      ? openingLinkedFlowPreview
      : null;

  const resetLinkedFlowPreview = useCallback(() => {
    linkedFlowPreviewRequestTokenRef.current += 1;
    setOpeningLinkedFlowPreview(null);
    setLinkedFlowPreview(EMPTY_LINKED_WHATSAPP_FLOW_PREVIEW);
  }, []);

  const fetchWhatsAppFlowDetailsWithJson = useCallback(
    async (flowId: string, sourceId?: string) => {
      const normalizedFlowId = flowId.trim();
      const normalizedSourceId = sourceId?.trim() || undefined;
      if (!normalizedFlowId) {
        throw new Error(linkedFlowPreviewLoadFailedLabel);
      }

      const cacheKey = `${workspaceId}:${normalizedSourceId ?? ""}:${normalizedFlowId}`;
      const cached = flowDetailsCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const inFlight = flowDetailsInFlightRef.current.get(cacheKey);
      if (inFlight) return inFlight;

      const requestPromise = fetchScenarioWhatsAppFlowDetails({
        workspaceId,
        ...(normalizedSourceId ? { sourceId: normalizedSourceId } : {}),
        flowId: normalizedFlowId,
      })
        .then(data => {
          flowDetailsCacheRef.current.set(cacheKey, data);
          return data;
        })
        .catch(error => {
          throw new Error(
            error instanceof Error
              ? error.message
              : linkedFlowPreviewLoadFailedLabel
          );
        })
        .finally(() => {
          flowDetailsInFlightRef.current.delete(cacheKey);
        });

      flowDetailsInFlightRef.current.set(cacheKey, requestPromise);
      return requestPromise;
    },
    [
      flowDetailsCacheRef,
      flowDetailsInFlightRef,
      linkedFlowPreviewLoadFailedLabel,
      workspaceId,
    ]
  );

  const openLinkedWhatsAppFlowPreview = useCallback(
    (
      nodeId: string,
      flowId: string,
      flowAction?: "navigate" | "data_exchange",
      currentConfig?: WhatsAppFlowConfig | null
    ) => {
      void (async () => {
        const normalizedFlowId = flowId.trim();
        if (!normalizedFlowId) return;

        const requestToken = ++linkedFlowPreviewRequestTokenRef.current;
        setOpeningLinkedFlowPreview({
          workspaceId,
          nodeId,
          flowId: normalizedFlowId,
        });
        setLinkedFlowPreview({
          workspaceId,
          open: true,
          nodeId,
          flowId: normalizedFlowId,
          flowName: "",
          flowStatus: null,
          flowAction,
          previewUrl: null,
          config: null,
          error: null,
          loading: true,
        });

        try {
          if (linkedFlowPreviewRequestTokenRef.current !== requestToken) {
            return;
          }

          const sourceId =
            currentConfig?.providerReference?.sourceId?.trim() ||
            whatsAppFlows
              .find(flow => flow.id === normalizedFlowId)
              ?.sourceId?.trim() ||
            undefined;
          const data = await fetchWhatsAppFlowDetailsWithJson(
            normalizedFlowId,
            sourceId
          );
          if (linkedFlowPreviewRequestTokenRef.current !== requestToken) {
            return;
          }

          const flowName =
            typeof data?.flow?.name === "string" &&
            data.flow.name.trim().length > 0
              ? data.flow.name.trim()
              : normalizedFlowId;
          const flowStatus =
            typeof data?.flow?.status === "string" &&
            data.flow.status.trim().length > 0
              ? data.flow.status.trim()
              : null;
          const previewUrl = getWhatsAppFlowPreviewUrl(data?.flow);
          const parsedConfig = data?.flowJson
            ? parseFlowJsonToWhatsAppFlowConfig({
                flowJson: data.flowJson,
                flowId: normalizedFlowId,
                flowName,
                flowStatus,
                previousConfig: currentConfig,
              })
            : null;
          const previewError =
            parsedConfig || previewUrl
              ? null
              : data?.flowJsonError || linkedFlowPreviewUnavailableLabel;

          setLinkedFlowPreview({
            workspaceId,
            open: true,
            nodeId,
            flowId: normalizedFlowId,
            flowName,
            flowStatus,
            flowAction,
            previewUrl,
            config: parsedConfig,
            error: previewError,
            loading: false,
          });
        } catch (error) {
          if (linkedFlowPreviewRequestTokenRef.current !== requestToken) {
            return;
          }

          setLinkedFlowPreview({
            workspaceId,
            open: true,
            nodeId,
            flowId: normalizedFlowId,
            flowName: normalizedFlowId,
            flowStatus: null,
            flowAction,
            previewUrl: null,
            config: null,
            error:
              error instanceof Error
                ? error.message
                : linkedFlowPreviewLoadFailedLabel,
            loading: false,
          });
        } finally {
          if (linkedFlowPreviewRequestTokenRef.current === requestToken) {
            setOpeningLinkedFlowPreview(current =>
              current?.workspaceId === workspaceId &&
              current.nodeId === nodeId &&
              current.flowId === normalizedFlowId
                ? null
                : current
            );
          }
        }
      })();
    },
    [
      fetchWhatsAppFlowDetailsWithJson,
      linkedFlowPreviewLoadFailedLabel,
      linkedFlowPreviewUnavailableLabel,
      whatsAppFlows,
      workspaceId,
    ]
  );

  const handleLinkedFlowPreviewOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setLinkedFlowPreview(current => ({ ...current, open: true }));
        return;
      }

      resetLinkedFlowPreview();
    },
    [resetLinkedFlowPreview]
  );

  const selectExistingFlowForNode = useCallback(
    async (nodeId: string, flow: ScenarioWhatsAppFlowOption) => {
      const normalizedFlowId = flow.id.trim();
      const sourceId = flow.sourceId?.trim();
      if (!normalizedFlowId || !sourceId) {
        throw new Error(linkedFlowPreviewLoadFailedLabel);
      }

      try {
        await attachWhatsAppFlowProviderReferenceToNode({
          nodeId,
          sourceId,
          flowId: normalizedFlowId,
        });
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : linkedFlowPreviewLoadFailedLabel
        );
      }
    },
    [
      attachWhatsAppFlowProviderReferenceToNode,
      linkedFlowPreviewLoadFailedLabel,
    ]
  );

  return {
    linkedFlowPreview: effectiveLinkedFlowPreview,
    openingLinkedFlowPreview: effectiveOpeningLinkedFlowPreview,
    openLinkedWhatsAppFlowPreview,
    handleLinkedFlowPreviewOpenChange,
    selectExistingFlowForNode,
  };
}
