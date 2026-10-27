import type {
  GENERATIVE_AI_DELIVERY_ATTACHMENT_KEYS,
  GENERATIVE_AI_DELIVERY_CLAIM_KEYS,
  GENERATIVE_AI_EXECUTION_KEYS,
  GENERATIVE_AI_SOURCE_MEDIA_KEYS,
  GENERATIVE_AI_TRANSITION_KEYS,
  GenerativeAIDeliveryAttachment,
  GenerativeAIDeliveryClaim,
  GenerativeAIExecution,
  GenerativeAISourceMedia,
  GenerativeAITransition,
} from "./scenario-generative-ai-execution";

type ExpectNever<T extends never> = T;

// Each list must name every key of its type, and nothing else.
type _MissingExecutionKeys = ExpectNever<
  Exclude<
    keyof GenerativeAIExecution,
    (typeof GENERATIVE_AI_EXECUTION_KEYS)[number]
  >
>;
type _MissingSourceMediaKeys = ExpectNever<
  Exclude<
    keyof GenerativeAISourceMedia,
    (typeof GENERATIVE_AI_SOURCE_MEDIA_KEYS)[number]
  >
>;
type _MissingTransitionKeys = ExpectNever<
  Exclude<
    keyof GenerativeAITransition,
    (typeof GENERATIVE_AI_TRANSITION_KEYS)[number]
  >
>;
type _MissingDeliveryClaimKeys = ExpectNever<
  Exclude<
    keyof GenerativeAIDeliveryClaim,
    (typeof GENERATIVE_AI_DELIVERY_CLAIM_KEYS)[number]
  >
>;
type _MissingDeliveryAttachmentKeys = ExpectNever<
  Exclude<
    keyof GenerativeAIDeliveryAttachment,
    (typeof GENERATIVE_AI_DELIVERY_ATTACHMENT_KEYS)[number]
  >
>;

const acceptedTextExecution: GenerativeAIExecution = {
  version: 1,
  configVersion: 1,
  executionId: "execution-1",
  phase: "accepted",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "revision-1",
  actionNodeId: "action-1",
  inputMessageId: "message-1",
  expectedInputKind: "text",
  mode: "text_to_video",
  composedPrompt: "Make a product video",
  sourceMedia: null,
  successTransition: { nextActionNodeId: "next-1", completesScenario: false },
  failureTransition: { nextActionNodeId: null, completesScenario: true },
  scenarioWorkflowId: "scenario-generation:execution-1",
  acceptedAt: "2026-07-30T10:00:00.000Z",
};

const unsupportedModeExecution: GenerativeAIExecution = {
  ...acceptedTextExecution,
  // @ts-expect-error Executions store only the supported generative modes.
  mode: "text_to_audio",
};

const unsupportedPhaseExecution: GenerativeAIExecution = {
  ...acceptedTextExecution,
  // @ts-expect-error Executions advance only through the declared phases.
  phase: "queued",
};

void acceptedTextExecution;
void unsupportedModeExecution;
void unsupportedPhaseExecution;
