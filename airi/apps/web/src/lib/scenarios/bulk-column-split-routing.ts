import type {
  ScenarioBulkColumnSplitPreview,
  ScenarioBulkConnectedAction,
  ScenarioCampaignRecipient,
  ScenarioGraphEdge,
  ScenarioGraphNode,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "@icecore/scenario-contracts";
import { resolveBulkWhatsAppTemplateSendBlockReason } from "@/lib/scenarios/whatsapp-template-selection";
import { prepareCampaignRecipientsForTemplate } from "@/lib/campaign/bulk-campaign-client";
import { normalizeActionReplyChannelForActionNode } from "@/lib/scenarios/normalization";
import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import { getScenarioLogicType } from "@icecore/scenario-contracts";
import { projectScenarioWhatsAppServiceMessagePresentation } from "@/lib/scenarios/whatsapp-service-message";
import {
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
  buildRecipientColumnSplitPathHandleId,
  getRecipientColumnSplitConfig,
  isRecipientColumnSplitNodeData,
  matchRecipientColumnSplit,
} from "@/lib/scenarios/recipient-column-split";
import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  isRecipientColumnSplitConfigReadyForSend,
} from "@icecore/scenario-contracts";
import { getTemplateVariables } from "@icecore/shared/types/whatsapp";

export type BulkColumnSplitRoute = {
  pathId: string;
  handleId: string;
  label: string;
  actionNodeId: string | null;
  action: ScenarioBulkConnectedAction | null;
  /**
   * The handle connects to a step the send can't use: not a WhatsApp
   * template action. The server refuses the whole send for it.
   */
  connectsNonTemplateStep?: boolean;
};

export type BulkColumnSplitRouting = {
  splitNodeId: string;
  config: NonNullable<ScenarioNodeData["recipientColumnSplit"]>;
  routes: BulkColumnSplitRoute[];
  elseRoute: BulkColumnSplitRoute;
};

function resolveSupportedTemplateCategory(
  category: string | undefined
): "MARKETING" | "UTILITY" | "AUTHENTICATION" | undefined {
  const normalized = category?.trim().toUpperCase();
  if (
    normalized === "MARKETING" ||
    normalized === "UTILITY" ||
    normalized === "AUTHENTICATION"
  ) {
    return normalized;
  }
  return undefined;
}

export function resolveBulkConnectedActionFromNode(params: {
  actionNodeId: string;
  actionData: ScenarioNodeData;
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
}): ScenarioBulkConnectedAction | null {
  const { actionNodeId, actionData, whatsAppTemplates = [] } = params;
  const resolvedActionType = resolveScenarioActionTypeFromNodeData(actionData);
  if (resolvedActionType === "generative_ai") return null;
  const generatedTemplateDraft = actionData.generatedTemplateDraft;
  const templateName =
    actionData.actionWhatsAppTemplateName?.trim() ||
    generatedTemplateDraft?.name?.trim() ||
    "";
  const templateLanguage =
    actionData.actionWhatsAppTemplateLanguage?.trim() ||
    generatedTemplateDraft?.language?.trim() ||
    "en";
  const templateComponents =
    actionData.actionWhatsAppTemplateComponents ||
    generatedTemplateDraft?.components;
  const actionType =
    resolvedActionType ||
    (templateName && templateComponents ? "whatsapp_template" : null);
  if (!actionType) return null;

  const replyMode =
    actionType === "reply"
      ? resolveReplyModeFromNodeData(actionData)
      : undefined;
  const replyChannel =
    actionType === "reply"
      ? normalizeActionReplyChannelForActionNode(actionData)
      : undefined;
  const templateCategory =
    actionData.actionWhatsAppTemplateCategory?.trim() ||
    generatedTemplateDraft?.category?.trim() ||
    "";
  const templateVariables =
    actionType === "whatsapp_template" && templateComponents
      ? getTemplateVariables({
          name: templateName,
          language: templateLanguage,
          status: "APPROVED",
          category:
            resolveSupportedTemplateCategory(templateCategory) || "UTILITY",
          components: templateComponents,
        })
      : [];
  const templateSendBlockReason =
    actionType === "whatsapp_template"
      ? resolveBulkWhatsAppTemplateSendBlockReason({
          nodeData: actionData,
          whatsAppTemplates,
        })
      : null;
  const templateBody =
    templateComponents
      ?.find(component => component.type === "BODY")
      ?.text?.trim() || "";
  const serviceMessage =
    projectScenarioWhatsAppServiceMessagePresentation(actionData);
  const previewText =
    serviceMessage?.previewText?.trim() ||
    actionData.actionReplyText?.trim() ||
    actionData.actionInstruction?.trim() ||
    templateBody ||
    templateName ||
    undefined;

  return {
    nodeId: actionNodeId,
    actionType,
    channel:
      actionType === "whatsapp_template"
        ? "whatsapp"
        : replyChannel === "telegram"
          ? "telegram"
          : undefined,
    replyMode,
    replyText: actionData.actionReplyText?.trim() || undefined,
    templateName: templateName || undefined,
    templateLanguage,
    templateCategory: templateCategory || undefined,
    templateVariables,
    templateComponents,
    previewText,
    templateSendBlockReason,
  };
}

export function findBulkColumnSplitNode(params: {
  bulkRootId: string;
  nodes: ScenarioGraphNode[];
  edges: ScenarioGraphEdge[];
}): { splitNodeId: string; splitNode: ScenarioGraphNode } | null {
  const nodesById = new Map(params.nodes.map(node => [node.id, node] as const));

  for (const edge of params.edges) {
    if (edge.source !== params.bulkRootId || !edge.target) continue;
    if (
      edge.sourceHandle &&
      edge.sourceHandle !== BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
    ) {
      continue;
    }
    const targetNode = nodesById.get(edge.target);
    const targetData = targetNode?.data;
    if (!targetNode || !isRecipientColumnSplitNodeData(targetData)) continue;
    return { splitNodeId: targetNode.id, splitNode: targetNode };
  }

  return null;
}

function resolveRouteAction(params: {
  splitNodeId: string;
  handleId: string;
  nodes: ScenarioGraphNode[];
  edges: ScenarioGraphEdge[];
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): {
  actionNodeId: string | null;
  action: ScenarioBulkConnectedAction | null;
  connectsNonTemplateStep: boolean;
} {
  const edge = params.edges.find(
    item =>
      item.source === params.splitNodeId &&
      item.sourceHandle?.trim() === params.handleId &&
      item.target
  );
  if (!edge?.target) {
    return { actionNodeId: null, action: null, connectsNonTemplateStep: false };
  }

  const actionNode = params.nodes.find(node => node.id === edge.target);
  const actionData = actionNode?.data;
  if (!actionNode || actionData?.kind !== "action") {
    return {
      actionNodeId: null,
      action: null,
      connectsNonTemplateStep: Boolean(actionNode),
    };
  }

  return {
    actionNodeId: actionNode.id,
    action: resolveBulkConnectedActionFromNode({
      actionNodeId: actionNode.id,
      actionData,
      whatsAppTemplates: params.whatsAppTemplates,
    }),
    // Same check as the server's provenance for a WhatsApp send.
    connectsNonTemplateStep:
      resolveScenarioActionTypeFromNodeData(actionData) !== "whatsapp_template",
  };
}

export function resolveBulkColumnSplitRouting(params: {
  bulkRootId: string;
  nodes: ScenarioGraphNode[];
  edges: ScenarioGraphEdge[];
  whatsAppTemplates?: ScenarioWhatsAppTemplate[];
}): BulkColumnSplitRouting | null {
  const split = findBulkColumnSplitNode(params);
  if (!split) return null;

  const splitData = split.splitNode.data;
  if (getScenarioLogicType(splitData) !== "recipient_column_split") {
    return null;
  }

  const config = getRecipientColumnSplitConfig(splitData);
  const whatsAppTemplates = params.whatsAppTemplates ?? [];

  const routes = config.paths.map(path => {
    const handleId = buildRecipientColumnSplitPathHandleId(path.id);
    const { actionNodeId, action, connectsNonTemplateStep } =
      resolveRouteAction({
        splitNodeId: split.splitNodeId,
        handleId,
        nodes: params.nodes,
        edges: params.edges,
        whatsAppTemplates,
      });
    return {
      pathId: path.id,
      handleId,
      label: path.label?.trim() || path.id,
      actionNodeId,
      action,
      connectsNonTemplateStep,
    };
  });

  const elseResolved = resolveRouteAction({
    splitNodeId: split.splitNodeId,
    handleId: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
    nodes: params.nodes,
    edges: params.edges,
    whatsAppTemplates,
  });

  return {
    splitNodeId: split.splitNodeId,
    config,
    routes,
    elseRoute: {
      pathId: RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
      handleId: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
      label: "Else",
      actionNodeId: elseResolved.actionNodeId,
      action: elseResolved.action,
      connectsNonTemplateStep: elseResolved.connectsNonTemplateStep,
    },
  };
}

export function summarizeBulkColumnSplitRouteCounts(params: {
  recipients: readonly ScenarioCampaignRecipient[];
  routing: Readonly<BulkColumnSplitRouting>;
}): { byPathId: Record<string, number>; elseCount: number } {
  const byPathId: Record<string, number> = {};
  for (const route of params.routing.routes) {
    byPathId[route.pathId] = 0;
  }

  let elseCount = 0;
  for (const recipient of params.recipients) {
    const match = matchRecipientColumnSplit(recipient, params.routing.config);
    if (match.isElse) {
      elseCount += 1;
      continue;
    }
    byPathId[match.pathId] = (byPathId[match.pathId] ?? 0) + 1;
  }

  return { byPathId, elseCount };
}

export function buildBulkColumnSplitPreview(params: {
  recipients: readonly ScenarioCampaignRecipient[];
  routing: Readonly<BulkColumnSplitRouting>;
}): ScenarioBulkColumnSplitPreview {
  const counts = summarizeBulkColumnSplitRouteCounts(params);
  const routes = [
    ...params.routing.routes.map(route => ({
      pathId: route.pathId,
      pathLabel: route.label,
      handleId: route.handleId,
      recipientCount: counts.byPathId[route.pathId] ?? 0,
      actionNodeId: route.actionNodeId ?? undefined,
      templateName: route.action?.templateName,
      templateSendBlockReason: route.action?.templateSendBlockReason ?? null,
      isElse: false as const,
    })),
    {
      pathId: params.routing.elseRoute.pathId,
      pathLabel: params.routing.elseRoute.label,
      handleId: params.routing.elseRoute.handleId,
      recipientCount: counts.elseCount,
      actionNodeId: params.routing.elseRoute.actionNodeId ?? undefined,
      templateName: params.routing.elseRoute.action?.templateName,
      templateSendBlockReason:
        params.routing.elseRoute.action?.templateSendBlockReason ?? null,
      isElse: true as const,
    },
  ];

  const configReady = isRecipientColumnSplitConfigReadyForSend(
    params.routing.config
  );
  const routings = [...params.routing.routes, params.routing.elseRoute];
  // The server verifies every connected route before it looks at any row, so
  // a route with no rows still has to send a WhatsApp template it can use.
  const hasNonTemplateStep = routings.some(route =>
    Boolean(route.connectsNonTemplateStep)
  );
  const hasBlockedConnectedTemplate = routes.some(
    route =>
      Boolean(route.actionNodeId) && Boolean(route.templateSendBlockReason)
  );
  const hasConnectedSendablePath = routings.some(route =>
    Boolean(
      route.action?.templateName &&
        route.actionNodeId &&
        !route.connectsNonTemplateStep
    )
  );

  let disabledReason: string | null = null;
  if (!configReady) {
    disabledReason = "columnSplitConfigIncomplete";
  } else if (hasNonTemplateStep) {
    disabledReason = "bulkNodeUploadedRequiresTemplate";
  } else if (!hasConnectedSendablePath) {
    disabledReason = "columnSplitNoTemplate";
  } else if (hasBlockedConnectedTemplate) {
    disabledReason = "columnSplitTemplateBlocked";
  }

  return {
    splitNodeId: params.routing.splitNodeId,
    routes,
    elseCount: counts.elseCount,
    total: params.recipients.length,
    ready: disabledReason === null,
    disabledReason,
  };
}

/** The template catalog as the scenario graph resources report it. */
export type BulkColumnSplitTemplateCatalogState = {
  loading: boolean;
  /** False until the catalog first loads. */
  loaded: boolean;
  /** The last catalog read failed (or Meta is limiting it). */
  failed: boolean;
};

export type BulkColumnSplitTemplateCatalogBlockReason =
  | "loading"
  | "catalog_unavailable";

/**
 * Applies the template catalog state to a column-split preview, the way the
 * bulk node treats its single connected template: before the catalog first
 * loads every template looks missing, so Send waits ("loading"); a failed
 * read, or a saved catalog Meta couldn't refresh that lacks a connected
 * template, can't tell whether it is approved ("catalog_unavailable"). In
 * both cases a template missing from the catalog is not reported as stale.
 * `waitsOnlyForCatalog` says the split's own checks pass, so only the
 * catalog holds Send back.
 */
export function applyBulkColumnSplitTemplateCatalogState(
  preview: ScenarioBulkColumnSplitPreview,
  catalog: BulkColumnSplitTemplateCatalogState
): {
  preview: ScenarioBulkColumnSplitPreview;
  templateCatalogBlockReason: BulkColumnSplitTemplateCatalogBlockReason | null;
  waitsOnlyForCatalog: boolean;
} {
  const templateRoutes = preview.routes.filter(
    route => Boolean(route.actionNodeId) && Boolean(route.templateName)
  );
  if (templateRoutes.length === 0) {
    return {
      preview,
      templateCatalogBlockReason: null,
      waitsOnlyForCatalog: false,
    };
  }
  const unavailable =
    catalog.failed &&
    !catalog.loading &&
    (!catalog.loaded ||
      templateRoutes.some(route => route.templateSendBlockReason === "stale"));
  const templateCatalogBlockReason: BulkColumnSplitTemplateCatalogBlockReason | null =
    unavailable
      ? "catalog_unavailable"
      : catalog.loading || !catalog.loaded
        ? "loading"
        : null;
  if (!templateCatalogBlockReason) {
    return {
      preview,
      templateCatalogBlockReason: null,
      waitsOnlyForCatalog: false,
    };
  }

  const routes = preview.routes.map(route =>
    route.templateSendBlockReason === "stale"
      ? { ...route, templateSendBlockReason: null }
      : route
  );
  const stillBlocked = routes.some(
    route =>
      Boolean(route.actionNodeId) && Boolean(route.templateSendBlockReason)
  );
  // A block that only came from templates missing from the catalog gives way
  // to the catalog state; the node words "catalog_unavailable" itself.
  const keepsOwnReason =
    Boolean(preview.disabledReason) &&
    (preview.disabledReason !== "columnSplitTemplateBlocked" || stillBlocked);
  return {
    preview: {
      ...preview,
      routes,
      ready: false,
      disabledReason: keepsOwnReason
        ? (preview.disabledReason ?? null)
        : templateCatalogBlockReason === "loading"
          ? "bulkNodeTemplateSendBlockedLoading"
          : null,
    },
    templateCatalogBlockReason,
    waitsOnlyForCatalog: !keepsOwnReason,
  };
}

export function prepareBulkColumnSplitRecipients(params: {
  recipients: readonly ScenarioCampaignRecipient[];
  routing: Readonly<BulkColumnSplitRouting>;
  actionVariableConfigsByNodeId: Readonly<
    Record<
      string,
      Readonly<NonNullable<ScenarioNodeData["actionCampaignVariableConfigs"]>>
    >
  >;
}): {
  ready: Array<{
    actionNodeId: string;
    recipient: ScenarioCampaignRecipient & {
      templateName?: string;
      languageCode?: string;
      templateCategory?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
    };
  }>;
  skippedElse: number;
  unresolved: Array<{ label: string; missingVariables: string[] }>;
  configReady: boolean;
  blockedActions: ScenarioBulkConnectedAction[];
} {
  const configReady = isRecipientColumnSplitConfigReadyForSend(
    params.routing.config
  );
  const blockedActions: ScenarioBulkConnectedAction[] = [];
  const ready: Array<{
    actionNodeId: string;
    recipient: ScenarioCampaignRecipient & {
      templateName?: string;
      languageCode?: string;
      templateCategory?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
    };
  }> = [];
  const unresolved: Array<{ label: string; missingVariables: string[] }> = [];
  let skippedElse = 0;

  for (const recipient of params.recipients) {
    const match = matchRecipientColumnSplit(recipient, params.routing.config);
    const route = match.isElse
      ? params.routing.elseRoute
      : params.routing.routes.find(item => item.pathId === match.pathId);

    // Else (or any path) without connected template/action → skip send.
    // Connected Else template must still send.
    if (!route?.action?.templateName || !route.actionNodeId) {
      skippedElse += 1;
      continue;
    }

    if (route.action.templateSendBlockReason) {
      if (!blockedActions.some(item => item.nodeId === route.action?.nodeId)) {
        blockedActions.push(route.action);
      }
      continue;
    }

    const variableConfigs =
      params.actionVariableConfigsByNodeId[route.actionNodeId] ?? {};
    const prepared = prepareCampaignRecipientsForTemplate({
      recipients: [recipient],
      templateVariables: route.action.templateVariables ?? [],
      variableConfigs,
    });

    if (prepared.unresolved.length > 0) {
      unresolved.push(...prepared.unresolved);
      continue;
    }

    const preparedRecipient = prepared.recipients[0];
    if (!preparedRecipient) continue;

    const templateCategory = resolveSupportedTemplateCategory(
      route.action.templateCategory
    );

    ready.push({
      actionNodeId: route.actionNodeId,
      recipient: {
        ...preparedRecipient,
        templateName: route.action.templateName,
        languageCode: route.action.templateLanguage,
        templateCategory,
      },
    });
  }

  return { ready, skippedElse, unresolved, configReady, blockedActions };
}
