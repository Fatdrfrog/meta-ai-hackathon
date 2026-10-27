/** whatsapp_template: drafts a template and saves it as an artifact. */

import { throwIfCancelled } from "@/lib/ai/cancellation";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import {
  createTemplateBuilderPatch,
  type ActiveAiriBuilderInput,
  type AiriBuilderPatch,
} from "@/lib/airi-chats/builder-state";
import {
  AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA,
  normalizeGeneratedAiriWhatsAppTemplateDraft,
  preserveActiveTemplateHeaderMedia,
  type AiriWhatsAppTemplateDraft,
} from "@/lib/airi-chats/whatsapp-template-drafts";
import {
  buildAiriDraftStructuredOutputOptions,
  parseAiriDraftJson,
} from "@/lib/airi-chats/draft-output";
import { buildAiriCreativeAssetUri } from "@/lib/airi-chats/creative-asset-refs";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import {
  createQueuedAiriImageGeneration,
  startQueuedAiriImageGeneration,
  updateQueuedAiriImageGenerationTarget,
  type QueuedAiriImageGeneration,
} from "@/lib/airi-chats/generated-image-generation";
import type { AiriGeneratedAssetAttachment } from "@/lib/airi-chats/generated-assets";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import { stageEvent, buildModelRunEvent } from "../progress";
import {
  AIRI_SHORT_DRAFT_AI_TIMEOUT_MS,
  type AiriTurnDeadline,
} from "../deadline";
import {
  withAiriBuilderPatchTarget,
  persistAiriBuilderArtifact,
  reportAiriBuilderArtifactInvalid,
  buildAiriBuilderArtifactInvalidNotice,
} from "../artifacts";
import {
  AiriDraftOutputError,
  buildAiriDraftFallbackReply,
  toAiriDraftGeneration,
} from "../draft-fallback";

const TEMPLATE_DRAFT_STAGE = {
  id: "template_draft",
  label: "Drafting WhatsApp template",
};

export function buildWhatsAppTemplateDraftPrompt(params: {
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
  activeBuilder?: ActiveAiriBuilderInput | null;
}) {
  const activeTemplate =
    params.activeBuilder?.kind === "whatsapp_template"
      ? JSON.stringify(params.activeBuilder.templateDraft, null, 2)
      : "No active template draft.";
  return `You draft WhatsApp Business message templates for Airi.chat workspaces.

Return ONLY valid JSON. Do not wrap it in markdown.

JSON shape:
{
  "name": "lower_snake_case_name",
  "language": "en",
  "category": "MARKETING",
  "components": [
    { "type": "HEADER", "format": "TEXT", "text": "Optional short title" },
    { "type": "BODY", "text": "Template body with WhatsApp placeholders like {{1}}" },
    { "type": "FOOTER", "text": "Optional footer" },
    { "type": "BUTTONS", "buttons": [
      { "type": "QUICK_REPLY", "text": "Tell me more" }
    ] }
  ],
  "rationale": "Why this template fits the request",
  "missingDetails": []
}

Rules:
- Use ${params.airiLanguage} as the template language when possible.
- Prefer MARKETING for campaigns/re-engagement, UTILITY for order/support updates, AUTHENTICATION only for OTP/login.
- Keep button text 25 characters or shorter.
- Do not include unsafe claims, spammy pressure, or fake discounts unless the user supplied them.
- If details are missing, still produce the best safe draft and list missing details.
- If an active template draft is provided, preserve its valid fields unless the user asks to change them.
- Use an IMAGE header only when the user explicitly asks for a visual/image creative or the campaign clearly requires a header image. Use { "type": "HEADER", "format": "IMAGE" } instead of a text header in that case. Do not include header_handle values for generated images; Airi will generate and attach the image asynchronously.

THREAD HISTORY:
${params.history || "No previous messages."}

ATTACHED SOURCES:
${params.attachedSourceContext}

ATTACHED FILES:
${params.attachedFileContext}

WORKSPACE KNOWLEDGE:
${params.kbContext || "No relevant KB articles found."}

RECENT CUSTOMER CONTEXT:
${params.conversationContext || "No relevant conversations found."}

USER REQUEST:
${params.userMessage}

ACTIVE TEMPLATE DRAFT:
${activeTemplate}`;
}

export async function generateWhatsAppTemplateDraft(params: {
  signal?: AbortSignal;
  workspaceId: string;
  threadId: string;
  userMessageId?: string | null;
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
  traceId: string;
  pendingActions: AiriChatPendingAction[];
  activeBuilder?: ActiveAiriBuilderInput | null;
  progress: AiriChatProgressRecorder;
  deadline: AiriTurnDeadline;
}): Promise<{
  draft: AiriWhatsAppTemplateDraft;
  patch: AiriBuilderPatch;
  provider: string;
  model: string;
  usage: unknown;
  latencyMs: number | null;
}> {
  await params.progress.emit(
    stageEvent(TEMPLATE_DRAFT_STAGE.id, TEMPLATE_DRAFT_STAGE.label, "running")
  );
  const response = await chatCompletionWithFallback({
    signal: params.signal,
    model: getHeavyTextModel(),
    messages: [
      {
        role: "user",
        content: buildWhatsAppTemplateDraftPrompt(params),
      },
    ],
    temperature: 0.25,
    ...buildAiriDraftStructuredOutputOptions(
      AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA
    ),
    resilience: {
      maxRetries: 2,
      initialRetryDelayMs: 300,
      maxRetryDelayMs: 2_000,
      timeoutMs: params.deadline.stepTimeoutMs(AIRI_SHORT_DRAFT_AI_TIMEOUT_MS),
    },
    analytics: {
      workspaceId: params.workspaceId,
      conversationId: params.threadId,
      messageId: params.userMessageId || null,
      traceId: `${params.traceId}:whatsapp_template_draft`,
      operation: "airi_chat.whatsapp_template_draft",
      sourceService: "web.airi_chat",
      inputText: params.userMessage,
      metadata: {
        pendingActions: params.pendingActions,
      },
    },
    onLifecycle: async event => {
      await params.progress.emit(buildModelRunEvent(event));
    },
  });
  const parsed = parseAiriDraftJson(response);
  const generated = parsed.ok
    ? normalizeGeneratedAiriWhatsAppTemplateDraft(parsed.value, {
        language: params.airiLanguage,
      })
    : null;
  // An edit keeps the open template's header media (the schema cannot
  // carry its handle), before an unresolved IMAGE header is regenerated.
  const draft =
    generated && params.activeBuilder?.kind === "whatsapp_template"
      ? preserveActiveTemplateHeaderMedia(
          generated,
          params.activeBuilder.templateDraft
        )
      : generated;
  if (!draft) {
    throw new AiriDraftOutputError(
      "whatsapp_template",
      parsed.ok ? "invalid" : parsed.reason,
      toAiriDraftGeneration(response)
    );
  }
  const baseRevision =
    params.activeBuilder?.kind === "whatsapp_template"
      ? params.activeBuilder.revision
      : 0;
  const patch = createTemplateBuilderPatch({
    baseRevision,
    draft,
    summary: `Updated ${draft.name}`,
  });
  await params.progress.emit(
    stageEvent(
      TEMPLATE_DRAFT_STAGE.id,
      TEMPLATE_DRAFT_STAGE.label,
      "complete",
      draft.name
    )
  );
  return {
    draft,
    patch,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

export function buildWhatsAppTemplateDraftAssistantContent(params: {
  draft: AiriWhatsAppTemplateDraft;
  airiLanguage: string;
  generatedHeaderImage?: boolean;
}) {
  if (params.airiLanguage === "ru") {
    const imageSuffix = params.generatedHeaderImage
      ? " Я также начала генерировать изображение для заголовка; оно появится во вложениях, когда будет готово."
      : "";
    return `Готово. Я подготовила черновик WhatsApp-шаблона **${params.draft.name}**. Проверьте карточку ниже и отправляйте в WhatsApp Manager только после подтверждения.${imageSuffix}`;
  }
  if (params.airiLanguage === "kz") {
    const imageSuffix = params.generatedHeaderImage
      ? " Сондай-ақ тақырып суретін жасай бастадым; дайын болғанда ол тіркеме ретінде пайда болады."
      : "";
    return `Дайын. **${params.draft.name}** WhatsApp үлгісінің жобасын дайындадым. Төмендегі карточканы тексеріп, дұрыс екеніне көз жеткізгеннен кейін ғана WhatsApp Manager-ге жіберіңіз.${imageSuffix}`;
  }
  const imageSuffix = params.generatedHeaderImage
    ? " I also started generating the image header; it will appear as an attachment when ready."
    : "";
  return `Done. I drafted the WhatsApp template **${params.draft.name}**. Review the card below and submit it to WhatsApp Manager only after confirming it is correct.${imageSuffix}`;
}

export function getTemplateBodyText(draft: AiriWhatsAppTemplateDraft): string {
  const body = draft.components.find(component => component.type === "BODY");
  return body?.type === "BODY" ? body.text || "" : "";
}

export function getUnresolvedImageHeaderIndex(
  draft: AiriWhatsAppTemplateDraft
): number {
  return draft.components.findIndex(component => {
    if (component.type !== "HEADER" || component.format !== "IMAGE") {
      return false;
    }
    const value = component.example?.header_handle?.[0];
    return !(typeof value === "string" && value.trim());
  });
}

export function withTemplateImageHeaderHandle(params: {
  draft: AiriWhatsAppTemplateDraft;
  headerIndex: number;
  handle: string;
}): AiriWhatsAppTemplateDraft {
  return {
    ...params.draft,
    components: params.draft.components.map((component, index) => {
      if (index !== params.headerIndex || component.type !== "HEADER") {
        return component;
      }
      return {
        ...component,
        example: {
          ...component.example,
          header_handle: [params.handle],
        },
      };
    }),
  };
}

export function buildTemplateHeaderImagePrompt(params: {
  userMessage: string;
  draft: AiriWhatsAppTemplateDraft;
  conversationContext: string;
  kbContext: string;
}): string {
  return [
    "Create a realistic, brand-safe WhatsApp template header image.",
    `Template: ${params.draft.name}`,
    `Category: ${params.draft.category}`,
    `Message body: ${getTemplateBodyText(params.draft)}`,
    `User request: ${params.userMessage}`,
    params.conversationContext
      ? `Customer context: ${params.conversationContext.slice(0, 1200)}`
      : null,
    params.kbContext
      ? `Workspace knowledge: ${params.kbContext.slice(0, 800)}`
      : null,
    "Use a clean mobile-first composition. Avoid readable text inside the image unless the user explicitly provided exact copy. Avoid logos unless provided in the workspace context.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The whatsapp_template step of the turn. */
export async function handleWhatsAppTemplateTurn(
  context: AiriTurnContext
): Promise<GeneratedAiriChatReply> {
  const {
    params,
    deadline,
    startedAt,
    progress,
    activeBuilder,
    airiLanguage,
    selectedContext,
    searchResult,
    sourceContext,
    selectedSourceLabels,
    resourceItems,
    pendingActions,
    traceId,
    historyContext,
    kbContext,
    conversationContext,
    attachedSourceContext,
    attachedFileContext,
    recoverFromGeneratorFailure,
  } = context;

  try {
    let templateDraft = await generateWhatsAppTemplateDraft({
      signal: params.signal,
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userMessageId: params.userMessageId,
      userMessage: params.userMessage,
      airiLanguage,
      attachedSourceContext,
      attachedFileContext,
      kbContext,
      conversationContext,
      history: historyContext,
      traceId,
      pendingActions,
      activeBuilder,
      progress,
      deadline,
    });
    let generatedHeaderImage: QueuedAiriImageGeneration | null = null;
    const imageHeaderIndex = getUnresolvedImageHeaderIndex(templateDraft.draft);
    if (imageHeaderIndex >= 0) {
      throwIfCancelled(params.signal);
      generatedHeaderImage = await createQueuedAiriImageGeneration({
        workspaceId: params.workspaceId,
        userId: params.userId,
        threadId: params.threadId,
        userMessageId: params.userMessageId,
        title: `${templateDraft.draft.name} header image`,
        prompt: buildTemplateHeaderImagePrompt({
          userMessage: params.userMessage,
          draft: templateDraft.draft,
          conversationContext,
          kbContext,
        }),
        aspectRatio: "16:9",
        target: { kind: "whatsapp_template_header" },
      });
      if (generatedHeaderImage) {
        const nextDraft = withTemplateImageHeaderHandle({
          draft: templateDraft.draft,
          headerIndex: imageHeaderIndex,
          handle: buildAiriCreativeAssetUri(generatedHeaderImage.assetId),
        });
        templateDraft = {
          ...templateDraft,
          draft: nextDraft,
          patch: createTemplateBuilderPatch({
            baseRevision: templateDraft.patch.baseRevision,
            draft: nextDraft,
            summary: templateDraft.patch.summary,
          }),
        };
      }
    }
    throwIfCancelled(params.signal);
    const artifactResult = await persistAiriBuilderArtifact({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userId: params.userId,
      userMessageId: params.userMessageId,
      activeBuilder,
      kind: "whatsapp_template",
      snapshot: { templateDraft: templateDraft.draft },
      changeSummary: templateDraft.patch.summary,
    });
    let generatedHeaderAttachments: AiriGeneratedAssetAttachment[] = [];
    if (generatedHeaderImage) {
      const target =
        artifactResult.artifact?.kind === "whatsapp_template"
          ? {
              kind: "whatsapp_template_header" as const,
              templateArtifactId: artifactResult.artifact.id,
              templateRevision: artifactResult.artifact.revision,
            }
          : { kind: "whatsapp_template_header" as const };
      throwIfCancelled(params.signal);
      await updateQueuedAiriImageGenerationTarget({
        workspaceId: params.workspaceId,
        assetId: generatedHeaderImage.assetId,
        target,
      });
      let imageStartError: string | null = null;
      try {
        throwIfCancelled(params.signal);
        await startQueuedAiriImageGeneration({
          workspaceId: params.workspaceId,
          assetId: generatedHeaderImage.assetId,
          prompt: generatedHeaderImage.attachment.prompt,
          aspectRatio: "16:9",
        });
      } catch (error) {
        throwIfCancelled(params.signal, error);
        if (isWorkspaceAiPolicyError(error)) throw error;
        imageStartError =
          error instanceof Error
            ? error.message
            : "Failed to start image generation";
      }
      generatedHeaderAttachments = [
        {
          ...generatedHeaderImage.attachment,
          ...("templateArtifactId" in target
            ? {
                templateArtifactId: target.templateArtifactId,
                templateRevision: target.templateRevision,
              }
            : {}),
          ...(imageStartError
            ? { status: "failed" as const, error: imageStartError }
            : {}),
        },
      ];
    }
    const receipt: AiriChatResourceReceipt = {
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels,
      resources: resourceItems,
      sourceIds: sourceContext.sourceIds,
      retrievalPath: sourceContext.retrievalPath,
      provider: templateDraft.provider,
      model: templateDraft.model,
      durationMs: Date.now() - startedAt,
    };
    await reportAiriBuilderArtifactInvalid(progress, artifactResult.invalid);
    return {
      content:
        buildWhatsAppTemplateDraftAssistantContent({
          draft: templateDraft.draft,
          airiLanguage,
          generatedHeaderImage: generatedHeaderAttachments.length > 0,
        }) +
        buildAiriBuilderArtifactInvalidNotice(
          artifactResult.invalid,
          airiLanguage
        ),
      metadata: {
        provider: templateDraft.provider,
        model: templateDraft.model,
        usage: templateDraft.usage,
        kbArticlesFound: searchResult.kbArticles.length,
        conversationsFound: searchResult.conversations.length,
        retrievalContextCount: sourceContext.sourceIds.length,
        sourceIds: sourceContext.sourceIds,
        selectedSources: selectedContext?.selectedSources ?? [],
        selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
        pendingActions: pendingActions.filter(
          action => action.kind !== "whatsapp_template_draft"
        ),
        whatsappTemplateDraft: templateDraft.draft,
        airiBuilderPatch: withAiriBuilderPatchTarget(
          templateDraft.patch,
          activeBuilder
        ),
        ...(generatedHeaderAttachments.length > 0
          ? { airiGeneratedAssetAttachments: generatedHeaderAttachments }
          : {}),
        ...(artifactResult.artifact
          ? { airiArtifact: artifactResult.artifact }
          : {}),
        ...(artifactResult.conflict
          ? { airiArtifactConflict: artifactResult.conflict }
          : {}),
        ...(artifactResult.invalid
          ? { airiArtifactInvalid: artifactResult.invalid }
          : {}),
        traceId,
        resourceReceipt: receipt,
        thinkingTrace: {
          stages: progress.stages,
          resources: resourceItems,
        },
      },
      analytics: {
        traceId,
        durationMs: Date.now() - startedAt,
        generationLatencyMs: templateDraft.latencyMs,
        generationModel: templateDraft.model ?? null,
        ...sourceContext,
      },
    };
  } catch (error) {
    if (error instanceof AiriDraftOutputError) {
      return buildAiriDraftFallbackReply(context, {
        error,
        stage: TEMPLATE_DRAFT_STAGE,
      });
    }
    return recoverFromGeneratorFailure(error, TEMPLATE_DRAFT_STAGE);
  }
}
