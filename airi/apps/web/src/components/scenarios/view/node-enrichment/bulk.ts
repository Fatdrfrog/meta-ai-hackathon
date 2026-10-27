import type {
  ScenarioBulkSendOptions,
  ScenarioGenerationJobServerUpdate,
  ScenarioNodeData,
} from "../../types";
import {
  BulkCampaignSendError,
  buildBulkCampaignAudienceIntent,
  buildBulkCampaignSendRequest,
  createBulkCampaignIdempotencyKey,
  formatMissingCampaignVariablesMessage,
  postBulkCampaignSend,
  prepareCampaignRecipientsForTemplate,
  type BulkCampaignTemplateInput,
} from "@/lib/campaign/bulk-campaign-client";
import type { BulkCampaignSendResponse } from "@/lib/campaign/bulk-campaign-contracts";
import { parseBulkCampaignCommandResult } from "@/lib/campaign/bulk-campaign-outcome";
import {
  fetchScenarioGeneratorJobRequest,
  sendGeneratedScenarioCampaignRequest,
} from "@/lib/scenarios/client";
import {
  buildBulkColumnSplitPreview,
  prepareBulkColumnSplitRecipients,
} from "@/lib/scenarios/bulk-column-split-routing";
import {
  getScenarioBulkGenerationRevision,
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignAudienceIntent,
  type BulkCampaignCommandResult,
  type BulkCampaignProvenanceIntent,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignSkipReason,
  type ScenarioCampaignRecipient,
} from "@icecore/scenario-contracts";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import { bulkTemplateSendBlockReasonMessageKey } from "../scenario-template-utils";
import {
  buildCommonNodeEnrichment,
  buildSourceHandleEnrichment,
  selectCommonEnrichmentView,
  type ScenarioCommonEnrichmentView,
  type ScenarioSourceHandleEnrichmentView,
} from "./common";
import { sliceIndexMap } from "./enrichment-view";
import type { ScenarioNodeGraphIndex } from "./scenario-node-graph-index";
import type {
  ScenarioBulkEditorNodeData,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

export type ScenarioBulkEnrichmentView = ScenarioCommonEnrichmentView &
  ScenarioSourceHandleEnrichmentView &
  Pick<
    ScenarioNodeEnrichmentContextValue,
    | "t"
    | "workspaceId"
    | "activeScenarioId"
    | "registeredBusinessPhonesAudience"
    | "scenarioCallbacksRef"
    | "adoptGeneratedBulkServerUpdate"
    | "prepareScenarioBulkSend"
    | "adoptScenarioActivation"
    | "onScenarioActivationBlocked"
    | "prepareGeneratedJobRefresh"
    | "reconcileGeneratedJobServerUpdate"
  > & {
    graphIndex: Pick<
      ScenarioNodeGraphIndex,
      | "bulkColumnSplitRoutingByRootId"
      | "bulkActionByRootId"
      | "actionVariableConfigsByNodeId"
    >;
  };

type BulkSendContext = Pick<
  ScenarioBulkEnrichmentView,
  | "workspaceId"
  | "t"
  | "callbacksRef"
  | "scenarioCallbacksRef"
  | "prepareScenarioBulkSend"
  | "adoptScenarioActivation"
>;

function missingTemplateVariablesMessage(
  unresolved: Array<{ label: string; missingVariables: string[] }>,
  t: BulkSendContext["t"]
) {
  return formatMissingCampaignVariablesMessage(unresolved, {
    summary: count => t("bulkNodeVariableMissing", { count }),
    more: count => t("bulkNodeVariableMissingMore", { count }),
  });
}

export function selectBulkEnrichmentView(
  nodeId: string,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioBulkEnrichmentView {
  return {
    ...selectCommonEnrichmentView(ctx),
    openNodePickerFromHandle: ctx.openNodePickerFromHandle,
    t: ctx.t,
    workspaceId: ctx.workspaceId,
    activeScenarioId: ctx.activeScenarioId,
    registeredBusinessPhonesAudience: ctx.registeredBusinessPhonesAudience,
    scenarioCallbacksRef: ctx.scenarioCallbacksRef,
    adoptGeneratedBulkServerUpdate: ctx.adoptGeneratedBulkServerUpdate,
    prepareScenarioBulkSend: ctx.prepareScenarioBulkSend,
    adoptScenarioActivation: ctx.adoptScenarioActivation,
    onScenarioActivationBlocked: ctx.onScenarioActivationBlocked,
    prepareGeneratedJobRefresh: ctx.prepareGeneratedJobRefresh,
    reconcileGeneratedJobServerUpdate: ctx.reconcileGeneratedJobServerUpdate,
    graphIndex: {
      bulkColumnSplitRoutingByRootId: sliceIndexMap(
        ctx.graphIndex.bulkColumnSplitRoutingByRootId,
        nodeId
      ),
      bulkActionByRootId: sliceIndexMap(
        ctx.graphIndex.bulkActionByRootId,
        nodeId
      ),
      actionVariableConfigsByNodeId:
        ctx.graphIndex.actionVariableConfigsByNodeId,
    },
  };
}

function skippedByReasonTotal(
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>
): number {
  return Object.values(skippedByReason).reduce(
    (total, count) => total + (count || 0),
    0
  );
}

function resolveSuccessfulCommandResult(
  payload: unknown
): Extract<BulkCampaignCommandResult, { ok: true }> | null {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "ok" in payload &&
    (payload as { ok?: unknown }).ok === true &&
    "outcome" in payload
  ) {
    return payload as Extract<BulkCampaignCommandResult, { ok: true }>;
  }
  try {
    const parsed = parseBulkCampaignCommandResult({
      payload,
      httpStatus: 200,
    });
    return parsed.ok ? parsed : null;
  } catch {
    return null;
  }
}

function toSendableRecipient(
  recipient: ScenarioCampaignRecipient & {
    templateName?: string;
    languageCode?: string;
  }
): ScenarioCampaignRecipient & {
  templateName?: string;
  languageCode?: string;
} {
  return {
    ...(recipient.phone ? { phone: recipient.phone } : {}),
    ...(recipient.chatId ? { chatId: recipient.chatId } : {}),
    ...(recipient.email ? { email: recipient.email } : {}),
    ...(recipient.name ? { name: recipient.name } : {}),
    ...(recipient.birthday ? { birthday: recipient.birthday } : {}),
    ...(recipient.fields ? { fields: recipient.fields } : {}),
    ...(recipient.variables ? { variables: recipient.variables } : {}),
    ...(recipient.sourceId ? { sourceId: recipient.sourceId } : {}),
    ...(recipient.templateName ? { templateName: recipient.templateName } : {}),
    ...(recipient.languageCode ? { languageCode: recipient.languageCode } : {}),
  };
}

function scenarioRunNowProvenance(params: {
  scenarioId: string;
  rootNodeId: string;
  actionNodeId?: string;
  columnSplitNodeId?: string;
}): BulkCampaignProvenanceIntent {
  return {
    kind: "scenario_run_now",
    scenarioId: params.scenarioId,
    rootNodeId: params.rootNodeId,
    ...(params.columnSplitNodeId
      ? { columnSplitNodeId: params.columnSplitNodeId }
      : params.actionNodeId
        ? { actionNodeId: params.actionNodeId }
        : {}),
  };
}

function resolveSendRecipientPolicy(
  rootPolicy: unknown,
  optionPolicy: BulkCampaignRecipientPolicy | undefined
): BulkCampaignRecipientPolicy {
  return normalizeBulkCampaignRecipientPolicy(optionPolicy ?? rootPolicy);
}

function requireAudience(
  audience: BulkCampaignAudienceIntent | undefined,
  errorMessage: string
): BulkCampaignAudienceIntent {
  if (!audience) {
    throw new Error(errorMessage);
  }
  return audience;
}

async function sendScenarioBulkCampaign(params: {
  nodeId: string;
  rawData: ScenarioNodeData;
  ctx: BulkSendContext;
  options?: ScenarioBulkSendOptions;
  idempotencyKey: string;
  channel: "whatsapp" | "telegram";
  audience: BulkCampaignAudienceIntent;
  provenance: {
    scenarioId: string;
    rootNodeId: string;
    actionNodeId?: string;
    columnSplitNodeId?: string;
  };
  useColumnSplitRouting?: boolean;
  messageText?: string;
  whatsappTemplate?: BulkCampaignTemplateInput;
}): Promise<BulkCampaignSendResponse> {
  const request = buildBulkCampaignSendRequest({
    workspaceId: params.ctx.workspaceId,
    channel: params.channel,
    campaignName:
      params.rawData.bulkRootConfig?.campaignName ||
      params.ctx.t("bulkNodeFallbackCampaignName"),
    idempotencyKey: params.idempotencyKey,
    provenance: scenarioRunNowProvenance(params.provenance),
    recipientPolicy: resolveSendRecipientPolicy(
      params.rawData.bulkRootConfig?.recipientPolicy,
      params.options?.recipientPolicy
    ),
    scheduledAt: params.options?.scheduledAt,
    audienceConfirmationFingerprint:
      params.options?.audienceConfirmationFingerprint,
    overflowQueueConfirmed: params.options?.overflowQueueConfirmed,
    audience: params.audience,
    ...(params.useColumnSplitRouting ? { useColumnSplitRouting: true } : {}),
    ...(params.messageText ? { messageText: params.messageText } : {}),
    ...(params.whatsappTemplate
      ? { whatsappTemplate: params.whatsappTemplate }
      : {}),
  });
  const releaseScenarioSaves = await params.ctx.prepareScenarioBulkSend();
  if (!releaseScenarioSaves) {
    throw new Error(params.ctx.t("bulkNodeSaveBeforeSend"));
  }
  try {
    const payload = await postBulkCampaignSend(request).catch(
      (error: unknown) => {
        // Admission can refuse a send after it turned the scenario on.
        if (error instanceof BulkCampaignSendError) {
          adoptSendScenarioActivation({
            ctx: params.ctx,
            scenarioId: params.provenance.scenarioId,
            payload: error.payload,
          });
        }
        throw error;
      }
    );
    updateBulkSendStatus({
      nodeId: params.nodeId,
      scenarioId: params.provenance.scenarioId,
      rawData: params.rawData,
      ctx: params.ctx,
      payload,
    });
    return payload;
  } finally {
    releaseScenarioSaves();
  }
}

/** Adopts the scenario activation a send response reports, if any. */
function adoptSendScenarioActivation(params: {
  ctx: BulkSendContext;
  /** The scenario open when the send started, which the server activated. */
  scenarioId: string;
  payload: unknown;
}): void {
  const payload = params.payload as Partial<BulkCampaignSendResponse> | null;
  if (payload?.scenarioStatus !== "active") return;
  if (typeof payload.scenarioUpdatedAt === "string") {
    params.ctx.adoptScenarioActivation({
      scenarioId: params.scenarioId,
      scenarioUpdatedAt: payload.scenarioUpdatedAt,
      previousScenarioUpdatedAt:
        typeof payload.previousScenarioUpdatedAt === "string"
          ? payload.previousScenarioUpdatedAt
          : null,
    });
    return;
  }
  // Legacy responses carry no revision; only the status is known.
  params.ctx.scenarioCallbacksRef.current.onScenarioStatusChange?.(
    "active",
    params.scenarioId
  );
}

function updateBulkSendStatus(params: {
  nodeId: string;
  /** The scenario open when the send started, which the server activated. */
  scenarioId: string;
  rawData: ScenarioNodeData;
  ctx: BulkSendContext;
  payload: BulkCampaignSendResponse | null;
}): void {
  const command = resolveSuccessfulCommandResult(params.payload);
  const outcome = command?.outcome;
  const skippedCount = outcome
    ? skippedByReasonTotal(outcome.skippedByReason)
    : Math.max(0, Number(params.payload?.skippedRecipientCount || 0));
  const requestedTotal = outcome
    ? outcome.requestedTotal
    : Math.max(0, Number(params.payload?.requestedTotal || 0));
  const queuedTotal = outcome
    ? outcome.queuedTotal
    : Math.max(0, Number(params.payload?.total || 0));
  const campaignId = outcome?.campaignId ?? params.payload?.campaignId;
  const dispatchId = outcome?.dispatchId ?? params.payload?.dispatchId;
  const workflowId = outcome?.workflowId ?? params.payload?.workflowId;
  const config = params.rawData.bulkRootConfig;
  const lifecycleStatus =
    outcome?.lifecycleStatus ||
    params.payload?.status ||
    (params.payload?.scheduledAt
      ? ("scheduled" as const)
      : params.payload?.queued
        ? ("queued" as const)
        : undefined);
  if (config) {
    params.ctx.callbacksRef.current.updateNodeById(params.nodeId, {
      bulkRootConfig: {
        ...config,
        sendStatus: {
          total: requestedTotal,
          queued: queuedTotal,
          sent: 0,
          skipped: skippedCount,
          failed: 0,
          ...(campaignId ? { campaignId } : {}),
          ...(dispatchId ? { dispatchId } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(lifecycleStatus ? { lifecycleStatus } : {}),
          ...(params.payload?.audience?.fingerprint
            ? {
                audienceFingerprint: params.payload.audience.fingerprint,
                audienceRevision: config.audienceRevision ?? 0,
              }
            : {}),
          ...(params.payload?.audience?.overlap
            ? { overlap: params.payload.audience.overlap }
            : {}),
          lastSendAttemptAt: new Date().toISOString(),
          ...(params.payload?.scheduledAt
            ? { scheduledAt: params.payload.scheduledAt }
            : {}),
          ...(outcome ? { lastOutcome: outcome } : {}),
        },
      },
    });
  }
  adoptSendScenarioActivation({
    ctx: params.ctx,
    scenarioId: params.scenarioId,
    payload: params.payload,
  });
}

export function enrichBulkRootNodeData(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"bulk">,
  ctx: ScenarioBulkEnrichmentView
): ScenarioBulkEditorNodeData {
  const columnSplitRouting =
    ctx.graphIndex.bulkColumnSplitRoutingByRootId.get(nodeId);
  const connectedAction = columnSplitRouting
    ? null
    : (ctx.graphIndex.bulkActionByRootId.get(nodeId) ?? null);

  const uploadedRecipients = rawData.bulkRootConfig?.uploadedRecipients ?? [];
  const uiBulkColumnSplitPreview = columnSplitRouting
    ? buildBulkColumnSplitPreview({
        recipients: uploadedRecipients,
        routing: columnSplitRouting,
      })
    : null;

  return {
    ...rawData,
    ...buildCommonNodeEnrichment(nodeId, ctx),
    ...buildSourceHandleEnrichment(nodeId, ctx),
    uiWorkspaceId: ctx.workspaceId,
    uiActiveScenarioId: ctx.activeScenarioId,
    uiRegisteredBusinessPhonesAudience: ctx.registeredBusinessPhonesAudience,
    uiOnConnectedActionPatch: (actionNodeId, patch) =>
      ctx.callbacksRef.current.updateNodeById(actionNodeId, patch),
    uiOnScenarioActivationBlocked: nodeIds =>
      ctx.onScenarioActivationBlocked(nodeIds),
    uiOnLoadWhatsAppTemplates: () => {
      void ctx.callbacksRef.current.loadWhatsAppTemplates();
    },
    uiBulkConnectedAction: connectedAction,
    uiBulkColumnSplitPreview,
    uiOnBulkSend: async (options?: ScenarioBulkSendOptions) => {
      if (!ctx.activeScenarioId) {
        throw new Error(ctx.t("bulkNodeSendRequiresScenario"));
      }
      const idempotencyKey =
        options?.idempotencyKey?.trim() || createBulkCampaignIdempotencyKey();
      if (getScenarioBulkGenerationRevision(rawData.bulkRootConfig)) {
        const payload = await sendGeneratedScenarioCampaignRequest({
          workspaceId: ctx.workspaceId,
          scenarioId: ctx.activeScenarioId,
          idempotencyKey,
          scheduledAt: options?.scheduledAt ?? undefined,
          audienceConfirmationFingerprint:
            options?.audienceConfirmationFingerprint,
          acknowledgeMediaFailures: options?.acknowledgeMediaFailures === true,
          errorFallback: ctx.t("bulkNodeSendFailed"),
        });
        if (
          !payload?.scenarioUpdate ||
          !ctx.adoptGeneratedBulkServerUpdate(
            payload.scenarioUpdate,
            payload.scenarioStatus === "active" ? "active" : undefined
          )
        ) {
          throw new BulkCampaignSendError(
            ctx.t("bulkNodeGeneratedStateRefreshRequired"),
            {
              ...payload,
              error: ctx.t("bulkNodeGeneratedStateRefreshRequired"),
              retryable: true,
            },
            502
          );
        }
        return payload;
      }
      const recipients = (options?.recipients || []).filter(recipient =>
        Boolean(
          recipient.phone?.trim() ||
            recipient.chatId?.trim() ||
            recipient.email?.trim()
        )
      );
      const registeredBusinessPhonesAudience =
        options?.registeredBusinessPhonesAudience;
      const telegramSubscribersAudience = options?.telegramSubscribersAudience;
      const audienceUploadEvidence =
        recipients.length > 0 ? options?.audienceUploadEvidence : undefined;

      const selectedAudienceSourceCount =
        (registeredBusinessPhonesAudience ? 1 : 0) +
        (telegramSubscribersAudience ? 1 : 0) +
        (recipients.length > 0 ? 1 : 0);

      if (selectedAudienceSourceCount > 1) {
        throw new Error(ctx.t("bulkNodeOnlyOneAudienceSource"));
      }

      if (columnSplitRouting) {
        if (registeredBusinessPhonesAudience || telegramSubscribersAudience) {
          throw new Error(ctx.t("columnSplitRequiresUploadedRecipients"));
        }
        if (recipients.length === 0) {
          throw new Error(ctx.t("columnSplitUploadRecipientsFirst"));
        }
        if (!uiBulkColumnSplitPreview?.ready) {
          throw new Error(
            ctx.t(
              uiBulkColumnSplitPreview?.disabledReason ||
                "columnSplitSendNotReady"
            )
          );
        }

        const prepared = prepareBulkColumnSplitRecipients({
          recipients,
          routing: columnSplitRouting,
          actionVariableConfigsByNodeId:
            ctx.graphIndex.actionVariableConfigsByNodeId,
        });

        if (prepared.blockedActions.length > 0) {
          const reason = prepared.blockedActions[0]?.templateSendBlockReason;
          if (reason) {
            throw new Error(
              ctx.t(bulkTemplateSendBlockReasonMessageKey(reason))
            );
          }
        }

        if (prepared.unresolved.length > 0) {
          throw new Error(
            missingTemplateVariablesMessage(prepared.unresolved, ctx.t)
          );
        }
        if (prepared.ready.length === 0) {
          throw new Error(
            prepared.skippedElse > 0
              ? ctx.t("columnSplitAllRecipientsSkipped")
              : ctx.t("bulkNodeSendRequiresAction")
          );
        }

        return sendScenarioBulkCampaign({
          nodeId,
          rawData,
          ctx,
          options,
          idempotencyKey,
          channel: "whatsapp",
          audience: requireAudience(
            buildBulkCampaignAudienceIntent("inline", {
              inlineRecipients: prepared.ready.map(item =>
                toSendableRecipient(item.recipient)
              ),
              uploadEvidence: audienceUploadEvidence,
            }),
            ctx.t("bulkNodeSendRequiresAudience")
          ),
          provenance: {
            scenarioId: ctx.activeScenarioId,
            rootNodeId: nodeId,
            columnSplitNodeId: columnSplitRouting.splitNodeId,
          },
          useColumnSplitRouting: true,
        });
      }

      if (!connectedAction?.actionType) {
        throw new Error(ctx.t("bulkNodeSendRequiresAction"));
      }
      if (connectedAction.templateSendBlockReason) {
        throw new Error(
          ctx.t(
            bulkTemplateSendBlockReasonMessageKey(
              connectedAction.templateSendBlockReason
            )
          )
        );
      }

      if (
        telegramSubscribersAudience ||
        registeredBusinessPhonesAudience ||
        recipients.length > 0
      ) {
        const isTelegramReply =
          connectedAction.actionType === "reply" &&
          connectedAction.channel === "telegram";

        if (isTelegramReply) {
          const messageText = connectedAction.replyText?.trim();
          if (!messageText) {
            throw new Error(ctx.t("bulkNodeUploadedRequiresTemplate"));
          }

          return sendScenarioBulkCampaign({
            nodeId,
            rawData,
            ctx,
            options,
            idempotencyKey,
            channel: "telegram",
            audience: requireAudience(
              telegramSubscribersAudience
                ? buildBulkCampaignAudienceIntent("telegram_subscribers", {
                    telegramSourceId: telegramSubscribersAudience.sourceId,
                    telegramSelectedChatIds:
                      telegramSubscribersAudience.selectedChatIds,
                  })
                : buildBulkCampaignAudienceIntent("inline", {
                    inlineRecipients: recipients.map(toSendableRecipient),
                    uploadEvidence: audienceUploadEvidence,
                  }),
              ctx.t("bulkNodeSendRequiresAudience")
            ),
            provenance: {
              scenarioId: ctx.activeScenarioId,
              rootNodeId: nodeId,
              actionNodeId: connectedAction.nodeId,
            },
            messageText,
          });
        }

        if (connectedAction.actionType !== "whatsapp_template") {
          throw new Error(ctx.t("bulkNodeUploadedRequiresTemplate"));
        }
        if (!connectedAction.templateName) {
          throw new Error(ctx.t("bulkNodeTemplateRequired"));
        }

        const prepared = registeredBusinessPhonesAudience
          ? { recipients: [], unresolved: [] }
          : prepareCampaignRecipientsForTemplate({
              recipients,
              templateVariables: connectedAction.templateVariables || [],
              variableConfigs: options?.variableConfigs || {},
            });

        if (prepared.unresolved.length > 0) {
          throw new Error(
            missingTemplateVariablesMessage(prepared.unresolved, ctx.t)
          );
        }

        return sendScenarioBulkCampaign({
          nodeId,
          rawData,
          ctx,
          options,
          idempotencyKey,
          channel: "whatsapp",
          audience: requireAudience(
            registeredBusinessPhonesAudience
              ? buildBulkCampaignAudienceIntent("registered_business_phones", {
                  selectedPhones:
                    registeredBusinessPhonesAudience.selectedPhones,
                })
              : buildBulkCampaignAudienceIntent("inline", {
                  inlineRecipients: prepared.recipients.map(toSendableRecipient),
                  uploadEvidence: audienceUploadEvidence,
                }),
            ctx.t("bulkNodeSendRequiresAudience")
          ),
          provenance: {
            scenarioId: ctx.activeScenarioId,
            rootNodeId: nodeId,
            actionNodeId: connectedAction.nodeId,
          },
          whatsappTemplate: {
            name: connectedAction.templateName,
            language: connectedAction.templateLanguage || "en",
            components: connectedAction.templateComponents,
          },
        });
      }

      throw new Error(ctx.t("bulkNodeSendRequiresAudience"));
    },
    uiOnRefreshGenerationJob: async () => {
      const config = rawData.bulkRootConfig;
      const generationJobId = config?.generationJobId;
      if (!generationJobId) {
        throw new Error(ctx.t("bulkNodeGenerationJobUnavailable"));
      }
      if (!(await ctx.prepareGeneratedJobRefresh())) {
        return { status: "failed" };
      }
      const payload = await fetchScenarioGeneratorJobRequest({
        workspaceId: ctx.workspaceId,
        jobId: generationJobId,
        errorFallback: ctx.t("bulkNodeRefreshGenerationFailed"),
      });

      return ctx.reconcileGeneratedJobServerUpdate({
        generationJobId: payload.generationJobId || generationJobId,
        previousScenarioUpdatedAt: payload.previousScenarioUpdatedAt ?? null,
        scenarioUpdatedAt: payload.scenarioUpdatedAt ?? null,
        scenarioRevisionConflict: payload.scenarioRevisionConflict !== false,
        nodeUpdates: (Array.isArray(payload.nodeUpdates)
          ? payload.nodeUpdates
          : []
        ).flatMap(update =>
          update.id && update.data ? [{ id: update.id, data: update.data }] : []
        ),
      } satisfies ScenarioGenerationJobServerUpdate);
    },
  };
}
