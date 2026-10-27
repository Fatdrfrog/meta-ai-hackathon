import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import { buildFrozenScenarioTransitionState } from "@/lib/airi/reply/runtime/auto-reply-scenario-state";
import { buildScenarioRevisionFingerprintFromRecord } from "@/lib/airi/scenario/scenario-runtime";
import type { AiriConversationOutboundDeliveryResult } from "@icecore/temporal";
import {
  GENERATIVE_AI_DAILY_LIMIT_WINDOW_MS,
  GENERATIVE_AI_DELIVERY_ATTACHMENT_KEYS,
  GENERATIVE_AI_DELIVERY_CLAIM_KEYS,
  GENERATIVE_AI_EXECUTION_KEYS,
  GENERATIVE_AI_SOURCE_MEDIA_KEYS,
  GENERATIVE_AI_TRANSITION_KEYS,
  isGenerativeAIActionMode,
  isGenerativeAIExecutionPhase,
  isGenerativeAIInputKind,
  isGenerativeAIResultDeliveryKind,
  normalizeGenerativeAIImageConfig,
  resolveGenerativeAIExpectedInputKind,
  type GenerativeAIDeliveryAttachment,
  type GenerativeAIDeliveryClaim,
  type GenerativeAIExecution,
  type GenerativeAIExecutionPhase,
  type GenerativeAISourceMedia,
  type GenerativeAITransition,
} from "@icecore/scenario-contracts";
import { canonicalGcsUri } from "@icecore/airi-runtime/media-api";
import {
  WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES,
  WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES,
} from "@icecore/whatsapp/mediaTypes";
import { isRecord, isNonEmptyString } from "@icecore/shared/lib/value-utils";

/** The persisted `airi_pending_generative_execution` owner. */
export type PendingGenerativeExecution = GenerativeAIExecution;

type OwnerProjection = {
  airi_pending_generative_execution?: unknown;
  airi_scenario_state?: unknown;
};

type ExactExecutionOwnerInput = {
  workspaceId: string;
  conversationId: string;
  executionId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
};

const ALLOWED_PHASE_TRANSITIONS = new Set([
  "accepted:importing_source",
  "accepted:preparing_generation",
  "importing_source:preparing_generation",
  "preparing_generation:generating",
]);
const PENDING_EXECUTION_KEYS = new Set<string>(GENERATIVE_AI_EXECUTION_KEYS);
const SOURCE_MEDIA_KEYS = new Set<string>(GENERATIVE_AI_SOURCE_MEDIA_KEYS);
const TRANSITION_KEYS = new Set<string>(GENERATIVE_AI_TRANSITION_KEYS);
const DELIVERY_CLAIM_KEYS = new Set<string>(GENERATIVE_AI_DELIVERY_CLAIM_KEYS);
const DELIVERY_ATTACHMENT_KEYS = new Set<string>(
  GENERATIVE_AI_DELIVERY_ATTACHMENT_KEYS
);

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isCanonicalIsoString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseTransition(value: unknown): GenerativeAITransition | null {
  if (!isRecord(value) || !hasOnlyKeys(value, TRANSITION_KEYS)) return null;
  if (
    !isNullableString(value.nextActionNodeId) ||
    typeof value.completesScenario !== "boolean" ||
    value.completesScenario !== (value.nextActionNodeId === null)
  ) {
    return null;
  }
  return {
    nextActionNodeId: value.nextActionNodeId,
    completesScenario: value.completesScenario,
  };
}

function parseSourceMedia(
  value: unknown
): GenerativeAISourceMedia | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, SOURCE_MEDIA_KEYS) ||
    !isNonEmptyString(value.whatsappMediaId) ||
    !isNullableString(value.declaredMimeType) ||
    !isNullableString(value.fileName)
  ) {
    return undefined;
  }
  return {
    whatsappMediaId: value.whatsappMediaId,
    declaredMimeType: value.declaredMimeType,
    fileName: value.fileName,
  };
}

function parseDeliveryAttachment(
  value: unknown
): GenerativeAIDeliveryAttachment | null {
  if (!isRecord(value) || !hasOnlyKeys(value, DELIVERY_ATTACHMENT_KEYS)) {
    return null;
  }
  if (
    !isNonEmptyString(value.bucket) ||
    !isNonEmptyString(value.path) ||
    value.url !== canonicalGcsUri(value.bucket, value.path) ||
    (value.mediaType !== "video" && value.mediaType !== "image") ||
    !isNonEmptyString(value.mimeType) ||
    !WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES[value.mediaType].includes(
      value.mimeType
    ) ||
    !isNonEmptyString(value.fileName) ||
    typeof value.fileSize !== "number" ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize <= 0 ||
    value.fileSize > WHATSAPP_OFFICIAL_MEDIA_MAX_BYTES[value.mediaType]
  ) {
    return null;
  }
  return {
    url: value.url,
    mediaType: value.mediaType,
    mimeType: value.mimeType,
    fileName: value.fileName,
    fileSize: value.fileSize,
    bucket: value.bucket,
    path: value.path,
  };
}

function hasSameDeliveryAttachment(
  left: GenerativeAIDeliveryAttachment | null,
  right: GenerativeAIDeliveryAttachment | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.url === right.url &&
    left.mediaType === right.mediaType &&
    left.mimeType === right.mimeType &&
    left.fileName === right.fileName &&
    left.fileSize === right.fileSize &&
    left.bucket === right.bucket &&
    left.path === right.path
  );
}

function parseDeliveryClaim(value: unknown): GenerativeAIDeliveryClaim | null {
  if (!isRecord(value) || !hasOnlyKeys(value, DELIVERY_CLAIM_KEYS)) return null;
  const attachment =
    value.attachment === null
      ? null
      : parseDeliveryAttachment(value.attachment);
  if (
    !isNonEmptyString(value.token) ||
    !isGenerativeAIResultDeliveryKind(value.kind) ||
    !isNonEmptyString(value.deliveryKey) ||
    !isNonEmptyString(value.reservedMessageId) ||
    !isCanonicalIsoString(value.claimedAt) ||
    !isNullableString(value.attemptToken) ||
    (value.attachment !== null && !attachment) ||
    ((value.kind === "success_video" || value.kind === "success_image") &&
      (!isNonEmptyString(value.attemptToken) ||
        !attachment ||
        attachment.mediaType !==
          (value.kind === "success_image" ? "image" : "video"))) ||
    (value.kind === "failure_feedback" && attachment !== null)
  ) {
    return null;
  }
  return {
    token: value.token,
    kind: value.kind,
    deliveryKey: value.deliveryKey,
    reservedMessageId: value.reservedMessageId,
    claimedAt: value.claimedAt,
    attemptToken: value.attemptToken,
    attachment,
  };
}

export function parsePendingGenerativeExecution(
  value: unknown
): PendingGenerativeExecution | null {
  if (!isRecord(value) || !hasOnlyKeys(value, PENDING_EXECUTION_KEYS)) {
    return null;
  }
  if (
    value.version !== 1 ||
    value.configVersion !== 1 ||
    !isNonEmptyString(value.executionId) ||
    !isGenerativeAIExecutionPhase(value.phase) ||
    !isNonEmptyString(value.scenarioId) ||
    !isNonEmptyString(value.scenarioRevisionFingerprint) ||
    !isNonEmptyString(value.actionNodeId) ||
    !isNonEmptyString(value.inputMessageId) ||
    !isGenerativeAIInputKind(value.expectedInputKind) ||
    !isGenerativeAIActionMode(value.mode) ||
    !isNonEmptyString(value.composedPrompt) ||
    !isNonEmptyString(value.scenarioWorkflowId) ||
    !isCanonicalIsoString(value.acceptedAt)
  ) {
    return null;
  }

  const sourceMedia = parseSourceMedia(value.sourceMedia);
  const successTransition = parseTransition(value.successTransition);
  const failureTransition = parseTransition(value.failureTransition);
  const imageConfig =
    value.mode === "text_to_image"
      ? normalizeGenerativeAIImageConfig(value.imageConfig)
      : null;
  if (
    sourceMedia === undefined ||
    !successTransition ||
    !failureTransition ||
    (value.mode === "text_to_image" && !imageConfig) ||
    (value.mode !== "text_to_image" && value.imageConfig !== undefined) ||
    value.expectedInputKind !==
      resolveGenerativeAIExpectedInputKind(value.mode) ||
    // Only an execution that expects an image froze the customer's media.
    (value.expectedInputKind === "image") !== (sourceMedia !== null)
  ) {
    return null;
  }

  const videoWorkflowId =
    value.videoWorkflowId === undefined
      ? undefined
      : isNonEmptyString(value.videoWorkflowId)
        ? value.videoWorkflowId
        : null;
  const assetId =
    value.assetId === undefined
      ? undefined
      : isNonEmptyString(value.assetId)
        ? value.assetId
        : null;
  if (videoWorkflowId === null || assetId === null) return null;

  const deliveryClaim =
    value.deliveryClaim === undefined
      ? undefined
      : parseDeliveryClaim(value.deliveryClaim);
  if (
    deliveryClaim === null ||
    (deliveryClaim?.kind === "success_image" &&
      value.mode !== "text_to_image") ||
    (deliveryClaim?.kind === "success_video" &&
      value.mode === "text_to_image") ||
    (value.phase === "delivering" && !deliveryClaim) ||
    (value.phase !== "delivering" && deliveryClaim) ||
    (deliveryClaim !== undefined &&
      Boolean(deliveryClaim.attemptToken) !==
        Boolean(videoWorkflowId && assetId))
  ) {
    return null;
  }

  return {
    version: 1,
    configVersion: 1,
    executionId: value.executionId,
    phase: value.phase,
    scenarioId: value.scenarioId,
    scenarioRevisionFingerprint: value.scenarioRevisionFingerprint,
    actionNodeId: value.actionNodeId,
    inputMessageId: value.inputMessageId,
    expectedInputKind: value.expectedInputKind,
    mode: value.mode,
    ...(imageConfig ? { imageConfig } : {}),
    composedPrompt: value.composedPrompt,
    sourceMedia,
    successTransition,
    failureTransition,
    scenarioWorkflowId: value.scenarioWorkflowId,
    ...(videoWorkflowId ? { videoWorkflowId } : {}),
    acceptedAt: value.acceptedAt,
    ...(assetId ? { assetId } : {}),
    ...(deliveryClaim ? { deliveryClaim } : {}),
  };
}

function parseOwnerProjection(
  value: unknown
): PendingGenerativeExecution | null {
  if (!isRecord(value)) return null;
  return parsePendingGenerativeExecution(
    (value as OwnerProjection).airi_pending_generative_execution
  );
}

function exactOwnerFilter(
  input: ExactExecutionOwnerInput,
  expectedPhase: GenerativeAIExecutionPhase,
  exactExecution: PendingGenerativeExecution
) {
  return {
    _id: input.conversationId,
    workspaceId: input.workspaceId,
    "airi_pending_generative_execution.executionId": input.executionId,
    "airi_pending_generative_execution.phase": expectedPhase,
    "airi_pending_generative_execution.scenarioId": input.scenarioId,
    "airi_pending_generative_execution.scenarioRevisionFingerprint":
      input.scenarioRevisionFingerprint,
    "airi_pending_generative_execution.actionNodeId": input.actionNodeId,
    airi_pending_generative_execution: exactExecution,
  };
}

const OWNER_PROJECTION = { airi_pending_generative_execution: 1 } as const;
const RETURN_OWNER_OPTIONS = {
  new: true,
  projection: OWNER_PROJECTION,
  lean: true,
} as const;

async function loadPendingGenerativeExecution(input: {
  workspaceId: string;
  conversationId: string;
}): Promise<PendingGenerativeExecution | null> {
  const result = await readGenerativeExecutionOwnerRecord(input);
  return result.classification === "present" ? result.execution : null;
}

export type GenerativeExecutionOwnerRecord =
  | { classification: "absent"; execution: null }
  | { classification: "malformed"; execution: null }
  | {
      classification: "present";
      execution: PendingGenerativeExecution;
    };

export async function readGenerativeExecutionOwnerRecord(input: {
  workspaceId: string;
  conversationId: string;
}): Promise<GenerativeExecutionOwnerRecord> {
  const persisted = await Conversation.findOne({
    _id: input.conversationId,
    workspaceId: input.workspaceId,
  })
    .select("airi_pending_generative_execution")
    .lean<OwnerProjection | null>();
  const raw = persisted?.airi_pending_generative_execution;
  if (raw === null || raw === undefined) {
    return { classification: "absent", execution: null };
  }
  const execution = parsePendingGenerativeExecution(raw);
  return execution
    ? { classification: "present", execution }
    : { classification: "malformed", execution: null };
}

export async function isAuthoritativeGenerativeScenarioRevisionActive(input: {
  workspaceId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
}): Promise<boolean> {
  if (
    !isNonEmptyString(input.workspaceId) ||
    !isNonEmptyString(input.scenarioId) ||
    !isNonEmptyString(input.scenarioRevisionFingerprint)
  ) {
    return false;
  }
  const scenario = await Scenario.findOne({
    _id: input.scenarioId,
    workspaceId: input.workspaceId,
    status: "active",
    mode: { $ne: "bulk_campaign" },
    deletedAt: null,
  })
    .select("nodes edges")
    .lean<{ nodes?: unknown; edges?: unknown } | null>();
  if (!scenario) {
    return false;
  }
  try {
    return (
      buildScenarioRevisionFingerprintFromRecord({
        nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
        edges: Array.isArray(scenario.edges) ? scenario.edges : [],
      }) === input.scenarioRevisionFingerprint
    );
  } catch {
    return false;
  }
}

async function loadExecutionOwnerDocument(input: {
  workspaceId: string;
  conversationId: string;
}): Promise<OwnerProjection | null> {
  return Conversation.findOne({
    _id: input.conversationId,
    workspaceId: input.workspaceId,
  })
    .select("airi_pending_generative_execution airi_scenario_state")
    .lean<OwnerProjection | null>();
}

async function loadExactGenerativeExecutionOwner(
  input: ExactExecutionOwnerInput,
  expectedPhase: GenerativeAIExecutionPhase
): Promise<PendingGenerativeExecution | null> {
  const execution = await loadPendingGenerativeExecution(input);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.phase !== expectedPhase ||
    execution.scenarioId !== input.scenarioId ||
    execution.scenarioRevisionFingerprint !==
      input.scenarioRevisionFingerprint ||
    execution.actionNodeId !== input.actionNodeId
  ) {
    return null;
  }
  return execution;
}

export async function loadGenerativeExecutionIfOwned(
  input: ExactExecutionOwnerInput & {
    expectedPhase: GenerativeAIExecutionPhase;
  }
): Promise<PendingGenerativeExecution | null> {
  return loadExactGenerativeExecutionOwner(input, input.expectedPhase);
}

export async function loadGenerativeExecutionOwner(
  input: ExactExecutionOwnerInput
): Promise<PendingGenerativeExecution | null> {
  const execution = await loadPendingGenerativeExecution(input);
  if (
    !execution ||
    execution.executionId !== input.executionId ||
    execution.scenarioId !== input.scenarioId ||
    execution.scenarioRevisionFingerprint !==
      input.scenarioRevisionFingerprint ||
    execution.actionNodeId !== input.actionNodeId
  ) {
    return null;
  }
  return execution;
}

export async function loadGenerativeExecutionById(input: {
  workspaceId: string;
  conversationId: string;
  executionId: string;
}): Promise<PendingGenerativeExecution | null> {
  const execution = await loadPendingGenerativeExecution(input);
  return execution?.executionId === input.executionId ? execution : null;
}

export async function claimGenerativeExecution(input: {
  workspaceId: string;
  conversationId: string;
  execution: PendingGenerativeExecution;
}): Promise<
  | { status: "claimed"; execution: PendingGenerativeExecution }
  | { status: "existing"; execution: PendingGenerativeExecution }
  | { status: "stale" }
> {
  const execution = parsePendingGenerativeExecution(input.execution);
  if (!execution || execution.phase !== "accepted") {
    return { status: "stale" };
  }

  const acceptedAt = new Date(execution.acceptedAt);
  // Starts outside the daily-limit window never count again.
  await Conversation.updateOne(
    { _id: input.conversationId, workspaceId: input.workspaceId },
    {
      $pull: {
        airi_generative_starts: {
          acceptedAt: {
            $lt: new Date(
              acceptedAt.getTime() - GENERATIVE_AI_DAILY_LIMIT_WINDOW_MS
            ),
          },
        },
      },
    }
  );
  const claimed = await Conversation.findOneAndUpdate(
    {
      _id: input.conversationId,
      workspaceId: input.workspaceId,
      "airi_scenario_state.lockedScenarioId": execution.scenarioId,
      "airi_scenario_state.currentActionNodeId": execution.actionNodeId,
      "airi_scenario_state.scenarioRevisionFingerprint":
        execution.scenarioRevisionFingerprint,
      airi_pending_generative_execution: null,
    },
    {
      $set: {
        airi_pending_generative_execution: execution,
      },
      // Every start counts toward the node's daily limit, whatever its result.
      $push: {
        airi_generative_starts: {
          scenarioId: execution.scenarioId,
          actionNodeId: execution.actionNodeId,
          acceptedAt,
        },
      },
    },
    RETURN_OWNER_OPTIONS
  );
  const claimedExecution = parseOwnerProjection(claimed);
  if (claimedExecution) {
    return { status: "claimed", execution: claimedExecution };
  }

  const existingExecution = await loadPendingGenerativeExecution(input);
  return existingExecution
    ? { status: "existing", execution: existingExecution }
    : { status: "stale" };
}

export async function countGenerativeAIStarts(input: {
  conversationId: string;
  scenarioId: string;
  actionNodeId: string;
  since: Date;
}): Promise<number> {
  const conversation = await Conversation.findById(input.conversationId)
    .select("airi_generative_starts")
    .lean<{
      airi_generative_starts?: Array<{
        scenarioId: string;
        actionNodeId: string;
        acceptedAt: Date;
      }>;
    } | null>();
  return (conversation?.airi_generative_starts ?? []).filter(
    start =>
      start.scenarioId === input.scenarioId &&
      start.actionNodeId === input.actionNodeId &&
      start.acceptedAt >= input.since
  ).length;
}

export async function advanceGenerativeExecutionPhase(
  input: ExactExecutionOwnerInput & {
    expectedPhase: GenerativeAIExecutionPhase;
    nextPhase: GenerativeAIExecutionPhase;
    updates?: {
      assetId?: string;
      videoWorkflowId?: string;
    };
  }
): Promise<PendingGenerativeExecution | null> {
  if (
    !ALLOWED_PHASE_TRANSITIONS.has(`${input.expectedPhase}:${input.nextPhase}`)
  ) {
    return null;
  }
  if (
    (input.updates?.assetId !== undefined &&
      !isNonEmptyString(input.updates.assetId)) ||
    (input.updates?.videoWorkflowId !== undefined &&
      !isNonEmptyString(input.updates.videoWorkflowId))
  ) {
    return null;
  }

  const exactExecution = await loadExactGenerativeExecutionOwner(
    input,
    input.expectedPhase
  );
  if (!exactExecution) return null;

  const nextExecution = parsePendingGenerativeExecution({
    ...exactExecution,
    phase: input.nextPhase,
    ...(input.updates?.assetId ? { assetId: input.updates.assetId } : {}),
    ...(input.updates?.videoWorkflowId
      ? { videoWorkflowId: input.updates.videoWorkflowId }
      : {}),
  });
  if (!nextExecution) return null;

  const updated = await Conversation.findOneAndUpdate(
    exactOwnerFilter(input, input.expectedPhase, exactExecution),
    {
      $set: {
        airi_pending_generative_execution: nextExecution,
      },
    },
    RETURN_OWNER_OPTIONS
  );
  return parseOwnerProjection(updated);
}

export async function claimGenerativeDelivery(
  input: ExactExecutionOwnerInput & {
    assetId: string | null;
    videoWorkflowId: string | null;
    attemptToken: string | null;
    deliveryClaim: GenerativeAIDeliveryClaim;
  }
): Promise<PendingGenerativeExecution | null> {
  const deliveryClaim = parseDeliveryClaim(input.deliveryClaim);
  const hasVideoIdentity =
    isNonEmptyString(input.assetId) &&
    isNonEmptyString(input.videoWorkflowId) &&
    isNonEmptyString(input.attemptToken);
  const hasNoVideoIdentity =
    input.assetId === null &&
    input.videoWorkflowId === null &&
    input.attemptToken === null;
  const expectedPhases: GenerativeAIExecutionPhase[] = hasVideoIdentity
    ? ["generating"]
    : ["accepted", "importing_source", "preparing_generation", "generating"];
  if (
    !deliveryClaim ||
    (!hasVideoIdentity && !hasNoVideoIdentity) ||
    deliveryClaim.attemptToken !== input.attemptToken ||
    ((deliveryClaim.kind === "success_video" ||
      deliveryClaim.kind === "success_image") &&
      !hasVideoIdentity)
  ) {
    return null;
  }

  const current = await loadPendingGenerativeExecution(input);
  if (!current) {
    return null;
  }
  if (current.phase === "delivering") {
    const existingClaim = current.deliveryClaim;
    const sameClaim = Boolean(
      existingClaim &&
        existingClaim.token === deliveryClaim.token &&
        existingClaim.kind === deliveryClaim.kind &&
        existingClaim.deliveryKey === deliveryClaim.deliveryKey &&
        existingClaim.reservedMessageId === deliveryClaim.reservedMessageId &&
        existingClaim.claimedAt === deliveryClaim.claimedAt &&
        existingClaim.attemptToken === deliveryClaim.attemptToken &&
        hasSameDeliveryAttachment(
          existingClaim.attachment,
          deliveryClaim.attachment
        ) &&
        current.assetId === (input.assetId || undefined) &&
        current.videoWorkflowId === (input.videoWorkflowId || undefined)
    );
    return sameClaim &&
      current.executionId === input.executionId &&
      current.scenarioId === input.scenarioId &&
      current.scenarioRevisionFingerprint ===
        input.scenarioRevisionFingerprint &&
      current.actionNodeId === input.actionNodeId
      ? current
      : null;
  }
  if (
    !expectedPhases.includes(current.phase) ||
    current.executionId !== input.executionId ||
    current.scenarioId !== input.scenarioId ||
    current.scenarioRevisionFingerprint !== input.scenarioRevisionFingerprint ||
    current.actionNodeId !== input.actionNodeId ||
    current.scenarioWorkflowId === "" ||
    current.assetId !== (input.assetId || undefined) ||
    current.videoWorkflowId !== (input.videoWorkflowId || undefined)
  ) {
    return null;
  }
  if (
    !(await isAuthoritativeGenerativeScenarioRevisionActive({
      workspaceId: input.workspaceId,
      scenarioId: current.scenarioId,
      scenarioRevisionFingerprint: current.scenarioRevisionFingerprint,
    }))
  ) {
    await Conversation.updateOne(
      exactOwnerFilter(input, current.phase, current),
      { $unset: { airi_pending_generative_execution: "" } }
    );
    return null;
  }

  const filter = {
    ...exactOwnerFilter(input, current.phase, current),
    ...(input.assetId
      ? { "airi_pending_generative_execution.assetId": input.assetId }
      : {}),
    ...(input.videoWorkflowId
      ? {
          "airi_pending_generative_execution.videoWorkflowId":
            input.videoWorkflowId,
        }
      : {}),
    "airi_scenario_state.lockedScenarioId": input.scenarioId,
    "airi_scenario_state.currentActionNodeId": input.actionNodeId,
    "airi_scenario_state.scenarioRevisionFingerprint":
      input.scenarioRevisionFingerprint,
  };
  const deliveringExecution = parsePendingGenerativeExecution({
    ...current,
    phase: "delivering",
    deliveryClaim,
  });
  if (!deliveringExecution) return null;

  const updated = await Conversation.findOneAndUpdate(
    filter,
    {
      $set: {
        airi_pending_generative_execution: deliveringExecution,
      },
    },
    RETURN_OWNER_OPTIONS
  );
  return parseOwnerProjection(updated);
}

function isManualHandoffDelivery(
  delivery: AiriConversationOutboundDeliveryResult
): boolean {
  return (
    delivery.classification === "skipped" &&
    delivery.skipReason === "manual_handoff_active"
  );
}

/**
 * Matches `airi_scenario_state` exactly as it was read. A plain
 * `airi_scenario_state: state` filter is cast through the Conversation
 * schema, which adds every field the schema defaults, so a state written by a
 * build with another schema (a deploy, or two builds running side by side)
 * would never match and the step could never finish. Mongoose leaves an
 * `$expr` comparison uncast when its literal comes first.
 */
export function exactStoredScenarioStateFilter(scenarioState: unknown) {
  return isRecord(scenarioState)
    ? {
        $expr: {
          $eq: [{ $literal: scenarioState }, "$airi_scenario_state"],
        },
      }
    : { airi_scenario_state: scenarioState };
}

function hasExactScenarioExecutionState(
  value: unknown,
  execution: PendingGenerativeExecution
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.lockedScenarioId === execution.scenarioId &&
    value.currentActionNodeId === execution.actionNodeId &&
    value.scenarioRevisionFingerprint === execution.scenarioRevisionFingerprint
  );
}

type GenerativeDeliveryClaimOwnerInput = ExactExecutionOwnerInput & {
  deliveryClaimToken: string;
  deliveryKey: string;
  reservedMessageId: string;
};

type GenerativeDeliveryPreflightInput = GenerativeDeliveryClaimOwnerInput & {
  assetId: string | null;
  videoWorkflowId: string | null;
  attemptToken: string | null;
  context: Record<string, unknown>;
};

export type GenerativeDeliveryPreflightResult = {
  classification:
    | "valid"
    | "stale_claim"
    | "invalid_payload"
    | "malformed_owner";
};

function hasExactGenerativeDeliveryClaim(
  execution: PendingGenerativeExecution | null,
  input: GenerativeDeliveryClaimOwnerInput
): execution is PendingGenerativeExecution {
  const claim = execution?.deliveryClaim;
  return Boolean(
    execution &&
      execution.phase === "delivering" &&
      execution.executionId === input.executionId &&
      execution.scenarioId === input.scenarioId &&
      execution.scenarioRevisionFingerprint ===
        input.scenarioRevisionFingerprint &&
      execution.actionNodeId === input.actionNodeId &&
      claim &&
      claim.token === input.deliveryClaimToken &&
      claim.deliveryKey === input.deliveryKey &&
      claim.reservedMessageId === input.reservedMessageId
  );
}

function hasNoScenarioAttachments(context: Record<string, unknown>): boolean {
  const attachments = context.scenarioAttachments;
  return (
    attachments === undefined ||
    attachments === null ||
    (Array.isArray(attachments) && attachments.length === 0)
  );
}

export async function inspectGenerativeDeliveryPreflight(
  input: GenerativeDeliveryPreflightInput
): Promise<GenerativeDeliveryPreflightResult> {
  if (
    !isNonEmptyString(input.deliveryClaimToken) ||
    !isNonEmptyString(input.deliveryKey) ||
    !isNonEmptyString(input.reservedMessageId)
  ) {
    return { classification: "invalid_payload" };
  }
  const ownerRecord = await readGenerativeExecutionOwnerRecord(input);
  if (ownerRecord.classification === "malformed") {
    return { classification: "malformed_owner" };
  }
  const execution =
    ownerRecord.classification === "present" ? ownerRecord.execution : null;
  if (!hasExactGenerativeDeliveryClaim(execution, input)) {
    return { classification: "stale_claim" };
  }
  const deliveryClaim = execution.deliveryClaim;
  if (!deliveryClaim) {
    return { classification: "malformed_owner" };
  }
  const hasVideoIdentity =
    isNonEmptyString(input.assetId) &&
    isNonEmptyString(input.videoWorkflowId) &&
    isNonEmptyString(input.attemptToken);
  const hasNoVideoIdentity =
    input.assetId === null &&
    input.videoWorkflowId === null &&
    input.attemptToken === null;
  if (!hasVideoIdentity && !hasNoVideoIdentity) {
    return { classification: "invalid_payload" };
  }
  if (hasNoVideoIdentity) {
    return {
      classification:
        deliveryClaim.kind === "failure_feedback" &&
        deliveryClaim.attemptToken === null &&
        deliveryClaim.attachment === null &&
        execution.assetId === undefined &&
        execution.videoWorkflowId === undefined &&
        hasNoScenarioAttachments(input.context) &&
        String(input.context.content || "").trim().length > 0
          ? "valid"
          : "invalid_payload",
    };
  }
  if (
    execution.assetId !== input.assetId ||
    execution.videoWorkflowId !== input.videoWorkflowId ||
    deliveryClaim.attemptToken !== input.attemptToken
  ) {
    return { classification: "invalid_payload" };
  }
  if (deliveryClaim.kind === "failure_feedback") {
    return {
      classification:
        hasNoScenarioAttachments(input.context) &&
        String(input.context.content || "").trim().length > 0
          ? "valid"
          : "invalid_payload",
    };
  }
  const claimedAttachment = deliveryClaim.attachment;
  if (!claimedAttachment || String(input.context.content || "").trim() !== "") {
    return { classification: "invalid_payload" };
  }
  const attachments = input.context.scenarioAttachments;
  if (!Array.isArray(attachments) || attachments.length !== 1) {
    return { classification: "invalid_payload" };
  }
  const attachment = isRecord(attachments[0]) ? attachments[0] : null;
  return {
    classification:
      attachment &&
      attachment.mediaType === claimedAttachment.mediaType &&
      attachment.url === claimedAttachment.url &&
      attachment.bucket === claimedAttachment.bucket &&
      attachment.path === claimedAttachment.path &&
      attachment.mimeType === claimedAttachment.mimeType &&
      attachment.fileName === claimedAttachment.fileName &&
      attachment.fileSize === claimedAttachment.fileSize
        ? "valid"
        : "invalid_payload",
  };
}

export async function terminalizeGenerativeDelivery(
  input: ExactExecutionOwnerInput & {
    deliveryClaimToken: string;
    delivery: AiriConversationOutboundDeliveryResult;
  }
): Promise<boolean> {
  if (
    !isNonEmptyString(input.deliveryClaimToken) ||
    !input.delivery.classification
  ) {
    return false;
  }
  const ownerDocument = await loadExecutionOwnerDocument(input);
  const execution = parseOwnerProjection(ownerDocument);
  const claimInput: GenerativeDeliveryClaimOwnerInput = {
    ...input,
    deliveryKey: input.delivery.deliveryKey,
    reservedMessageId: input.delivery.outboundMessageId,
  };
  if (!hasExactGenerativeDeliveryClaim(execution, claimInput)) {
    return false;
  }
  const claim = execution.deliveryClaim;
  if (!claim) {
    return false;
  }

  const ownerFilter = exactOwnerFilter(input, "delivering", execution);
  if (isManualHandoffDelivery(input.delivery)) {
    const cleared = await Conversation.findOneAndUpdate(
      ownerFilter,
      { $unset: { airi_pending_generative_execution: "" } },
      RETURN_OWNER_OPTIONS
    );
    return Boolean(cleared);
  }

  const scenarioState = ownerDocument?.airi_scenario_state;
  if (!hasExactScenarioExecutionState(scenarioState, execution)) {
    const cleared = await Conversation.findOneAndUpdate(
      {
        ...ownerFilter,
        ...(scenarioState === undefined
          ? { airi_scenario_state: { $exists: false } }
          : exactStoredScenarioStateFilter(scenarioState)),
      },
      { $unset: { airi_pending_generative_execution: "" } },
      RETURN_OWNER_OPTIONS
    );
    return Boolean(cleared);
  }

  const transition =
    input.delivery.classification === "sent" &&
    (claim.kind === "success_video" || claim.kind === "success_image")
      ? execution.successTransition
      : execution.failureTransition;
  const completedAt = input.delivery.outboundDate
    ? new Date(input.delivery.outboundDate)
    : new Date();
  if (Number.isNaN(completedAt.getTime())) {
    return false;
  }
  const scenarioName =
    isRecord(scenarioState) &&
    isNonEmptyString(scenarioState.lockedScenarioName)
      ? scenarioState.lockedScenarioName
      : null;
  const nextScenarioState = buildFrozenScenarioTransitionState({
    baseState: scenarioState,
    scenarioId: execution.scenarioId,
    scenarioName,
    actionNodeId: execution.actionNodeId,
    transition,
    completedAt,
    lastMessageId:
      input.delivery.classification === "sent"
        ? input.delivery.outboundMessageId
        : null,
  });
  const finalized = await Conversation.findOneAndUpdate(
    {
      ...ownerFilter,
      "airi_scenario_state.lockedScenarioId": execution.scenarioId,
      "airi_scenario_state.currentActionNodeId": execution.actionNodeId,
      "airi_scenario_state.scenarioRevisionFingerprint":
        execution.scenarioRevisionFingerprint,
      ...exactStoredScenarioStateFilter(scenarioState),
    },
    {
      $set: { airi_scenario_state: nextScenarioState },
      $unset: { airi_pending_generative_execution: "" },
    },
    RETURN_OWNER_OPTIONS
  );
  return Boolean(finalized);
}

export async function clearGenerativeExecutionIfOwned(
  input: ExactExecutionOwnerInput & {
    expectedPhase: GenerativeAIExecutionPhase;
  }
): Promise<boolean> {
  const exactExecution = await loadExactGenerativeExecutionOwner(
    input,
    input.expectedPhase
  );
  if (!exactExecution) return false;

  const result = await Conversation.updateOne(
    exactOwnerFilter(input, input.expectedPhase, exactExecution),
    { $unset: { airi_pending_generative_execution: "" } }
  );
  return result.modifiedCount === 1;
}

export async function terminalizeAcceptedGenerativeExecution(
  input: ExactExecutionOwnerInput & {
    outcome: "manual_handoff" | "failure";
  }
): Promise<boolean> {
  const ownerDocument = await loadExecutionOwnerDocument(input);
  const exactExecution = parseOwnerProjection(ownerDocument);
  if (
    !exactExecution ||
    exactExecution.executionId !== input.executionId ||
    exactExecution.phase !== "accepted" ||
    exactExecution.scenarioId !== input.scenarioId ||
    exactExecution.scenarioRevisionFingerprint !==
      input.scenarioRevisionFingerprint ||
    exactExecution.actionNodeId !== input.actionNodeId
  ) {
    return false;
  }

  const filter = exactOwnerFilter(input, "accepted", exactExecution);
  if (input.outcome === "manual_handoff") {
    const cleared = await Conversation.findOneAndUpdate(
      filter,
      { $unset: { airi_pending_generative_execution: "" } },
      RETURN_OWNER_OPTIONS
    );
    return Boolean(cleared);
  }

  const scenarioState = ownerDocument?.airi_scenario_state;
  const scenarioName =
    isRecord(scenarioState) &&
    isNonEmptyString(scenarioState.lockedScenarioName)
      ? scenarioState.lockedScenarioName
      : null;
  const nextScenarioState = buildFrozenScenarioTransitionState({
    baseState: scenarioState,
    scenarioId: exactExecution.scenarioId,
    scenarioName,
    actionNodeId: exactExecution.actionNodeId,
    transition: exactExecution.failureTransition,
    completedAt: new Date(),
    lastMessageId: null,
  });
  const failed = await Conversation.findOneAndUpdate(
    {
      ...filter,
      "airi_scenario_state.lockedScenarioId": input.scenarioId,
      "airi_scenario_state.currentActionNodeId": input.actionNodeId,
      "airi_scenario_state.scenarioRevisionFingerprint":
        input.scenarioRevisionFingerprint,
      ...(scenarioState === undefined
        ? {}
        : exactStoredScenarioStateFilter(scenarioState)),
    },
    {
      $set: { airi_scenario_state: nextScenarioState },
      $unset: { airi_pending_generative_execution: "" },
    },
    RETURN_OWNER_OPTIONS
  );
  if (failed) return true;

  const cleared = await Conversation.findOneAndUpdate(
    filter,
    { $unset: { airi_pending_generative_execution: "" } },
    RETURN_OWNER_OPTIONS
  );
  return Boolean(cleared);
}
