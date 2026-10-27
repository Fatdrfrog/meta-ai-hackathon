import connectDB from "@/lib/mongoose";
import {
  Conversation,
  CONVERSATION_OFFLINE_EVAL_INDEX,
  CONVERSATION_REQUESTS_DEPENDENCY_INDEXES,
  CONVERSATION_VISIBILITY_GATE_INDEX_KEYS,
  CONVERSATION_VISIBILITY_GATE_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER,
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS,
  CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
  CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER,
  CONVERSATION_CLASSIFICATION_QUEUE_LEGACY_INDEX_NAME,
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS,
  CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME,
  CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER,
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS,
  CONVERSATION_SCENARIO_PENDING_WAIT_LEGACY_INDEX_NAME,
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME,
  CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER,
  CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC,
  CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC,
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS,
  CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME,
  CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_KEYS,
  CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_NAME,
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS,
  CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME,
} from "@/models/conversation";
import {
  RequestListItem,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME,
  REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER,
} from "@/models/request-list-item";
import {
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_KEYS,
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME,
  ANALYSIS_REVISION_DUE_EFFECTS_PARTIAL_FILTER,
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_KEYS,
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME,
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_PARTIAL_FILTER,
  ConversationAnalysisRevision,
} from "@/models/conversation-analysis-revision";
import Message, {
  MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX,
  MESSAGE_AIRI_INGRESS_PENDING_INDEX,
  MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX,
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS,
  MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
  MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS,
} from "@/models/message";
import MessageDeliveryEvent from "@/models/message-delivery-event";
import { ensureRealtimeEventIndexes } from "@/models/realtime-event";
import WhatsAppPendingMessageMutation from "@/models/whatsapp-pending-message-mutation";
import WhatsAppGroup from "@/models/whatsapp-group";
import WhatsAppGroupEvent from "@/models/whatsapp-group-event";
import {
  ScenarioFlowEvent,
  SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_KEYS,
  SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_OPTIONS,
  SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS,
  SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_OPTIONS,
  SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME,
} from "@/models/scenario-flow-event";
import { ScenarioFlowSuppression } from "@/models/scenario-flow-suppression";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import { ensureScenarioObservabilityIndexes } from "@/lib/scenarios/ensure-observability-indexes";
import { ensureConversationEngagementIndexes } from "@/lib/engagement/conversation-engagement";
import ScenarioLinkedCondition from "@/models/scenario-linked-condition";
import Customer, {
  CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS,
  CUSTOMER_CONTACT_PHONE_INDEX_KEYS,
  CUSTOMER_CONTACT_PHONE_INDEX_NAME,
  CUSTOMER_CRM_STAGE_INDEX_KEYS,
  CUSTOMER_CRM_STAGE_INDEX_NAME,
  CUSTOMER_OWNER_INDEX_KEYS,
  CUSTOMER_OWNER_INDEX_NAME,
  CUSTOMER_OWNER_INDEX_OPTIONS,
} from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import ScenarioBehaviorRun from "@/models/scenario-behavior-run";
import WebsiteCart from "@/models/website-cart";
import WebsiteCommerceSettings from "@/models/website-commerce-settings";
import WebsiteCommerceEvent from "@/models/website-commerce-event";
import CustomerContactPolicy from "@/models/customer-contact-policy";
import CustomerContactReservation from "@/models/customer-contact-reservation";
import { Scenario, SCENARIO_LIST_ORDER_INDEX_KEYS } from "@/models/scenario";
import { AiriArtifact, AiriArtifactVersion } from "@/models/airi-artifact";
import { createCreativeAssetGenerationIndexes } from "@/lib/creative-assets/creative-asset-generation-indexes";
import { CreativeVideoPlan } from "@/models/creative-video-plan";
import { ensurePlatformCreativeGenerationQuotaIndexes } from "@/models/platform-creative-generation-quota-claim";
import { ensureTikTokPlatformCredentialIndexes } from "@/models/tiktok-platform-credential";
import { ensureWhatsAppIdentityIndexes } from "@/lib/whatsapp/identity/indexes";
import { WhatsAppFlowEndpointSecurity } from "@/models/whatsapp-flow-endpoint-security";
import { WhatsAppFlowProvisioningOperation } from "@/models/whatsapp-flow-provisioning-operation";
import { WhatsAppFlowSourceBindingFence } from "@/models/whatsapp-flow-source-binding-fence";
import { WhatsAppFlowSession } from "@/models/whatsapp-flow-session";
import { WhatsAppTemplateAnalyticsDaily } from "@/models/whatsapp-template-analytics-daily";
import { WhatsAppAnalyticsHealthDaily } from "@/models/whatsapp-analytics-health-daily";
import {
  AnalyticsAcquisitionEntry,
  AnalyticsAcquisitionMessageLink,
  AnalyticsConversionFact,
  AnalyticsCustomerPurchaseObservation,
  AnalyticsAcquisitionCheckpoint,
  AnalyticsAcquisitionDaily,
} from "@/models/analytics-acquisition";
import { AnalyticsPolicy } from "@/models/analytics-policy";
import {
  AnalyticsServiceLifecycleFact,
  AnalyticsServiceLifecycleCheckpoint,
  AnalyticsCustomerStageCheckpoint,
} from "@/models/analytics-service-lifecycle";
import { ensureWhatsAppQrEntryPointIndexes } from "@/lib/whatsapp/qr-entry-points/indexes";
import { WhatsAppQrCode } from "@/models/whatsapp-qr-code";
import { WhatsAppQrOperation } from "@/models/whatsapp-qr-operation";
import AiriTurnContext from "@/models/airi-turn-context";
import { AiriChatMessage } from "@/models/airi-chat-message";
import { AiriChatRun } from "@/models/airi-chat-run";
import { AiriChatThread } from "@/models/airi-chat-thread";
import { BusinessLocation } from "@/models/business-location";
import CrossStoreOutbox, {
  CROSS_STORE_OUTBOX_INDEX_SPECS,
} from "@/models/cross-store-outbox";
import LlmEvaluationReviewItem, {
  LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX,
  LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME,
} from "@/models/llm-evaluation-review-item";

type MongoIndexCache = {
  ensured: boolean;
  ensurePromise: Promise<void> | null;
};

const globalForMongoIndexes = globalThis as typeof globalThis & {
  __mongoIndexCache?: MongoIndexCache;
};

const mongoIndexCache: MongoIndexCache =
  globalForMongoIndexes.__mongoIndexCache ?? {
    ensured: false,
    ensurePromise: null,
  };

globalForMongoIndexes.__mongoIndexCache = mongoIndexCache;

type PersistedMongoIndex = {
  collation?: Record<string, unknown>;
  hidden?: boolean;
  expireAfterSeconds?: number;
  key?: Record<string, unknown>;
  name?: string;
  partialFilterExpression?: Record<string, unknown>;
  sparse?: boolean;
  unique?: boolean;
};

type ManagedMongoIndexSpec = {
  key: Record<string, 1 | -1>;
  options: {
    background?: boolean;
    expireAfterSeconds?: number;
    name: string;
    partialFilterExpression?: Record<string, unknown>;
    unique?: true;
  };
};

type DuplicateIndexGroup = Record<string, unknown> & {
  duplicateCount?: unknown;
  sampleDocumentId?: unknown;
};

const DUPLICATE_INDEX_EVIDENCE_LIMIT = 10;
const DUPLICATE_INDEX_AUDIT_LIMIT = DUPLICATE_INDEX_EVIDENCE_LIMIT + 1;

function sameIndexRecord(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchesManagedMongoIndex(
  actual: PersistedMongoIndex | undefined,
  expected: ManagedMongoIndexSpec
): boolean {
  return Boolean(
    actual &&
      actual.name === expected.options.name &&
      sameIndexRecord(actual.key, expected.key) &&
      sameIndexRecord(
        actual.partialFilterExpression,
        expected.options.partialFilterExpression
      ) &&
      actual.expireAfterSeconds === expected.options.expireAfterSeconds &&
      actual.sparse !== true &&
      actual.hidden !== true &&
      actual.collation === undefined &&
      (actual.unique === true) === (expected.options.unique === true)
  );
}

function matchesKnownLlmReviewItemLegacyDedupeIndex(
  actual: PersistedMongoIndex
): boolean {
  if (
    actual.name !== LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME ||
    !sameIndexRecord(actual.key, LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX.key) ||
    actual.unique !== true ||
    actual.expireAfterSeconds !== undefined
  ) {
    return false;
  }

  const isSparseLegacy =
    actual.sparse === true && actual.partialFilterExpression === undefined;
  const isPriorPartialDefinition =
    actual.sparse !== true &&
    sameIndexRecord(
      actual.partialFilterExpression,
      LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX.options.partialFilterExpression
    );
  return isSparseLegacy || isPriorPartialDefinition;
}

function isMissingMongoNamespace(error: unknown): boolean {
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound";
}

function isMissingMongoIndex(error: unknown): boolean {
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 27 || mongoError.codeName === "IndexNotFound";
}

function isConflictingMongoIndex(error: unknown): boolean {
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return (
    mongoError.code === 85 ||
    mongoError.code === 86 ||
    mongoError.codeName === "IndexOptionsConflict" ||
    mongoError.codeName === "IndexKeySpecsConflict"
  );
}

/** Preserve an equivalent ordinary index under a custom name. */
async function ensureOrdinaryMongoIndex(params: {
  key: Record<string, 1 | -1>;
  createIndex: () => Promise<unknown>;
  readIndexes: () => Promise<unknown>;
}): Promise<void> {
  try {
    await params.createIndex();
  } catch (error) {
    if (!isConflictingMongoIndex(error)) throw error;
    const indexes = await readManagedMongoIndexes(params.readIndexes);
    const equivalent = indexes.some(
      index =>
        typeof index.name === "string" &&
        matchesManagedMongoIndex(index, {
          key: params.key,
          options: { name: index.name },
        })
    );
    if (!equivalent) throw error;
  }
}

async function readManagedMongoIndexes(
  readIndexes: () => Promise<unknown>
): Promise<PersistedMongoIndex[]> {
  try {
    return (await readIndexes()) as PersistedMongoIndex[];
  } catch (error) {
    if (isMissingMongoNamespace(error)) return [];
    throw error;
  }
}

function inspectManagedMongoIndexes(
  actualIndexes: PersistedMongoIndex[],
  expectedIndexes: readonly ManagedMongoIndexSpec[]
): {
  invalid: string[];
  missing: string[];
} {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const expected of expectedIndexes) {
    const actual = actualIndexes.find(
      index => index.name === expected.options.name
    );
    if (!actual) {
      missing.push(expected.options.name);
    } else if (!matchesManagedMongoIndex(actual, expected)) {
      invalid.push(expected.options.name);
    }
  }

  return { invalid, missing };
}

function boundedIndexEvidenceValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

function boundedDuplicateCount(value: unknown): number | null {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 2) return null;
  return count;
}

function throwDuplicateIndexPreflightError(params: {
  evidenceFields: readonly string[];
  groups: DuplicateIndexGroup[];
  label: string;
  remediationKey: string;
}): never {
  const evidence = params.groups
    .slice(0, DUPLICATE_INDEX_EVIDENCE_LIMIT)
    .map(group => {
      const item: Record<string, string | number | null> = {};
      for (const field of params.evidenceFields) {
        item[field] = boundedIndexEvidenceValue(group[field]);
      }
      item.duplicateCount = boundedDuplicateCount(group.duplicateCount);
      item.sampleDocumentId = boundedIndexEvidenceValue(group.sampleDocumentId);
      return item;
    });

  throw new Error(
    [
      `${params.label} unique index preflight found duplicate rows; no rows were modified.`,
      `Resolve the reported ${params.remediationKey} groups manually, then rerun pnpm --filter @icecore/web run ensure:mongo-indexes.`,
      `Evidence (showing ${evidence.length}${params.groups.length > DUPLICATE_INDEX_EVIDENCE_LIMIT ? ", additional groups omitted" : ""}): ${JSON.stringify(evidence)}`,
    ].join(" ")
  );
}

async function assertNoCrossStoreOutboxUniqueDuplicates(): Promise<void> {
  const duplicateGroups = (await CrossStoreOutbox.collection
    .aggregate(
      [
        {
          $group: {
            _id: {
              target: "$target",
              operation: "$operation",
              dedupeKey: "$dedupeKey",
            },
            duplicateCount: { $sum: 1 },
            sampleDocumentId: { $first: "$_id" },
          },
        },
        { $match: { duplicateCount: { $gt: 1 } } },
        {
          $sort: {
            duplicateCount: -1,
            "_id.target": 1,
            "_id.operation": 1,
            "_id.dedupeKey": 1,
          },
        },
        { $limit: DUPLICATE_INDEX_AUDIT_LIMIT },
        {
          $project: {
            _id: 0,
            target: "$_id.target",
            operation: "$_id.operation",
            dedupeKey: "$_id.dedupeKey",
            duplicateCount: 1,
            sampleDocumentId: 1,
          },
        },
      ],
      { allowDiskUse: true, maxTimeMS: 60_000 }
    )
    .toArray()) as DuplicateIndexGroup[];

  if (duplicateGroups.length === 0) return;

  throwDuplicateIndexPreflightError({
    evidenceFields: ["target", "operation", "dedupeKey"],
    groups: duplicateGroups,
    label: "Cross-store outbox",
    remediationKey: "target/operation/dedupeKey",
  });
}

async function assertNoLlmReviewItemUniqueDuplicates(): Promise<void> {
  const duplicateGroups = (await LlmEvaluationReviewItem.collection
    .aggregate(
      [
        { $match: { dedupeKey: { $type: "string" } } },
        {
          $group: {
            _id: {
              workspaceId: "$workspaceId",
              dedupeKey: "$dedupeKey",
            },
            duplicateCount: { $sum: 1 },
            sampleDocumentId: { $first: "$_id" },
          },
        },
        { $match: { duplicateCount: { $gt: 1 } } },
        {
          $sort: {
            duplicateCount: -1,
            "_id.workspaceId": 1,
            "_id.dedupeKey": 1,
          },
        },
        { $limit: DUPLICATE_INDEX_AUDIT_LIMIT },
        {
          $project: {
            _id: 0,
            workspaceId: "$_id.workspaceId",
            dedupeKey: "$_id.dedupeKey",
            duplicateCount: 1,
            sampleDocumentId: 1,
          },
        },
      ],
      { allowDiskUse: true, maxTimeMS: 60_000 }
    )
    .toArray()) as DuplicateIndexGroup[];

  if (duplicateGroups.length === 0) return;

  throwDuplicateIndexPreflightError({
    evidenceFields: ["workspaceId", "dedupeKey"],
    groups: duplicateGroups,
    label: "LLM evaluation review-item",
    remediationKey: "workspaceId/dedupeKey",
  });
}

async function reconcileManagedMongoIndexes(params: {
  auditUniqueDuplicates: () => Promise<void>;
  createIndex: (spec: ManagedMongoIndexSpec) => Promise<unknown>;
  indexes: readonly ManagedMongoIndexSpec[];
  label: string;
  persistedBefore?: PersistedMongoIndex[];
  readIndexes: () => Promise<unknown>;
}): Promise<PersistedMongoIndex[]> {
  const persistedBefore =
    params.persistedBefore ||
    (await readManagedMongoIndexes(params.readIndexes));
  const before = inspectManagedMongoIndexes(persistedBefore, params.indexes);
  if (before.invalid.length > 0) {
    throw new Error(
      `${params.label} index verification failed before reconciliation: invalid indexes ${before.invalid.join(", ")}. Refusing to replace indexes automatically.`
    );
  }

  const needsUniqueAudit = params.indexes.some(
    spec =>
      spec.options.unique === true && before.missing.includes(spec.options.name)
  );
  if (needsUniqueAudit) {
    await params.auditUniqueDuplicates();
  }

  const missing = new Set(before.missing);
  for (const spec of params.indexes) {
    if (!missing.has(spec.options.name)) continue;
    await params.createIndex(spec);
  }

  const persistedAfter = await readManagedMongoIndexes(params.readIndexes);
  const after = inspectManagedMongoIndexes(persistedAfter, params.indexes);
  if (after.invalid.length > 0 || after.missing.length > 0) {
    throw new Error(
      `${params.label} index verification failed after reconciliation: missing=${after.missing.join(",") || "none"}; invalid=${after.invalid.join(",") || "none"}.`
    );
  }
  return persistedAfter;
}

async function ensureCrossStoreOutboxIndexes(): Promise<void> {
  await reconcileManagedMongoIndexes({
    auditUniqueDuplicates: assertNoCrossStoreOutboxUniqueDuplicates,
    createIndex: spec =>
      CrossStoreOutbox.collection.createIndex(spec.key, spec.options),
    indexes: CROSS_STORE_OUTBOX_INDEX_SPECS,
    label: "Cross-store outbox",
    readIndexes: () => CrossStoreOutbox.collection.indexes(),
  });
}

/** Additive repair for the cost audit; never drops or replaces stored indexes. */
export async function ensureMongoQueryIndexes(): Promise<void> {
  await connectDB();
  await reconcileManagedMongoIndexes({
    auditUniqueDuplicates: async () => {
      const groups = (await Message.collection
        .aggregate(
          [
            { $match: { temporalDeliveryKey: { $type: "string" } } },
            {
              $group: {
                _id: "$temporalDeliveryKey",
                duplicateCount: { $sum: 1 },
              },
            },
            { $match: { duplicateCount: { $gt: 1 } } },
            { $limit: DUPLICATE_INDEX_AUDIT_LIMIT },
            { $project: { _id: 0, duplicateCount: 1 } },
          ],
          { allowDiskUse: true, maxTimeMS: 60_000 }
        )
        .toArray()) as DuplicateIndexGroup[];
      if (groups.length > 0) {
        throwDuplicateIndexPreflightError({
          evidenceFields: [],
          groups,
          label: "Temporal delivery-key",
          remediationKey: "temporalDeliveryKey",
        });
      }
    },
    createIndex: spec => Message.collection.createIndex(spec.key, spec.options),
    indexes: [
      {
        key: MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.keys,
        options: MESSAGE_TEMPORAL_DELIVERY_KEY_INDEX.options,
      },
    ],
    label: "Temporal delivery-key",
    readIndexes: () => Message.collection.indexes(),
  });
  await reconcileManagedMongoIndexes({
    auditUniqueDuplicates: async () => {},
    createIndex: spec =>
      Conversation.collection.createIndex(spec.key, spec.options),
    indexes: CONVERSATION_REQUESTS_DEPENDENCY_INDEXES.map(
      ({ keys, options }) => ({ key: keys, options })
    ),
    label: "Requests dependency fanout",
    readIndexes: () => Conversation.collection.indexes(),
  });
  await reconcileManagedMongoIndexes({
    auditUniqueDuplicates: async () => {},
    createIndex: spec =>
      Conversation.collection.createIndex(spec.key, spec.options),
    indexes: [{
      key: CONVERSATION_OFFLINE_EVAL_INDEX.keys,
      options: CONVERSATION_OFFLINE_EVAL_INDEX.options,
    }],
    label: "Offline evaluation",
    readIndexes: () => Conversation.collection.indexes(),
  });
}

async function ensureLlmEvaluationReviewItemIndexes(): Promise<void> {
  const persistedBefore = await readManagedMongoIndexes(() =>
    LlmEvaluationReviewItem.collection.indexes()
  );
  const legacyIndex = persistedBefore.find(
    index => index.name === LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME
  );
  if (legacyIndex && !matchesKnownLlmReviewItemLegacyDedupeIndex(legacyIndex)) {
    throw new Error(
      `LLM evaluation review-item index verification failed before reconciliation: invalid legacy index ${LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME}. Refusing to replace indexes automatically.`
    );
  }

  await reconcileManagedMongoIndexes({
    auditUniqueDuplicates: assertNoLlmReviewItemUniqueDuplicates,
    createIndex: spec =>
      LlmEvaluationReviewItem.collection.createIndex(spec.key, spec.options),
    indexes: [LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX],
    label: "LLM evaluation review-item",
    persistedBefore,
    readIndexes: () => LlmEvaluationReviewItem.collection.indexes(),
  });

  if (!legacyIndex) return;
  try {
    await LlmEvaluationReviewItem.collection.dropIndex(
      LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME
    );
  } catch (error) {
    if (!isMissingMongoIndex(error)) throw error;
  }

  const persistedAfterMigration = await readManagedMongoIndexes(() =>
    LlmEvaluationReviewItem.collection.indexes()
  );
  if (
    persistedAfterMigration.some(
      index =>
        index.name === LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME
    )
  ) {
    throw new Error(
      `LLM evaluation review-item legacy index migration failed: ${LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME} is still present.`
    );
  }
}

/** Keep the old token fence until both narrower replacement fences are verified. */
async function ensureScenarioFlowSubmissionIndexes() {
  const readIndexes = () =>
    readManagedMongoIndexes(() => ScenarioFlowEvent.collection.indexes());
  const specs: ManagedMongoIndexSpec[] = [
    {
      key: SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_KEYS,
      options: {
        ...SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_OPTIONS,
        unique: true,
      },
    },
    {
      key: SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS,
      options: { ...SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_OPTIONS, unique: true },
    },
  ];
  const before = await readIndexes();
  const legacy = before.find(
    index => index.name === SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME
  );
  if (
    legacy &&
    (!legacy.unique ||
      !sameIndexRecord(legacy.key, SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS) ||
      !sameIndexRecord(legacy.partialFilterExpression, {
        flowToken: { $type: "string" },
        eventType: "submitted",
      }))
  ) {
    throw new Error("Unknown Flow submission legacy index definition");
  }
  for (const spec of specs) {
    try {
      await ScenarioFlowEvent.collection.createIndex(spec.key, spec.options);
    } catch {
      throw new Error("Flow submission identity indexes unavailable");
    }
  }
  const installed = await readIndexes();
  if (
    !specs.every(spec =>
      installed.some(
        index => matchesManagedMongoIndex(index, spec)
      )
    )
  )
    throw new Error("Flow submission replacement indexes not verified");
  if (legacy) {
    try {
      await ScenarioFlowEvent.collection.dropIndex(
        SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME
      );
    } catch (error) {
      if (!isMissingMongoIndex(error)) throw error;
    }
    if (
      (await readIndexes()).some(
        index => index.name === SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME
      )
    )
      throw new Error("Flow submission legacy index migration incomplete");
  }
}

/**
 * Schema-declared Airi chat indexes (threads, messages, runs). Connections run
 * with autoIndex off, so without this the collections keep only `_id` and
 * every history or thread-list read scans the collection; the runs' unique
 * client-turn index is what makes a retried send attach to its run instead
 * of starting a second one. Additive only.
 */
export async function ensureAiriChatIndexes(): Promise<void> {
  await connectDB();
  await AiriChatThread.createIndexes();
  await AiriChatMessage.createIndexes();
  await AiriChatRun.createIndexes();
}

async function createIndexes() {
  await connectDB();
  await ensureMongoQueryIndexes();
  await ensureWhatsAppIdentityIndexes();
  await WhatsAppFlowEndpointSecurity.createIndexes();
  await WhatsAppFlowProvisioningOperation.createIndexes();
  await WhatsAppFlowSourceBindingFence.createIndexes();
  await WhatsAppFlowSession.createIndexes();
  await WhatsAppTemplateAnalyticsDaily.createIndexes();
  await WhatsAppAnalyticsHealthDaily.createIndexes();
  await AnalyticsAcquisitionEntry.createIndexes();
  await AnalyticsAcquisitionMessageLink.createIndexes();
  await AnalyticsConversionFact.createIndexes();
  await AnalyticsCustomerPurchaseObservation.createIndexes();
  await AnalyticsAcquisitionCheckpoint.createIndexes();
  await AnalyticsAcquisitionDaily.createIndexes();
  await AnalyticsPolicy.createIndexes();
  await AnalyticsServiceLifecycleFact.createIndexes();
  await AnalyticsServiceLifecycleCheckpoint.createIndexes();
  await AnalyticsCustomerStageCheckpoint.createIndexes();
  // Independent keyset reconciliation does not share the live updatedAt cursor.
  await Message.collection.createIndex({ workspaceId: 1, _id: 1 });
  await Conversation.collection.createIndex({ workspaceId: 1, _id: 1 });
  await Customer.collection.createIndex({ workspaceId: 1, _id: 1 });
  await Message.collection.createIndex({
    workspaceId: 1,
    updatedAt: 1,
    _id: 1,
  });
  await Message.collection.createIndex({
    workspaceId: 1,
    conversation: 1,
    date: 1,
  });
  await Conversation.collection.createIndex({
    workspaceId: 1,
    updatedAt: 1,
    _id: 1,
  });
  await Message.collection.createIndex({
    workspaceId: 1,
    conversation: 1,
    direction: 1,
    date: 1,
    _id: 1,
  });
  await ensureWhatsAppQrEntryPointIndexes();
  await WhatsAppQrCode.createIndexes();
  await WhatsAppQrOperation.createIndexes();
  await AiriTurnContext.createIndexes();
  await ensureAiriChatIndexes();
  await BusinessLocation.createIndexes();
  await CustomerEvent.createIndexes();
  await ensureScenarioFlowSubmissionIndexes();
  await ScenarioFlowEvent.collection.createIndex({
    workspaceId: 1,
    eventType: 1,
    eventAt: 1,
    sourceId: 1,
  });
  await ScenarioFlowEvent.collection.createIndex({
    workspaceId: 1,
    conversationId: 1,
    eventType: 1,
    eventAt: 1,
    _id: 1,
  });
  await ScenarioFlowEvent.collection.createIndex({
    workspaceId: 1,
    conversationId: 1,
    flowToken: 1,
    eventAt: 1,
  });
  await ScenarioBehaviorRun.createIndexes();
  await WebsiteCart.createIndexes();
  await WebsiteCommerceSettings.createIndexes();
  await WebsiteCommerceEvent.createIndexes();
  await CustomerContactPolicy.createIndexes();
  await CustomerContactReservation.createIndexes();
  await Scenario.collection.createIndex({
    workspaceId: 1,
    status: 1,
    "nodes.data.triggerConfig.entryPointType": 1,
    _id: 1,
  });
  await ensureOrdinaryMongoIndex({
    key: SCENARIO_LIST_ORDER_INDEX_KEYS,
    createIndex: () =>
      Scenario.collection.createIndex(SCENARIO_LIST_ORDER_INDEX_KEYS),
    readIndexes: () => Scenario.collection.indexes(),
  });
  await ensureCrossStoreOutboxIndexes();
  await ensureLlmEvaluationReviewItemIndexes();
  // Provision ownership before activating writers; failures must fail deployment.
  for (const spec of [CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC, CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC]) {
    await Conversation.collection.createIndex(spec.keys, spec.options);
  }
  // Conversation indexes (some are defined in schema too)
  await Conversation.collection.createIndex(
    CONVERSATION_VISIBILITY_GATE_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_VISIBILITY_GATE_INDEX_NAME,
    }
  );
  await RequestListItem.collection.createIndex(
    REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS,
    {
      background: true,
      name: REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME,
      partialFilterExpression: REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER,
    }
  );
  await Conversation.collection.createIndex(
    { workspaceId: 1, lastMessageAt: -1 },
    { background: true }
  );
  await Conversation.collection.createIndex(
    { workspaceId: 1, is_read_by_manager: 1, lastMessageAt: -1 },
    { background: true }
  );
  await Conversation.collection.createIndex(
    CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME,
      partialFilterExpression:
        CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER,
    }
  );
  try {
    await Conversation.collection.dropIndex(
      CONVERSATION_SCENARIO_PENDING_WAIT_LEGACY_INDEX_NAME
    );
  } catch (error) {
    const indexError = error as { code?: unknown; codeName?: unknown };
    if (indexError.code !== 27 && indexError.codeName !== "IndexNotFound") {
      throw error;
    }
  }
  await Conversation.collection.createIndex(
    CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME,
    }
  );
  await Conversation.collection.createIndex(
    CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME,
    }
  );
  await Conversation.collection.createIndex(
    CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_NAME,
      partialFilterExpression: { "whatsappGroup.groupId": { $type: "string" } },
    }
  );

  // Message indexes
  await ensureConversationEngagementIndexes();
  await Message.collection.createIndex(
    MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.keys,
    MESSAGE_WHATSAPP_INBOUND_DEDUPE_INDEX.options
  );
  await Message.collection.createIndex(
    MESSAGE_AIRI_INGRESS_PENDING_INDEX.keys,
    MESSAGE_AIRI_INGRESS_PENDING_INDEX.options
  );
  await Message.collection.createIndex({
    workspaceId: 1,
    "external_ids.messageId": 1,
  });
  await Message.collection.createIndex(
    { conversation: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { conversation: 1, date: 1, _id: 1 },
    { background: true }
  );
  await Message.collection.createIndex(
    MESSAGE_REQUEST_AIRI_WITNESS_INDEX_KEYS,
    {
      background: true,
      name: MESSAGE_REQUEST_AIRI_WITNESS_INDEX_NAME,
    }
  );
  await Message.collection.createIndex(
    { conversation: 1, direction: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { conversation: 1, whatsappWamidFingerprint: 1 },
    {
      background: true,
      sparse: true,
      name: "messages_conversation_whatsapp_wamid_fingerprint",
    }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, channel: 1, direction: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    MESSAGE_WORKSPACE_DIRECTION_DATE_INDEX_KEYS,
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, channel: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { direction: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, channel: 1, direction: 1, messageId: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    {
      workspaceId: 1,
      channel: 1,
      direction: 1,
      "origin.templateName": 1,
      date: -1,
    },
    { background: true }
  );
  await Message.collection.createIndex(
    {
      workspaceId: 1,
      channel: 1,
      direction: 1,
      "whatsappTemplate.name": 1,
      date: -1,
    },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, conversation: 1, channel: 1, direction: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, conversation: 1, channel: 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, "origin.kind": 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, "origin.campaignId": 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
    { workspaceId: 1, "delivery.status": 1, date: -1 },
    { background: true }
  );
  await Message.collection.createIndex(
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
  await WhatsAppPendingMessageMutation.collection.createIndex(
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
  await MessageDeliveryEvent.collection.createIndex(
    { workspaceId: 1, messageId: 1, status: 1, eventAt: 1 },
    { background: true }
  );
  await MessageDeliveryEvent.collection.createIndex(
    { workspaceId: 1, conversationId: 1, eventAt: -1 },
    { background: true }
  );
  await MessageDeliveryEvent.collection.createIndex(
    { workspaceId: 1, campaignId: 1, eventAt: -1 },
    { background: true }
  );
  // Both canonical facts own an atomic pending marker; drain only pending rows.
  for (const [model, name] of [
    [Message, "messages_customer_webhook_pending_v1"],
    [MessageDeliveryEvent, "message_delivery_customer_webhook_pending_v1"],
  ] as const) {
    await model.collection.createIndex(
      { "customerWebhookIntent.timestamp": 1, _id: 1 },
      {
        background: true,
        name,
        partialFilterExpression: { customerWebhookIntent: { $exists: true } },
      }
    );
  }
  await WhatsAppGroup.collection.createIndex(
    { workspaceId: 1, sourceId: 1, groupId: 1 },
    { background: true, unique: true }
  );
  await WhatsAppGroup.collection.createIndex(
    { workspaceId: 1, phoneNumberId: 1, status: 1 },
    { background: true }
  );
  await WhatsAppGroupEvent.collection.createIndex(
    { workspaceId: 1, sourceId: 1, groupId: 1, eventAt: -1 },
    { background: true }
  );
  await WhatsAppGroupEvent.collection.createIndex(
    { workspaceId: 1, phoneNumberId: 1, field: 1, eventAt: -1 },
    { background: true }
  );
  try {
    await Conversation.collection.dropIndex(
      CONVERSATION_CLASSIFICATION_QUEUE_LEGACY_INDEX_NAME
    );
  } catch (error) {
    const indexError = error as { code?: unknown; codeName?: unknown };
    if (indexError.code !== 27 && indexError.codeName !== "IndexNotFound") {
      throw error;
    }
  }
  await Conversation.collection.createIndex(
    CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
      partialFilterExpression:
        CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER,
    }
  );
  await ensureRealtimeEventIndexes();
  await Conversation.collection.createIndex(
    CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
      partialFilterExpression:
        CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER,
    }
  );
  await ConversationAnalysisRevision.collection.createIndex(
    ANALYSIS_REVISION_DUE_EFFECTS_INDEX_KEYS,
    {
      background: true,
      name: ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME,
      partialFilterExpression: ANALYSIS_REVISION_DUE_EFFECTS_PARTIAL_FILTER,
    }
  );
  await ConversationAnalysisRevision.collection.createIndex(
    ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_KEYS,
    {
      background: true,
      name: ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME,
      partialFilterExpression:
        ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_PARTIAL_FILTER,
    }
  );
  await Conversation.collection.createIndex(
    CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
    }
  );
  await Conversation.collection.createIndex(
    CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS,
    {
      background: true,
      name: CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME,
      partialFilterExpression:
        CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER,
    }
  );
  await ScenarioLinkedCondition.collection.createIndex(
    { workspaceId: 1, childScenarioId: 1 },
    { unique: true, background: true }
  );
  await ScenarioLinkedCondition.collection.createIndex(
    { workspaceId: 1, "parentRefs.parentScenarioId": 1 },
    { background: true }
  );
  await ScenarioFlowEvent.collection.createIndex(
    { workspaceId: 1, eventAt: -1 },
    {
      background: true,
      name: "scenario_flow_events_workspace_event_at_desc",
      partialFilterExpression: {
        scenarioId: { $type: "string" },
      },
    }
  );
  await ScenarioFlowEvent.collection.createIndex(
    { workspaceId: 1, evaluationId: 1, eventAt: -1 },
    {
      background: true,
      name: "scenario_flow_events_workspace_evaluation_event_at_desc",
      partialFilterExpression: {
        evaluationId: { $type: "string" },
      },
    }
  );
  await ScenarioFlowSuppression.collection.createIndex(
    { workspaceId: 1, flowId: 1, reason: 1 },
    { unique: true, background: true }
  );
  await ScenarioFlowSuppression.collection.createIndex(
    { workspaceId: 1, flowId: 1, resolvedAt: 1, expiresAt: 1 },
    { background: true }
  );
  await ScenarioFlowSuppression.collection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, background: true }
  );
  await ScenarioTriggerLog.collection.createIndex(
    { workspaceId: 1, evaluatedAt: -1 },
    {
      background: true,
      name: "scenario_trigger_logs_workspace_evaluated_at_desc",
    }
  );
  await ensureScenarioObservabilityIndexes();
  await Customer.collection.createIndex(CUSTOMER_CRM_STAGE_INDEX_KEYS, {
    background: true,
    name: CUSTOMER_CRM_STAGE_INDEX_NAME,
  });
  await Customer.collection.createIndex(CUSTOMER_CONTACT_PHONE_INDEX_KEYS, {
    background: true,
    name: CUSTOMER_CONTACT_PHONE_INDEX_NAME,
  });
  // Preserve the existing generated index name while provisioning both arms
  // of the canonical customer phone lookup through the deployment gate.
  await Customer.collection.createIndex(CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS, {
    background: true,
  });
  await Customer.collection.createIndex(CUSTOMER_OWNER_INDEX_KEYS, {
    background: true,
    name: CUSTOMER_OWNER_INDEX_NAME,
    partialFilterExpression:
      CUSTOMER_OWNER_INDEX_OPTIONS.partialFilterExpression,
  });
  await AiriArtifact.collection.createIndex(
    { workspaceId: 1, threadId: 1, updatedAt: -1 },
    {
      background: true,
      name: "airi_artifacts_workspace_thread_updated_desc",
    }
  );
  await AiriArtifact.collection.createIndex(
    { workspaceId: 1, kind: 1, updatedAt: -1 },
    {
      background: true,
      name: "airi_artifacts_workspace_kind_updated_desc",
    }
  );
  await AiriArtifact.collection.createIndex(
    { workspaceId: 1, status: 1, updatedAt: -1 },
    {
      background: true,
      name: "airi_artifacts_workspace_status_updated_desc",
    }
  );
  await AiriArtifact.collection.createIndex(
    { workspaceId: 1, threadId: 1, kind: 1 },
    {
      background: true,
      name: "airi_artifacts_workspace_thread_kind",
    }
  );
  await AiriArtifactVersion.collection.createIndex(
    { artifactId: 1, revision: 1 },
    {
      background: true,
      unique: true,
      name: "airi_artifact_versions_artifact_revision_unique",
    }
  );
  await createCreativeAssetGenerationIndexes();
  await CreativeVideoPlan.createIndexes();
  await ensurePlatformCreativeGenerationQuotaIndexes();
  await ensureTikTokPlatformCredentialIndexes();
  await AiriArtifactVersion.collection.createIndex(
    { workspaceId: 1, threadId: 1, artifactId: 1, revision: -1 },
    {
      background: true,
      name: "airi_artifact_versions_workspace_thread_artifact_revision_desc",
    }
  );

  const missionControlIndexes: Record<string, 1 | -1>[] = [
    { workspaceId: 1, "classification.category": 1 },
    { workspaceId: 1, channel: 1, user: 1 },
    { workspaceId: 1, user: 1, lastMessageAt: -1 },
  ];
  for (const key of missionControlIndexes) {
    await ensureOrdinaryMongoIndex({
      key,
      createIndex: () =>
        Conversation.collection.createIndex(key, { background: true }),
      readIndexes: () => Conversation.collection.indexes(),
    });
  }
}

export async function ensureIndexes() {
  if (mongoIndexCache.ensured) {
    return;
  }

  if (mongoIndexCache.ensurePromise) {
    return mongoIndexCache.ensurePromise;
  }

  mongoIndexCache.ensurePromise = createIndexes()
    .then(() => {
      mongoIndexCache.ensured = true;
    })
    .catch(error => {
      mongoIndexCache.ensurePromise = null;
      throw error;
    })
    .finally(() => {
      if (mongoIndexCache.ensured) {
        mongoIndexCache.ensurePromise = null;
      }
    });

  return mongoIndexCache.ensurePromise;
}
