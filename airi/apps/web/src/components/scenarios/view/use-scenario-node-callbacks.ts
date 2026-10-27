"use client";

import {
  isScenarioContextOptionId,
  type ScenarioTriggerConfig,
} from "@/components/scenarios/types";
import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import { getConfiguredScenarioActionOutcomeHandleIds } from "@icecore/scenario-contracts";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  createScenarioAnswerSnippet,
  generateScenarioActionVoice,
  uploadScenarioActionImage,
} from "@/lib/scenarios/client";
import {
  inferScenarioActionAttachmentMediaType,
  isScenarioGenericActionAttachment,
} from "@/lib/scenarios/action-attachments";
import {
  prepareLegacyRoutingGraphForDeletion,
  type LegacyActionRoutingGraph,
} from "@/lib/scenarios/legacy-action-routing";
import { SCENARIO_HANDLE_RULES } from "../graph/config";
import { resolveScenarioFlowNodeType } from "../graph/node-type";
import { showScenarioErrorToast } from "../nodes/action-node/action-node-utils";
import { resolveScenarioRequestErrorMessage } from "./scenario-request-error-utils";
import type {
  ScenarioActionAttachment,
  ScenarioContextOption,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
  TranslateFn,
} from "../types";
import { buildActionWhatsAppTemplateSelectionPatch } from "./action/selector-utils";
import {
  removeUnconfiguredActionOutcomeEdges,
  type ScenarioGraphEditor,
} from "./graph/controller-utils";
import { uniqueStrings } from "../nodes/action-node/action-node-utils";
import { useLatestRef } from "./use-latest-ref";

type UpdateNodeById = (
  nodeId: string,
  patch: Partial<ScenarioNodeData>
) => void;
type LatestRef<T> = { current: T };
type ReadNodeData = (nodeId: string) => ScenarioNodeData | undefined;

function hasScenarioNodePatchChanges(
  currentData: ScenarioNodeData,
  patch: Partial<ScenarioNodeData>
): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const currentValue = currentData[key as keyof ScenarioNodeData];
    return !Object.is(currentValue, value);
  });
}

type UseScenarioNodeCallbacksParams = {
  workspaceId: string;
  graphEditor: ScenarioGraphEditor;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  contextOptions: ScenarioContextOption[];
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
  loadContextItems: (
    contextOptionId: string,
    forceRefresh?: boolean
  ) => Promise<void>;
  t: TranslateFn;
};

export function useScenarioNodeCallbacks({
  workspaceId,
  graphEditor,
  setSelectedNodeId,
  contextOptions,
  whatsAppTemplates,
  loadContextItems,
  t,
}: UseScenarioNodeCallbacksParams) {
  const readNodeData = useCallback<ReadNodeData>(
    nodeId => graphEditor.read().nodes.find(node => node.id === nodeId)?.data,
    [graphEditor]
  );
  const contextOptionsRef = useLatestRef(contextOptions);
  const whatsAppTemplatesRef = useLatestRef(whatsAppTemplates);

  const { updateNodeById, removeNodeById } = useScenarioBaseNodeCallbacks({
    graphEditor,
    setSelectedNodeId,
  });
  const contextCallbacks = useScenarioContextNodeCallbacks({
    readNodeData,
    contextOptionsRef,
    loadContextItems,
    updateNodeById,
  });
  const triggerCallbacks = useScenarioTriggerNodeCallbacks({
    graphEditor,
  });
  const actionCallbacks = useScenarioActionNodeCallbacks({
    workspaceId,
    readNodeData,
    whatsAppTemplatesRef,
    updateNodeById,
    t,
  });
  const snippetCallbacks = useScenarioAnswerSnippetCreation({
    workspaceId,
    readNodeData,
    loadContextItems,
    updateNodeById,
    t,
  });

  return {
    updateNodeById,
    removeNodeById,
    ...contextCallbacks,
    ...triggerCallbacks,
    ...actionCallbacks,
    ...snippetCallbacks,
  };
}

function useScenarioBaseNodeCallbacks({
  graphEditor,
  setSelectedNodeId,
}: {
  graphEditor: ScenarioGraphEditor;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
}) {
  const updateNodeById = useCallback(
    (nodeId: string, patch: Partial<ScenarioNodeData>) => {
      if (!nodeId) return;
      graphEditor.edit(({ nodes, edges }) => {
        const currentNode = nodes.find(node => node.id === nodeId);
        if (
          !currentNode ||
          !hasScenarioNodePatchChanges(currentNode.data, patch)
        ) {
          return null;
        }

        const currentData = currentNode.data;
        const nextData: ScenarioNodeData = { ...currentData, ...patch };
        const actionOutcomeHandlesChanged =
          Object.prototype.hasOwnProperty.call(patch, "actionOutcomes") &&
          getConfiguredScenarioActionOutcomeHandleIds(
            currentData.actionOutcomes
          ).join("\u0000") !==
            getConfiguredScenarioActionOutcomeHandleIds(
              nextData.actionOutcomes
            ).join("\u0000");
        let nextEdges = edges;
        // Only a new node kind resets handles; same-kind patches (e.g. a reply
        // mode switch) must keep branch and outcome routes such as timers.
        if (patch.kind && patch.kind !== currentData.kind) {
          const kindRules = SCENARIO_HANDLE_RULES[patch.kind];
          nextEdges = edges.flatMap(edge => {
            if (edge.source === nodeId) {
              if (!kindRules.outputHandleId) return [];
              return edge.sourceHandle === kindRules.outputHandleId
                ? [edge]
                : [{ ...edge, sourceHandle: kindRules.outputHandleId }];
            }
            if (edge.target === nodeId) {
              if (!kindRules.inputHandleId) return [];
              return edge.targetHandle === kindRules.inputHandleId
                ? [edge]
                : [{ ...edge, targetHandle: kindRules.inputHandleId }];
            }
            return [edge];
          });
        } else if (actionOutcomeHandlesChanged) {
          nextEdges = removeUnconfiguredActionOutcomeEdges({
            nodeId,
            nodeData: nextData,
            edges,
          });
        }

        return {
          nodes: nodes.map(node =>
            node.id === nodeId
              ? {
                  ...node,
                  type: resolveScenarioFlowNodeType(nextData.kind),
                  data: nextData,
                }
              : node
          ),
          edges: nextEdges,
          history:
            patch.kind || actionOutcomeHandlesChanged ? "record" : "skip",
        };
      });
    },
    [graphEditor]
  );

  const removeNodeById = useCallback(
    (nodeId: string) => {
      if (!nodeId) return;
      const removed = graphEditor.edit(({ nodes, edges }) => {
        if (!nodes.some(node => node.id === nodeId)) return null;
        const preparedDeletion = prepareLegacyRoutingGraphForDeletion({
          graph: { nodes, edges } as LegacyActionRoutingGraph,
          nodeIds: new Set([nodeId]),
          edgeIds: new Set(),
        });
        const nodeIdsToRemove = preparedDeletion.nodeIds;
        return {
          nodes: (preparedDeletion.graph.nodes as ScenarioFlowNode[]).filter(
            node => !nodeIdsToRemove.has(node.id)
          ),
          edges: (preparedDeletion.graph.edges as ScenarioFlowEdge[]).filter(
            edge =>
              !nodeIdsToRemove.has(edge.source) &&
              !nodeIdsToRemove.has(edge.target)
          ),
          history: "record",
        };
      });
      if (removed) {
        setSelectedNodeId(current => (current === nodeId ? null : current));
      }
    },
    [graphEditor, setSelectedNodeId]
  );

  return { updateNodeById, removeNodeById };
}
function useScenarioContextNodeCallbacks({
  readNodeData,
  contextOptionsRef,
  loadContextItems,
  updateNodeById,
}: {
  readNodeData: ReadNodeData;
  contextOptionsRef: LatestRef<ScenarioContextOption[]>;
  loadContextItems: (
    contextOptionId: string,
    forceRefresh?: boolean
  ) => Promise<void>;
  updateNodeById: UpdateNodeById;
}) {
  const updateNodeContextOptionById = useCallback(
    (nodeId: string, contextOptionId: string) => {
      const option = contextOptionsRef.current.find(
        item => item.id === contextOptionId
      );
      if (!option) return;

      updateNodeById(nodeId, {
        kind: "context",
        contextOptionId: option.id,
        contextSelectionMode: "specific",
        contextItemIds: [],
      });
      void loadContextItems(option.id);
    },
    [contextOptionsRef, loadContextItems, updateNodeById]
  );

  const updateNodeContextSelectionModeById = useCallback(
    (nodeId: string, mode: "all" | "specific") => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;

      if (mode === "all") {
        updateNodeById(nodeId, { contextSelectionMode: "all" });
        return;
      }

      updateNodeById(nodeId, {
        contextSelectionMode: "specific",
        contextItemIds: nodeData.contextItemIds || [],
      });
    },
    [readNodeData, updateNodeById]
  );

  const toggleContextItemSelectionById = useCallback(
    (nodeId: string, itemId: string) => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const currentIds = nodeData.contextItemIds || [];
      const nextIds = currentIds.includes(itemId)
        ? currentIds.filter(id => id !== itemId)
        : [...currentIds, itemId];

      updateNodeById(nodeId, {
        contextSelectionMode: "specific",
        contextItemIds: nextIds,
      });
    },
    [readNodeData, updateNodeById]
  );

  const selectContextItemsById = useCallback(
    (nodeId: string, itemIds: string[]) => {
      if (itemIds.length === 0) return;
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const merged = uniqueStrings([
        ...(nodeData.contextItemIds || []),
        ...itemIds,
      ]);
      updateNodeById(nodeId, {
        contextSelectionMode: "specific",
        contextItemIds: merged,
      });
    },
    [readNodeData, updateNodeById]
  );

  const clearContextItemSelectionById = useCallback(
    (nodeId: string) => {
      updateNodeById(nodeId, {
        contextSelectionMode: "specific",
        contextItemIds: [],
      });
    },
    [updateNodeById]
  );

  const toggleContextSourceById = useCallback(
    (nodeId: string, optionId: string, enabled: boolean) => {
      if (!isScenarioContextOptionId(optionId)) return;
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const sources = nodeData.contextSources || [];
      const existing = sources.find(source => source.optionId === optionId);

      const nextSources = enabled
        ? existing
          ? sources
          : [
              ...sources,
              { optionId, selectionMode: "all" as const, itemIds: [] },
            ]
        : sources.filter(source => source.optionId !== optionId);

      if (enabled) {
        void loadContextItems(optionId);
      }
      updateNodeById(nodeId, { contextSources: nextSources });
    },
    [loadContextItems, readNodeData, updateNodeById]
  );

  const updateContextSourceSelectionModeById = useCallback(
    (nodeId: string, optionId: string, mode: "all" | "specific") => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const sources = nodeData.contextSources || [];
      const nextSources = sources.map(source =>
        source.optionId === optionId
          ? {
              ...source,
              selectionMode: mode,
              itemIds: mode === "specific" ? [] : source.itemIds,
            }
          : source
      );
      if (mode === "specific") void loadContextItems(optionId, true);
      updateNodeById(nodeId, { contextSources: nextSources });
    },
    [loadContextItems, readNodeData, updateNodeById]
  );

  const toggleContextSourceItemById = useCallback(
    (nodeId: string, optionId: string, itemId: string) => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const sources = nodeData.contextSources || [];
      const nextSources = sources.map(source => {
        if (source.optionId !== optionId) return source;
        const ids = source.itemIds || [];
        const nextIds = ids.includes(itemId)
          ? ids.filter(id => id !== itemId)
          : [...ids, itemId];
        return { ...source, itemIds: nextIds };
      });
      updateNodeById(nodeId, { contextSources: nextSources });
    },
    [readNodeData, updateNodeById]
  );

  const selectContextSourceItemsById = useCallback(
    (nodeId: string, optionId: string, itemIds: string[]) => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const sources = nodeData.contextSources || [];
      const nextSources = sources.map(source => {
        if (source.optionId !== optionId) return source;
        const merged = uniqueStrings([...(source.itemIds || []), ...itemIds]);
        return { ...source, itemIds: merged };
      });
      updateNodeById(nodeId, { contextSources: nextSources });
    },
    [readNodeData, updateNodeById]
  );

  const clearContextSourceItemSelectionById = useCallback(
    (nodeId: string, optionId: string) => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const sources = nodeData.contextSources || [];
      const nextSources = sources.map(source =>
        source.optionId === optionId ? { ...source, itemIds: [] } : source
      );
      updateNodeById(nodeId, { contextSources: nextSources });
    },
    [readNodeData, updateNodeById]
  );

  return {
    updateNodeContextOptionById,
    updateNodeContextSelectionModeById,
    toggleContextItemSelectionById,
    selectContextItemsById,
    clearContextItemSelectionById,
    toggleContextSourceById,
    updateContextSourceSelectionModeById,
    toggleContextSourceItemById,
    selectContextSourceItemsById,
    clearContextSourceItemSelectionById,
  };
}

function useScenarioTriggerNodeCallbacks({
  graphEditor,
}: {
  graphEditor: ScenarioGraphEditor;
}) {
  const updateTriggerConfigById = useCallback(
    (nodeId: string, patch: Partial<ScenarioTriggerConfig>) => {
      if (!nodeId) return;
      graphEditor.edit(({ nodes, edges }) => {
        const node = nodes.find(candidate => candidate.id === nodeId);
        if (!node || node.data.kind !== "trigger") return null;
        const currentConfig = node.data.triggerConfig || {};
        if (
          !Object.entries(patch).some(
            ([key, value]) =>
              !Object.is(
                currentConfig[key as keyof ScenarioTriggerConfig],
                value
              )
          )
        )
          return null;
        const triggerConfig = normalizeScenarioTriggerConfig({
          nodeData: {
            ...node.data,
            triggerConfig: { ...currentConfig, ...patch },
          },
        });
        return {
          nodes: nodes.map(candidate =>
            candidate === node
              ? {
                  ...node,
                  data: { ...node.data, triggerConfig },
                }
              : candidate
          ),
          edges,
          history: "skip",
        };
      });
    },
    [graphEditor]
  );
  return { updateTriggerConfigById };
}
function useScenarioActionNodeCallbacks({
  workspaceId,
  readNodeData,
  whatsAppTemplatesRef,
  updateNodeById,
  t,
}: {
  workspaceId: string;
  readNodeData: ReadNodeData;
  whatsAppTemplatesRef: LatestRef<ScenarioWhatsAppTemplate[]>;
  updateNodeById: UpdateNodeById;
  t: TranslateFn;
}) {
  const updateActionWhatsAppTemplateById = useCallback(
    (nodeId: string, templateValue: string) => {
      const patch = buildActionWhatsAppTemplateSelectionPatch({
        nodeData: readNodeData(nodeId),
        templateValue,
        whatsAppTemplates: whatsAppTemplatesRef.current,
      });
      if (patch) updateNodeById(nodeId, patch);
    },
    [readNodeData, updateNodeById, whatsAppTemplatesRef]
  );

  const uploadActionImageForNodeId = useCallback(
    async (
      nodeId: string,
      file: File,
      options?: { persist?: boolean }
    ): Promise<ScenarioActionAttachment | undefined> => {
      if (!nodeId || !file) return undefined;

      try {
        const nodeData = readNodeData(nodeId);
        const isWhatsAppReplyAction =
          nodeData?.kind === "action" &&
          (nodeData.actionReplyChannel === "whatsapp" ||
            nodeData.actionWhatsAppServiceMessage !== undefined);
        const uploaded = await uploadScenarioActionImage({
          workspaceId,
          file,
          channel: isWhatsAppReplyAction ? "whatsapp" : undefined,
        });
        const uploadedAttachment = {
          url: uploaded.url,
          mediaType:
            uploaded.mediaType ||
            inferScenarioActionAttachmentMediaType(uploaded.url),
          mimeType: uploaded.mimeType,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
          bucket: uploaded.bucket,
          path: uploaded.path,
        };
        if (
          options?.persist !== false &&
          isScenarioGenericActionAttachment(uploadedAttachment)
        ) {
          const nextAttachments = isWhatsAppReplyAction
            ? [uploadedAttachment]
            : uniqueStrings([
                ...(nodeData?.actionAttachments || []).map(
                  attachment => attachment.url
                ),
                uploaded.url,
              ]).map(url =>
                url === uploaded.url
                  ? uploadedAttachment
                  : nodeData?.actionAttachments?.find(
                      attachment => attachment.url === url
                    ) || {
                      url,
                      mediaType: inferScenarioActionAttachmentMediaType(url),
                    }
              );
          const nextUrls = isWhatsAppReplyAction
            ? [uploaded.url]
            : uniqueStrings([
                ...(nodeData?.actionImageUrls || []),
                uploaded.url,
              ]);
          updateNodeById(nodeId, {
            actionAttachments: nextAttachments,
            actionImageUrls: nextUrls,
          });
        }
        // The new thumbnail confirms the upload.
        return uploadedAttachment;
      } catch (error) {
        // Media fields own their inline feedback; legacy asset lists use a toast.
        if (options?.persist === false) throw error;
        showScenarioErrorToast(
          resolveScenarioRequestErrorMessage(
            error,
            t,
            "actionImageUploadFailed"
          )
        );
        return undefined;
      }
    },
    [readNodeData, t, updateNodeById, workspaceId]
  );

  const generateActionVoiceForNodeId = useCallback(
    async (
      _nodeId: string,
      params: { text: string; voiceId?: string }
    ): Promise<ScenarioActionAttachment | undefined> => {
      const text = params.text.trim();
      if (!text) return undefined;

      const generated = await generateScenarioActionVoice({
        workspaceId,
        text,
        ...(params.voiceId?.trim() ? { voiceId: params.voiceId.trim() } : {}),
      });

      return {
        url: generated.url,
        mediaType: "audio",
        mimeType: generated.mimeType,
        fileName: generated.fileName,
        fileSize: generated.fileSize,
        bucket: generated.bucket,
        path: generated.path,
      };
    },
    [workspaceId]
  );

  const removeActionImageUrlByNodeId = useCallback(
    (nodeId: string, imageUrl: string) => {
      const nodeData = readNodeData(nodeId);
      if (!nodeData) return;
      const nextUrls = (nodeData.actionImageUrls || []).filter(
        current => current !== imageUrl
      );
      const nextAttachments = (nodeData.actionAttachments || []).filter(
        attachment => attachment.url !== imageUrl
      );
      updateNodeById(nodeId, {
        actionAttachments:
          nextAttachments.length > 0 ? nextAttachments : undefined,
        actionImageUrls: nextUrls,
      });
    },
    [readNodeData, updateNodeById]
  );

  return {
    updateActionWhatsAppTemplateById,
    uploadActionImageForNodeId,
    generateActionVoiceForNodeId,
    removeActionImageUrlByNodeId,
  };
}

function useScenarioAnswerSnippetCreation({
  workspaceId,
  readNodeData,
  loadContextItems,
  updateNodeById,
  t,
}: {
  workspaceId: string;
  readNodeData: ReadNodeData;
  loadContextItems: (
    contextOptionId: string,
    forceRefresh?: boolean
  ) => Promise<void>;
  updateNodeById: UpdateNodeById;
  t: TranslateFn;
}) {
  const [isCreatingSnippet, setIsCreatingSnippet] = useState(false);

  const createAnswerSnippetFromNode = useCallback(
    async (nodeId: string, questionInput: string, answerInput: string) => {
      const question = questionInput.trim();
      const answer = answerInput.trim();
      if (!question || !answer) {
        toast.error(t("snippetCreateValidation"));
        return;
      }

      try {
        setIsCreatingSnippet(true);
        const created = await createScenarioAnswerSnippet({
          workspaceId,
          question,
          answer,
        });

        await loadContextItems("answer_snippets", true);
        attachAnswerSnippetToContextNode({
          nodeId,
          snippetId: created.id,
          nodeData: readNodeData(nodeId),
          updateNodeById,
        });

        toast.success(t("snippetCreateSuccess"));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("snippetCreateFailed");
        toast.error(message);
      } finally {
        setIsCreatingSnippet(false);
      }
    },
    [loadContextItems, readNodeData, t, updateNodeById, workspaceId]
  );

  return {
    isCreatingSnippet,
    createAnswerSnippetFromNode,
  };
}

function attachAnswerSnippetToContextNode({
  nodeId,
  snippetId,
  nodeData,
  updateNodeById,
}: {
  nodeId: string;
  snippetId?: string;
  nodeData: ScenarioNodeData | undefined;
  updateNodeById: UpdateNodeById;
}) {
  if (!snippetId || nodeData?.kind !== "context") return;

  if (nodeData.contextSources) {
    const source = nodeData.contextSources.find(
      item => item.optionId === "answer_snippets"
    );
    if (!source) return;

    const nextIds = uniqueStrings([...(source.itemIds || []), snippetId]);
    const nextSources = nodeData.contextSources.map(item =>
      item.optionId === "answer_snippets"
        ? {
            ...item,
            selectionMode: "specific" as const,
            itemIds: nextIds,
          }
        : item
    );
    updateNodeById(nodeId, { contextSources: nextSources });
    return;
  }

  if (nodeData.contextOptionId !== "answer_snippets") return;

  const nextIds = uniqueStrings([
    ...(nodeData.contextItemIds || []),
    snippetId,
  ]);
  updateNodeById(nodeId, {
    contextSelectionMode: "specific",
    contextItemIds: nextIds,
  });
}
