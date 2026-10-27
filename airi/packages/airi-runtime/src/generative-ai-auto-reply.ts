import {
  composeGenerativeAIPrompt,
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
  normalizeGenerativeAIImageConfig,
  resolveGenerativeAIExpectedInputKind,
  type GenerativeAIActionConfig,
  type GenerativeAIExecution,
  type GenerativeAIExecutionPhase,
  type GenerativeAIPickedOptionIssue,
  type GenerativeAITransition,
} from "@icecore/scenario-contracts";
import type { AiriConversationDeferredCommand } from "@icecore/temporal";
export {
  findGenerativeAIReferenceImageIssue,
  GENERATIVE_AI_REFERENCE_IMAGE_LIMITS,
  isSameGenerativeAIReferenceImageList,
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
  normalizeGenerativeAIImageConfig,
  type GenerativeAIExecution,
  type GenerativeAIImageConfig,
  type GenerativeAIReferenceImageMimeType,
  type GenerativeAITransition,
} from "@icecore/scenario-contracts";
import type {
  GenerativeAIInboundDescriptor,
  GenerativeAIInboundDisposition,
} from "./scenario-generative-ai-input-types";

import {
  buildGenerativeAIExecutionId,
  buildGenerativeAIScenarioWorkflowId,
} from "./scenario-generative-ai-identity";
import {
  normalizeConversationPreferredLanguage,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";

/** An accepted execution, before the worker records its progress. */
export type FrozenGenerativeAIExecution = Omit<
  GenerativeAIExecution,
  "phase" | "videoWorkflowId" | "assetId" | "deliveryClaim"
> & { phase: "accepted" };

export type ActiveGenerativeAIExecution = Omit<
  FrozenGenerativeAIExecution,
  "phase"
> & { phase: GenerativeAIExecutionPhase };

export type GenerativeAIAutoReplyRuntime = {
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
  config: GenerativeAIActionConfig;
  input: GenerativeAIInboundDisposition;
  successTransition: GenerativeAITransition;
  failureTransition: GenerativeAITransition;
};

type ClaimResult = { status: "claimed" | "existing" | "stale" };

// Generation starts and runs silently: every outbound WhatsApp message is
// billed, so the customer hears only the result, guidance or a failure.
type CustomerCopyKind =
  | "text_guidance"
  | "image_guidance"
  | "failure"
  | "limit_reached";

const CUSTOMER_COPY: Record<
  ConversationPreferredLanguage,
  Record<CustomerCopyKind, string>
> = {
  en: {
    text_guidance: "Please send a text description to continue.",
    image_guidance: "Please send an image to continue.",
    failure: "We couldn't create a video this time. Please try again.",
    limit_reached: "You've reached today's limit. Please try again tomorrow.",
  },
  ru: {
    text_guidance: "Отправьте текстовое описание, чтобы продолжить.",
    image_guidance: "Отправьте изображение, чтобы продолжить.",
    failure: "Не удалось создать видео. Пожалуйста, попробуйте ещё раз.",
    limit_reached: "Лимит на сегодня исчерпан. Попробуйте снова завтра.",
  },
  kz: {
    text_guidance: "Жалғастыру үшін мәтіндік сипаттама жіберіңіз.",
    image_guidance: "Жалғастыру үшін сурет жіберіңіз.",
    failure: "Бейнені жасау мүмкін болмады. Қайтадан көріңіз.",
    limit_reached: "Бүгінгі лимит таусылды. Ертең қайталап көріңіз.",
  },
  uz: {
    text_guidance: "Davom etish uchun matnli tavsif yuboring.",
    image_guidance: "Davom etish uchun rasm yuboring.",
    failure: "Videoni yaratib bo‘lmadi. Qayta urinib ko‘ring.",
    limit_reached: "Bugungi limit tugadi. Ertaga qayta urinib ko‘ring.",
  },
};

const IMAGE_FAILURE_COPY: Record<ConversationPreferredLanguage, string> = {
  en: "We couldn't create an image this time. Please try again.",
  ru: "Не удалось создать изображение. Пожалуйста, попробуйте ещё раз.",
  kz: "Суретті жасау мүмкін болмады. Қайтадан көріңіз.",
  uz: "Rasmni yaratib bo‘lmadi. Qayta urinib ko‘ring.",
};

export function resolveGenerativeAICustomerCopy(
  language: string,
  kind: CustomerCopyKind,
  mode?: GenerativeAIActionConfig["mode"],
): string {
  const copyLanguage = normalizeConversationPreferredLanguage(language) ?? "en";
  if (mode === "text_to_image" && kind === "failure") {
    return IMAGE_FAILURE_COPY[copyLanguage];
  }
  return CUSTOMER_COPY[copyLanguage][kind];
}

/** Why a rendered prompt cannot be accepted; each follows the Failure branch. */
export type GenerativeAIPromptIssue =
  | "prompt_input_missing"
  /** The prompt names an answer from a form the customer never submitted. */
  | "form_answer_missing"
  | GenerativeAIPickedOptionIssue
  | "prompt_empty"
  | "prompt_too_long"
  /** The light-model check found the customer's words unfit to generate. */
  | "customer_text_flagged"
  /** The conversation used the node's generations for the day. */
  | "daily_limit_reached";

/** The customer's text an execution appends to the node prompt, if any. */
export function readGenerativeAIAppendedCustomerText(
  config: GenerativeAIActionConfig,
  input: Pick<GenerativeAIInboundDescriptor, "textOrCaption">,
): string | null {
  const imageConfig =
    config.mode === "text_to_image"
      ? normalizeGenerativeAIImageConfig(config.image)
      : null;
  return imageConfig?.includeInboundText === false
    ? null
    : input.textOrCaption?.trim() || null;
}

/** The prompt an execution freezes: node prompt, then the customer's text. */
export function composeGenerativeAIExecutionPrompt(
  config: GenerativeAIActionConfig,
  input: Pick<GenerativeAIInboundDescriptor, "textOrCaption">,
): string {
  return composeGenerativeAIPrompt(
    config.prompt,
    readGenerativeAIAppendedCustomerText(config, input),
  );
}

/**
 * Checked before claiming, so a prompt the worker would refuse follows Failure
 * without starting a paid generation.
 */
export function findGenerativeAIPromptIssue(
  config: GenerativeAIActionConfig,
  input: Pick<GenerativeAIInboundDescriptor, "textOrCaption">,
): "prompt_empty" | "prompt_too_long" | null {
  const prompt = composeGenerativeAIExecutionPrompt(config, input);
  if (!prompt.trim()) return "prompt_empty";
  if (
    config.mode === "text_to_image" &&
    prompt.length > MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS
  ) {
    return "prompt_too_long";
  }
  return null;
}

function buildExecution(
  runtime: GenerativeAIAutoReplyRuntime,
  input: GenerativeAIInboundDescriptor,
  acceptedAt: string,
): FrozenGenerativeAIExecution {
  const executionId = buildGenerativeAIExecutionId({
    workspaceId: runtime.workspaceId,
    conversationId: runtime.conversationId,
    scenarioId: runtime.scenarioId,
    actionNodeId: runtime.actionNodeId,
    inputMessageId: input.messageId,
    mode: runtime.config.mode,
  });

  const imageConfig =
    runtime.config.mode === "text_to_image"
      ? normalizeGenerativeAIImageConfig(runtime.config.image)
      : null;
  if (runtime.config.mode === "text_to_image" && !imageConfig) {
    throw new Error("Image generation configuration is invalid");
  }

  return {
    version: 1,
    configVersion: runtime.config.version,
    executionId,
    phase: "accepted",
    scenarioId: runtime.scenarioId,
    scenarioRevisionFingerprint: runtime.scenarioRevisionFingerprint,
    actionNodeId: runtime.actionNodeId,
    inputMessageId: input.messageId,
    expectedInputKind: resolveGenerativeAIExpectedInputKind(
      runtime.config.mode,
    ),
    mode: runtime.config.mode,
    composedPrompt: composeGenerativeAIExecutionPrompt(runtime.config, input),
    ...(imageConfig ? { imageConfig } : {}),
    sourceMedia:
      input.kind === "image" && input.whatsappMediaId
        ? {
            whatsappMediaId: input.whatsappMediaId,
            declaredMimeType: input.declaredMimeType,
            fileName: input.fileName,
          }
        : null,
    successTransition: runtime.successTransition,
    failureTransition: runtime.failureTransition,
    scenarioWorkflowId: buildGenerativeAIScenarioWorkflowId(executionId),
    acceptedAt,
  };
}

const AT_MOST_ONCE = { dispatchPolicy: "at_most_once" as const };

function buildDeferredCommand(
  execution: ActiveGenerativeAIExecution,
  context: { workspaceId: string; conversationId: string },
): AiriConversationDeferredCommand {
  return {
    version: 1,
    kind: "start_generative_ai_scenario",
    workflowId: execution.scenarioWorkflowId,
    workspaceId: context.workspaceId,
    conversationId: context.conversationId,
    executionId: execution.executionId,
    scenarioId: execution.scenarioId,
    scenarioRevisionFingerprint: execution.scenarioRevisionFingerprint,
    actionNodeId: execution.actionNodeId,
  };
}

/** The deferred start of an accepted execution; nothing is sent. */
function buildStart(
  execution: ActiveGenerativeAIExecution,
  context: { workspaceId: string; conversationId: string },
) {
  return {
    kind: "started" as const,
    execution: {
      ...execution,
      phase: "accepted" as const,
    },
    deferredCommand: buildDeferredCommand(execution, context),
  };
}

export async function resolveGenerativeAIAutoReplyAction(params: {
  runtime: GenerativeAIAutoReplyRuntime | null;
  activeExecution: ActiveGenerativeAIExecution | null;
  executionContext: {
    workspaceId: string;
    conversationId: string;
  };
  acceptedAt: string;
  targetLanguage: string;
  /** Found before the turn committed to this action, which now follows Failure. */
  promptIssue?: GenerativeAIPromptIssue | null;
  claimExecution: (
    execution: FrozenGenerativeAIExecution,
  ) => Promise<ClaimResult>;
}): Promise<
  | { kind: "waiting" }
  | {
      kind: "guidance" | "failure";
      content: string;
      dispatchPolicy: "at_most_once";
    }
  | {
      kind: "started";
      execution: FrozenGenerativeAIExecution;
      deferredCommand: AiriConversationDeferredCommand;
    }
> {
  if (params.activeExecution) {
    // An accepted execution whose start was not confirmed starts again; the
    // workflow id makes the start idempotent. A running one stays silent.
    return params.activeExecution.phase === "accepted"
      ? buildStart(params.activeExecution, params.executionContext)
      : { kind: "waiting" };
  }

  if (!params.runtime) {
    return { kind: "waiting" };
  }

  if (params.promptIssue) {
    // The same copy a provider failure sends, unless the day's limit was
    // reached; nothing is claimed or started.
    return {
      kind: "failure",
      content: resolveGenerativeAICustomerCopy(
        params.targetLanguage,
        params.promptIssue === "daily_limit_reached"
          ? "limit_reached"
          : "failure",
        params.runtime.config.mode,
      ),
      ...AT_MOST_ONCE,
    };
  }

  if (params.runtime.input.status === "waiting_for_compatible_input") {
    return { kind: "waiting" };
  }

  if (params.runtime.input.status !== "compatible") {
    return {
      kind: "guidance",
      content: resolveGenerativeAICustomerCopy(
        params.targetLanguage,
        params.runtime.input.expectedInputKind === "image"
          ? "image_guidance"
          : "text_guidance",
      ),
      ...AT_MOST_ONCE,
    };
  }

  const execution = buildExecution(
    params.runtime,
    params.runtime.input.input,
    params.acceptedAt,
  );
  const claim = await params.claimExecution(execution);
  // Another turn owns the generation, or the conversation moved on.
  if (claim.status !== "claimed") return { kind: "waiting" };

  return buildStart(execution, params.executionContext);
}

export async function resolveGenerativeAIAutoReplyActionAfterContext(
  params: Omit<
    Parameters<typeof resolveGenerativeAIAutoReplyAction>[0],
    "targetLanguage"
  > & {
    ensurePreRuntimeContext: () => Promise<void>;
    readTargetLanguage: () => string;
  },
) {
  const { ensurePreRuntimeContext, readTargetLanguage, ...actionParams } =
    params;
  await ensurePreRuntimeContext();
  return resolveGenerativeAIAutoReplyAction({
    ...actionParams,
    targetLanguage: readTargetLanguage(),
  });
}
