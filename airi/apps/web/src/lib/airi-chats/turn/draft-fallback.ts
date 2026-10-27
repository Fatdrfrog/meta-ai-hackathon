/**
 * The degraded reply of a draft handler. When the model's answer does not
 * become a valid draft (truncated, not JSON, or rejected by the draft's
 * validator) nothing is saved: no artifact, no builder patch, so the draft
 * open in the builder stays as it was. The reply says so in the workspace
 * language and records metadata.fallbackUsed. No canned draft is ever saved
 * in place of the model's.
 */

import { throwIfCancelled } from "@/lib/ai/cancellation";
import type { AiriDraftOutputFailureReason } from "@/lib/airi-chats/draft-output";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import { AiriTurnError } from "./failure";
import { stageEvent } from "./progress";
import type {
  AiriChatGeneratorStage,
  AiriTurnContext,
  GeneratedAiriChatReply,
} from "./types";

export type AiriDraftKind =
  | "whatsapp_template"
  | "whatsapp_flow"
  | "opportunity_scan"
  | "campaign_package";

/** The model call whose answer could not be used. */
export type AiriDraftGeneration = {
  provider: string;
  model: string;
  usage: unknown;
  latencyMs: number | null;
};

/** A draft call answered, but its answer is not a valid draft. */
export class AiriDraftOutputError extends AiriTurnError {
  constructor(
    readonly draftKind: AiriDraftKind,
    readonly reason: AiriDraftOutputFailureReason,
    readonly generation: AiriDraftGeneration
  ) {
    super(
      "artifact_validation_failed",
      `Airi ${draftKind} draft output was ${reason}`
    );
    this.name = "AiriDraftOutputError";
  }
}

export function toAiriDraftGeneration(response: {
  provider: string;
  model: string;
  usage?: unknown;
  latencyMs?: number | null;
}): AiriDraftGeneration {
  return {
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

type LocalizedText = { en: string; ru: string; kz: string };

/** `kept`: a draft of this kind is open and stays unchanged. */
export const AIRI_DRAFT_FALLBACK_MESSAGES: Record<
  AiriDraftKind,
  { created: LocalizedText; kept?: LocalizedText }
> = {
  whatsapp_template: {
    created: {
      en: "I couldn't turn this answer into a valid WhatsApp template, so I didn't create a draft. Try again, or add the goal, audience and buttons you want.",
      ru: "Не удалось собрать из ответа корректный WhatsApp-шаблон, поэтому черновик не создан. Попробуйте ещё раз или уточните цель, аудиторию и кнопки.",
      kz: "Жауаптан дұрыс WhatsApp үлгісін құрастыру мүмкін болмады, сондықтан жоба жасалмады. Қайталап көріңіз немесе мақсатты, аудиторияны және батырмаларды нақтылаңыз.",
    },
    kept: {
      en: "I couldn't turn this answer into a valid WhatsApp template, so your current draft is unchanged. Try again, or describe the change more specifically.",
      ru: "Не удалось собрать из ответа корректный WhatsApp-шаблон, поэтому текущий черновик не изменён. Попробуйте ещё раз или опишите изменение точнее.",
      kz: "Жауаптан дұрыс WhatsApp үлгісін құрастыру мүмкін болмады, сондықтан ағымдағы жоба өзгертілмеді. Қайталап көріңіз немесе өзгерісті нақтырақ сипаттаңыз.",
    },
  },
  whatsapp_flow: {
    created: {
      en: "I couldn't turn this answer into a valid WhatsApp Flow, so I didn't create a draft. Try again, or list the screens and fields you need.",
      ru: "Не удалось собрать из ответа корректный WhatsApp Flow, поэтому черновик не создан. Попробуйте ещё раз или перечислите нужные экраны и поля.",
      kz: "Жауаптан дұрыс WhatsApp Flow құрастыру мүмкін болмады, сондықтан жоба жасалмады. Қайталап көріңіз немесе қажетті экрандар мен өрістерді атап шығыңыз.",
    },
    kept: {
      en: "I couldn't turn this answer into a valid WhatsApp Flow, so your current Flow is unchanged. Try again, or describe the change more specifically.",
      ru: "Не удалось собрать из ответа корректный WhatsApp Flow, поэтому текущий Flow не изменён. Попробуйте ещё раз или опишите изменение точнее.",
      kz: "Жауаптан дұрыс WhatsApp Flow құрастыру мүмкін болмады, сондықтан ағымдағы Flow өзгертілмеді. Қайталап көріңіз немесе өзгерісті нақтырақ сипаттаңыз.",
    },
  },
  opportunity_scan: {
    created: {
      en: "I couldn't turn this answer into a valid opportunity scan, so nothing was saved. Try again, or narrow it to one channel, segment or goal.",
      ru: "Не удалось собрать из ответа корректный обзор возможностей, поэтому ничего не сохранено. Попробуйте ещё раз или сузьте запрос до одного канала, сегмента или цели.",
      kz: "Жауаптан дұрыс мүмкіндіктер шолуын құрастыру мүмкін болмады, сондықтан ештеңе сақталмады. Қайталап көріңіз немесе сұрауды бір арнаға, сегментке не мақсатқа тарылтыңыз.",
    },
  },
  campaign_package: {
    created: {
      en: "I couldn't turn this answer into a valid campaign package, so nothing was saved. Try again, or name the goal, audience and channel.",
      ru: "Не удалось собрать из ответа корректный пакет кампании, поэтому ничего не сохранено. Попробуйте ещё раз или укажите цель, аудиторию и канал.",
      kz: "Жауаптан дұрыс науқан пакетін құрастыру мүмкін болмады, сондықтан ештеңе сақталмады. Қайталап көріңіз немесе мақсатты, аудиторияны және арнаны көрсетіңіз.",
    },
  },
};

export function getAiriDraftFallbackMessage(params: {
  kind: AiriDraftKind;
  language: string;
  activeDraftKept: boolean;
}): string {
  const messages = AIRI_DRAFT_FALLBACK_MESSAGES[params.kind];
  const text =
    params.activeDraftKept && messages.kept ? messages.kept : messages.created;
  return params.language === "ru" || params.language === "kz"
    ? text[params.language]
    : text.en;
}

/** The reply saved when a draft call's answer is not a valid draft. */
export async function buildAiriDraftFallbackReply(
  context: AiriTurnContext,
  params: { error: AiriDraftOutputError; stage: AiriChatGeneratorStage }
): Promise<GeneratedAiriChatReply> {
  throwIfCancelled(context.params.signal);
  const { error } = params;
  const { generation } = error;
  await context.progress.emit(
    stageEvent(
      params.stage.id,
      params.stage.label,
      "error",
      `Draft not saved: ${error.reason} output`
    )
  );
  const errorCode = error.code;
  const receipt: AiriChatResourceReceipt = {
    selectedSources: context.selectedContext?.selectedSources ?? [],
    selectedSourceLabels: context.selectedSourceLabels,
    resources: context.resourceItems,
    sourceIds: context.sourceContext.sourceIds,
    retrievalPath: context.sourceContext.retrievalPath,
    provider: generation.provider,
    model: generation.model,
    errorCode,
    durationMs: Date.now() - context.startedAt,
  };
  return {
    content: getAiriDraftFallbackMessage({
      kind: error.draftKind,
      language: context.airiLanguage,
      activeDraftKept: context.activeBuilder?.kind === error.draftKind,
    }),
    metadata: {
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
      kbArticlesFound: context.searchResult.kbArticles.length,
      conversationsFound: context.searchResult.conversations.length,
      retrievalContextCount: context.sourceContext.sourceIds.length,
      sourceIds: context.sourceContext.sourceIds,
      selectedSources: context.selectedContext?.selectedSources ?? [],
      selectedSourceLabels: context.selectedContext?.selectedSourceLabels ?? [],
      // The draft was not made, so its pending action stays open.
      pendingActions: context.pendingActions,
      traceId: context.traceId,
      fallbackUsed: true,
      errorCode,
      draftFallback: { kind: error.draftKind, reason: error.reason },
      resourceReceipt: receipt,
      thinkingTrace: {
        stages: context.progress.stages,
        resources: context.resourceItems,
      },
    },
    analytics: {
      traceId: context.traceId,
      durationMs: Date.now() - context.startedAt,
      generationLatencyMs: generation.latencyMs,
      generationModel: generation.model,
      ...context.sourceContext,
    },
  };
}
