import type {
  GenerativeAIActionMode,
  GenerativeAIImageConfig,
  GenerativeAIInputKind,
} from "./scenario-generative-ai";

/**
 * The execution a conversation owns while a generative request runs, stored at
 * `Conversation.airi_pending_generative_execution`. Auto-reply freezes it, the
 * web store validates and advances it, the worker reads it and the result
 * handler delivers it. Each key list below is checked against its type in
 * `scenario-generative-ai-execution.type-test.ts`, so a parser allowlist built
 * from a list cannot drift from the type.
 */

export const GENERATIVE_AI_EXECUTION_PHASES = [
  "accepted",
  "importing_source",
  "preparing_generation",
  "generating",
  "delivering",
] as const;

export type GenerativeAIExecutionPhase =
  (typeof GENERATIVE_AI_EXECUTION_PHASES)[number];

export function isGenerativeAIExecutionPhase(
  value: unknown,
): value is GenerativeAIExecutionPhase {
  return (
    typeof value === "string" &&
    (GENERATIVE_AI_EXECUTION_PHASES as readonly string[]).includes(value)
  );
}

export const GENERATIVE_AI_RESULT_DELIVERY_KINDS = [
  "success_video",
  "success_image",
  "failure_feedback",
] as const;

export type GenerativeAIResultDeliveryKind =
  (typeof GENERATIVE_AI_RESULT_DELIVERY_KINDS)[number];

export function isGenerativeAIResultDeliveryKind(
  value: unknown,
): value is GenerativeAIResultDeliveryKind {
  return (
    typeof value === "string" &&
    (GENERATIVE_AI_RESULT_DELIVERY_KINDS as readonly string[]).includes(value)
  );
}

export const GENERATIVE_AI_DELIVERY_MEDIA_TYPES = ["video", "image"] as const;

export type GenerativeAIDeliveryMediaType =
  (typeof GENERATIVE_AI_DELIVERY_MEDIA_TYPES)[number];

export type GenerativeAITransition = {
  nextActionNodeId: string | null;
  completesScenario: boolean;
};

/** The customer's WhatsApp image an image-to-video execution imports. */
export type GenerativeAISourceMedia = {
  whatsappMediaId: string;
  declaredMimeType: string | null;
  fileName: string | null;
};

/** The finished asset a success delivery sends, by its durable GCS object. */
export type GenerativeAIDeliveryAttachment = {
  url: string;
  mediaType: GenerativeAIDeliveryMediaType;
  mimeType: string;
  fileName: string;
  fileSize: number;
  bucket: string;
  path: string;
};

export type GenerativeAIDeliveryClaim = {
  token: string;
  kind: GenerativeAIResultDeliveryKind;
  deliveryKey: string;
  reservedMessageId: string;
  claimedAt: string;
  attemptToken: string | null;
  attachment: GenerativeAIDeliveryAttachment | null;
};

export type GenerativeAIExecution = {
  version: 1;
  configVersion: 1;
  executionId: string;
  phase: GenerativeAIExecutionPhase;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
  inputMessageId: string;
  expectedInputKind: GenerativeAIInputKind;
  mode: GenerativeAIActionMode;
  imageConfig?: GenerativeAIImageConfig;
  composedPrompt: string;
  sourceMedia: GenerativeAISourceMedia | null;
  successTransition: GenerativeAITransition;
  failureTransition: GenerativeAITransition;
  scenarioWorkflowId: string;
  videoWorkflowId?: string;
  acceptedAt: string;
  assetId?: string;
  deliveryClaim?: GenerativeAIDeliveryClaim;
};

export const GENERATIVE_AI_EXECUTION_KEYS = [
  "version",
  "configVersion",
  "executionId",
  "phase",
  "scenarioId",
  "scenarioRevisionFingerprint",
  "actionNodeId",
  "inputMessageId",
  "expectedInputKind",
  "mode",
  "imageConfig",
  "composedPrompt",
  "sourceMedia",
  "successTransition",
  "failureTransition",
  "scenarioWorkflowId",
  "videoWorkflowId",
  "acceptedAt",
  "assetId",
  "deliveryClaim",
] as const satisfies readonly (keyof GenerativeAIExecution)[];

export const GENERATIVE_AI_SOURCE_MEDIA_KEYS = [
  "whatsappMediaId",
  "declaredMimeType",
  "fileName",
] as const satisfies readonly (keyof GenerativeAISourceMedia)[];

export const GENERATIVE_AI_TRANSITION_KEYS = [
  "nextActionNodeId",
  "completesScenario",
] as const satisfies readonly (keyof GenerativeAITransition)[];

export const GENERATIVE_AI_DELIVERY_CLAIM_KEYS = [
  "token",
  "kind",
  "deliveryKey",
  "reservedMessageId",
  "claimedAt",
  "attemptToken",
  "attachment",
] as const satisfies readonly (keyof GenerativeAIDeliveryClaim)[];

export const GENERATIVE_AI_DELIVERY_ATTACHMENT_KEYS = [
  "url",
  "mediaType",
  "mimeType",
  "fileName",
  "fileSize",
  "bucket",
  "path",
] as const satisfies readonly (keyof GenerativeAIDeliveryAttachment)[];
