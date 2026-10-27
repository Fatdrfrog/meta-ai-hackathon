import mongoose from "mongoose";

import {
  buildClassificationInputPendingTransitionPipeline,
  type ClassificationWakeScheduler,
} from "./classification-contract";
import { scheduleConversationClassificationWakeBestEffort } from "./classification-pubsub";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";

const SEMANTIC_MESSAGE_PATHS = new Set([
  "text",
  "ragContext",
  "subject",
  "html",
  "attachments",
  "imageUrl",
  "imageAnalysis",
  "audioAnalysis",
  "videoAnalysis",
  "mediaType",
  "mimeType",
  "fileName",
  "fileSize",
  "whatsappMediaId",
  "whatsappFlow",
  "whatsappFlowReply",
  "whatsappTemplate",
  "whatsappServiceMessage",
  "whatsappCtaLink",
  "groundedReplyOptions",
  "whatsappLocation",
  "whatsappContacts",
  "whatsappProductInquiry",
  "whatsappOrder",
  "whatsappReferral",
]);

const TRANSPORT_MESSAGE_PATHS = new Set([
  "mediaAnalysis",
  "mediaAnalysis.status",
  "mediaAnalysis.kind",
  "mediaAnalysis.workflowId",
  "mediaAnalysis.sourceId",
  "mediaAnalysis.requestedAt",
  "mediaAnalysis.startedAt",
  "mediaAnalysis.completedAt",
  "mediaAnalysis.lastError",
  "mediaAnalysis.transcriptSource",
  "mediaAnalysis.analysisSource",
  "mediaAnalysis.provider",
  "mediaAnalysis.providerRequestId",
  "mediaAnalysis.providerWebhookId",
  "mediaAnalysis.contractVersion",
  "editMeta",
  "editMeta.editedAt",
  "editMeta.previousText",
  "editMeta.editCount",
  "editMeta.source",
  "editMeta.kind",
]);

export type ClassificationInputMessagePatch = {
  set?: Record<string, unknown>;
  unset?: string[];
  semanticPaths: string[];
};

export type ClassificationInputMutationDependencies = {
  messageModel: typeof Message;
  conversationModel: typeof Conversation;
  now: () => Date;
  scheduleWake: ClassificationWakeScheduler;
};

export type ClassificationInputMutationResult =
  | { semanticChanged: false }
  | {
      semanticChanged: true;
      requestedRevision: number;
      generation: number;
      status: string;
    };

function dependencies(
  overrides: Partial<ClassificationInputMutationDependencies> = {}
): ClassificationInputMutationDependencies {
  return {
    messageModel: overrides.messageModel ?? Message,
    conversationModel: overrides.conversationModel ?? Conversation,
    now: overrides.now ?? (() => new Date()),
    scheduleWake:
      overrides.scheduleWake ?? scheduleConversationClassificationWakeBestEffort,
  };
}

function toObjectId(value: mongoose.Types.ObjectId | string, name: string) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(`${name} must be a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(value);
}

function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("$") ||
    path.includes("..") ||
    path.startsWith(".") ||
    path.endsWith(".")
  ) {
    throw new Error(`Message mutation path ${path || "<empty>"} is invalid`);
  }
  if (!SEMANTIC_MESSAGE_PATHS.has(path) && !TRANSPORT_MESSAGE_PATHS.has(path)) {
    throw new Error(`Message mutation path ${path} is not allowed`);
  }
}

export function assertClassificationInputMessagePatch(
  patch: ClassificationInputMessagePatch
): void {
  const setPaths = Object.keys(patch.set ?? {});
  const unsetPaths = patch.unset ?? [];
  if (setPaths.length === 0 && unsetPaths.length === 0) {
    throw new Error("Message mutation patch is empty");
  }
  const allPaths = [...setPaths, ...unsetPaths];
  for (const path of allPaths) validatePath(path);
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("Message mutation paths must be unique");
  }
  for (const semanticPath of patch.semanticPaths) {
    if (!SEMANTIC_MESSAGE_PATHS.has(semanticPath)) {
      throw new Error(`Message mutation path ${semanticPath} is not allowed`);
    }
    if (!allPaths.includes(semanticPath)) {
      throw new Error(`Semantic path ${semanticPath} is not mutated`);
    }
  }
  if (new Set(patch.semanticPaths).size !== patch.semanticPaths.length) {
    throw new Error("Semantic paths must be unique");
  }
  const declaredSemanticPaths = new Set(patch.semanticPaths);
  for (const path of allPaths) {
    if (SEMANTIC_MESSAGE_PATHS.has(path) && !declaredSemanticPaths.has(path)) {
      throw new Error(`Classifier input path ${path} must be declared semantic`);
    }
  }
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function bsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof mongoose.Types.ObjectId) {
    return (
      (right instanceof mongoose.Types.ObjectId || typeof right === "string") &&
      left.equals(right)
    );
  }
  if (right instanceof mongoose.Types.ObjectId) {
    return typeof left === "string" && right.equals(left);
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => bsonEqual(entry, right[index]))
    );
  }
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && bsonEqual(leftRecord[key], rightRecord[key])
      )
    );
  }
  return false;
}

function semanticPatchChanges(
  preimage: Record<string, unknown>,
  patch: ClassificationInputMessagePatch
): boolean {
  const unset = new Set(patch.unset ?? []);
  return patch.semanticPaths.some(path => {
    const next = unset.has(path) ? undefined : patch.set?.[path];
    return !bsonEqual(getPath(preimage, path), next);
  });
}

function matchedCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const value = result as { matchedCount?: number; n?: number };
  return value.matchedCount ?? value.n ?? 0;
}

export async function updateClassificationInputMessageAndInvalidate(
  input: {
    messageId: mongoose.Types.ObjectId | string;
    conversationId: mongoose.Types.ObjectId | string;
  } & ClassificationInputMessagePatch,
  overrides: Partial<ClassificationInputMutationDependencies> = {}
): Promise<ClassificationInputMutationResult> {
  assertClassificationInputMessagePatch(input);
  const deps = dependencies(overrides);
  const messageId = toObjectId(input.messageId, "messageId");
  const conversationId = toObjectId(input.conversationId, "conversationId");
  const requestedAt = deps.now();
  const session = await deps.conversationModel.startSession();
  let result: ClassificationInputMutationResult = { semanticChanged: false };
  let wakeRequest:
    | {
        conversationId: string;
        requestedRevision: number;
        generation: number;
        requestedAt: Date;
      }
    | undefined;

  try {
    await session.withTransaction(async () => {
      result = { semanticChanged: false };
      wakeRequest = undefined;
      const preimage = (await deps.messageModel
        .findOne({ _id: messageId, conversation: conversationId })
        .session(session)
        .lean()
        .exec()) as Record<string, unknown> | null;
      if (!preimage) throw new Error("Classification input Message was not found");

      const semanticChanged = semanticPatchChanges(preimage, input);
      const update: Record<string, unknown> = {};
      if (input.set && Object.keys(input.set).length > 0) {
        update.$set = input.set;
      }
      if (input.unset && input.unset.length > 0) {
        update.$unset = Object.fromEntries(input.unset.map(path => [path, 1]));
      }
      const messageResult = await deps.messageModel.updateOne(
        { _id: messageId, conversation: conversationId },
        update,
        { session, runValidators: true }
      );
      if (matchedCount(messageResult) !== 1) {
        throw new Error("Classification input Message update did not match");
      }
      if (!semanticChanged) return;

      const conversationResult = await deps.conversationModel.updateOne(
        { _id: conversationId, messages: messageId },
        buildClassificationInputPendingTransitionPipeline({ now: requestedAt }),
        { session, timestamps: false }
      );
      if (matchedCount(conversationResult) !== 1) {
        throw new Error("Conversation input invalidation did not match");
      }
      const conversation = (await deps.conversationModel
        .findById(conversationId)
        .session(session)
        .select({ classification_state: 1 })
        .lean()
        .exec()) as {
        classification_state?: {
          status?: string;
          requestedRevision?: number;
          generation?: number;
          requestedAt?: Date;
        };
      } | null;
      const state = conversation?.classification_state;
      if (
        !state ||
        !Number.isSafeInteger(state.requestedRevision) ||
        !Number.isSafeInteger(state.generation) ||
        !(state.requestedAt instanceof Date) ||
        typeof state.status !== "string"
      ) {
        throw new Error("Conversation invalidation returned invalid v2 state");
      }
      result = {
        semanticChanged: true,
        requestedRevision: state.requestedRevision as number,
        generation: state.generation as number,
        status: state.status,
      };
      if (state.status !== "not_applicable") {
        wakeRequest = {
          conversationId: String(conversationId),
          requestedRevision: state.requestedRevision as number,
          generation: state.generation as number,
          requestedAt: state.requestedAt,
        };
      }
    });
  } finally {
    await session.endSession();
  }

  if (wakeRequest) {
    try {
      await deps.scheduleWake(wakeRequest);
    } catch {
      // Pending Mongo state is the durable outbox; reconciliation republishes.
    }
  }
  return result;
}
