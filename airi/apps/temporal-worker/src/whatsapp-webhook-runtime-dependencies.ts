import { scheduleWhatsAppOptionalWork } from "./whatsapp-optional-work.js";
import * as RealtimeServer from "@/lib/realtime/server";
import {
  withCompanyRuntimeCapacity,
  type CompanyRuntimeLane,
} from "@icecore/shared/lib/company-runtime-capacity";
import * as AiriReplySelection from "@/lib/airi/reply/selection";
import * as Cache from "@/lib/cache";
import * as Crypto from "@/lib/crypto";
import * as CrossStoreOutbox from "@/lib/cross-store-outbox";
import * as CustomerWebhookIntents from "@/lib/customer-webhook-intents";
import * as CustomerContactPolicy from "@/lib/campaign/customer-contact-policy";
import * as Engagement from "@/lib/engagement/conversation-engagement";
import * as ScenarioFlowAnalytics from "@/lib/scenarios/scenario-flow-analytics";
import * as SupabaseAdmin from "@/lib/supabase/admin";
import * as AiriDirectIngress from "@/lib/temporal/airi-direct-ingress";
import * as LlmWhatsAppFeedback from "@/lib/llm-analytics/whatsapp-feedback";
import * as WorkspaceAlerts from "@/lib/notifications/workspace-alerts";
import * as WebhookEvents from "@/lib/webhook-events";
import * as AccountHealth from "@/lib/whatsapp/account/health";
import * as AccountUpdateHandler from "@/lib/whatsapp/account/update-handler";
import * as SourceRebindGuard from "@/lib/whatsapp/flows/source-rebind-guard";
import * as SourceResolver from "@/lib/whatsapp/source-resolver";
import * as WhatsAppCredentials from "@/lib/whatsapp/credentials";
import * as TemplateMirror from "@/lib/whatsapp/templates/template-mirror";
import type { MirroredWhatsAppTemplate } from "@/lib/whatsapp/templates/template-mirror";
import * as WhatsAppCallClient from "@/lib/temporal/whatsapp-call-client";
import CampaignDeliveryTask from "@/models/campaign-delivery-task";
import Chat from "@/models/chat";
import * as ConversationModel from "@/models/conversation";
import Message from "@/models/message";
import MessageDeliveryEvent from "@/models/message-delivery-event";
import User from "@/models/user";
import WhatsAppCallEvent from "@/models/whatsapp-call-event";
import WhatsAppGroup from "@/models/whatsapp-group";
import WhatsAppGroupEvent from "@/models/whatsapp-group-event";
import * as WhatsAppTemplateModels from "@/models/whatsapp-template";
import { createWhatsAppBusinessCapabilityUpdateHandler } from "@icecore/airi-runtime/whatsapp-business-capability";
import {
  createWhatsAppCallWebhookHandler,
  type PersistWhatsAppCallEventParams,
} from "@icecore/airi-runtime/whatsapp-call-webhook-handler";
import { createWhatsAppEchoWebhookHandler } from "@icecore/airi-runtime/whatsapp-echo-webhook-handler";
import { createWhatsAppGroupWebhookHandler } from "@icecore/airi-runtime/whatsapp-groups-handler";
import { createWhatsAppHistoryWebhookHandler } from "@icecore/airi-runtime/whatsapp-history-webhook-handler";
import * as InteractiveReplyEvent from "@icecore/airi-runtime/whatsapp-interactive-reply-event";
import { createWhatsAppLifecycleWebhookHandler } from "@icecore/airi-runtime/whatsapp-lifecycle-handler";
import { processWhatsAppMessage as processSharedWhatsAppMessage } from "@icecore/airi-runtime/whatsapp-message-processor";
import { createWhatsAppIntakePlanGate } from "@icecore/airi-runtime/whatsapp-intake-plan-gate";
import * as WebsiteCarts from "@/lib/commerce/carts";
import { createWhatsAppPhoneNumberUsernameUpdateHandler } from "@icecore/airi-runtime/whatsapp-phone-number-username";
import { createWhatsAppStatusWebhookHandler } from "@icecore/airi-runtime/whatsapp-status-webhook-handler";
import { createCampaignTaskProviderAcceptance } from "@icecore/airi-runtime/campaign-task-provider-acceptance";
import { createWhatsAppUserPreferencesWebhookHandler } from "@icecore/airi-runtime/whatsapp-user-preferences-handler";
import type { WhatsAppWebhookRuntimeDependencies } from "@icecore/airi-runtime/whatsapp-webhook-runtime";
import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  getWhatsAppLogIdentity,
  getWhatsAppPrimaryIdentifier,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  shouldQueueWhatsAppAiriIngress,
  shouldSuppressGeneralWhatsAppAiriReply,
} from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";
import {
  normalizeWhatsAppWebhookContact,
  resolveWhatsAppDisplayPhoneNumber,
  resolveWhatsAppMessageContext,
} from "@icecore/shared/lib/whatsapp/webhook-direction";
import {
  buildWhatsAppMessageRawSourcePayload,
  parseWhatsAppTimestamp,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  buildWhatsAppWebhookSourceSkipPayload,
  getWhatsAppWebhookSourceSkip,
} from "@icecore/shared/lib/whatsapp/source-state";
import type {
  WhatsAppGroupParticipant,
  WhatsAppGroupWebhookEvent,
} from "@icecore/whatsapp/groupWebhooks";
import connectDB from "@icecore/airi-runtime/mongoose";
import type { Source } from "@icecore/shared/types/sources";
import { createLogger } from "@icecore/shared/lib/logger";
import { shouldProcessEvenIfDuplicate } from "@icecore/whatsapp/webhookMessageDedupe";
import { createWhatsAppContactSyncWebhookHandler } from "./whatsapp-contact-sync/handler.js";
import {
  linkWhatsAppCallSessionToConversation,
  readWhatsAppIntakeCompanyPlan,
} from "./whatsapp-call-conversation-linker.js";
import { upsertWhatsAppCallSessionFromEvent } from "./whatsapp-call-session-reducer.js";
import { createRecordWhatsAppMessageDeliveryStatus } from "./whatsapp-message-delivery.js";
import { createPhoneNumberQualityUpdateHandler } from "./whatsapp-phone-number-quality.js";
import {
  createTemplateMirrorRefresher,
  createWhatsAppTemplateLifecycleHandlers,
} from "./whatsapp-template-lifecycle.js";
import * as IdentityChange from "./whatsapp-identity-change.js";
import { findExistingWhatsAppMessageByExternalId } from "./whatsapp-message-dedupe.js";
import * as WhatsAppMarketingConsent from "@/lib/whatsapp/marketing-consent";
import { workerRealtime } from "./worker-realtime.js";

function getRuntimeModule<T>(moduleNamespace: T): T {
  const defaultExport = (moduleNamespace as { default?: unknown }).default;
  if (
    defaultExport &&
    typeof defaultExport === "object" &&
    Object.keys(defaultExport).length > 0
  ) {
    return defaultExport as T;
  }
  return moduleNamespace;
}

const airiReplySelection = getRuntimeModule(AiriReplySelection);
const cache = getRuntimeModule(Cache);
const cryptoUtils = getRuntimeModule(Crypto);
const crossStoreOutbox = getRuntimeModule(CrossStoreOutbox);
const customerContactPolicy = getRuntimeModule(CustomerContactPolicy);
const customerWebhookIntents = getRuntimeModule(CustomerWebhookIntents);
const engagement = getRuntimeModule(Engagement);
const realtimeServer = getRuntimeModule(RealtimeServer);
const scenarioFlowAnalytics = getRuntimeModule(ScenarioFlowAnalytics);
const supabaseAdminModule = getRuntimeModule(SupabaseAdmin);
export async function withWorkspaceRuntimeCapacity<T>(
  workspaceId: string,
  lane: CompanyRuntimeLane,
  run: (companyId: string) => Promise<T>,
): Promise<T> {
  return withCompanyRuntimeCapacity(
    await supabaseAdminModule.supabaseAdmin,
    workspaceId,
    lane,
    run,
  );
}
const airiDirectIngress = getRuntimeModule(AiriDirectIngress);
const llmWhatsAppFeedback = getRuntimeModule(LlmWhatsAppFeedback);
const workspaceAlerts = getRuntimeModule(WorkspaceAlerts);
const accountHealth = getRuntimeModule(AccountHealth);
const accountUpdateHandler = getRuntimeModule(AccountUpdateHandler);
const sourceRebindGuard = getRuntimeModule(SourceRebindGuard);
const identityChange = getRuntimeModule(IdentityChange);
const interactiveReplyEvent = getRuntimeModule(InteractiveReplyEvent);
const sourceResolver = getRuntimeModule(SourceResolver);
const whatsappCredentials = getRuntimeModule(WhatsAppCredentials);
const templateMirror = getRuntimeModule(TemplateMirror);
const webhookEvents = getRuntimeModule(WebhookEvents);
const whatsappCallClient = getRuntimeModule(WhatsAppCallClient);
const websiteCarts = getRuntimeModule(WebsiteCarts);
const { upsertWhatsAppMarketingConsent } = getRuntimeModule(
  WhatsAppMarketingConsent,
);
// One process-local plan cache shared by every WhatsApp intake path.
const whatsappIntakePlanGate = createWhatsAppIntakePlanGate({
  readPlan: readWhatsAppIntakeCompanyPlan,
});
// The gate param is required on the shared processor, so dropping it here
// fails the worker typecheck instead of silently lifting the conversation cap.
const processWhatsAppMessage = (
  params: Omit<
    Parameters<typeof processSharedWhatsAppMessage>[0],
    "getNewConversationPlanSkip"
  >,
) =>
  processSharedWhatsAppMessage({
    ...params,
    claimWebsiteCart: websiteCarts.claimWebsiteCartFromWhatsApp,
    getNewConversationPlanSkip: whatsappIntakePlanGate.getNewConversationSkip,
  });
const conversationModel = getRuntimeModule(ConversationModel);
const whatsappTemplateModels = getRuntimeModule(WhatsAppTemplateModels);

function isMongooseModelLike(value: unknown): value is {
  findById: (...args: unknown[]) => unknown;
} {
  return (
    Boolean(value) &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { findById?: unknown }).findById === "function"
  );
}

function getRuntimeModel<T>(modelOrModule: T): T {
  const defaultExport = (modelOrModule as { default?: unknown }).default;
  if (isMongooseModelLike(defaultExport)) {
    return defaultExport as T;
  }
  return modelOrModule;
}

const CampaignDeliveryTaskModel = getRuntimeModel(CampaignDeliveryTask);
const ChatModel = getRuntimeModel(Chat);
const MessageModel = getRuntimeModel(Message);
const MessageDeliveryEventModel = getRuntimeModel(MessageDeliveryEvent);
const UserModel = getRuntimeModel(User);
const WhatsAppCallEventModel = getRuntimeModel(WhatsAppCallEvent);
const WhatsAppGroupModel = getRuntimeModel(WhatsAppGroup);
const WhatsAppGroupEventModel = getRuntimeModel(WhatsAppGroupEvent);
const WhatsAppTemplateModel = whatsappTemplateModels.WhatsAppTemplateModel;
const WhatsAppTemplateAuditLog =
  whatsappTemplateModels.WhatsAppTemplateAuditLog;

type LeanConversationForRealtime = {
  _id: unknown;
  workspaceId?: string | null;
  createdAt?: Date | string | null;
  message_count?: number | null;
};

async function triggerWorkerConversationRealtime(
  conversationId: string,
  wasJustCreated?: boolean,
): Promise<void> {
  try {
    const conversation = (await conversationModel.Conversation.findById(
      conversationId,
    )
      .select("_id workspaceId createdAt message_count")
      .lean()
      .exec()) as LeanConversationForRealtime | null;

    if (!conversation?.workspaceId) {
      return;
    }

    let shouldEmitNewConversation = wasJustCreated;
    if (shouldEmitNewConversation === undefined) {
      const createdAt = new Date(conversation.createdAt || Date.now());
      const secondsSinceCreation = (Date.now() - createdAt.getTime()) / 1000;
      shouldEmitNewConversation =
        secondsSinceCreation < 5 && (conversation.message_count ?? 0) <= 1;
    }

    await workerRealtime.trigger(
      `tenant-${conversation.workspaceId}`,
      shouldEmitNewConversation ? "requests.new" : "requests.update",
      {
        _id: String(conversation._id),
        conversationId: String(conversation._id),
        workspaceId: String(conversation.workspaceId),
      },
    );
  } catch (error) {
    console.error("Worker realtime conversation update failed", {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function triggerWorkerWhatsAppReactionRealtimeUpdate(params: {
  conversationId: string;
  messageId: string;
}): Promise<void> {
  const reactionPayload = (await MessageModel.findById(params.messageId)
    .select("_id reactions")
    .lean()) as { reactions?: unknown[] } | null;

  await workerRealtime.trigger(
    `private-conversation-${params.conversationId}`,
    "message-updated",
    {
      messageId: params.messageId,
      reactions: reactionPayload?.reactions || [],
    },
  );
}

async function emitWorkerConversationCallUpdatedRealtimeEvent(params: {
  workspaceId: string;
  conversationId: string;
  callSessionId: string;
  state: string;
}): Promise<unknown> {
  return workerRealtime.trigger(
    `private-conversation-${params.conversationId}`,
    "conversation.call.updated",
    {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      callSessionId: params.callSessionId,
      state: params.state,
    },
  );
}

async function persistWhatsAppCallEvent(
  params: PersistWhatsAppCallEventParams,
): Promise<unknown> {
  const { event } = params;
  return WhatsAppCallEventModel.updateOne(
    {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      callId: event.callId,
      kind: event.kind,
      event: event.event,
      status: event.status,
      timestamp: event.timestamp,
    },
    {
      $set: {
        workspaceId: params.workspaceId,
        sourceId: params.sourceId,
        wabaId: event.wabaId,
        phoneNumberId: event.phoneNumberId,
        callId: event.callId,
        kind: event.kind,
        event: event.event,
        status: event.status,
        direction: event.direction,
        from: event.from,
        to: event.to,
        fromUserId: event.fromUserId,
        fromParentUserId: event.fromParentUserId,
        toUserId: event.toUserId,
        toParentUserId: event.toParentUserId,
        recipientId: event.recipientId,
        recipientUserId: event.recipientUserId,
        recipientParentUserId: event.recipientParentUserId,
        contactUserId: event.contactUserId,
        contactParentUserId: event.contactParentUserId,
        contactWaId: event.contactWaId,
        contactName: event.contactName,
        contactUsername: event.contactUsername,
        countryCode: event.countryCode,
        timestamp: event.timestamp,
        eventAt: params.eventAt,
        bizOpaqueCallbackData: event.bizOpaqueCallbackData,
        sessionSdpType: event.sessionSdpType,
        sessionSdp: event.sessionSdp,
        durationSeconds: event.durationSeconds,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        rawEvent: event.rawEvent,
      },
    },
    { upsert: true },
  ).exec();
}

function isWhatsAppAiriRuntimeEnabled(): boolean {
  return (process.env.AIRI_AUTO_REPLY ?? "true").toLowerCase() === "true";
}

function resolveWhatsAppConversationAutomationEnabled(
  conversation: any,
): boolean {
  if (!conversation) return false;
  const botEnabled =
    conversation.airi_bot_enabled ?? conversation.airi_enabled ?? false;
  const scenariosEnabled =
    conversation.airi_scenarios_enabled ?? conversation.airi_enabled ?? false;
  return Boolean(botEnabled || scenariosEnabled);
}

async function updateWhatsAppSourceCredentials(params: {
  sourceId: string;
  workspaceId: string;
  currentCredentials: Record<string, unknown>;
  credentials: Record<string, unknown>;
}) {
  try {
    await sourceRebindGuard.updateCurrentWhatsAppSourceCredentialsFromSnapshot({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      currentCredentials: params.currentCredentials,
      nextCredentials: params.credentials,
    });
    return { error: null };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function findWhatsAppSourceByDisplayPhoneNumber(
  displayPhoneNumber: string,
) {
  const { data } = await supabaseAdminModule.supabaseAdmin
    .from("sources")
    .select("*")
    .eq("type", "whatsapp")
    .eq("credentials->>display_phone_number", displayPhoneNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

async function readLatestWhatsAppSourceCredentials(params: {
  sourceId: string;
  workspaceId: string;
}) {
  const { data, error } = await supabaseAdminModule.supabaseAdmin
    .from("sources")
    .select("credentials")
    .eq("id", params.sourceId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (error) {
    throw new Error(
      error.message || "Failed to read current WhatsApp source credentials",
    );
  }
  return data?.credentials;
}

function groupParticipantKey(
  participant: WhatsAppGroupParticipant,
): string | null {
  return (
    participant.userId ||
    participant.waId ||
    participant.parentUserId ||
    participant.input ||
    participant.username ||
    null
  );
}

function normalizeGroupParticipant(participant: WhatsAppGroupParticipant) {
  return {
    input: participant.input,
    waId: participant.waId,
    userId: participant.userId,
    parentUserId: participant.parentUserId,
    username: participant.username,
  };
}

function appendDefinedGroupEventFields(
  set: Record<string, unknown>,
  event: WhatsAppGroupWebhookEvent,
) {
  if (event.wabaId) set.wabaId = event.wabaId;
  if (event.phoneNumberId) set.phoneNumberId = event.phoneNumberId;
  if (event.displayPhoneNumber)
    set.displayPhoneNumber = event.displayPhoneNumber;
  if (event.subject) set.subject = event.subject;
  if (event.description) set.description = event.description;
  if (event.inviteLink) set.inviteLink = event.inviteLink;
  if (event.joinApprovalMode) set.joinApprovalMode = event.joinApprovalMode;
}

function resolveWhatsAppGroupStatus(event: WhatsAppGroupWebhookEvent) {
  const type = (event.type || "").toLowerCase();
  if (type.includes("delete")) return "deleted";
  if (type.includes("suspend")) return "suspended";
  return "active";
}

async function upsertWhatsAppGroupEvent(params: {
  workspaceId: string;
  sourceId: string;
  event: WhatsAppGroupWebhookEvent;
}) {
  const { event } = params;
  const document = {
    addedParticipants: event.addedParticipants.map(normalizeGroupParticipant),
    description: event.description,
    displayPhoneNumber: event.displayPhoneNumber,
    eventAt: event.eventAt,
    failedParticipants: event.failedParticipants.map(normalizeGroupParticipant),
    field: event.field,
    groupId: event.groupId,
    inviteLink: event.inviteLink,
    joinApprovalMode: event.joinApprovalMode,
    pendingParticipants: event.pendingParticipants.map(
      normalizeGroupParticipant,
    ),
    phoneNumberId: event.phoneNumberId,
    rawGroup: event.rawGroup,
    reason: event.reason,
    removedParticipants: event.removedParticipants.map(
      normalizeGroupParticipant,
    ),
    requestId: event.requestId,
    sourceId: params.sourceId,
    subject: event.subject,
    type: event.type,
    wabaId: event.wabaId,
    workspaceId: params.workspaceId,
  };

  const filter = event.requestId
    ? {
        groupId: event.groupId,
        requestId: event.requestId,
        sourceId: params.sourceId,
        workspaceId: params.workspaceId,
      }
    : {
        eventAt: event.eventAt,
        field: event.field,
        groupId: event.groupId,
        sourceId: params.sourceId,
        type: event.type,
        workspaceId: params.workspaceId,
      };

  await WhatsAppGroupEventModel.updateOne(
    filter,
    { $setOnInsert: document },
    { upsert: true },
  );
}

async function upsertWhatsAppGroupState(params: {
  workspaceId: string;
  sourceId: string;
  event: WhatsAppGroupWebhookEvent;
}) {
  const { event } = params;
  const set: Record<string, unknown> = {
    lastEventAt: event.eventAt,
    lastEventField: event.field,
    lastEventType: event.type,
    rawLastEvent: event.rawGroup,
    status: resolveWhatsAppGroupStatus(event),
  };
  appendDefinedGroupEventFields(set, event);

  const group = await WhatsAppGroupModel.findOneAndUpdate(
    {
      groupId: event.groupId,
      sourceId: params.sourceId,
      workspaceId: params.workspaceId,
    },
    {
      $set: set,
      $setOnInsert: {
        groupId: event.groupId,
        sourceId: params.sourceId,
        workspaceId: params.workspaceId,
      },
    },
    { new: true, upsert: true },
  );

  const participantEvents = [
    ...event.addedParticipants.map((participant) => ({
      participant,
      status: "active" as const,
    })),
    ...event.removedParticipants.map((participant) => ({
      participant,
      status: "removed" as const,
    })),
    ...event.pendingParticipants.map((participant) => ({
      participant,
      status: "pending" as const,
    })),
    ...event.failedParticipants.map((participant) => ({
      participant,
      status: "failed" as const,
    })),
  ];
  if (participantEvents.length === 0) return;

  const participants = Array.isArray(group.participants)
    ? [...group.participants]
    : [];
  for (const participantEvent of participantEvents) {
    const key = groupParticipantKey(participantEvent.participant);
    if (!key) continue;

    const existing = participants.find(
      (participant: any) =>
        groupParticipantKey({
          input: participant.input ?? null,
          parentUserId: participant.parentUserId ?? null,
          userId: participant.userId ?? null,
          username: participant.username ?? null,
          waId: participant.waId ?? null,
        }) === key,
    );
    const next = {
      ...normalizeGroupParticipant(participantEvent.participant),
      status: participantEvent.status,
      updatedAt: event.eventAt,
      ...(participantEvent.status === "active"
        ? { joinedAt: event.eventAt }
        : {}),
      ...(participantEvent.status === "removed"
        ? { removedAt: event.eventAt }
        : {}),
    };

    if (existing) {
      Object.assign(existing, next);
    } else {
      participants.push(next);
    }
  }

  group.participants = participants;
  await group.save();
}

const handleBusinessCapabilityUpdate =
  createWhatsAppBusinessCapabilityUpdateHandler({
    resolveWhatsAppSourcesByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourcesByAccountIdentifiers,
    updateSourceCredentials: updateWhatsAppSourceCredentials,
  });

const handlePhoneNumberQualityUpdate = createPhoneNumberQualityUpdateHandler({
  logger: createLogger("whatsapp.phone-number-quality"),
  now: () => new Date(),
  publishWorkspaceAlert: workspaceAlerts.publishWorkspaceAlert,
  resolveWhatsAppSourcesByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourcesByAccountIdentifiers,
  updateSourceCredentials: async (params) => {
    const { error } = await updateWhatsAppSourceCredentials({
      sourceId: params.sourceId,
      workspaceId: params.workspaceId,
      currentCredentials: params.currentCredentials,
      credentials: params.credentials,
    });
    return { errorMessage: error?.message || null };
  },
});

const handlePhoneNumberUsernameUpdate =
  createWhatsAppPhoneNumberUsernameUpdateHandler({
    findWhatsAppSourceByDisplayPhoneNumber,
    logger: createLogger("whatsapp.phone-number-username"),
    now: () => new Date(),
    resolveWhatsAppSourceByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
    updateSourceCredentials: updateWhatsAppSourceCredentials,
  });

const tryHandleWhatsAppContactSyncWebhook =
  createWhatsAppContactSyncWebhookHandler({
    buildWhatsAppWebhookSourceSkipPayload,
    getWhatsAppWebhookSourceSkip,
    resolveWhatsAppSourceByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
    updateSourceCredentials: updateWhatsAppSourceCredentials,
  });

const tryHandleWhatsAppGroupWebhook = createWhatsAppGroupWebhookHandler({
  buildWhatsAppWebhookSourceSkipPayload,
  getWhatsAppWebhookSourceSkip,
  invalidateRequestsForWorkspace: cache.invalidateRequestsForWorkspace,
  realtime: workerRealtime,
  resolveWhatsAppSourceByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
  upsertWhatsAppGroupEvent,
  upsertWhatsAppGroupState,
});

const tryHandleWhatsAppCallWebhook = createWhatsAppCallWebhookHandler({
  buildWhatsAppWebhookSourceSkipPayload,
  emitConversationCallUpdatedRealtimeEvent:
    emitWorkerConversationCallUpdatedRealtimeEvent,
  getWhatsAppWebhookSourceSkip,
  linkWhatsAppCallSessionToConversation,
  persistWhatsAppCallEvent,
  resolveWhatsAppSourceByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
  signalWithStartWhatsAppCallWorkflow:
    whatsappCallClient.signalWithStartWhatsAppCallWorkflow,
  upsertWhatsAppCallSessionFromEvent,
});

const templateLifecycleHandlers = createWhatsAppTemplateLifecycleHandlers({
  connectDB,
  patchTemplateCatalog: (params) =>
    templateMirror.patchWhatsAppTemplateCatalogState(params),
  createTemplateAudit: (params) => WhatsAppTemplateAuditLog.create(params),
  findTemplateSnapshot: async (filter) =>
    (await WhatsAppTemplateModel.findOne(filter)
      .select("_id components")
      .lean()
      .exec()) as { _id: unknown; components?: unknown } | null,
  logger: createLogger("whatsapp.template-lifecycle"),
  now: () => new Date(),
  publishWorkspaceAlert: workspaceAlerts.publishWorkspaceAlert,
  refreshTemplateMirrors: createTemplateMirrorRefresher({
    fetchTemplate: async (params) => ({
      ...(await templateMirror.fetchWhatsAppTemplateById(params)),
    }),
    logger: createLogger("whatsapp.template-lifecycle"),
    mirrorTemplate: (params) =>
      templateMirror.mirrorWhatsAppTemplate({
        supabase: supabaseAdminModule.supabaseAdmin,
        workspaceId: params.workspaceId,
        template: params.template as MirroredWhatsAppTemplate,
      }),
    readAccessToken: (credentials) =>
      whatsappCredentials.normalizeWhatsAppCredentials(credentials).accessToken,
    resolveWhatsAppSourcesByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourcesByAccountIdentifiers,
  }),
  resolveWhatsAppSourcesByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourcesByAccountIdentifiers,
  retirePendingCampaignTasks: async (params) => {
    const filter: Record<string, unknown> = {
      workspaceId: params.workspaceId,
      channel: "whatsapp",
      templateName: params.templateName,
      status: { $in: ["pending", "retry"] },
    };
    if (params.templateLanguage) {
      filter.templateLanguage = params.templateLanguage;
    }

    const now = new Date();
    const result = await CampaignDeliveryTaskModel.updateMany(filter, {
      $set: {
        status: "skipped",
        completedAt: now,
        skipReason: params.reason,
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        wakeCancelledAt: now,
      },
    });
    return result.modifiedCount || 0;
  },
  updateTemplateSnapshot: (params) =>
    WhatsAppTemplateModel.updateOne(params.filter, {
      $set: params.set,
    }),
});

const tryHandleWhatsAppLifecycleWebhook = createWhatsAppLifecycleWebhookHandler(
  {
    handleBusinessCapabilityUpdate,
    handlePhoneNumberQualityUpdate,
    handlePhoneNumberUsernameUpdate,
    handleTemplateCategoryUpdate:
      templateLifecycleHandlers.handleTemplateCategoryUpdate,
    handleTemplateComponentsUpdate:
      templateLifecycleHandlers.handleTemplateComponentsUpdate,
    handleTemplateQualityUpdate:
      templateLifecycleHandlers.handleTemplateQualityUpdate,
    handleTemplateStatusUpdate:
      templateLifecycleHandlers.handleTemplateStatusUpdate,
    mergeWhatsAppAccountHealthCredentials:
      accountHealth.mergeWhatsAppAccountHealthCredentials,
    resolveWhatsAppSourcesByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourcesByAccountIdentifiers,
    updateSourceCredentials: updateWhatsAppSourceCredentials,
  },
);

const tryHandleWhatsAppUserPreferencesWebhook =
  createWhatsAppUserPreferencesWebhookHandler({
    resolveWhatsAppSourceByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
    upsertWhatsAppMarketingConsent,
  });

const tryHandleWhatsAppEchoWebhook = createWhatsAppEchoWebhookHandler({
  buildWhatsAppWebhookSourceSkipPayload,
  decryptString: cryptoUtils.decryptString,
  findExistingWhatsAppMessageByExternalId,
  findMessageForRealtime: (messageId: unknown) =>
    MessageModel.findById(messageId).populate({
      path: "author",
      model: UserModel,
      select: "firstName isBot",
    }),
  getWhatsAppWebhookSourceSkip,
  getWhatsAppIntakePlanSkip: whatsappIntakePlanGate.getIntakeSkip,
  processWhatsAppMessage,
  realtimeTrigger: workerRealtime.trigger,
  resolveWhatsAppSourceByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
  shouldProcessEvenIfDuplicate,
  triggerConversationRealtime: triggerWorkerConversationRealtime,
  triggerWhatsAppReactionRealtimeUpdate:
    triggerWorkerWhatsAppReactionRealtimeUpdate,
});

const tryHandleWhatsAppHistoryWebhook = createWhatsAppHistoryWebhookHandler({
  buildWhatsAppWebhookSourceSkipPayload,
  decryptString: cryptoUtils.decryptString,
  getWhatsAppWebhookSourceSkip,
  getWhatsAppIntakePlanSkip: whatsappIntakePlanGate.getIntakeSkip,
  invalidateRequestsForWorkspace: cache.invalidateRequestsForWorkspace,
  processWhatsAppMessage,
  readLatestSourceCredentials: readLatestWhatsAppSourceCredentials,
  resolveWhatsAppSourceByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
  triggerConversationRealtime: triggerWorkerConversationRealtime,
  updateSourceCredentials: updateWhatsAppSourceCredentials,
});

const recordWhatsAppMessageDeliveryStatus =
  createRecordWhatsAppMessageDeliveryStatus({
    connectDB,
    findMessageByWhatsAppMessageId: async (params) => {
      const message = (await MessageModel.findOne({
        workspaceId: params.workspaceId,
        channel: "whatsapp",
        $or: [
          { messageId: params.messageId },
          { messageId: params.normalizedMessageId },
        ],
      })
        .select("_id conversation chat delivery")
        .lean()
        .exec()) as {
        _id: unknown;
        conversation?: unknown;
        chat?: unknown;
        delivery?: Record<string, unknown> | null;
      } | null;

      if (!message?._id) return null;
      return {
        _id: String(message._id),
        conversationId:
          message.conversation !== null && message.conversation !== undefined
            ? String(message.conversation)
            : null,
        chatId: message.chat ? String(message.chat) : null,
        delivery: message.delivery || null,
      };
    },
    refreshConversationEngagement: (params) =>
      engagement.refreshConversationEngagement(params.conversationId, {
        workspaceId: params.workspaceId,
        messageId: params.messageObjectId,
      }),
    updateMessageDelivery: async (params) => {
      const result = await MessageModel.updateOne(
        {
          _id: params.messageObjectId,
          "delivery.status": params.expectedStatus ?? null,
          "delivery.lastEventAt": params.expectedLastEventAt ?? null,
        },
        { $set: { ...params.update, engagementRefreshPending: true } },
      ).exec();
      return result.matchedCount === 1;
    },
    upsertDeliveryEvent: (params) =>
      MessageDeliveryEventModel.updateOne(
        {
          workspaceId: params.workspaceId,
          messageId: params.messageId,
          status: params.status,
          eventAt: params.eventAt,
        },
        {
          $setOnInsert: {
            customerWebhookIntent:
              customerWebhookIntents.buildCustomerStatusWebhookIntent(params) ||
              undefined,
          },
          $set: {
            workspaceId: params.workspaceId,
            messageId: params.messageId,
            channel: params.channel,
            status: params.status,
            eventAt: params.eventAt,
            recipientId: params.recipientId,
            recipientWaId: params.recipientWaId,
            recipientUserId: params.recipientUserId,
            recipientParentUserId: params.recipientParentUserId,
            recipientUsername: params.recipientUsername,
            recipientType: params.recipientType,
            recipientParticipantId: params.recipientParticipantId,
            campaignId: params.campaignId,
            phoneNumberId: params.phoneNumberId,
            sourceId: params.sourceId,
            conversationId: params.conversationId,
            messageObjectId: params.messageObjectId,
            pricing: params.pricing,
            conversation: params.conversation,
            errors: params.errors,
            rawStatus: params.rawStatus,
            providerStatus: params.providerStatus,
            pricingBillable: params.structured.pricingBillable,
            pricingCategory: params.structured.pricingCategory,
            pricingType: params.structured.pricingType,
            pricingModel: params.structured.pricingModel,
            conversationCategory: params.structured.conversationCategory,
            conversationProviderId: params.structured.conversationProviderId,
            conversationExpiresAt: params.structured.conversationExpiresAt,
            bizOpaqueCallbackData: params.bizOpaqueCallbackData,
            recipientIdentityKeyHash: params.recipientIdentityKeyHash,
            errorCode: params.errorCode,
            errorMessage: params.errorMessage,
          },
        },
        { upsert: true },
      ).exec(),
  });

const tryHandleWhatsAppStatusWebhook = createWhatsAppStatusWebhookHandler({
  buildWhatsAppWebhookSourceSkipPayload,
  findOpenWhatsAppConversationByChatId: async ({ chatId, workspaceId, sourceId }) => {
    const conversation = (await conversationModel.Conversation.findOne({
      chat: chatId,
      workspaceId,
      sourceId,
      status: "open",
      channel: "whatsapp",
    })
      .select("_id workspaceId")
      .maxTimeMS(10_000)
      .lean()) as { _id: unknown; workspaceId?: string | null } | null;
    return conversation
      ? {
          _id: conversation._id,
          workspaceId: conversation.workspaceId,
        }
      : null;
  },
  findOriginalMessageChatIdByMessageId: async (messageId: string) => {
    const originalMessage = (await MessageModel.findOne({
      messageId,
      channel: "whatsapp",
    })
      .select("chat")
      .lean()) as { chat?: unknown } | null;
    return originalMessage?.chat ? String(originalMessage.chat) : null;
  },
  getWhatsAppWebhookSourceSkip: (source) =>
    getWhatsAppWebhookSourceSkip(source as Source),
  persistCampaignMessageStatusWithOutbox:
    crossStoreOutbox.persistCampaignMessageStatusWithOutbox,
  recordCampaignTaskProviderAcceptance: createCampaignTaskProviderAcceptance({
    taskModel: CampaignDeliveryTaskModel,
    persistCampaignMessageSentWithOutbox:
      crossStoreOutbox.persistCampaignMessageSentWithOutbox,
  }),
  realtimeTrigger: workerRealtime.trigger,
  recordWhatsAppMessageDeliveryStatus,
  releaseCampaignContactSlot: customerContactPolicy.releaseCampaignContactSlot,
  resolveWhatsAppSourceByAccountIdentifiers:
    sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
  trackScenarioFlowReadByMessageId:
    scenarioFlowAnalytics.trackScenarioFlowReadByMessageId,
  updateChatWhatsAppUserId: async (params) =>
    ChatModel.updateOne(
      { _id: params.chatId, "whatsapp.userId": { $exists: false } },
      { $set: { "whatsapp.userId": params.userId } },
    ),
  updateUserWhatsAppUserId: async (params) =>
    UserModel.updateOne(
      { _id: params.chatId, "whatsapp.userId": { $exists: false } },
      { $set: { "whatsapp.userId": params.userId } },
    ),
});

export const whatsappWebhookRuntimeDependencies: WhatsAppWebhookRuntimeDependencies =
  {
    Chat: ChatModel,
    Conversation: conversationModel.Conversation,
    Message: MessageModel,
    User: UserModel,
    buildGroundedReplyOptionPayload:
      airiReplySelection.buildGroundedReplyOptionPayload,
    buildWhatsAppMessageRawSourcePayload,
    buildWhatsAppWebhookSourceSkipPayload,
    decryptString: cryptoUtils.decryptString,
    directIngressAiriConversation: (payload) =>
      airiDirectIngress.enqueueAiriConversationIngress(
        payload,
        scheduleWhatsAppOptionalWork,
      ),
    enqueueReferralEnrichment:
      crossStoreOutbox.enqueueWhatsAppReferralEnrichmentWithOutbox,
    enqueueMessageRealtime: async (input) => {
      // Always repair creation as well as a later recovered-content revision.
      const created = await realtimeServer.enqueueWhatsAppMessageRealtimeEvent({
        ...input,
        recoveryRevision: null,
      });
      const updated = input.recoveryRevision
        ? await realtimeServer.enqueueWhatsAppMessageRealtimeEvent(input)
        : null;
      scheduleWhatsAppOptionalWork(async () => {
        if (created) await realtimeServer.publishPendingRealtimeOutboxEvent(created);
        if (updated) await realtimeServer.publishPendingRealtimeOutboxEvent(updated);
      });
    },
    extractWhatsAppIdentifiersFromWebhookValue,
    findExistingWhatsAppMessageByExternalId,
    getWhatsAppLogIdentity,
    getWhatsAppPrimaryIdentifier,
    getWhatsAppWebhookSourceSkip,
    getWhatsAppIntakePlanSkip: whatsappIntakePlanGate.getIntakeSkip,
    handleAccountUpdateWebhook: accountUpdateHandler.handleAccountUpdateWebhook,
    handleUserChangedNumber: identityChange.handleUserChangedNumber,
    handleUserChangedUserId: identityChange.handleUserChangedUserId,
    invalidateRequestsForWorkspace: cache.invalidateRequestsForWorkspace,
    isWhatsAppAiriRuntimeEnabled,
    normalizeWhatsAppWebhookContact,
    parseWhatsAppLlmFeedbackPayload:
      llmWhatsAppFeedback.parseWhatsAppLlmFeedbackPayload,
    parseWhatsAppTimestamp,
    processWhatsAppMessage,
    realtime: workerRealtime,
    resolveWhatsAppConversationAutomationEnabled,
    resolveWhatsAppDisplayPhoneNumber,
    resolveWhatsAppInteractiveReplyTriggerEventKind:
      interactiveReplyEvent.resolveWhatsAppInteractiveReplyTriggerEventKind,
    resolveWhatsAppMessageContext,
    resolveWhatsAppSourceByAccountIdentifiers:
      sourceResolver.resolveWhatsAppSourceByAccountIdentifiers,
    enqueueWhatsAppLlmFeedbackReasonPrompt:
      crossStoreOutbox.enqueueWhatsAppLlmFeedbackReasonPromptWithOutbox,
    shouldProcessEvenIfDuplicate,
    shouldQueueWhatsAppAiriIngress,
    shouldSuppressGeneralWhatsAppAiriReply,
    supabaseAdmin: supabaseAdminModule.supabaseAdmin,
    trackScenarioFlowSubmitted:
      scenarioFlowAnalytics.trackScenarioFlowSubmitted,
    upsertWhatsAppLlmFeedbackReviewItem:
      llmWhatsAppFeedback.upsertWhatsAppLlmFeedbackReviewItem,
    triggerConversationRealtime: triggerWorkerConversationRealtime,
    triggerConversationReopened: webhookEvents.triggerConversationReopened,
    triggerWhatsAppReactionRealtimeUpdate:
      triggerWorkerWhatsAppReactionRealtimeUpdate,
    tryHandleWhatsAppCallWebhook,
    tryHandleWhatsAppContactSyncWebhook,
    tryHandleWhatsAppEchoWebhook,
    tryHandleWhatsAppGroupWebhook,
    tryHandleWhatsAppHistoryWebhook,
    tryHandleWhatsAppLifecycleWebhook,
    tryHandleWhatsAppStatusWebhook,
    tryHandleWhatsAppUserPreferencesWebhook,
  };
