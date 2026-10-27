import { CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS } from "@icecore/shared/lib/conversation-classification-freshness";

const mockCollections = {
  conversation: {
    createIndex: jest.fn(),
    dropIndex: jest.fn(),
    indexes: jest.fn(),
  },
  requestListItem: { createIndex: jest.fn() },
  conversationAnalysisRevision: { createIndex: jest.fn() },
  message: { createIndex: jest.fn(), indexes: jest.fn(), aggregate: jest.fn() },
  messageDeliveryEvent: { createIndex: jest.fn() },
  pendingMutation: { createIndex: jest.fn() },
  whatsappGroup: { createIndex: jest.fn() },
  whatsappGroupEvent: { createIndex: jest.fn() },
  scenarioFlowEvent: { createIndex: jest.fn(), indexes:jest.fn(), dropIndex:jest.fn() },
  scenarioFlowSuppression: { createIndex: jest.fn() },
  scenarioTriggerLog: { createIndex: jest.fn() },
  scenarioLinkedCondition: { createIndex: jest.fn() },
  customer: { createIndex: jest.fn() },
  airiArtifact: { createIndex: jest.fn() },
  airiArtifactVersion: { createIndex: jest.fn() },
  creativeAsset: { createIndex: jest.fn(), dropIndex: jest.fn() },
  videoGenerationNsfwVerdict: { createIndex: jest.fn() },
  crossStoreOutbox: {
    aggregate: jest.fn(),
    createIndex: jest.fn(),
    indexes: jest.fn(),
  },
  llmEvaluationReviewItem: {
    aggregate: jest.fn(),
    createIndex: jest.fn(),
    dropIndex: jest.fn(),
    indexes: jest.fn(),
  },
};
let mockCrossStoreOutboxDuplicateGroups: Array<Record<string, unknown>> = [];
let mockCrossStoreOutboxPersistIndexWrites = true;
let mockCrossStoreOutboxPersistedIndexes: Array<Record<string, unknown>> = [];
let mockLlmReviewDuplicateGroups: Array<Record<string, unknown>> = [];
let mockLlmReviewPersistIndexWrites = true;
let mockLlmReviewPersistedIndexes: Array<Record<string, unknown>> = [];
let mockFlowSubmissionPersistedIndexes:Array<Record<string,unknown>>=[];
let mockFlowSubmissionPersistWrites=true;
const mockEnsurePlatformCreativeGenerationQuotaIndexes = jest.fn();
let mockQueryIndexes: Record<string, Array<Record<string, unknown>>> = {};
let mockDeliveryKeyDuplicateGroups: Array<Record<string, unknown>> = [];
let mockQueryIndexPersistWrites = true;
const mockEnsureTikTokPlatformCredentialIndexes = jest.fn();
const mockEnsureRealtimeEventIndexes = jest.fn();
const mockEnsureScenarioObservabilityIndexes = jest.fn();
const mockEnsureConversationEngagementIndexes = jest.fn();
jest.mock("@/lib/engagement/conversation-engagement", () => ({
  ensureConversationEngagementIndexes: (...args: unknown[]) => mockEnsureConversationEngagementIndexes(...args),
}));
jest.mock("@/lib/scenarios/ensure-observability-indexes", () => ({
  ensureScenarioObservabilityIndexes: (...args: unknown[]) => mockEnsureScenarioObservabilityIndexes(...args),
}));
const mockWhatsAppFlowEndpointSecurityCreateIndexes = jest.fn();
const mockWhatsAppFlowProvisioningOperationCreateIndexes = jest.fn();
const mockWhatsAppFlowSessionCreateIndexes = jest.fn();
const mockWhatsAppFlowSourceBindingFenceCreateIndexes = jest.fn();
const mockEnsureWhatsAppQrEntryPointIndexes = jest.fn();
const mockWhatsAppQrCodeCreateIndexes = jest.fn();
const mockWhatsAppQrOperationCreateIndexes = jest.fn();
const mockAiriTurnContextCreateIndexes = jest.fn();
const mockAiriChatThreadCreateIndexes = jest.fn();
const mockAiriChatMessageCreateIndexes = jest.fn();
const mockAiriChatRunCreateIndexes = jest.fn();
const mockBusinessLocationCreateIndexes = jest.fn();
const mockCreativeVideoPlanCreateIndexes = jest.fn();
const mockBehaviorIndexes = jest.fn();
const mockAnalyticsIndexes = jest.fn();
jest.mock("@/models/analytics-acquisition", () => Object.fromEntries([
  "AnalyticsAcquisitionEntry", "AnalyticsAcquisitionMessageLink", "AnalyticsConversionFact",
  "AnalyticsCustomerPurchaseObservation", "AnalyticsAcquisitionCheckpoint", "AnalyticsAcquisitionDaily",
].map(name => [name, { createIndexes: () => mockAnalyticsIndexes(name) }])));
jest.mock("@/models/analytics-policy", () => ({ AnalyticsPolicy: { createIndexes: () => mockAnalyticsIndexes("AnalyticsPolicy") } }));
jest.mock("@/models/analytics-service-lifecycle", () => Object.fromEntries([
  "AnalyticsServiceLifecycleFact", "AnalyticsServiceLifecycleCheckpoint", "AnalyticsCustomerStageCheckpoint",
].map(name => [name, { createIndexes: () => mockAnalyticsIndexes(name) }])));
jest.mock("@/models/whatsapp-template-analytics-daily", () => ({ WhatsAppTemplateAnalyticsDaily: { createIndexes: () => mockAnalyticsIndexes("WhatsAppTemplateAnalyticsDaily") } }));
jest.mock("@/models/whatsapp-analytics-health-daily", () => ({ WhatsAppAnalyticsHealthDaily: { createIndexes: () => mockAnalyticsIndexes("WhatsAppAnalyticsHealthDaily") } }));
jest.mock("@/models/website-cart", () => ({ __esModule: true, default: { createIndexes: () => mockBehaviorIndexes("carts") } }));
jest.mock("@/models/website-commerce-settings", () => ({ __esModule: true, default: { createIndexes: () => mockBehaviorIndexes("commerce_settings") } }));
jest.mock("@/models/website-commerce-event", () => ({ __esModule: true, default: { createIndexes: () => mockBehaviorIndexes("commerce_events") } }));
jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: { createIndexes: () => mockBehaviorIndexes("events") },
}));
jest.mock("@/models/scenario-behavior-run", () => ({
  __esModule: true,
  default: { createIndexes: () => mockBehaviorIndexes("runs") },
}));
jest.mock("@/models/customer-contact-policy", () => ({
  __esModule: true,
  default: { createIndexes: () => mockBehaviorIndexes("policy") },
}));
jest.mock("@/models/customer-contact-reservation", () => ({
  __esModule: true,
  default: { createIndexes: () => mockBehaviorIndexes("reservations") },
}));
const mockScenarioCreateIndex = jest.fn();
const mockScenarioReadIndexes = jest.fn();
jest.mock("@/models/scenario", () => ({
  SCENARIO_LIST_ORDER_INDEX_KEYS: {
    workspaceId: 1,
    deletedAt: 1,
    priority: -1,
    _id: 1,
  },
  Scenario: {
    collection: {
      indexes: () => mockScenarioReadIndexes(),
      createIndex: (...args: unknown[]) =>
        mockScenarioCreateIndex(...args) ?? mockBehaviorIndexes("scenarios"),
    },
  },
}));

jest.mock("@/models/creative-video-plan", () => ({
  CreativeVideoPlan: {
    createIndexes: (...args: unknown[]) =>
      mockCreativeVideoPlanCreateIndexes(...args),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/lib/whatsapp/identity/indexes", () => ({
  ensureWhatsAppIdentityIndexes: jest.fn(async () => undefined),
}));

jest.mock("@/models/conversation", () => ({
  CONVERSATION_OFFLINE_EVAL_INDEX: jest.requireActual(
    "@/models/conversation"
  ).CONVERSATION_OFFLINE_EVAL_INDEX,
  ...jest.requireActual("@icecore/airi-runtime/whatsapp-conversation-ownership"),
  CONVERSATION_REQUESTS_DEPENDENCY_INDEXES: jest.requireActual(
    "@/models/conversation"
  ).CONVERSATION_REQUESTS_DEPENDENCY_INDEXES,
  CONVERSATION_VISIBILITY_GATE_INDEX_KEYS: {
    workspaceId: 1,
    createdAt: 1,
    _id: 1,
  },
  CONVERSATION_VISIBILITY_GATE_INDEX_NAME:
    "conversations_workspace_created_id_asc_v1",
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS: {
    "classification_state.status": 1,
    "classification_state.nextAttemptAt": 1,
    "classification_state.requestedAt": 1,
    _id: 1,
  },
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME:
    "conversations_classification_pending_due",
  CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER: {
    "classification_state.contractVersion": 2,
    "classification_state.status": { $in: ["pending", "blocked"] },
  },
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS: {
    "classification_state.status": 1,
    "classification_state.lease.expiresAt": 1,
    _id: 1,
  },
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME:
    "conversations_classification_processing_lease_expired",
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER: {
    "classification_state.contractVersion": 2,
    "classification_state.status": "processing",
  },
  CONVERSATION_CLASSIFICATION_QUEUE_LEGACY_INDEX_NAME:
    "conversations_unclassified_inbound_classification_queue",
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS: {
    workspaceId: 1,
    first_inbound_at: 1,
    first_response_seconds: 1,
  },
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME:
    "conversations_workspace_first_inbound_first_response",
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS: {
    workspaceId: 1,
    "airi_scenario_state.lockedScenarioId": 1,
    "airi_scenario_state.pendingConditionNodeId": 1,
    "airi_scenario_state.pendingSourceActionNodeId": 1,
  },
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME:
    "conversations_workspace_scenario_pending_wait_v2",
  CONVERSATION_SCENARIO_PENDING_WAIT_LEGACY_INDEX_NAME:
    "conversations_workspace_scenario_pending_wait",
  CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER: {
    "airi_scenario_state.lockedScenarioId": { $type: "string" },
    "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
  },
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS: {
    workspaceId: 1,
    channel: 1,
    sourceId: 1,
    chat: 1,
    updatedAt: -1,
  },
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME:
    "conversations_workspace_channel_source_chat_updated_desc",
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS: {
    workspaceId: 1,
    channel: 1,
    sourceId: 1,
    user: 1,
    updatedAt: -1,
  },
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME:
    "conversations_workspace_channel_source_user_updated_desc",
  CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_KEYS: {
    workspaceId: 1,
    channel: 1,
    sourceId: 1,
    "whatsappGroup.groupId": 1,
    updatedAt: -1,
  },
  CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_NAME:
    "conversations_workspace_channel_source_group_updated_desc",
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS: {
    workspaceId: 1,
    channel: 1,
    "external_thread.referral.adId": 1,
    lastMessageAt: -1,
  },
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME:
    "conversations_workspace_channel_instagram_referral_ad_last_message",
  CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER: {
    "external_thread.referral.adId": { $type: "string" },
  },
  Conversation: { collection: mockCollections.conversation },
}));

jest.mock("@/models/request-list-item", () => {
  const actual = jest.requireActual("@/models/request-list-item");
  return {
    ...actual,
    RequestListItem: { collection: mockCollections.requestListItem },
  };
});

jest.mock("@/models/conversation-analysis-revision", () => ({
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_KEYS: {
    "effects.status": 1,
    "effects.nextAttemptAt": 1,
    completedAt: 1,
    _id: 1,
  },
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME:
    "conversation_analysis_revisions_effects_due",
  ANALYSIS_REVISION_DUE_EFFECTS_PARTIAL_FILTER: {
    "effects.status": { $in: ["pending", "failed"] },
  },
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_KEYS: {
    "effects.status": 1,
    "effects.lease.expiresAt": 1,
    completedAt: 1,
    _id: 1,
  },
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME:
    "conversation_analysis_revisions_effects_processing_expired",
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_PARTIAL_FILTER: {
    "effects.status": "processing",
  },
  ConversationAnalysisRevision: {
    collection: mockCollections.conversationAnalysisRevision,
  },
}));

jest.mock("@/models/message", () => ({
  MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX:
    jest.requireActual("@/models/message").MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX,
  MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX:
    jest.requireActual("@/models/message")
      .MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX,
  MESSAGE_AIRI_INGRESS_PENDING_INDEX: {
    keys: { "airiIngressIntent.ingressNextRetryAt": 1, _id: 1 },
    options: {
      name: "message_airi_ingress_pending",
      partialFilterExpression: {
        "airiIngressIntent.ingressKey": { $type: "string" },
      },
    },
  },
  __esModule: true,
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS: {
    conversation: 1,
    direction: 1,
    "origin.kind": 1,
    _id: -1,
  },
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME:
    "messages_conversation_direction_origin_id_desc_v1",
  MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS: {
    workspaceId: 1,
    direction: 1,
    date: -1,
  },
  default: { collection: mockCollections.message },
}));

jest.mock("@/models/message-delivery-event", () => ({
  __esModule: true,
  default: { collection: mockCollections.messageDeliveryEvent },
}));

jest.mock("@/models/realtime-event", () => ({
  ensureRealtimeEventIndexes: (...args: unknown[]) =>
    mockEnsureRealtimeEventIndexes(...args),
}));

jest.mock("@/models/whatsapp-pending-message-mutation", () => ({
  __esModule: true,
  default: { collection: mockCollections.pendingMutation },
}));

jest.mock("@/models/whatsapp-group", () => ({
  __esModule: true,
  default: { collection: mockCollections.whatsappGroup },
}));

jest.mock("@/models/whatsapp-group-event", () => ({
  __esModule: true,
  default: { collection: mockCollections.whatsappGroupEvent },
}));

jest.mock("@/models/scenario-flow-event", () => ({
  ...jest.requireActual("@/models/scenario-flow-event"),
  ScenarioFlowEvent: { collection: mockCollections.scenarioFlowEvent },
}));

jest.mock("@/models/scenario-flow-suppression", () => ({
  ScenarioFlowSuppression: {
    collection: mockCollections.scenarioFlowSuppression,
  },
}));

jest.mock("@/models/scenario-trigger-log", () => ({
  ScenarioTriggerLog: { collection: mockCollections.scenarioTriggerLog },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: { collection: mockCollections.scenarioLinkedCondition },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  CUSTOMER_CONTACT_PHONE_INDEX_KEYS: {
    workspaceId: 1,
    status: 1,
    "profileSummary.contactPoints.phones": 1,
  },
  CUSTOMER_CONTACT_PHONE_INDEX_NAME: "customers_workspace_status_contact_phone",
  CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS: {
    workspaceId: 1,
    "identities.type": 1,
    "identities.normalizedValue": 1,
  },
  CUSTOMER_CRM_STAGE_INDEX_KEYS: { workspaceId: 1, crm_stage: 1 },
  CUSTOMER_CRM_STAGE_INDEX_NAME: "customers_workspace_crm_stage",
  CUSTOMER_OWNER_INDEX_KEYS: {
    workspaceId: 1,
    ownerUserId: 1,
    lastInteractionAt: -1,
  },
  CUSTOMER_OWNER_INDEX_NAME: "customers_workspace_owner_recent",
  CUSTOMER_OWNER_INDEX_OPTIONS: {
    name: "customers_workspace_owner_recent",
    background: true,
    partialFilterExpression: { ownerUserId: { $type: "string" } },
  },
  default: { collection: mockCollections.customer },
}));

jest.mock("@/models/airi-artifact", () => ({
  AiriArtifact: { collection: mockCollections.airiArtifact },
  AiriArtifactVersion: { collection: mockCollections.airiArtifactVersion },
}));

jest.mock("@/models/creative-asset", () => ({
  CREATIVE_ASSET_PLATFORM_QUOTA_INDEX: {
    key: {
      workspaceId: 1,
      "generation.recoveryMode": 1,
      provider: 1,
      status: 1,
      providerSourceId: 1,
    },
    options: {
      name: "workspace_platform_creative_generation_quota_v2",
      partialFilterExpression: {
        provider: { $in: ["google", "elevenlabs"] },
        status: { $in: ["queued", "in_progress", "complete", "nsfw"] },
      },
    },
  },
  CREATIVE_ASSET_PLATFORM_QUOTA_LEGACY_INDEX_NAME:
    "workspace_platform_creative_generation_quota",
  CREATIVE_ASSET_VIDEO_IDEMPOTENCY_INDEX: {
    key: { workspaceId: 1, "generation.requestIdempotencyKey": 1 },
    options: {
      name: "workspace_video_generation_idempotency",
      unique: true,
      partialFilterExpression: {
        "generation.requestIdempotencyKey": { $type: "string" },
      },
    },
  },
  CREATIVE_ASSET_VIDEO_SAFETY_ALIAS_INDEX: {
    key: {
      workspaceId: 1,
      "generation.safetyProviderRequestIds": 1,
    },
    options: {
      name: "workspace_video_generation_safety_alias",
      partialFilterExpression: {
        "generation.contractVersion": 1,
        "generation.spec.provider": "higgsfield",
        "generation.safetyProviderRequestIds": { $exists: true },
      },
    },
  },
  CREATIVE_ASSET_VIDEO_SAFETY_ANCESTOR_INDEX: {
    key: {
      workspaceId: 1,
      "generation.safetyAncestors.assetId": 1,
      "generation.safetyAncestors.attemptToken": 1,
    },
    options: {
      name: "workspace_video_generation_safety_ancestor",
      partialFilterExpression: {
        "generation.contractVersion": 1,
        "generation.spec.provider": "higgsfield",
        "generation.safetyAncestors": { $exists: true },
      },
    },
  },
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_INDEX: {
    key: { "generation.orchestration.state": 1, updatedAt: 1, _id: 1 },
    options: {
      name: "video_generation_orchestration_reconcile_v2",
      partialFilterExpression: {
        status: { $in: ["queued", "in_progress"] },
        "generation.contractVersion": 1,
        "generation.orchestration.state": {
          $in: ["pending", "unknown", "started"],
        },
      },
    },
  },
  CREATIVE_ASSET_VIDEO_ORCHESTRATION_LEGACY_INDEX_NAME:
    "video_generation_orchestration_reconcile",
  CREATIVE_ASSET_VIDEO_NSFW_CLEANUP_INDEX: {
    key: { updatedAt: 1, _id: 1 },
    options: {
      name: "video_generation_nsfw_storage_cleanup",
      partialFilterExpression: {
        kind: "video",
        status: "nsfw",
        storageProvider: "gcs",
        workspaceId: { $type: "string" },
        bucket: { $type: "string" },
        path: { $type: "string" },
        "generation.contractVersion": 1,
        "generation.submission.attemptToken": { $type: "string" },
      },
    },
  },
  CreativeAsset: { collection: mockCollections.creativeAsset },
}));

jest.mock("@/models/video-generation-nsfw-verdict", () => ({
  VideoGenerationNsfwVerdict: {
    collection: mockCollections.videoGenerationNsfwVerdict,
  },
  VIDEO_GENERATION_NSFW_VERDICT_SOURCE_INDEX: {
    key: {
      workspaceId: 1,
      provider: 1,
      sourceAssetId: 1,
      sourceAttemptToken: 1,
    },
    options: { name: "workspace_video_nsfw_source_attempt" },
  },
  VIDEO_GENERATION_NSFW_VERDICT_PENDING_SWEEP_INDEX: {
    key: {
      sweepCompletedAt: 1,
      firstReceivedAt: 1,
      _id: 1,
    },
    options: {
      name: "video_generation_nsfw_pending_sweep",
      partialFilterExpression: {
        sweepCompletedAt: null,
      },
    },
  },
}));

jest.mock("@/models/platform-creative-generation-quota-claim", () => ({
  ensurePlatformCreativeGenerationQuotaIndexes:
    mockEnsurePlatformCreativeGenerationQuotaIndexes,
}));

jest.mock("@/models/tiktok-platform-credential", () => ({
  ensureTikTokPlatformCredentialIndexes:
    mockEnsureTikTokPlatformCredentialIndexes,
}));

jest.mock("@/models/whatsapp-flow-endpoint-security", () => ({
  WhatsAppFlowEndpointSecurity: {
    createIndexes: mockWhatsAppFlowEndpointSecurityCreateIndexes,
  },
}));

jest.mock("@/models/whatsapp-flow-provisioning-operation", () => ({
  WhatsAppFlowProvisioningOperation: {
    createIndexes: mockWhatsAppFlowProvisioningOperationCreateIndexes,
  },
}));

jest.mock("@/models/whatsapp-flow-session", () => ({
  WhatsAppFlowSession: {
    createIndexes: mockWhatsAppFlowSessionCreateIndexes,
  },
}));

jest.mock("@/models/whatsapp-flow-source-binding-fence", () => ({
  WhatsAppFlowSourceBindingFence: {
    createIndexes: mockWhatsAppFlowSourceBindingFenceCreateIndexes,
  },
}));

jest.mock("@/lib/whatsapp/qr-entry-points/indexes", () => ({
  ensureWhatsAppQrEntryPointIndexes: mockEnsureWhatsAppQrEntryPointIndexes,
}));

jest.mock("@/models/whatsapp-qr-code", () => ({
  WhatsAppQrCode: { createIndexes: mockWhatsAppQrCodeCreateIndexes },
}));

jest.mock("@/models/whatsapp-qr-operation", () => ({
  WhatsAppQrOperation: { createIndexes: mockWhatsAppQrOperationCreateIndexes },
}));

jest.mock("@/models/airi-turn-context", () => ({
  __esModule: true,
  default: { createIndexes: mockAiriTurnContextCreateIndexes },
}));
jest.mock("@/models/airi-chat-thread", () => ({
  AiriChatThread: { createIndexes: mockAiriChatThreadCreateIndexes },
}));
jest.mock("@/models/airi-chat-message", () => ({
  AiriChatMessage: { createIndexes: mockAiriChatMessageCreateIndexes },
}));
jest.mock("@/models/airi-chat-run", () => ({
  AiriChatRun: { createIndexes: mockAiriChatRunCreateIndexes },
}));
jest.mock("@/models/business-location", () => ({
  BusinessLocation: { createIndexes: mockBusinessLocationCreateIndexes },
}));

jest.mock("@/models/cross-store-outbox", () => {
  const actual = jest.requireActual("@/models/cross-store-outbox");
  return {
    ...actual,
    __esModule: true,
    default: { collection: mockCollections.crossStoreOutbox },
  };
});

jest.mock("@/models/llm-evaluation-review-item", () => {
  const actual = jest.requireActual("@/models/llm-evaluation-review-item");
  return {
    ...actual,
    __esModule: true,
    default: { collection: mockCollections.llmEvaluationReviewItem },
  };
});

describe("ensureIndexes", () => {
  beforeEach(() => {
    delete (globalThis as typeof globalThis & { __mongoIndexCache?: unknown })
      .__mongoIndexCache;
    mockEnsureScenarioObservabilityIndexes.mockReset();
    mockEnsureScenarioObservabilityIndexes.mockResolvedValue(undefined);
    mockEnsureConversationEngagementIndexes.mockReset();
    mockEnsureConversationEngagementIndexes.mockResolvedValue(undefined);
    mockAnalyticsIndexes.mockReset();
    mockAnalyticsIndexes.mockResolvedValue(undefined);
    mockFlowSubmissionPersistedIndexes=[{ name:"_id_", key:{ _id:1 } }];
    mockFlowSubmissionPersistWrites=true;
    for (const collection of Object.values(mockCollections)) {
      collection.createIndex.mockClear();
      collection.createIndex.mockResolvedValue("ok");
    }
    mockDeliveryKeyDuplicateGroups = [];
    mockQueryIndexPersistWrites = true;
    mockQueryIndexes = { message: [], conversation: [] };
    mockScenarioReadIndexes.mockReset().mockResolvedValue([]);
    for (const name of ["message", "conversation"] as const) {
      mockCollections[name].indexes
        .mockReset()
        .mockImplementation(async () => mockQueryIndexes[name]);
      mockCollections[name].createIndex.mockImplementation(
        async (key, options) => {
          if (options?.name && mockQueryIndexPersistWrites) {
            mockQueryIndexes[name].push({ key, ...options });
          }
          return options?.name || "ok";
        }
      );
    }
    mockCollections.message.aggregate.mockReset().mockImplementation(() => ({
      toArray: async () => mockDeliveryKeyDuplicateGroups,
    }));
    mockCollections.scenarioFlowEvent.indexes.mockReset();
    mockCollections.scenarioFlowEvent.indexes.mockImplementation(async()=>mockFlowSubmissionPersistedIndexes);
    mockCollections.scenarioFlowEvent.createIndex.mockImplementation(async(key,options)=>{
      if (options?.name && mockFlowSubmissionPersistWrites && !mockFlowSubmissionPersistedIndexes.some(index=>index.name === options.name)) mockFlowSubmissionPersistedIndexes.push({ name:options.name, key, ...options });
      return options?.name || "ok";
    });
    mockCollections.scenarioFlowEvent.dropIndex.mockReset();
    mockCollections.scenarioFlowEvent.dropIndex.mockImplementation(
      async name => {
        mockFlowSubmissionPersistedIndexes =
          mockFlowSubmissionPersistedIndexes.filter(
            index => index.name !== name
          );
      }
    );
    mockCrossStoreOutboxDuplicateGroups = [];
    mockCrossStoreOutboxPersistIndexWrites = true;
    mockCrossStoreOutboxPersistedIndexes = [{ name: "_id_", key: { _id: 1 } }];
    mockCollections.crossStoreOutbox.aggregate.mockClear();
    mockCollections.crossStoreOutbox.aggregate.mockImplementation(() => ({
      toArray: async () => mockCrossStoreOutboxDuplicateGroups,
    }));
    mockCollections.crossStoreOutbox.indexes.mockClear();
    mockCollections.crossStoreOutbox.indexes.mockImplementation(
      async () => mockCrossStoreOutboxPersistedIndexes
    );
    mockCollections.crossStoreOutbox.createIndex.mockImplementation(
      async (
        key: Record<string, number>,
        options: {
          expireAfterSeconds?: number;
          name: string;
          partialFilterExpression?: Record<string, unknown>;
          unique?: boolean;
        }
      ) => {
        if (mockCrossStoreOutboxPersistIndexWrites) {
          mockCrossStoreOutboxPersistedIndexes.push({
            name: options.name,
            key,
            ...(options.expireAfterSeconds !== undefined
              ? { expireAfterSeconds: options.expireAfterSeconds }
              : {}),
            ...(options.partialFilterExpression
              ? { partialFilterExpression: options.partialFilterExpression }
              : {}),
            ...(options.unique ? { unique: true } : {}),
          });
        }
        return options.name;
      }
    );
    mockLlmReviewDuplicateGroups = [];
    mockLlmReviewPersistIndexWrites = true;
    mockLlmReviewPersistedIndexes = [{ name: "_id_", key: { _id: 1 } }];
    mockCollections.llmEvaluationReviewItem.aggregate.mockClear();
    mockCollections.llmEvaluationReviewItem.aggregate.mockImplementation(
      () => ({
        toArray: async () => mockLlmReviewDuplicateGroups,
      })
    );
    mockCollections.llmEvaluationReviewItem.indexes.mockClear();
    mockCollections.llmEvaluationReviewItem.indexes.mockImplementation(
      async () => mockLlmReviewPersistedIndexes
    );
    mockCollections.llmEvaluationReviewItem.createIndex.mockImplementation(
      async (
        key: Record<string, number>,
        options: {
          name: string;
          partialFilterExpression?: Record<string, unknown>;
          unique?: boolean;
        }
      ) => {
        if (mockLlmReviewPersistIndexWrites) {
          mockLlmReviewPersistedIndexes.push({
            name: options.name,
            key,
            ...(options.partialFilterExpression
              ? { partialFilterExpression: options.partialFilterExpression }
              : {}),
            ...(options.unique ? { unique: true } : {}),
          });
        }
        return options.name;
      }
    );
    mockCollections.llmEvaluationReviewItem.dropIndex.mockClear();
    mockCollections.llmEvaluationReviewItem.dropIndex.mockImplementation(
      async (name: string) => {
        mockLlmReviewPersistedIndexes = mockLlmReviewPersistedIndexes.filter(
          index => index.name !== name
        );
      }
    );
    mockCollections.conversation.dropIndex.mockClear();
    mockCollections.conversation.dropIndex.mockResolvedValue(undefined);
    mockCollections.creativeAsset.dropIndex.mockClear();
    mockCollections.creativeAsset.dropIndex.mockResolvedValue(undefined);
    mockEnsurePlatformCreativeGenerationQuotaIndexes.mockClear();
    mockEnsurePlatformCreativeGenerationQuotaIndexes.mockResolvedValue(
      undefined
    );
    mockEnsureTikTokPlatformCredentialIndexes.mockClear();
    mockEnsureTikTokPlatformCredentialIndexes.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockClear();
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    for (const createIndexes of [
      mockWhatsAppFlowEndpointSecurityCreateIndexes,
      mockWhatsAppFlowProvisioningOperationCreateIndexes,
      mockWhatsAppFlowSourceBindingFenceCreateIndexes,
      mockWhatsAppFlowSessionCreateIndexes,
      mockEnsureWhatsAppQrEntryPointIndexes,
      mockWhatsAppQrCodeCreateIndexes,
      mockWhatsAppQrOperationCreateIndexes,
      mockAiriTurnContextCreateIndexes,
      mockAiriChatThreadCreateIndexes,
      mockAiriChatMessageCreateIndexes,
      mockAiriChatRunCreateIndexes,
      mockBusinessLocationCreateIndexes,
      mockCreativeVideoPlanCreateIndexes,
    ]) {
      createIndexes.mockClear();
      createIndexes.mockResolvedValue(undefined);
    }
  });

  it("provisions and verifies delivery ownership and dependency fanout indexes", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      expect(mockQueryIndexes.message).toContainEqual(
        expect.objectContaining({
          key: { temporalDeliveryKey: 1 },
          name: "messages_temporal_delivery_key_unique_v1",
          unique: true,
          partialFilterExpression: { temporalDeliveryKey: { $type: "string" } },
        })
      );
      for (const field of ["user", "chat"]) {
        expect(mockQueryIndexes.conversation).toContainEqual(
          expect.objectContaining({
            key: { [field]: 1, _id: 1 },
            name: `conversations_requests_${field}_id_v1`,
          })
        );
      }
      expect(mockCollections.message.aggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          { $match: { temporalDeliveryKey: { $type: "string" } } },
        ]),
        expect.objectContaining({ maxTimeMS: 60_000 })
      );
    });
  });

  it("provisions the partial offline evaluation index through the narrow query repair", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureMongoQueryIndexes } = await import("./mongo");
      await ensureMongoQueryIndexes();
      expect(mockQueryIndexes.conversation).toContainEqual(expect.objectContaining({
        key: { createdAt: 1 },
        name: "conversations_offline_eval_created_v1",
        partialFilterExpression: {
          "classification.category": { $exists: true },
          "shadow_classification.category": { $exists: true },
        },
      }));
    });
  });

  it("rejects a drifted offline evaluation index without replacing it", async () => {
    mockQueryIndexes.conversation = [{
      key: { createdAt: 1 },
      name: "conversations_offline_eval_created_v1",
      partialFilterExpression: { "classification.category": { $exists: true } },
    }];
    await jest.isolateModulesAsync(async () => {
      const { ensureMongoQueryIndexes } = await import("./mongo");
      await expect(ensureMongoQueryIndexes()).rejects.toThrow("Offline evaluation index verification failed");
      expect(mockCollections.conversation.dropIndex).not.toHaveBeenCalled();
    });
  });

  it("refuses duplicate delivery keys before index creation without printing keys", async () => {
    mockDeliveryKeyDuplicateGroups = [
      { _id: "private-delivery-key", duplicateCount: 2 },
    ];
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow(
        "Temporal delivery-key unique index preflight"
      );
      expect(mockCollections.message.createIndex).not.toHaveBeenCalled();
      mockDeliveryKeyDuplicateGroups = [];
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it.each([
    { hidden: true },
    { sparse: true },
    { unique: false },
    { collation: { locale: "en" } },
  ])(
    "refuses drifted delivery index options %j without caching success",
    async drift => {
      const correct = {
        name: "messages_temporal_delivery_key_unique_v1",
        key: { temporalDeliveryKey: 1 },
        unique: true,
        partialFilterExpression: { temporalDeliveryKey: { $type: "string" } },
      };
      mockQueryIndexes.message = [{ ...correct, ...drift }];
      await jest.isolateModulesAsync(async () => {
        const { ensureIndexes } = await import("./mongo");
        await expect(ensureIndexes()).rejects.toThrow(
          "Temporal delivery-key index verification failed"
        );
        mockQueryIndexes.message = [correct];
        await expect(ensureIndexes()).resolves.toBeUndefined();
        expect(mockCollections.message.aggregate).not.toHaveBeenCalled();
      });
    }
  );

  it("rejects acknowledged query index writes whose stored definitions are absent", async () => {
    mockQueryIndexPersistWrites = false;
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow(
        "index verification failed after reconciliation"
      );
      mockQueryIndexPersistWrites = true;
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("provisions scenario retention and retries a rejected TTL repair", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      mockEnsureScenarioObservabilityIndexes.mockRejectedValueOnce(new Error("TTL repair denied"));
      await expect(ensureIndexes()).rejects.toThrow("TTL repair denied");
      await ensureIndexes();
      expect(mockEnsureScenarioObservabilityIndexes).toHaveBeenCalledTimes(2);
    });
  });

  it("provisions engagement indexes and retries a rejected build", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      mockEnsureConversationEngagementIndexes.mockRejectedValueOnce(new Error("Engagement index denied"));
      await expect(ensureIndexes()).rejects.toThrow("Engagement index denied");
      await ensureIndexes();
      expect(mockEnsureConversationEngagementIndexes).toHaveBeenCalledTimes(2);
    });
  });

  it("stops provisioning indexes retired after the zero-use review", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      const messageKeys = mockCollections.message.createIndex.mock.calls.map(
        ([key]) => JSON.stringify(key)
      );
      for (const retired of [
        { workspaceId: 1, text: 1 },
        { workspaceId: 1, text: 1, conversation: 1 },
        { workspaceId: 1, date: -1, conversation: 1 },
        { workspaceId: 1, channel: 1, date: -1, conversation: 1 },
        { workspaceId: 1, channel: 1, "whatsappGroup.groupId": 1, date: -1 },
        { workspaceId: 1, "mediaAnalysis.workflowId": 1 },
        {
          "rawSourcePayload.provider": 1,
          "rawSourcePayload.payload.type": 1,
          createdAt: -1,
        },
      ])
        expect(messageKeys).not.toContain(JSON.stringify(retired));
      expect(
        mockCollections.scenarioTriggerLog.createIndex.mock.calls.map(
          ([key]) => JSON.stringify(key)
        )
      ).not.toContain(JSON.stringify({ workspaceId: 1, evaluationId: 1 }));
    });
  });

  it("stops provisioning conversation indexes retired after the 2026-10-20 review", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      const conversationKeys =
        mockCollections.conversation.createIndex.mock.calls.map(([key]) =>
          JSON.stringify(key)
        );
      for (const retired of [
        { workspaceId: 1, rename: 1 },
        { workspaceId: 1, channel: 1, subject: 1, createdAt: -1 },
        { workspaceId: 1, "engagement_metrics.score": -1, lastMessageAt: -1 },
        {
          workspaceId: 1,
          channel: 1,
          "engagement_metrics.score": -1,
          lastMessageAt: -1,
        },
        {
          workspaceId: 1,
          channel: 1,
          "classification.category": 1,
          "whatsapp_opt_in.status": 1,
          lastMessageAt: -1,
        },
        { workspaceId: 1, channel: 1, "whatsapp_opt_in.status": 1 },
        { workspaceId: 1, channel: 1, internal_labels: 1, lastMessageAt: -1 },
        { workspaceId: 1, channel: 1, page_url: 1 },
        { workspaceId: 1, channel: 1, visitor_id: 1 },
        { workspaceId: 1, channel: 1, last_outbound_at: -1 },
        { customerId: 1 },
        { sourceId: 1 },
        { workspaceId: 1, churn_risk_level: 1, lastMessageAt: -1 },
        { workspaceId: 1, "whatsappReferral.ctwaClid": 1 },
        { workspaceId: 1, first_response_manager_id: 1, first_inbound_at: 1 },
        { workspaceId: 1, chat: 1, lastMessageAt: -1 },
        { workspaceId: 1, "external_thread.provider": 1 },
        { workspaceId: 1, handled_by_agent_id: 1 },
        { workspaceId: 1, "followUpAudience.analyzedAt": -1, lastMessageAt: -1 },
        { workspaceId: 1, "followUpAudience.effectiveCategoryKey": 1 },
        { workspaceId: 1, channel: 1, "followUpAudience.status": 1 },
      ])
        expect(conversationKeys).not.toContain(JSON.stringify(retired));
      for (const kept of [
        { workspaceId: 1, is_read_by_manager: 1, lastMessageAt: -1 },
        { workspaceId: 1, "classification.category": 1 },
        { workspaceId: 1, user: 1, lastMessageAt: -1 },
      ])
        expect(conversationKeys).toContain(JSON.stringify(kept));
    });
  });

  it("owns the used channel/date and cross-workspace direction/date indexes", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, channel: 1, date: -1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { direction: 1, date: -1 },
        { background: true }
      );
    });
  });

  it("builds the scenario list index next to the existing scenario index", async () => {
    await jest.isolateModulesAsync(async () => {
      mockScenarioCreateIndex.mockClear();
      const { ensureIndexes } = await import("./mongo");

      await ensureIndexes();

      expect(mockScenarioCreateIndex.mock.calls).toEqual([
        [
          {
            workspaceId: 1,
            status: 1,
            "nodes.data.triggerConfig.entryPointType": 1,
            _id: 1,
          },
        ],
        // No options: the server's default name matches the schema index.
        [{ workspaceId: 1, deletedAt: 1, priority: -1, _id: 1 }],
      ]);
    });
  });
  it("provisions analytics identity and independent source cursors through the production index gate", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      expect(mockAnalyticsIndexes.mock.calls.map(([name]) => name)).toEqual([
        "WhatsAppTemplateAnalyticsDaily", "WhatsAppAnalyticsHealthDaily",
        "AnalyticsAcquisitionEntry", "AnalyticsAcquisitionMessageLink", "AnalyticsConversionFact",
        "AnalyticsCustomerPurchaseObservation", "AnalyticsAcquisitionCheckpoint", "AnalyticsAcquisitionDaily",
        "AnalyticsPolicy", "AnalyticsServiceLifecycleFact", "AnalyticsServiceLifecycleCheckpoint", "AnalyticsCustomerStageCheckpoint",
      ]);
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith({ workspaceId:1, _id:1 });
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith({ workspaceId:1, _id:1 });
      expect(mockCollections.customer.createIndex).toHaveBeenCalledWith({ workspaceId:1, _id:1 });
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith({ workspaceId:1, conversation:1, date:1 });
      await ensureIndexes();
      expect(mockAnalyticsIndexes).toHaveBeenCalledTimes(12);
    });
  });
  it("fails closed and retries when an acquisition identity index cannot deploy", async () => {
    await jest.isolateModulesAsync(async () => {
      let failed = false;
      mockAnalyticsIndexes.mockImplementation(async name => {
        if (name === "AnalyticsAcquisitionMessageLink" && !failed) { failed=true; throw new Error("acquisition identity index unavailable"); }
      });
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("acquisition identity index unavailable");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });
  it("verifies both Flow submission identities before removing the legacy token fence", async () => {
    await jest.isolateModulesAsync(async()=>{
      const model=jest.requireActual("@/models/scenario-flow-event");
      mockFlowSubmissionPersistedIndexes.push({ name:model.SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME, key:model.SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS, unique:true, partialFilterExpression:{ flowToken:{ $type:"string" }, eventType:"submitted" } });
      const originalDrop=mockCollections.scenarioFlowEvent.dropIndex.getMockImplementation()!;
      mockCollections.scenarioFlowEvent.dropIndex.mockImplementation(async name=>{
        expect(mockFlowSubmissionPersistedIndexes.some(index=>index.name === model.SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_NAME)).toBe(true);
        expect(mockFlowSubmissionPersistedIndexes.some(index=>index.name === model.SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_NAME)).toBe(true);
        return originalDrop(name);
      });
      const { ensureIndexes }=await import("./mongo");
      await ensureIndexes();
      expect(mockCollections.scenarioFlowEvent.dropIndex).toHaveBeenCalledWith(model.SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME);
    });
  });
  it("keeps the legacy Flow fence when replacement identity indexes cannot be verified", async()=>{
    await jest.isolateModulesAsync(async()=>{
      const model=jest.requireActual("@/models/scenario-flow-event");
      mockFlowSubmissionPersistedIndexes.push({ name:model.SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME, key:model.SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS, unique:true, partialFilterExpression:{ flowToken:{ $type:"string" }, eventType:"submitted" } });
      mockFlowSubmissionPersistWrites=false;
      const { ensureIndexes }=await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("Flow submission replacement indexes not verified");
      expect(mockCollections.scenarioFlowEvent.dropIndex).not.toHaveBeenCalled();
    });
  });
  it("refuses to remove an unknown Flow legacy index definition", async()=>{
    await jest.isolateModulesAsync(async()=>{
      const model=jest.requireActual("@/models/scenario-flow-event");
      mockFlowSubmissionPersistedIndexes.push({ name:model.SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME, key:{ workspaceId:1 }, unique:true });
      const { ensureIndexes }=await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("Unknown Flow submission legacy index definition");
      expect(mockCollections.scenarioFlowEvent.dropIndex).not.toHaveBeenCalled();
    });
  });

  it("keeps an existing scenario list index under another name and carries on", async () => {
    mockScenarioReadIndexes.mockResolvedValue([{
      name: "custom_scenario_list",
      key: { workspaceId: 1, deletedAt: 1, priority: -1, _id: 1 },
    }]);
    mockScenarioCreateIndex.mockReset();
    mockScenarioCreateIndex.mockImplementation((keys: { deletedAt?: 1 }) =>
      keys.deletedAt === 1
        ? Promise.reject({ code: 85, codeName: "IndexOptionsConflict" })
        : undefined
    );

    mockCollections.conversation.createIndex.mockClear();
    try {
      await jest.isolateModulesAsync(async () => {
        const { ensureIndexes } = await import("./mongo");
        await expect(ensureIndexes()).resolves.toBeUndefined();
      });
      // A conversation index built after the scenario list step proves it carried on.
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "conversations_workspace_created_id_asc_v1",
        })
      );
    } finally {
      mockScenarioCreateIndex.mockReset();
    }
  });

  it("does not hide any other failure to build the scenario list index", async () => {
    mockScenarioCreateIndex.mockReset();
    mockScenarioCreateIndex.mockImplementation((keys: { deletedAt?: 1 }) =>
      keys.deletedAt === 1
        ? Promise.reject(new Error("scenario list index denied"))
        : undefined
    );

    try {
      await jest.isolateModulesAsync(async () => {
        const { ensureIndexes } = await import("./mongo");
        await expect(ensureIndexes()).rejects.toThrow(
          "scenario list index denied"
        );
      });
    } finally {
      mockScenarioCreateIndex.mockReset();
    }
  });

  it("rejects a scenario list conflict without a verified equivalent index", async () => {
    const conflict = { code: 85, codeName: "IndexOptionsConflict" };
    mockScenarioCreateIndex.mockImplementation((keys: { deletedAt?: 1 }) =>
      keys.deletedAt === 1 ? Promise.reject(conflict) : undefined
    );
    try {
      await jest.isolateModulesAsync(async () => {
        const { ensureIndexes } = await import("./mongo");
        await expect(ensureIndexes()).rejects.toBe(conflict);
      });
    } finally {
      mockScenarioCreateIndex.mockReset();
    }
  });

  it.each(["conversations_whatsapp_identity_owner_v1", "conversations_whatsapp_identity_aliases_v1"])("fails deployment when WhatsApp ownership index %s is unavailable and retries", async name => {
    const createIndex = mockCollections.conversation.createIndex;
    const provision = createIndex.getMockImplementation()!;
    let fail = true;
    createIndex.mockImplementation(async (key, options) => {
      if (options?.name === name && fail) {
        fail = false;
        throw new Error("ownership index denied");
      }
      return provision(key, options);
    });
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("ownership index denied");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("propagates mission-control index failures and allows provisioning to retry", async () => {
    const createIndex = mockCollections.conversation.createIndex;
    const provision = createIndex.getMockImplementation()!;
    let fail = true;
    createIndex.mockImplementation(async (key, options) => {
      if (key["classification.category"] && fail) {
        fail = false;
        throw new Error("conversation index denied");
      }
      return provision(key, options);
    });
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("conversation index denied");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("continues provisioning after verifying an equivalent mission-control index", async () => {
    const createIndex = mockCollections.conversation.createIndex;
    const provision = createIndex.getMockImplementation()!;
    mockQueryIndexes.conversation.push({
      name: "custom_agent_lookup",
      key: { workspaceId: 1, "classification.category": 1 },
    });
    createIndex.mockImplementation(async (key, options) => {
      if (key["classification.category"]) {
        throw { code: 85, codeName: "IndexOptionsConflict" };
      }
      return provision(key, options);
    });
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
    expect(createIndex).toHaveBeenCalledWith(
      { workspaceId: 1, user: 1, lastMessageAt: -1 },
      { background: true }
    );
  });

  it.each([
    { sparse: true },
    { hidden: true },
    { unique: true },
    { partialFilterExpression: { deletedAt: null } },
    { collation: { locale: "en" } },
    { expireAfterSeconds: 3600 },
  ])("rejects an incompatible mission-control index: %j", async options => {
    const createIndex = mockCollections.conversation.createIndex;
    const provision = createIndex.getMockImplementation()!;
    const conflict = { code: 85, codeName: "IndexOptionsConflict" };
    mockQueryIndexes.conversation.push({
      name: "custom_agent_lookup",
      key: { workspaceId: 1, "classification.category": 1 },
      ...options,
    });
    createIndex.mockImplementation(async (key, options) => {
      if (key["classification.category"]) throw conflict;
      return provision(key, options);
    });
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toBe(conflict);
    });
  });

  it("provisions the covering company conversation visibility index", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();

      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, createdAt: 1, _id: 1 },
        {
          background: true,
          name: "conversations_workspace_created_id_asc_v1",
        }
      );
    });
  });

  it("provisions optional unread ordering without replacing required projection indexes", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();

      expect(mockCollections.requestListItem.createIndex).toHaveBeenCalledTimes(1);
      expect(mockCollections.requestListItem.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, sortAt: -1, _id: -1 },
        {
          background: true,
          name: "requests_projection_unread_ordered_v1",
          partialFilterExpression: {
            deletedAt: null,
            "projection.status": "ready",
            unreadGeneration: { $type: "long" },
          },
        }
      );
    });
  });

  it("remains retryable when optional unread index provisioning fails", async () => {
    await jest.isolateModulesAsync(async () => {
      mockCollections.requestListItem.createIndex.mockRejectedValueOnce(
        new Error("optional unread index denied")
      );
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).rejects.toThrow("optional unread index denied");
      await expect(ensureIndexes()).resolves.toBeUndefined();
      expect(mockCollections.requestListItem.createIndex).toHaveBeenCalledTimes(2);
    });
  });

  it("provisions both canonical customer phone lookup branches without renaming the identity index", async () => {
    const { ensureIndexes } = await import("./mongo");
    await ensureIndexes();
    expect(mockCollections.customer.createIndex).toHaveBeenCalledWith(
      { workspaceId: 1, status: 1, "profileSummary.contactPoints.phones": 1 },
      { background: true, name: "customers_workspace_status_contact_phone" }
    );
    expect(mockCollections.customer.createIndex).toHaveBeenCalledWith(
      { workspaceId: 1, "identities.type": 1, "identities.normalizedValue": 1 },
      { background: true }
    );
  });

  it("creates the Atlas query-shape indexes explicitly in production", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await ensureIndexes();
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, whatsappInboundDedupeKey: 1 },
        {
          background: true,
          name: "messages_whatsapp_inbound_dedupe_v1",
          unique: true,
          partialFilterExpression: {
            channel: "whatsapp",
            direction: "inbound",
            workspaceId: { $type: "string" },
            whatsappInboundDedupeKey: { $type: "string" },
          },
        }
      );
      for (const owner of [
        "events",
        "runs",
        "policy",
        "reservations",
        "scenarios",
        "carts",
        "commerce_settings",
        "commerce_events",
      ])
        expect(mockBehaviorIndexes).toHaveBeenCalledWith(owner);

      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { "airiIngressIntent.ingressNextRetryAt": 1, _id: 1 },
        {
          name: "message_airi_ingress_pending",
          partialFilterExpression: {
            "airiIngressIntent.ingressKey": { $type: "string" },
          },
        }
      );

      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        {
          "rawSourcePayload.provider": 1,
          "rawSourcePayload.eventType": 1,
          createdAt: -1,
        },
        {
          background: true,
          name: "messages_raw_provider_event_type_created_at_desc",
        }
      );
      expect(mockCollections.pendingMutation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          status: 1,
          normalizedTargetMessageId: 1,
          eventAt: 1,
          createdAt: 1,
        },
        {
          background: true,
          name: "whatsapp_pending_mutations_workspace_status_target_event_created",
        }
      );
      expect(mockEnsureRealtimeEventIndexes).toHaveBeenCalledTimes(1);
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          "classification_state.status": 1,
          "classification_state.nextAttemptAt": 1,
          "classification_state.requestedAt": 1,
          _id: 1,
        },
        {
          background: true,
          name: "conversations_classification_pending_due",
          partialFilterExpression: {
            "classification_state.contractVersion": 2,
            "classification_state.status": {
              $in: ["pending", "blocked"],
            },
          },
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          "classification_state.status": 1,
          "classification_state.lease.expiresAt": 1,
          _id: 1,
        },
        {
          background: true,
          name: "conversations_classification_processing_lease_expired",
          partialFilterExpression: {
            "classification_state.contractVersion": 2,
            "classification_state.status": "processing",
          },
        }
      );
      expect(mockCollections.conversation.dropIndex).toHaveBeenCalledWith(
        "conversations_unclassified_inbound_classification_queue"
      );
      expect(
        mockCollections.conversationAnalysisRevision.createIndex
      ).toHaveBeenCalledWith(
        {
          "effects.status": 1,
          "effects.nextAttemptAt": 1,
          completedAt: 1,
          _id: 1,
        },
        {
          background: true,
          name: "conversation_analysis_revisions_effects_due",
          partialFilterExpression: {
            "effects.status": { $in: ["pending", "failed"] },
          },
        }
      );
      expect(
        mockCollections.conversationAnalysisRevision.createIndex
      ).toHaveBeenCalledWith(
        {
          "effects.status": 1,
          "effects.lease.expiresAt": 1,
          completedAt: 1,
          _id: 1,
        },
        {
          background: true,
          name: "conversation_analysis_revisions_effects_processing_expired",
          partialFilterExpression: {
            "effects.status": "processing",
          },
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          "airi_scenario_state.lockedScenarioId": 1,
          "airi_scenario_state.pendingConditionNodeId": 1,
          "airi_scenario_state.pendingSourceActionNodeId": 1,
        },
        {
          background: true,
          name: "conversations_workspace_scenario_pending_wait_v2",
          partialFilterExpression: {
            "airi_scenario_state.lockedScenarioId": { $type: "string" },
            "airi_scenario_state.pendingConditionNodeId": {
              $type: "string",
            },
          },
        }
      );
      expect(mockCollections.conversation.dropIndex).toHaveBeenCalledWith(
        "conversations_workspace_scenario_pending_wait"
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, lastMessageAt: -1 },
        { background: true }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, is_read_by_manager: 1, lastMessageAt: -1 },
        { background: true }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          first_inbound_at: 1,
          first_response_seconds: 1,
        },
        {
          background: true,
          name: "conversations_workspace_first_inbound_first_response",
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          channel: 1,
          sourceId: 1,
          chat: 1,
          updatedAt: -1,
        },
        {
          background: true,
          name: "conversations_workspace_channel_source_chat_updated_desc",
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          channel: 1,
          sourceId: 1,
          user: 1,
          updatedAt: -1,
        },
        {
          background: true,
          name: "conversations_workspace_channel_source_user_updated_desc",
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          channel: 1,
          sourceId: 1,
          "whatsappGroup.groupId": 1,
          updatedAt: -1,
        },
        {
          background: true,
          name: "conversations_workspace_channel_source_group_updated_desc",
          partialFilterExpression: {
            "whatsappGroup.groupId": { $type: "string" },
          },
        }
      );
      expect(mockCollections.whatsappGroup.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, sourceId: 1, groupId: 1 },
        { background: true, unique: true }
      );
      expect(
        mockCollections.whatsappGroupEvent.createIndex
      ).toHaveBeenCalledWith(
        { workspaceId: 1, sourceId: 1, groupId: 1, eventAt: -1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { conversation: 1, date: -1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { conversation: 1, direction: 1, date: -1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, direction: 1, date: -1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        { conversation: 1, date: 1, _id: 1 },
        { background: true }
      );
      expect(mockCollections.message.createIndex).toHaveBeenCalledWith(
        {
          conversation: 1,
          direction: 1,
          "origin.kind": 1,
          _id: -1,
        },
        {
          background: true,
          name: "messages_conversation_direction_origin_id_desc_v1",
        }
      );
      expect(mockCollections.conversation.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          channel: 1,
          "external_thread.referral.adId": 1,
          lastMessageAt: -1,
        },
        {
          background: true,
          name: "conversations_workspace_channel_instagram_referral_ad_last_message",
          partialFilterExpression: {
            "external_thread.referral.adId": { $type: "string" },
          },
        }
      );
      expect(mockCollections.airiArtifact.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, threadId: 1, updatedAt: -1 },
        {
          background: true,
          name: "airi_artifacts_workspace_thread_updated_desc",
        }
      );
      expect(
        mockCollections.airiArtifactVersion.createIndex
      ).toHaveBeenCalledWith(
        { artifactId: 1, revision: 1 },
        {
          background: true,
          unique: true,
          name: "airi_artifact_versions_artifact_revision_unique",
        }
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          "generation.recoveryMode": 1,
          provider: 1,
          status: 1,
          providerSourceId: 1,
        },
        {
          background: true,
          name: "workspace_platform_creative_generation_quota_v2",
          partialFilterExpression: {
            provider: { $in: ["google", "elevenlabs"] },
            status: {
              $in: ["queued", "in_progress", "complete", "nsfw"],
            },
          },
        }
      );
      expect(mockCollections.creativeAsset.dropIndex).toHaveBeenCalledWith(
        "workspace_platform_creative_generation_quota"
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        { workspaceId: 1, "generation.requestIdempotencyKey": 1 },
        {
          background: true,
          name: "workspace_video_generation_idempotency",
          unique: true,
          partialFilterExpression: {
            "generation.requestIdempotencyKey": { $type: "string" },
          },
        }
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          "generation.safetyProviderRequestIds": 1,
        },
        {
          background: true,
          name: "workspace_video_generation_safety_alias",
          partialFilterExpression: {
            "generation.contractVersion": 1,
            "generation.spec.provider": "higgsfield",
            "generation.safetyProviderRequestIds": { $exists: true },
          },
        }
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          "generation.safetyAncestors.assetId": 1,
          "generation.safetyAncestors.attemptToken": 1,
        },
        {
          background: true,
          name: "workspace_video_generation_safety_ancestor",
          partialFilterExpression: {
            "generation.contractVersion": 1,
            "generation.spec.provider": "higgsfield",
            "generation.safetyAncestors": { $exists: true },
          },
        }
      );
      expect(
        mockCollections.videoGenerationNsfwVerdict.createIndex
      ).toHaveBeenCalledWith(
        {
          workspaceId: 1,
          provider: 1,
          sourceAssetId: 1,
          sourceAttemptToken: 1,
        },
        {
          background: true,
          name: "workspace_video_nsfw_source_attempt",
        }
      );
      expect(
        mockCollections.videoGenerationNsfwVerdict.createIndex
      ).toHaveBeenCalledWith(
        {
          sweepCompletedAt: 1,
          firstReceivedAt: 1,
          _id: 1,
        },
        {
          background: true,
          name: "video_generation_nsfw_pending_sweep",
          partialFilterExpression: {
            sweepCompletedAt: null,
          },
        }
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        { "generation.orchestration.state": 1, updatedAt: 1, _id: 1 },
        {
          background: true,
          name: "video_generation_orchestration_reconcile_v2",
          partialFilterExpression: {
            status: { $in: ["queued", "in_progress"] },
            "generation.contractVersion": 1,
            "generation.orchestration.state": {
              $in: ["pending", "unknown", "started"],
            },
          },
        }
      );
      expect(mockCollections.creativeAsset.dropIndex).toHaveBeenCalledWith(
        "video_generation_orchestration_reconcile"
      );
      expect(mockCollections.creativeAsset.createIndex).toHaveBeenCalledWith(
        { updatedAt: 1, _id: 1 },
        {
          background: true,
          name: "video_generation_nsfw_storage_cleanup",
          partialFilterExpression: {
            kind: "video",
            status: "nsfw",
            storageProvider: "gcs",
            workspaceId: { $type: "string" },
            bucket: { $type: "string" },
            path: { $type: "string" },
            "generation.contractVersion": 1,
            "generation.submission.attemptToken": { $type: "string" },
          },
        }
      );
      expect(
        mockEnsurePlatformCreativeGenerationQuotaIndexes
      ).toHaveBeenCalledTimes(1);
      expect(mockEnsureTikTokPlatformCredentialIndexes).toHaveBeenCalledTimes(
        1
      );
      for (const createIndexes of [
        mockWhatsAppFlowEndpointSecurityCreateIndexes,
        mockWhatsAppFlowProvisioningOperationCreateIndexes,
        mockWhatsAppFlowSourceBindingFenceCreateIndexes,
        mockWhatsAppFlowSessionCreateIndexes,
        mockEnsureWhatsAppQrEntryPointIndexes,
        mockWhatsAppQrCodeCreateIndexes,
        mockWhatsAppQrOperationCreateIndexes,
        mockAiriTurnContextCreateIndexes,
        mockAiriChatThreadCreateIndexes,
        mockAiriChatMessageCreateIndexes,
        mockAiriChatRunCreateIndexes,
        mockBusinessLocationCreateIndexes,
      ]) {
        expect(createIndexes).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("builds the schema-declared Airi chat indexes through the narrow repair", async () => {
    await jest.isolateModulesAsync(async () => {
      const connectDB = (await import("@/lib/mongoose")).default as jest.Mock;
      connectDB.mockClear();
      const { ensureAiriChatIndexes } = await import("./mongo");
      await ensureAiriChatIndexes();
      expect(connectDB).toHaveBeenCalledTimes(1);
      expect(mockAiriChatThreadCreateIndexes).toHaveBeenCalledTimes(1);
      expect(mockAiriChatMessageCreateIndexes).toHaveBeenCalledTimes(1);
      expect(mockAiriChatRunCreateIndexes).toHaveBeenCalledTimes(1);
      expect(mockAiriTurnContextCreateIndexes).not.toHaveBeenCalled();
      expect(mockCollections.message.createIndex).not.toHaveBeenCalled();
    });
  });

  it("fails closed and remains retryable when Airi chat indexes cannot deploy", async () => {
    mockAiriChatMessageCreateIndexes.mockRejectedValueOnce(
      new Error("Airi chat index denied")
    );
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("Airi chat index denied");
      await expect(ensureIndexes()).resolves.toBeUndefined();
      expect(mockAiriChatMessageCreateIndexes).toHaveBeenCalledTimes(2);
    });
  });

  it("declares the Airi chat read paths on the models the repair builds", () => {
    const { AiriChatMessage } = jest.requireActual<
      typeof import("@/models/airi-chat-message")
    >("@/models/airi-chat-message");
    const { AiriChatThread } = jest.requireActual<
      typeof import("@/models/airi-chat-thread")
    >("@/models/airi-chat-thread");
    const messageKeys = AiriChatMessage.schema.indexes().map(([key]) => key);
    const threadKeys = AiriChatThread.schema.indexes().map(([key]) => key);
    // Per-turn history and message pages: one thread, ordered by time.
    expect(messageKeys).toContainEqual({ threadId: 1, createdAt: 1 });
    // Thread list: the owner's pinned threads first, then most recent.
    expect(threadKeys).toContainEqual({
      workspaceId: 1,
      createdByUserId: 1,
      pinnedAt: -1,
      updatedAt: -1,
    });
  });

  it("declares the Airi chat run indexes, with one run per client turn", () => {
    const { AiriChatRun } = jest.requireActual<
      typeof import("@/models/airi-chat-run")
    >("@/models/airi-chat-run");
    expect(AiriChatRun.collection.collectionName).toBe("airichatruns");
    expect(AiriChatRun.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ workspaceId: 1, threadId: 1, startedAt: -1 }, expect.anything()],
        [
          { workspaceId: 1, userId: 1, clientTurnId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [{ status: 1, heartbeatAt: 1 }, expect.anything()],
        // One running run per thread: a racing second send cannot insert.
        [
          { workspaceId: 1, threadId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: "running" },
          }),
        ],
      ])
    );
  });

  it("deploys reference video plan indexes through the explicit index gate", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await ensureIndexes();
      expect(mockCreativeVideoPlanCreateIndexes).toHaveBeenCalledTimes(1);
    });
  });

  it("fails closed and remains retryable when reference video plan indexes cannot deploy", async () => {
    mockCreativeVideoPlanCreateIndexes.mockRejectedValueOnce(
      new Error("video plan TTL index denied")
    );
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow(
        "video plan TTL index denied"
      );
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("creates and validates every cross-store outbox index in the deployment gate", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await ensureIndexes();

      expect(mockCollections.crossStoreOutbox.createIndex.mock.calls).toEqual([
        [{ target: 1 }, { background: true, name: "target_1" }],
        [{ operation: 1 }, { background: true, name: "operation_1" }],
        [{ dedupeKey: 1 }, { background: true, name: "dedupeKey_1" }],
        [{ status: 1 }, { background: true, name: "status_1" }],
        [{ nextRetryAt: 1 }, { background: true, name: "nextRetryAt_1" }],
        [
          { processingStartedAt: 1 },
          { background: true, name: "processingStartedAt_1" },
        ],
        [
          { status: 1, nextRetryAt: 1 },
          { background: true, name: "status_1_nextRetryAt_1" },
        ],
        [
          { target: 1, operation: 1, dedupeKey: 1 },
          {
            background: true,
            name: "target_1_operation_1_dedupeKey_1",
            unique: true,
          },
        ],
        [
          { completedAt: 1 },
          {
            background: true,
            expireAfterSeconds: 2_592_000,
            name: "completedAt_1_completed_ttl",
            partialFilterExpression: { status: "completed" },
          },
        ],
      ]);
      expect(mockCollections.crossStoreOutbox.indexes).toHaveBeenCalledTimes(2);
      expect(mockCollections.crossStoreOutbox.aggregate).toHaveBeenCalledTimes(
        1
      );
      expect(mockCollections.crossStoreOutbox.aggregate).toHaveBeenCalledWith(
        expect.arrayContaining([{ $limit: 11 }]),
        { allowDiskUse: true, maxTimeMS: 60_000 }
      );
    });
  });

  it("fails closed with bounded evidence when existing outbox rows violate uniqueness", async () => {
    mockCrossStoreOutboxDuplicateGroups = Array.from(
      { length: 11 },
      (_, index) => ({
        target: "gcp_ai_gateway",
        operation: "llm_analytics.publish_events",
        dedupeKey: `dedupe-key-${index}`,
        duplicateCount: index + 2,
        sampleDocumentId: `document-${index}`,
      })
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      let error: Error | undefined;
      try {
        await ensureIndexes();
      } catch (value) {
        error = value instanceof Error ? value : new Error(String(value));
      }
      expect(error).toBeInstanceOf(Error);
      const message = error?.message || "";
      expect(message).toMatch(
        /Cross-store outbox unique index preflight found duplicate rows/
      );
      expect(message).toMatch(/dedupe-key-0/);
      expect(message).toMatch(/dedupe-key-9/);
      expect(message).not.toMatch(/dedupe-key-10/);
      expect(
        mockCollections.crossStoreOutbox.createIndex
      ).not.toHaveBeenCalled();
    });
  });

  it("fails the deployment gate when created outbox indexes cannot be validated", async () => {
    mockCrossStoreOutboxPersistIndexWrites = false;

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).rejects.toThrow(
        /Cross-store outbox index verification failed/
      );
    });
  });

  it("creates and validates the partial LLM review-item dedupe index", async () => {
    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await ensureIndexes();

      expect(
        mockCollections.llmEvaluationReviewItem.createIndex
      ).toHaveBeenCalledWith(
        { workspaceId: 1, dedupeKey: 1 },
        {
          background: true,
          name: "llm_review_items_workspace_dedupe_unique_v2",
          partialFilterExpression: { dedupeKey: { $type: "string" } },
          unique: true,
        }
      );
      expect(
        mockCollections.llmEvaluationReviewItem.indexes
      ).toHaveBeenCalledTimes(2);
      expect(
        mockCollections.llmEvaluationReviewItem.aggregate
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          { $match: { dedupeKey: { $type: "string" } } },
          { $limit: 11 },
        ]),
        {
          allowDiskUse: true,
          maxTimeMS: 60_000,
        }
      );
    });
  });

  it("migrates the legacy sparse LLM review-item dedupe index after duplicate preflight", async () => {
    mockLlmReviewPersistedIndexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        key: { workspaceId: 1, dedupeKey: 1 },
        name: "workspaceId_1_dedupeKey_1",
        sparse: true,
        unique: true,
      },
    ];

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).resolves.toBeUndefined();

      expect(
        mockCollections.llmEvaluationReviewItem.aggregate
      ).toHaveBeenCalledTimes(1);
      expect(
        mockCollections.llmEvaluationReviewItem.dropIndex
      ).toHaveBeenCalledWith("workspaceId_1_dedupeKey_1");
      expect(
        mockCollections.llmEvaluationReviewItem.createIndex
      ).toHaveBeenCalledWith(
        { workspaceId: 1, dedupeKey: 1 },
        {
          background: true,
          name: "llm_review_items_workspace_dedupe_unique_v2",
          partialFilterExpression: { dedupeKey: { $type: "string" } },
          unique: true,
        }
      );
      expect(
        mockCollections.llmEvaluationReviewItem.aggregate.mock
          .invocationCallOrder[0]
      ).toBeLessThan(
        mockCollections.llmEvaluationReviewItem.createIndex.mock
          .invocationCallOrder[0]
      );
      expect(
        mockCollections.llmEvaluationReviewItem.createIndex.mock
          .invocationCallOrder[0]
      ).toBeLessThan(
        mockCollections.llmEvaluationReviewItem.dropIndex.mock
          .invocationCallOrder[0]
      );
      expect(
        mockCollections.llmEvaluationReviewItem.indexes
      ).toHaveBeenCalledTimes(3);
    });
  });

  it("leaves the legacy sparse review-item index intact when duplicate preflight fails", async () => {
    mockLlmReviewPersistedIndexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        key: { workspaceId: 1, dedupeKey: 1 },
        name: "workspaceId_1_dedupeKey_1",
        sparse: true,
        unique: true,
      },
    ];
    mockLlmReviewDuplicateGroups = [
      {
        workspaceId: "workspace-1",
        dedupeKey: "review-dedupe-1",
        duplicateCount: 2,
        sampleDocumentId: "review-document-1",
      },
    ];

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).rejects.toThrow(
        /LLM evaluation review-item unique index preflight found duplicate rows/
      );
      expect(
        mockCollections.llmEvaluationReviewItem.dropIndex
      ).not.toHaveBeenCalled();
      expect(
        mockCollections.llmEvaluationReviewItem.createIndex
      ).not.toHaveBeenCalled();
    });
  });

  it("refuses to replace an unknown review-item index definition", async () => {
    mockLlmReviewPersistedIndexes = [
      { name: "_id_", key: { _id: 1 } },
      {
        key: { workspaceId: 1, dedupeKey: -1 },
        name: "workspaceId_1_dedupeKey_1",
        sparse: true,
        unique: true,
      },
    ];

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).rejects.toThrow(
        /invalid legacy index workspaceId_1_dedupeKey_1/
      );
      expect(
        mockCollections.llmEvaluationReviewItem.aggregate
      ).not.toHaveBeenCalled();
      expect(
        mockCollections.llmEvaluationReviewItem.dropIndex
      ).not.toHaveBeenCalled();
      expect(
        mockCollections.llmEvaluationReviewItem.createIndex
      ).not.toHaveBeenCalled();
    });
  });

  it("blocks the review-item dedupe index with bounded duplicate evidence and no mutation", async () => {
    mockLlmReviewDuplicateGroups = Array.from({ length: 11 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      dedupeKey: `review-dedupe-${index}`,
      duplicateCount: index + 2,
      sampleDocumentId: `review-document-${index}`,
    }));

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      let error: Error | undefined;
      try {
        await ensureIndexes();
      } catch (value) {
        error = value instanceof Error ? value : new Error(String(value));
      }
      const message = error?.message || "";
      expect(message).toMatch(
        /LLM evaluation review-item unique index preflight found duplicate rows/
      );
      expect(message).toMatch(/review-dedupe-0/);
      expect(message).toMatch(/review-dedupe-9/);
      expect(message).not.toMatch(/review-dedupe-10/);
      expect(
        mockCollections.llmEvaluationReviewItem.createIndex
      ).not.toHaveBeenCalled();
    });
  });

  it("treats an already-removed legacy orchestration index as migrated", async () => {
    mockCollections.creativeAsset.dropIndex.mockRejectedValueOnce({
      code: 27,
      codeName: "IndexNotFound",
    });

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("treats an already-removed legacy pending-wait index as migrated", async () => {
    mockCollections.conversation.dropIndex.mockRejectedValueOnce({
      code: 27,
      codeName: "IndexNotFound",
    });

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("treats an already-removed legacy classification queue index as migrated", async () => {
    mockCollections.conversation.dropIndex.mockImplementation(
      async (indexName: string) => {
        if (
          indexName ===
          "conversations_unclassified_inbound_classification_queue"
        ) {
          throw { code: 27, codeName: "IndexNotFound" };
        }
      }
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("does not hide a legacy classification queue migration failure", async () => {
    mockCollections.conversation.dropIndex.mockImplementation(
      async (indexName: string) => {
        if (
          indexName ===
          "conversations_unclassified_inbound_classification_queue"
        ) {
          throw new Error("classification queue index drop denied");
        }
      }
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow(
        "classification queue index drop denied"
      );
    });
  });

  it("does not hide a legacy pending-wait index migration failure", async () => {
    mockCollections.conversation.dropIndex.mockRejectedValueOnce(
      new Error("pending-wait index drop denied")
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow(
        "pending-wait index drop denied"
      );
    });
  });

  it("does not hide a legacy orchestration index migration failure", async () => {
    mockCollections.creativeAsset.dropIndex.mockRejectedValueOnce(
      new Error("drop denied")
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("drop denied");
    });
  });

  it("treats an already-removed legacy platform quota index as migrated", async () => {
    mockCollections.creativeAsset.dropIndex
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ code: 27, codeName: "IndexNotFound" });

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });

  it("does not hide a legacy platform quota index migration failure", async () => {
    mockCollections.creativeAsset.dropIndex
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("quota drop denied"));

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("quota drop denied");
    });
  });

  it("fails the deployment index gate when platform quota fencing is unavailable", async () => {
    mockEnsurePlatformCreativeGenerationQuotaIndexes.mockRejectedValueOnce(
      new Error("quota slot index denied")
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");
      await expect(ensureIndexes()).rejects.toThrow("quota slot index denied");
    });
  });

  it("fails closed and remains retryable when a Flow security index cannot deploy", async () => {
    mockWhatsAppFlowSessionCreateIndexes.mockRejectedValueOnce(
      new Error("flow session index denied")
    );

    await jest.isolateModulesAsync(async () => {
      const { ensureIndexes } = await import("./mongo");

      await expect(ensureIndexes()).rejects.toThrow(
        "flow session index denied"
      );
      await expect(ensureIndexes()).resolves.toBeUndefined();
    });
  });
});

describe("classification v2 persistence schema", () => {
  const conversationId = "507f1f77bcf86cd799439011";
  const completedAt = new Date("2026-08-10T10:00:00.000Z");

  function emptyEffectsChecklist() {
    return {
      summary: null,
      analytics: null,
      realtime: null,
      usage: null,
      webhook: null,
    };
  }

  function validEffectInputs(overrides: Record<string, unknown> = {}) {
    return {
      companyId: "company-1",
      source: { id: "source-1", type: "whatsapp" },
      predictedCategoryConfidence: 0.9,
      processingTimeMs: 1_250,
      provider: "vertex",
      model: "gemini-2.5-flash",
      ragSummary: {
        mode: "replace",
        language: "en",
        summary: "Customer needs help.",
        chunks: ["Customer needs help."],
        metadata: {
          wordCount: 3,
          messageCount: 2,
          chunkCount: 1,
          generationTimeMs: 250,
        },
      },
      ...overrides,
    };
  }

  function pendingInitialEffects(overrides: Record<string, unknown> = {}) {
    return {
      status: "pending",
      attemptCount: 0,
      fence: 0,
      nextAttemptAt: completedAt,
      completedAt: null,
      lease: null,
      checklist: emptyEffectsChecklist(),
      ...overrides,
    };
  }

  function reviewInitialEffects(overrides: Record<string, unknown> = {}) {
    return {
      status: "not_applicable",
      attemptCount: 0,
      fence: 0,
      nextAttemptAt: null,
      completedAt,
      lease: null,
      checklist: emptyEffectsChecklist(),
      ...overrides,
    };
  }

  function readyRevision(overrides: Record<string, unknown> = {}) {
    return {
      conversationId,
      workspaceId: "workspace-1",
      sourceRevision: 4,
      completedAt,
      outcome: "ready",
      projection: { category: "sales" },
      review: null,
      effectInputs: validEffectInputs(),
      provenance: {
        taxonomyId: "taxonomy-1",
        taxonomyDigest: "digest-1",
        classifierVersion: "classifier-1",
        classifierContractRevision: 2,
      },
      effects: pendingInitialEffects(),
      ...overrides,
    };
  }

  function effectInputValidator() {
    const actualModel = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >(
      "@/models/conversation-analysis-revision"
    ) as typeof import("@/models/conversation-analysis-revision") & {
      assertConversationClassificationEffectInputs?: (value: unknown) => void;
    };
    const assertion = actualModel.assertConversationClassificationEffectInputs;
    if (!assertion) {
      throw new Error(
        "assertConversationClassificationEffectInputs is not implemented"
      );
    }
    return assertion;
  }

  it("exports one exact bounded effect-input contract", () => {
    const actualModel = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >(
      "@/models/conversation-analysis-revision"
    ) as typeof import("@/models/conversation-analysis-revision") & {
      CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS?: Record<string, number>;
      assertConversationClassificationEffectInputs?: (value: unknown) => void;
    };

    expect(actualModel.CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS).toEqual(
      {
        companyIdLength: 128,
        sourceIdLength: 128,
        sourceTypeLength: 64,
        providerLength: 64,
        modelLength: 128,
        processingTimeMs: 86_400_000,
        ragSummaryLength: 32_000,
        ragChunkCount: 64,
        ragChunkLength: 16_000,
        ragGenerationTimeMs: 86_400_000,
        count: Number.MAX_SAFE_INTEGER,
      }
    );
    expect(
      typeof actualModel.assertConversationClassificationEffectInputs
    ).toBe("function");
  });

  it("accepts every scalar effect-input boundary without changing values", () => {
    const assertEffectInputs = effectInputValidator();
    const minimum = {
      companyId: "c",
      source: { id: null, type: null },
      predictedCategoryConfidence: 0,
      processingTimeMs: 0,
      provider: "p",
      model: "m",
      ragSummary: null,
    };
    const maximum = {
      companyId: "c".repeat(128),
      source: { id: "i".repeat(128), type: "t".repeat(64) },
      predictedCategoryConfidence: 1,
      processingTimeMs: 86_400_000,
      provider: "p".repeat(64),
      model: "m".repeat(128),
      ragSummary: {
        mode: "promote",
        language: "uz",
        summary: ` ${"s".repeat(31_998)} `,
        chunks: Array.from({ length: 64 }, () => "x".repeat(16_000)),
        metadata: {
          wordCount: Number.MAX_SAFE_INTEGER,
          messageCount: Number.MAX_SAFE_INTEGER,
          chunkCount: 64,
          generationTimeMs: 86_400_000,
        },
      },
    };

    expect(() => assertEffectInputs(minimum)).not.toThrow();
    expect(() => assertEffectInputs(maximum)).not.toThrow();
    expect(maximum.ragSummary.summary.startsWith(" ")).toBe(true);
    expect(maximum.ragSummary.summary.endsWith(" ")).toBe(true);
  });

  it.each([
    [
      "missing top-level key",
      (() => {
        const value = validEffectInputs();
        delete (value as Record<string, unknown>).model;
        return value;
      })(),
    ],
    ["unknown top-level key", { ...validEffectInputs(), extra: true }],
    ["non-record top-level", []],
    ["blank company", validEffectInputs({ companyId: " " })],
    ["non-canonical company", validEffectInputs({ companyId: " company " })],
    ["company too long", validEffectInputs({ companyId: "c".repeat(129) })],
    ["source missing type", validEffectInputs({ source: { id: "source-1" } })],
    [
      "source unknown key",
      validEffectInputs({ source: { id: null, type: null, extra: true } }),
    ],
    [
      "half-null source",
      validEffectInputs({ source: { id: "source-1", type: null } }),
    ],
    [
      "source id too long",
      validEffectInputs({ source: { id: "i".repeat(129), type: "whatsapp" } }),
    ],
    [
      "source type too long",
      validEffectInputs({ source: { id: "source-1", type: "t".repeat(65) } }),
    ],
    [
      "string confidence",
      validEffectInputs({ predictedCategoryConfidence: "0.5" }),
    ],
    [
      "nan confidence",
      validEffectInputs({ predictedCategoryConfidence: Number.NaN }),
    ],
    [
      "infinite confidence",
      validEffectInputs({
        predictedCategoryConfidence: Number.POSITIVE_INFINITY,
      }),
    ],
    [
      "negative confidence",
      validEffectInputs({ predictedCategoryConfidence: -Number.EPSILON }),
    ],
    [
      "confidence above one",
      validEffectInputs({ predictedCategoryConfidence: 1 + Number.EPSILON }),
    ],
    [
      "string processing duration",
      validEffectInputs({ processingTimeMs: "1" }),
    ],
    [
      "fractional processing duration",
      validEffectInputs({ processingTimeMs: 0.5 }),
    ],
    [
      "negative processing duration",
      validEffectInputs({ processingTimeMs: -1 }),
    ],
    [
      "processing duration too large",
      validEffectInputs({ processingTimeMs: 86_400_001 }),
    ],
    ["blank provider", validEffectInputs({ provider: "" })],
    ["provider too long", validEffectInputs({ provider: "p".repeat(65) })],
    ["blank model", validEffectInputs({ model: "\t" })],
    ["model too long", validEffectInputs({ model: "m".repeat(129) })],
    [
      "omitted rag summary",
      (() => {
        const value = validEffectInputs();
        delete (value as Record<string, unknown>).ragSummary;
        return value;
      })(),
    ],
    [
      "rag unknown key",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          extra: true,
        },
      }),
    ],
    [
      "rag missing mode",
      (() => {
        const rag = {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
        };
        delete rag.mode;
        return validEffectInputs({ ragSummary: rag });
      })(),
    ],
    [
      "bad rag mode",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          mode: "append",
        },
      }),
    ],
    [
      "bad rag language",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          language: "fr",
        },
      }),
    ],
    [
      "blank rag summary",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          summary: "  ",
        },
      }),
    ],
    [
      "rag summary too long",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          summary: "s".repeat(32_001),
        },
      }),
    ],
    [
      "too many rag chunks",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          chunks: Array.from({ length: 65 }, () => "x"),
          metadata: {
            wordCount: 1,
            messageCount: 1,
            chunkCount: 65,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "blank rag chunk",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          chunks: [" "],
          metadata: {
            wordCount: 1,
            messageCount: 1,
            chunkCount: 1,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "rag chunk too long",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          chunks: ["x".repeat(16_001)],
          metadata: {
            wordCount: 1,
            messageCount: 1,
            chunkCount: 1,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "metadata unknown key",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: 1,
            messageCount: 1,
            chunkCount: 1,
            generationTimeMs: 1,
            extra: true,
          },
        },
      }),
    ],
    [
      "metadata missing count",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: { wordCount: 1, messageCount: 1, chunkCount: 1 },
        },
      }),
    ],
    [
      "string word count",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: "3",
            messageCount: 2,
            chunkCount: 1,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "negative message count",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: 3,
            messageCount: -1,
            chunkCount: 1,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "fractional chunk count",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: 3,
            messageCount: 2,
            chunkCount: 0.5,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "mismatched chunk count",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: 3,
            messageCount: 2,
            chunkCount: 0,
            generationTimeMs: 1,
          },
        },
      }),
    ],
    [
      "generation duration too large",
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: 3,
            messageCount: 2,
            chunkCount: 1,
            generationTimeMs: 86_400_001,
          },
        },
      }),
    ],
  ])("rejects invalid exact effect inputs: %s", (_name, value) => {
    expect(() => effectInputValidator()(value)).toThrow(/effect input/i);
  });

  it("builds deterministic analysis revision IDs from conversation and source revision", () => {
    const actualModel = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >(
      "@/models/conversation-analysis-revision"
    ) as typeof import("@/models/conversation-analysis-revision") & {
      buildConversationAnalysisRevisionId?: (input: {
        conversationId: string;
        sourceRevision: number;
      }) => string;
    };
    const buildRevisionId = actualModel.buildConversationAnalysisRevisionId;

    expect(typeof buildRevisionId).toBe("function");
    expect(
      buildRevisionId?.({
        conversationId: "507f1f77bcf86cd799439011",
        sourceRevision: 4,
      })
    ).toBe("507f1f77bcf86cd799439011:4");
    expect(() =>
      buildRevisionId?.({
        conversationId: "507f1f77bcf86cd799439011",
        sourceRevision: 0,
      })
    ).toThrow(/sourceRevision/);
  });

  it("declares the revisioned conversation state and removes the Boolean queue declaration", () => {
    const { Conversation } = jest.requireActual<
      typeof import("@/models/conversation")
    >("@/models/conversation");

    for (const path of [
      "classification_revision",
      "classification_state.contractVersion",
      "classification_state.status",
      "classification_state.requestedRevision",
      "classification_state.processingRevision",
      "classification_state.appliedRevision",
      "classification_state.generation",
      "classification_state.attemptRevision",
      "classification_state.attemptCount",
      "classification_state.fence",
      "classification_state.requestedAt",
      "classification_state.nextAttemptAt",
      "classification_state.lastEnqueuedAt",
      "classification_state.completedAt",
      "classification_state.lease.ownerToken",
      "classification_state.lease.claimedAt",
      "classification_state.lease.expiresAt",
      "classification_state.error.code",
      "classification_state.review.reason",
      "classification_state.blocked.reason",
      "classification_meta.source_revision",
      "classification_meta.provenance_kind",
      "classification_meta.taxonomy_digest",
      "classification_meta.classifier_contract_revision",
      "classification_meta.analysis_revision_id",
      "classification_meta.completed_at",
    ]) {
      expect(Conversation.schema.path(path)).toBeDefined();
    }

    expect(CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS).toEqual([
      "v2",
      "legacy_unknown",
    ]);
    expect(
      Conversation.schema.path("classification_meta.provenance_kind").options
    ).toMatchObject({
      enum: ["v2", "legacy_unknown"],
      default: null,
    });

    expect(
      Conversation.schema
        .indexes()
        .some(
          ([, options]) =>
            options.name ===
            "conversations_unclassified_inbound_classification_queue"
        )
    ).toBe(false);
  });

  it("indexes both pending and blocked work by one canonical due timestamp", () => {
    const { Conversation } = jest.requireActual<
      typeof import("@/models/conversation")
    >("@/models/conversation");
    const pendingIndex = Conversation.schema
      .indexes()
      .find(
        ([, options]) =>
          options.name === "conversations_classification_pending_due"
      );

    expect(pendingIndex).toEqual([
      {
        "classification_state.status": 1,
        "classification_state.nextAttemptAt": 1,
        "classification_state.requestedAt": 1,
        _id: 1,
      },
      expect.objectContaining({
        partialFilterExpression: {
          "classification_state.contractVersion": 2,
          "classification_state.status": {
            $in: ["pending", "blocked"],
          },
        },
      }),
    ]);
  });

  it("keeps analysis payload immutable while exposing a mutable effects checklist", () => {
    const { ANALYSIS_REVISION_EFFECT_STATUSES, ConversationAnalysisRevision } =
      jest.requireActual<
        typeof import("@/models/conversation-analysis-revision")
      >("@/models/conversation-analysis-revision");

    expect(ANALYSIS_REVISION_EFFECT_STATUSES).toEqual([
      "pending",
      "processing",
      "completed",
      "failed",
      "superseded",
      "not_applicable",
    ]);

    for (const path of [
      "conversationId",
      "workspaceId",
      "sourceRevision",
      "completedAt",
      "outcome",
      "projection",
      "review.code",
      "review.reason",
      "effectInputs.companyId",
      "effectInputs.source.id",
      "effectInputs.source.type",
      "effectInputs.predictedCategoryConfidence",
      "effectInputs.processingTimeMs",
      "effectInputs.provider",
      "effectInputs.model",
      "effectInputs.ragSummary.mode",
      "effectInputs.ragSummary.language",
      "effectInputs.ragSummary.summary",
      "effectInputs.ragSummary.chunks",
      "effectInputs.ragSummary.metadata.wordCount",
      "effectInputs.ragSummary.metadata.messageCount",
      "effectInputs.ragSummary.metadata.chunkCount",
      "effectInputs.ragSummary.metadata.generationTimeMs",
      "provenance.taxonomyId",
      "provenance.taxonomyDigest",
      "provenance.classifierVersion",
      "provenance.classifierContractRevision",
      "effects.status",
      "effects.attemptCount",
      "effects.fence",
      "effects.nextAttemptAt",
      "effects.lease.ownerToken",
      "effects.lease.claimedAt",
      "effects.lease.expiresAt",
      "effects.checklist.summary",
      "effects.checklist.analytics",
      "effects.checklist.realtime",
      "effects.checklist.usage",
      "effects.checklist.webhook",
    ]) {
      expect(ConversationAnalysisRevision.schema.path(path)).toBeDefined();
    }

    const indexes = ConversationAnalysisRevision.schema.indexes();
    const indexNames = indexes.map(([, options]) => options.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "conversation_analysis_revisions_effects_due",
        "conversation_analysis_revisions_effects_processing_expired",
      ])
    );
    expect(indexNames).not.toContain(
      "conversation_analysis_revisions_conversation_source_unique"
    );
    expect(
      indexes.find(
        ([, options]) =>
          options.name === "conversation_analysis_revisions_effects_due"
      )?.[0]
    ).toEqual({
      "effects.status": 1,
      "effects.nextAttemptAt": 1,
      completedAt: 1,
      _id: 1,
    });
    expect(
      indexes.find(
        ([, options]) =>
          options.name ===
          "conversation_analysis_revisions_effects_processing_expired"
      )?.[0]
    ).toEqual({
      "effects.status": 1,
      "effects.lease.expiresAt": 1,
      completedAt: 1,
      _id: 1,
    });
  });

  it("derives and validates the canonical revision identity", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const canonical = new ConversationAnalysisRevision(readyRevision());

    await expect(canonical.validate()).resolves.toBeUndefined();
    expect(canonical._id).toBe(`${conversationId}:4`);

    const mismatched = new ConversationAnalysisRevision({
      ...readyRevision(),
      _id: "arbitrary-id",
    });
    await expect(mismatched.validate()).rejects.toThrow(/canonical/i);

    const invalidRevision = new ConversationAnalysisRevision(
      readyRevision({ sourceRevision: 0 })
    );
    await expect(invalidRevision.validate()).rejects.toThrow(/sourceRevision/);
  });

  it("accepts only consistent immutable ready and review-required outcomes", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");

    const ready = new ConversationAnalysisRevision(readyRevision());
    await expect(ready.validate()).resolves.toBeUndefined();
    expect(ready.effects.fence).toBe(0);

    const reviewRequired = new ConversationAnalysisRevision(
      readyRevision({
        outcome: "review_required",
        projection: null,
        review: { code: "safety_blocked", reason: "provider_safety" },
        effectInputs: null,
        effects: reviewInitialEffects(),
      })
    );
    await expect(reviewRequired.validate()).resolves.toBeUndefined();

    for (const inconsistent of [
      readyRevision({ projection: null }),
      readyRevision({ review: { code: "unexpected", reason: "unexpected" } }),
      readyRevision({ effectInputs: null }),
      readyRevision({
        outcome: "review_required",
        projection: { category: "must-not-exist" },
        review: { code: "safety_blocked", reason: "provider_safety" },
        effectInputs: null,
      }),
      readyRevision({
        outcome: "review_required",
        projection: null,
        review: null,
        effectInputs: null,
      }),
      readyRevision({
        outcome: "review_required",
        projection: null,
        review: { code: "safety_blocked", reason: "provider_safety" },
        effectInputs: validEffectInputs(),
      }),
      readyRevision({
        outcome: "review_required",
        projection: null,
        review: { code: "safety_blocked", reason: "provider_safety" },
        effectInputs: null,
        effects: {
          status: "pending",
          attemptCount: 0,
          fence: 0,
          nextAttemptAt: completedAt,
          completedAt: null,
          lease: null,
          checklist: emptyEffectsChecklist(),
        },
      }),
    ]) {
      await expect(
        new ConversationAnalysisRevision(inconsistent).validate()
      ).rejects.toThrow(/outcome|projection|review|effects/i);
    }
  });

  it("enforces exact effect inputs before document casting can coerce values", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");

    const invalidInputs = [
      validEffectInputs({ predictedCategoryConfidence: "0.5" }),
      validEffectInputs({ processingTimeMs: "1250" }),
      validEffectInputs({ source: { id: null, type: null, extra: true } }),
      validEffectInputs({
        ragSummary: {
          ...(validEffectInputs().ragSummary as Record<string, unknown>),
          metadata: {
            wordCount: "3",
            messageCount: 2,
            chunkCount: 1,
            generationTimeMs: 250,
          },
        },
      }),
    ];

    for (const effectInputs of invalidInputs) {
      await expect(
        Promise.resolve().then(() =>
          new ConversationAnalysisRevision(
            readyRevision({ effectInputs })
          ).validate()
        )
      ).rejects.toThrow(/effect.?input/i);
    }

    const missingReadyInputs = readyRevision();
    delete (missingReadyInputs as Record<string, unknown>).effectInputs;
    await expect(
      new ConversationAnalysisRevision(missingReadyInputs).validate()
    ).rejects.toThrow(/effect input/i);

    const missingReviewInputs = readyRevision({
      outcome: "review_required",
      projection: null,
      review: { code: "safety_blocked", reason: "provider_safety" },
      effects: reviewInitialEffects(),
    });
    delete (missingReviewInputs as Record<string, unknown>).effectInputs;
    await expect(
      new ConversationAnalysisRevision(missingReviewInputs).validate()
    ).rejects.toThrow(/effect input/i);
  });

  it("rejects old, partial, and extra initial effect checklist keys", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const checklistCases = [
      {
        ...emptyEffectsChecklist(),
        activeLearning: null,
        customerStage: null,
      },
      {
        summary: null,
        analytics: null,
        realtime: null,
        usage: null,
      },
      { ...emptyEffectsChecklist(), extra: null },
    ];

    for (const checklist of checklistCases) {
      await expect(
        Promise.resolve().then(() =>
          new ConversationAnalysisRevision(
            readyRevision({
              effects: pendingInitialEffects({ checklist }),
            })
          ).validate()
        )
      ).rejects.toThrow(/effects|strict/i);
    }
  });

  it("validates safe source revisions, record projections, and exact initial effects", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");

    for (const sourceRevision of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        new ConversationAnalysisRevision(
          readyRevision({ sourceRevision })
        ).validate()
      ).rejects.toThrow(/sourceRevision|safe integer/i);
    }
    for (const projection of [[], "not-a-record", 42, completedAt]) {
      await expect(
        new ConversationAnalysisRevision(
          readyRevision({ projection })
        ).validate()
      ).rejects.toThrow(/projection/i);
    }

    for (const effects of [
      pendingInitialEffects({ status: "processing" }),
      pendingInitialEffects({ attemptCount: 1 }),
      pendingInitialEffects({ fence: 1 }),
      pendingInitialEffects({ nextAttemptAt: new Date("invalid") }),
      pendingInitialEffects({ completedAt }),
      pendingInitialEffects({
        lease: {
          ownerToken: "owner-1",
          claimedAt: completedAt,
          expiresAt: completedAt,
        },
      }),
      pendingInitialEffects({
        checklist: { ...emptyEffectsChecklist(), webhook: completedAt },
      }),
    ]) {
      await expect(
        new ConversationAnalysisRevision(readyRevision({ effects })).validate()
      ).rejects.toThrow(/effects/i);
    }

    for (const effects of [
      reviewInitialEffects({ status: "pending" }),
      reviewInitialEffects({ attemptCount: 1 }),
      reviewInitialEffects({ fence: 1 }),
      reviewInitialEffects({ nextAttemptAt: completedAt }),
      reviewInitialEffects({
        completedAt: new Date("2026-08-10T10:01:00.000Z"),
      }),
      reviewInitialEffects({
        lease: {
          ownerToken: "owner-1",
          claimedAt: completedAt,
          expiresAt: completedAt,
        },
      }),
      reviewInitialEffects({
        checklist: { ...emptyEffectsChecklist(), summary: completedAt },
      }),
    ]) {
      await expect(
        new ConversationAnalysisRevision(
          readyRevision({
            outcome: "review_required",
            projection: null,
            review: { code: "safety_blocked", reason: "provider_safety" },
            effectInputs: null,
            effects,
          })
        ).validate()
      ).rejects.toThrow(/effects/i);
    }
  });

  it("rejects hydrated payload mutation while allowing effects bookkeeping", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const immutable = ConversationAnalysisRevision.hydrate({
      ...readyRevision(),
      _id: `${conversationId}:4`,
      createdAt: completedAt,
      updatedAt: completedAt,
    });

    immutable.set("projection", { category: "changed" });
    expect(immutable.getChanges()).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({ projection: { category: "changed" } }),
      })
    );
    await expect(immutable.save()).rejects.toThrow(/immutable.*projection/i);

    const immutableEffectInputs = ConversationAnalysisRevision.hydrate({
      ...readyRevision(),
      _id: `${conversationId}:4`,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    immutableEffectInputs.set("effectInputs.processingTimeMs", 5_000);
    await expect(immutableEffectInputs.save()).rejects.toThrow(
      /immutable.*effectInputs/i
    );

    const effectsOnly = ConversationAnalysisRevision.hydrate({
      ...readyRevision(),
      _id: `${conversationId}:4`,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    effectsOnly.set("effects.status", "completed");
    effectsOnly.set("effects.fence", 1);
    const updateSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true, matchedCount: 1 } as never);
    await expect(effectsOnly.save()).resolves.toBe(effectsOnly);
    updateSpy.mockRestore();
  });

  it("rejects query payload mutation and permits effects-only updates", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const updateSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true, matchedCount: 1 } as never);
    const replaceSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "replaceOne")
      .mockResolvedValue({ acknowledged: true, matchedCount: 1 } as never);

    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        { $set: { "projection.category": "changed" } }
      ).exec()
    ).rejects.toThrow(/immutable.*projection/i);
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        { $set: { "provenance.taxonomyDigest": "changed" } }
      ).exec()
    ).rejects.toThrow(/immutable.*provenance/i);
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        { $set: { "effectInputs.processingTimeMs": 5_000 } }
      ).exec()
    ).rejects.toThrow(/immutable.*effectInputs/i);
    await expect(
      ConversationAnalysisRevision.replaceOne(
        { _id: `${conversationId}:4` },
        { ...readyRevision(), projection: { category: "changed" } }
      ).exec()
    ).rejects.toThrow(/immutable/i);
    await expect(
      ConversationAnalysisRevision.replaceOne({ _id: `${conversationId}:4` }, {
        effects: {
          status: "completed",
          attemptCount: 1,
          fence: 1,
          nextAttemptAt: null,
          completedAt,
          lease: null,
          checklist: emptyEffectsChecklist(),
        },
      } as never).exec()
    ).rejects.toThrow(/immutable/i);

    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        {
          $set: { "effects.status": "completed" },
          $inc: { "effects.fence": 1 },
        }
      ).exec()
    ).resolves.toEqual(expect.objectContaining({ acknowledged: true }));

    const readyImmutableInsert = {
      conversationId,
      workspaceId: "workspace-1",
      sourceRevision: 4,
      completedAt,
      outcome: "ready",
      projection: { category: "sales" },
      review: null,
      effectInputs: validEffectInputs(),
      provenance: {
        taxonomyId: "taxonomy-1",
        taxonomyDigest: "digest-1",
        classifierVersion: "classifier-1",
        classifierContractRevision: 2,
      },
      effects: pendingInitialEffects(),
    };
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        {
          $setOnInsert: readyImmutableInsert,
        },
        { upsert: true }
      ).exec()
    ).resolves.toEqual(expect.objectContaining({ acknowledged: true }));
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: "arbitrary-id" },
        {
          $setOnInsert: readyImmutableInsert,
        },
        { upsert: true }
      ).exec()
    ).rejects.toThrow(/canonical/i);
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        {
          $setOnInsert: {
            ...readyImmutableInsert,
            outcome: "review_required",
            projection: { category: "inconsistent" },
            review: null,
          },
        },
        { upsert: true }
      ).exec()
    ).rejects.toThrow(/outcome|projection|review/i);

    const reviewImmutableInsert = {
      ...readyImmutableInsert,
      outcome: "review_required",
      projection: null,
      review: { code: "safety_blocked", reason: "provider_safety" },
      effectInputs: null,
      effects: reviewInitialEffects(),
    };
    await expect(
      ConversationAnalysisRevision.updateOne(
        { _id: `${conversationId}:4` },
        { $setOnInsert: reviewImmutableInsert },
        { upsert: true }
      ).exec()
    ).resolves.toEqual(expect.objectContaining({ acknowledged: true }));

    const missingEffectsInsert: Record<string, unknown> = {
      ...readyImmutableInsert,
    };
    delete missingEffectsInsert.effects;
    const missingEffectInputsInsert: Record<string, unknown> = {
      ...readyImmutableInsert,
    };
    delete missingEffectInputsInsert.effectInputs;
    const partialEffectsInsert = {
      ...readyImmutableInsert,
      effects: {
        ...pendingInitialEffects(),
        checklist: {
          summary: null,
          analytics: null,
          realtime: null,
          usage: null,
        },
      },
    };
    for (const update of [
      { $setOnInsert: missingEffectsInsert },
      { $setOnInsert: missingEffectInputsInsert },
      {
        $setOnInsert: {
          ...readyImmutableInsert,
          effectInputs: validEffectInputs({
            predictedCategoryConfidence: "0.5",
          }),
        },
      },
      {
        $setOnInsert: {
          ...readyImmutableInsert,
          effectInputs: validEffectInputs({
            source: { id: null, type: null, extra: true },
          }),
        },
      },
      { $setOnInsert: partialEffectsInsert },
      {
        $setOnInsert: readyImmutableInsert,
        $set: { "effects.status": "pending" },
      },
      {
        $setOnInsert: readyImmutableInsert,
        $inc: { "effects.fence": 1 },
      },
      {
        $setOnInsert: readyImmutableInsert,
        $unset: { "effects.lease": "" },
      },
      {
        $setOnInsert: readyImmutableInsert,
        "effects.status": "pending",
      },
      {
        $setOnInsert: readyImmutableInsert,
        $rename: { updatedAt: "effects.status" },
      },
      {
        $setOnInsert: {
          ...reviewImmutableInsert,
          effects: reviewInitialEffects({
            completedAt: new Date("2026-08-10T10:01:00.000Z"),
          }),
        },
      },
      {
        $setOnInsert: {
          ...readyImmutableInsert,
          projection: completedAt,
        },
      },
    ]) {
      await expect(
        ConversationAnalysisRevision.updateOne(
          { _id: `${conversationId}:4` },
          update,
          { upsert: true }
        ).exec()
      ).rejects.toThrow(/effect|upsert/i);
    }

    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(replaceSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
    replaceSpy.mockRestore();
  });

  it("applies immutable payload guards to bulk updates", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const bulkWriteSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "bulkWrite")
      .mockResolvedValue({ acknowledged: true, modifiedCount: 1 } as never);

    await expect(
      ConversationAnalysisRevision.bulkWrite([
        {
          updateOne: {
            filter: { _id: `${conversationId}:4` },
            update: { $set: { "projection.category": "changed" } },
          },
        },
      ])
    ).rejects.toThrow(/immutable.*projection/i);

    await expect(
      ConversationAnalysisRevision.bulkWrite(
        [
          {
            insertOne: {
              document: {
                ...readyRevision(),
                _id: `${conversationId}:4`,
              },
            },
          },
        ],
        { skipValidation: true }
      )
    ).rejects.toThrow(/append-only|bulk.*insert/i);
    await expect(
      ConversationAnalysisRevision.bulkWrite([
        { deleteOne: { filter: { _id: `${conversationId}:4` } } },
      ])
    ).rejects.toThrow(/append-only|delete/i);
    await expect(
      ConversationAnalysisRevision.bulkWrite([
        { deleteMany: { filter: { conversationId } } },
      ])
    ).rejects.toThrow(/append-only|delete/i);

    await expect(
      ConversationAnalysisRevision.bulkWrite([
        {
          updateOne: {
            filter: { _id: `${conversationId}:4` },
            update: { $inc: { "effects.fence": 1 } },
          },
        },
      ])
    ).resolves.toEqual(expect.objectContaining({ acknowledged: true }));

    const readyImmutableInsert = {
      ...readyRevision(),
      _id: `${conversationId}:4`,
    };
    await expect(
      ConversationAnalysisRevision.bulkWrite([
        {
          updateOne: {
            filter: { _id: `${conversationId}:4` },
            update: { $setOnInsert: readyImmutableInsert as never },
            upsert: true,
          },
        },
      ])
    ).resolves.toEqual(expect.objectContaining({ acknowledged: true }));
    await expect(
      ConversationAnalysisRevision.bulkWrite([
        {
          updateOne: {
            filter: { _id: `${conversationId}:4` },
            update: {
              $setOnInsert: {
                ...readyImmutableInsert,
                effectInputs: validEffectInputs({ processingTimeMs: "1250" }),
              } as never,
            },
            upsert: true,
          },
        },
      ])
    ).rejects.toThrow(/effect input/i);

    expect(bulkWriteSpy).toHaveBeenCalledTimes(2);
    bulkWriteSpy.mockRestore();
  });

  it("blocks query deletion APIs for append-only analysis revisions", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const deleteOneSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "deleteOne")
      .mockResolvedValue({ acknowledged: true, deletedCount: 1 } as never);
    const deleteManySpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "deleteMany")
      .mockResolvedValue({ acknowledged: true, deletedCount: 1 } as never);
    const findOneAndDeleteSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "findOneAndDelete")
      .mockResolvedValue({
        ...readyRevision(),
        _id: `${conversationId}:4`,
      } as never);

    try {
      await expect(
        ConversationAnalysisRevision.deleteOne({
          _id: `${conversationId}:4`,
        }).exec()
      ).rejects.toThrow(/append-only|delete/i);
      await expect(
        ConversationAnalysisRevision.deleteMany({ conversationId }).exec()
      ).rejects.toThrow(/append-only|delete/i);
      await expect(
        ConversationAnalysisRevision.findOneAndDelete({
          _id: `${conversationId}:4`,
        }).exec()
      ).rejects.toThrow(/append-only|delete/i);
      expect(deleteOneSpy).not.toHaveBeenCalled();
      expect(deleteManySpy).not.toHaveBeenCalled();
      expect(findOneAndDeleteSpy).not.toHaveBeenCalled();
    } finally {
      deleteOneSpy.mockRestore();
      deleteManySpy.mockRestore();
      findOneAndDeleteSpy.mockRestore();
    }
  });

  it("blocks document deletion and insertMany bypasses", async () => {
    const { ConversationAnalysisRevision } = jest.requireActual<
      typeof import("@/models/conversation-analysis-revision")
    >("@/models/conversation-analysis-revision");
    const deleteOneSpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "deleteOne")
      .mockResolvedValue({ acknowledged: true, deletedCount: 1 } as never);
    const insertManySpy = jest
      .spyOn(ConversationAnalysisRevision.collection, "insertMany")
      .mockResolvedValue({ acknowledged: true, insertedCount: 1 } as never);
    const hydrated = ConversationAnalysisRevision.hydrate({
      ...readyRevision(),
      _id: `${conversationId}:4`,
      createdAt: completedAt,
      updatedAt: completedAt,
    });

    try {
      await expect(hydrated.deleteOne()).rejects.toThrow(/append-only|delete/i);
      await expect(
        ConversationAnalysisRevision.insertMany([
          { ...readyRevision(), _id: `${conversationId}:4` },
        ])
      ).rejects.toThrow(/append-only|insertMany/i);
      expect(deleteOneSpy).not.toHaveBeenCalled();
      expect(insertManySpy).not.toHaveBeenCalled();
    } finally {
      deleteOneSpy.mockRestore();
      insertManySpy.mockRestore();
    }
  });
});
