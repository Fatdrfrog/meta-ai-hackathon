/** image_generation: prepares a brief and queues the image worker. */

import { throwIfCancelled } from "@/lib/ai/cancellation";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import {
  createQueuedAiriImageGeneration,
  startQueuedAiriImageGeneration,
  type QueuedAiriImageGeneration,
} from "@/lib/airi-chats/generated-image-generation";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import { stageEvent, buildModelRunEvent } from "../progress";
import {
  AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS,
  type AiriTurnDeadline,
} from "../deadline";

export type AiriImageGenerationBrief = {
  title: string;
  summary: string;
  prompt: string;
  aspectRatio: string;
};

export function normalizeImageGenerationBrief(
  value: unknown
): AiriImageGenerationBrief | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title =
    typeof raw.title === "string" ? raw.title.trim().slice(0, 160) : "";
  const summary =
    typeof raw.summary === "string" ? raw.summary.trim().slice(0, 360) : "";
  const prompt =
    typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, 1600) : "";
  const aspectRatio =
    typeof raw.aspectRatio === "string"
      ? raw.aspectRatio.trim().slice(0, 16)
      : "9:16";
  if (!title || prompt.length < 3) return null;
  return {
    title,
    summary: summary || "Generated image",
    prompt,
    aspectRatio: aspectRatio || "9:16",
  };
}

export function buildImageGenerationBriefPrompt(params: {
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
}): string {
  return `You are Airi, preparing one realistic image generation prompt for a workspace user.

Return ONLY valid JSON. Do not wrap it in markdown.

JSON shape:
{
  "title": "Short image title",
  "summary": "What this image is for",
  "prompt": "Detailed provider prompt for a realistic image",
  "aspectRatio": "9:16"
}

Rules:
- Use ${params.airiLanguage} for title and summary when possible.
- The prompt must be specific, visual, realistic, and safe for customer-facing marketing.
- Ground the image in the workspace context only when the context clearly supports it.
- Do not invent brand logos, celebrity likenesses, regulated claims, or unreadable tiny UI.
- Prefer 9:16 for WhatsApp/status/social creatives unless the user asks for another format.
- Keep the provider prompt under 1600 characters.

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
${params.userMessage}`;
}

export async function generateAiriImageGenerationBrief(params: {
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
  progress: AiriChatProgressRecorder;
  deadline: AiriTurnDeadline;
}): Promise<{
  brief: AiriImageGenerationBrief;
  provider: string;
  model: string;
  usage: unknown;
  latencyMs: number | null;
}> {
  await params.progress.emit(
    stageEvent("image_brief", "Preparing image prompt", "running")
  );
  const response = await chatCompletionWithFallback({
    signal: params.signal,
    model: getLightTextModel(),
    messages: [
      {
        role: "user",
        content: buildImageGenerationBriefPrompt(params),
      },
    ],
    temperature: 0.25,
    responseFormat: { type: "json_object" },
    resilience: {
      maxRetries: 2,
      initialRetryDelayMs: 300,
      maxRetryDelayMs: 2_000,
      timeoutMs: params.deadline.stepTimeoutMs(
        AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS
      ),
    },
    analytics: {
      workspaceId: params.workspaceId,
      conversationId: params.threadId,
      messageId: params.userMessageId || null,
      traceId: `${params.traceId}:image_generation_brief`,
      operation: "airi_chat.image_generation_brief",
      sourceService: "web.airi_chat",
      inputText: params.userMessage,
    },
    onLifecycle: async event => {
      await params.progress.emit(buildModelRunEvent(event));
    },
  });

  let parsedBrief: AiriImageGenerationBrief | null = null;
  try {
    parsedBrief = normalizeImageGenerationBrief(
      extractJsonObject(response.content || "")
    );
  } catch (error) {
    throwIfCancelled(params.signal, error);
    if (isWorkspaceAiPolicyError(error)) throw error;
    parsedBrief = null;
  }
  const brief =
    parsedBrief ||
    ({
      title: "Generated image",
      summary: "Image generated from the Airi chat request.",
      prompt: params.userMessage.trim().slice(0, 1600),
      aspectRatio: "9:16",
    } satisfies AiriImageGenerationBrief);

  await params.progress.emit(
    stageEvent("image_brief", "Preparing image prompt", "complete", brief.title)
  );

  return {
    brief,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

export function buildImageGenerationAssistantContent(params: {
  brief: AiriImageGenerationBrief;
  queued: boolean;
  airiLanguage: string;
}): string {
  if (!params.queued) {
    return `I prepared the image prompt **${params.brief.title}**, but image generation is not ready in this workspace. Connect/configure Google creative generation and the media worker, then retry.`;
  }
  return `I started generating **${params.brief.title}** with Nano Banana. The image will appear below as soon as the worker finishes.`;
}

/** The image_generation step of the turn. */
export async function handleImageGenerationTurn(
  context: AiriTurnContext
): Promise<GeneratedAiriChatReply> {
  const {
    params,
    deadline,
    startedAt,
    progress,
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

  let imageBrief: Awaited<ReturnType<typeof generateAiriImageGenerationBrief>>;
  try {
    imageBrief = await generateAiriImageGenerationBrief({
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
      progress,
      deadline,
    });
  } catch (error) {
    return recoverFromGeneratorFailure(
      error,
      { id: "image_brief", label: "Preparing image prompt" },
      getLightTextModel()
    );
  }
  throwIfCancelled(params.signal);
  let generatedImage: QueuedAiriImageGeneration | null = null;
  let imageStartError: string | null = null;
  await progress.emit(
    stageEvent("image_generation", "Starting image generation", "running")
  );
  try {
    throwIfCancelled(params.signal);
    generatedImage = await createQueuedAiriImageGeneration({
      workspaceId: params.workspaceId,
      userId: params.userId,
      threadId: params.threadId,
      userMessageId: params.userMessageId,
      title: imageBrief.brief.title,
      prompt: imageBrief.brief.prompt,
      aspectRatio: imageBrief.brief.aspectRatio,
      target: { kind: "chat_attachment" },
    });
    if (generatedImage) {
      throwIfCancelled(params.signal);
      await startQueuedAiriImageGeneration({
        workspaceId: params.workspaceId,
        assetId: generatedImage.assetId,
        prompt: imageBrief.brief.prompt,
        aspectRatio: imageBrief.brief.aspectRatio,
      });
    }
    await progress.emit(
      stageEvent(
        "image_generation",
        "Starting image generation",
        generatedImage ? "complete" : "error",
        generatedImage?.assetId || "Image generation is not ready"
      )
    );
  } catch (error) {
    throwIfCancelled(params.signal, error);
    if (isWorkspaceAiPolicyError(error)) throw error;
    imageStartError =
      error instanceof Error
        ? error.message
        : "Failed to start image generation";
    await progress.emit(
      stageEvent(
        "image_generation",
        "Starting image generation",
        "error",
        imageStartError
      )
    );
  }

  const generatedAssets = generatedImage
    ? [
        {
          ...generatedImage.attachment,
          ...(imageStartError
            ? { status: "failed" as const, error: imageStartError }
            : {}),
        },
      ]
    : [];
  const imageResourceItems = generatedImage
    ? [
        ...resourceItems,
        {
          id: `creative-asset:${generatedImage.assetId}`,
          label: "Nano Banana image generation",
          kind: "creative_asset" as const,
          status: imageStartError ? ("error" as const) : ("running" as const),
          detail: imageBrief.brief.title,
        },
      ]
    : resourceItems;
  const receipt: AiriChatResourceReceipt = {
    selectedSources: selectedContext?.selectedSources ?? [],
    selectedSourceLabels,
    resources: imageResourceItems,
    sourceIds: sourceContext.sourceIds,
    retrievalPath: sourceContext.retrievalPath,
    provider: imageBrief.provider,
    model: imageBrief.model,
    durationMs: Date.now() - startedAt,
  };
  return {
    content: buildImageGenerationAssistantContent({
      brief: imageBrief.brief,
      queued: Boolean(generatedImage && !imageStartError),
      airiLanguage,
    }),
    metadata: {
      provider: imageBrief.provider,
      model: imageBrief.model,
      usage: imageBrief.usage,
      kbArticlesFound: searchResult.kbArticles.length,
      conversationsFound: searchResult.conversations.length,
      retrievalContextCount: sourceContext.sourceIds.length,
      sourceIds: sourceContext.sourceIds,
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
      pendingActions,
      airiImageGenerationBrief: imageBrief.brief,
      ...(generatedAssets.length > 0
        ? { airiGeneratedAssetAttachments: generatedAssets }
        : {}),
      traceId,
      resourceReceipt: receipt,
      thinkingTrace: {
        stages: progress.stages,
        resources: imageResourceItems,
      },
    },
    analytics: {
      traceId,
      durationMs: Date.now() - startedAt,
      generationLatencyMs: imageBrief.latencyMs,
      generationModel: imageBrief.model,
      ...sourceContext,
    },
  };
}
