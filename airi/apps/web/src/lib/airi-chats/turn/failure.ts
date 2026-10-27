/**
 * The one failure mapper of an Airi chat turn. Errors map to typed codes
 * (never to message text); a retryable provider failure inside a step
 * becomes the busy reply, anything else at the turn boundary becomes the
 * failure reply. Both keep the user's message answered.
 */

import { throwIfCancelled } from "@/lib/ai/cancellation";
import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";
import {
  AIChatProviderAggregateError,
  getHeavyTextModel,
  isRetryableAIProviderError,
} from "@/lib/ai";
import { isAiriChatReplyFailed } from "@/lib/airi-chats/errors";
import {
  buildAiriChatFailureFields,
  describeAiriChatFailure,
  formatAiriChatFailureDetail,
  type AiriChatFailureDiagnostics,
} from "@/lib/airi-chats/failure-diagnostics";
import type { AiriChatTurnOutcome } from "@/lib/airi-chats/analytics";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriChatGeneratorStage,
  AiriTurnContext,
} from "./types";
import { stageEvent } from "./progress";
import { AiriTurnDeadlineExceededError } from "./deadline";

/** Every code a failed or degraded turn can record on its reply. */
export type AiriTurnErrorCode =
  | "provider_resource_exhausted"
  | "airi_generation_failed"
  | "meta_ads_requires_claude"
  | "airi_run_cancelled"
  | "airi_run_interrupted"
  | "artifact_validation_failed"
  | "own_ai_source_required";

/** A typed turn failure a handler or the run layer throws on purpose. */
export class AiriTurnError extends Error {
  constructor(
    readonly code: Exclude<
      AiriTurnErrorCode,
      "provider_resource_exhausted" | "own_ai_source_required"
    >,
    message: string = code
  ) {
    super(message);
    this.name = "AiriTurnError";
  }
}

export type AiriTurnFailure = {
  code: AiriTurnErrorCode;
  /** A step may answer with the busy reply and let the user retry. */
  retryable: boolean;
  diagnostics: AiriChatFailureDiagnostics;
};

/**
 * Maps an error to its turn failure. Inside a step ("step") a retryable
 * provider failure is the busy reply's provider_resource_exhausted; at the
 * turn boundary ("turn") every untyped error is airi_generation_failed.
 */
export function mapAiriTurnFailure(
  error: unknown,
  at: "step" | "turn"
): AiriTurnFailure {
  const diagnostics = describeAiriChatFailure(error);
  const required = getWorkspaceAiRequiredDetails(error);
  if (required) {
    return { code: required.code, retryable: false, diagnostics };
  }
  if (error instanceof AiriTurnError) {
    return { code: error.code, retryable: false, diagnostics };
  }
  // Out of turn time: retrying inside this turn cannot help.
  if (error instanceof AiriTurnDeadlineExceededError) {
    return { code: "airi_generation_failed", retryable: false, diagnostics };
  }
  if (at === "step" && isRetryableAIProviderError(error)) {
    return {
      code: "provider_resource_exhausted",
      retryable: true,
      diagnostics,
    };
  }
  return { code: "airi_generation_failed", retryable: false, diagnostics };
}

/** Failure codes whose reply text is localized (en, ru, kz). */
export const AIRI_TURN_LOCALIZED_FAILURE_CODES: ReadonlySet<AiriTurnErrorCode> =
  new Set([
    "provider_resource_exhausted",
    "meta_ads_requires_claude",
    "airi_run_cancelled",
    "airi_run_interrupted",
    "artifact_validation_failed",
  ]);

export const AIRI_TURN_FAILURE_MESSAGES: Record<
  | "meta_ads_requires_claude"
  | "airi_run_cancelled"
  | "airi_run_interrupted"
  | "artifact_validation_failed",
  { en: string; ru: string; kz: string }
> = {
  meta_ads_requires_claude: {
    en: "Meta Ads answers need Claude, which is unavailable right now. Please try again in a few minutes.",
    ru: "Для ответов по Meta Ads нужен Claude, а он сейчас недоступен. Попробуйте ещё раз через несколько минут.",
    kz: "Meta Ads бойынша жауап беру үшін Claude қажет, ол қазір қолжетімсіз. Бірнеше минуттан кейін қайталап көріңіз.",
  },
  airi_run_cancelled: {
    en: "Stopped.",
    ru: "Остановлено.",
    kz: "Тоқтатылды.",
  },
  airi_run_interrupted: {
    en: "This answer was interrupted before it finished. Please send the request again.",
    ru: "Ответ прервался до завершения. Отправьте запрос ещё раз.",
    kz: "Жауап аяқталмай үзілді. Сұрауды қайта жіберіңіз.",
  },
  artifact_validation_failed: {
    en: "I could not save this draft because it did not pass validation. Try again or adjust the request.",
    ru: "Не удалось сохранить черновик: он не прошёл проверку. Попробуйте ещё раз или уточните запрос.",
    kz: "Жобаны сақтау мүмкін болмады: ол тексеруден өтпеді. Қайталап көріңіз немесе сұрауды нақтылаңыз.",
  },
};

export const AIRI_TURN_GENERIC_FAILURE_MESSAGE =
  "I saved your request, but I could not finish the answer. Try again, or narrow the request to one concrete output such as a WhatsApp reminder flow, campaign plan, or template draft.";

/** The reply text a failed turn saves for its code. */
export function getAiriTurnFailureMessage(params: {
  code: AiriTurnErrorCode;
  language?: string | null;
  workspaceId: string;
}): string {
  if (params.code === "own_ai_source_required") {
    return `Your workspace needs a connected AI source to continue. [Connect Google AI in Settings > Integrations](/panel/w/${encodeURIComponent(params.workspaceId)}/settings/integrations?integration=google_ai).`;
  }
  if (params.code === "provider_resource_exhausted") {
    return getRetryableAiriChatErrorMessage(params.language ?? "en");
  }
  if (params.code === "airi_generation_failed") {
    return AIRI_TURN_GENERIC_FAILURE_MESSAGE;
  }
  const messages = AIRI_TURN_FAILURE_MESSAGES[params.code];
  return params.language === "ru" || params.language === "kz"
    ? messages[params.language]
    : messages.en;
}

export function getRetryableAiriChatErrorMessage(language: string): string {
  switch (language) {
    case "ru":
      return "Airi \u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e \u043f\u0435\u0440\u0435\u0433\u0440\u0443\u0436\u0435\u043d\u0430. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u0437\u0430\u043f\u0440\u043e\u0441 \u0435\u0449\u0435 \u0440\u0430\u0437 \u0447\u0435\u0440\u0435\u0437 \u043c\u0438\u043d\u0443\u0442\u0443.";
    case "kz":
      return "Airi \u0443\u0430\u049b\u044b\u0442\u0448\u0430 \u0448\u0430\u043c\u0430\u0434\u0430\u043d \u0442\u044b\u0441 \u0436\u04af\u043a\u0442\u0435\u043b\u0434\u0456. \u0421\u04b1\u0440\u0430\u0443\u0434\u044b \u0431\u0456\u0440 \u043c\u0438\u043d\u0443\u0442\u0442\u0430\u043d \u043a\u0435\u0439\u0456\u043d \u049b\u0430\u0439\u0442\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u043f \u043a\u04e9\u0440\u0456\u04a3\u0456\u0437.";
    case "uz":
      return "Airi vaqtincha band. So'rovni bir daqiqadan keyin qayta yuborib ko'ring.";
    default:
      return "Airi is temporarily busy. Please try sending the request again in a minute.";
  }
}

/**
 * Provider and model recorded for a generation that failed with a retryable
 * error: the last provider attempt when the error carries attempts, otherwise
 * only the requested model (no provider served the turn).
 */
export function resolveFailedAiriChatGenerationTarget(
  error: unknown,
  requestedModel: string
): { provider: string | null; model: string } {
  const lastAttempt =
    error instanceof AIChatProviderAggregateError
      ? error.providerErrors[error.providerErrors.length - 1]
      : undefined;
  return lastAttempt
    ? { provider: lastAttempt.provider, model: lastAttempt.model }
    : { provider: null, model: requestedModel };
}

/**
 * Records a failed step on its stage with a safe error class. Cancellation
 * and workspace AI policy errors propagate unchanged. A retryable provider
 * failure is "Provider unavailable" (capacity, rate limit or timeout alike),
 * never a guess at which one.
 */
export async function recordAiriChatStepFailure(params: {
  error: unknown;
  signal?: AbortSignal;
  progress: AiriChatProgressRecorder;
  stage: AiriChatGeneratorStage;
}): Promise<AiriTurnFailure> {
  throwIfCancelled(params.signal, params.error);
  if (isWorkspaceAiPolicyError(params.error)) throw params.error;
  const failure = mapAiriTurnFailure(params.error, "step");
  const detail = formatAiriChatFailureDetail(failure.diagnostics);
  await params.progress.emit(
    stageEvent(
      params.stage.id,
      params.stage.label,
      "error",
      failure.retryable ? `Provider unavailable: ${detail}` : detail
    )
  );
  return failure;
}

/**
 * The one catch for a generator step: a retryable provider failure returns
 * its failure so the caller saves the busy reply; anything else is rethrown
 * to the turn's failure reply.
 */
export async function recordAiriChatGeneratorFailure(
  params: Parameters<typeof recordAiriChatStepFailure>[0]
): Promise<AiriTurnFailure> {
  const failure = await recordAiriChatStepFailure(params);
  if (!failure.retryable) throw params.error;
  return failure;
}

/** A failure reply and a busy (retryable) reply both count as failed. */
export function getAiriChatReplyOutcome(
  metadata: Record<string, unknown>
): AiriChatTurnOutcome {
  return isAiriChatReplyFailed(metadata) ? "failed" : "ok";
}

/** The reply saved when the turn itself failed (no step recovered it). */
export function buildAiriChatFailureReply(params: {
  workspaceId: string;
  threadId: string;
  userMessageId?: string | null;
  startedAt: number;
  progress: AiriChatProgressRecorder;
  error?: unknown;
  /** Workspace language, for the codes whose reply text is localized. */
  language?: string | null;
}): GeneratedAiriChatReply {
  const failure =
    params.error === undefined
      ? null
      : mapAiriTurnFailure(params.error, "turn");
  const errorCode = failure?.code ?? "airi_generation_failed";
  const failureFields = failure
    ? buildAiriChatFailureFields(failure.diagnostics)
    : {};
  const traceId = [
    "airi-chat",
    params.workspaceId,
    params.threadId,
    params.userMessageId || String(params.startedAt),
    "failure",
  ].join(":");
  const receipt: AiriChatResourceReceipt = {
    selectedSources: [],
    selectedSourceLabels: [],
    resources: params.progress.resources,
    sourceIds: [],
    retrievalPath: "none",
    provider: null,
    model: null,
    errorCode,
    ...failureFields,
    durationMs: Date.now() - params.startedAt,
  };

  return {
    content: getAiriTurnFailureMessage({
      code: errorCode,
      language: params.language,
      workspaceId: params.workspaceId,
    }),
    metadata: {
      provider: null,
      model: null,
      usage: null,
      kbArticlesFound: 0,
      conversationsFound: 0,
      retrievalContextCount: 0,
      sourceIds: [],
      selectedSources: [],
      selectedSourceLabels: [],
      pendingActions: [],
      traceId,
      failed: true,
      errorCode,
      ...failureFields,
      resourceReceipt: receipt,
      thinkingTrace: {
        stages: params.progress.stages,
        resources: params.progress.resources,
      },
    },
    analytics: {
      traceId,
      durationMs: Date.now() - params.startedAt,
      generationLatencyMs: null,
      generationModel: null,
      sourceIds: [],
      conversationSourceIds: [],
      kbSourceIds: [],
      retrievalPath: "none",
    },
  };
}

export type AiriChatGeneratorFailureContext = Pick<
  AiriTurnContext,
  | "airiLanguage"
  | "selectedContext"
  | "selectedSourceLabels"
  | "resourceItems"
  | "sourceContext"
  | "searchResult"
  | "pendingActions"
  | "traceId"
  | "progress"
  | "startedAt"
>;

/**
 * The busy reply saved when a generator step failed on a retryable provider
 * error: the last attempted provider and model, the safe failure facts, and
 * the sources the turn had gathered.
 */
export function buildAiriChatRetryableFailureReply(
  context: AiriChatGeneratorFailureContext,
  params: {
    error: unknown;
    failure: AiriTurnFailure;
    requestedModel: string;
  }
): GeneratedAiriChatReply {
  const failedTarget = resolveFailedAiriChatGenerationTarget(
    params.error,
    params.requestedModel
  );
  const failureFields = buildAiriChatFailureFields(params.failure.diagnostics);
  const errorCode = params.failure.code;
  const receipt: AiriChatResourceReceipt = {
    selectedSources: context.selectedContext?.selectedSources ?? [],
    selectedSourceLabels: context.selectedSourceLabels,
    resources: context.resourceItems,
    sourceIds: context.sourceContext.sourceIds,
    retrievalPath: context.sourceContext.retrievalPath,
    provider: failedTarget.provider,
    model: failedTarget.model,
    retryable: true,
    errorCode,
    ...failureFields,
    durationMs: Date.now() - context.startedAt,
  };
  return {
    content: getRetryableAiriChatErrorMessage(context.airiLanguage),
    metadata: {
      provider: failedTarget.provider,
      model: failedTarget.model,
      usage: null,
      kbArticlesFound: context.searchResult.kbArticles.length,
      conversationsFound: context.searchResult.conversations.length,
      retrievalContextCount: context.sourceContext.sourceIds.length,
      sourceIds: context.sourceContext.sourceIds,
      selectedSources: context.selectedContext?.selectedSources ?? [],
      selectedSourceLabels: context.selectedContext?.selectedSourceLabels ?? [],
      pendingActions: context.pendingActions,
      traceId: context.traceId,
      retryable: true,
      errorCode,
      ...failureFields,
      resourceReceipt: receipt,
      thinkingTrace: {
        stages: context.progress.stages,
        resources: context.resourceItems,
      },
    },
    analytics: {
      traceId: context.traceId,
      durationMs: Date.now() - context.startedAt,
      generationLatencyMs: null,
      generationModel: failedTarget.model,
      ...context.sourceContext,
    },
  };
}

/**
 * The step recovery every handler shares (AiriTurnContext's
 * recoverFromGeneratorFailure): the busy reply on a retryable provider
 * error; anything else is rethrown to the turn's failure reply.
 */
export function createAiriTurnStepRecovery(
  context: AiriChatGeneratorFailureContext & { signal?: AbortSignal }
): AiriTurnContext["recoverFromGeneratorFailure"] {
  return async (error, stage, requestedModel = getHeavyTextModel()) => {
    const failure = await recordAiriChatGeneratorFailure({
      error,
      signal: context.signal,
      progress: context.progress,
      stage,
    });
    return buildAiriChatRetryableFailureReply(context, {
      error,
      failure,
      requestedModel,
    });
  };
}
