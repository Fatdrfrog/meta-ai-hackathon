/** whatsapp_flow: drafts a Flow and saves it as an artifact. */

import { throwIfCancelled } from "@/lib/ai/cancellation";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { repairAiriGeneratedFlowConfig } from "@/lib/airi-chats/flow-draft-repair";
import {
  AIRI_FLOW_DRAFT_RESPONSE_SCHEMA,
  createFlowBuilderPatch,
  type ActiveAiriBuilderInput,
} from "@/lib/airi-chats/builder-state";
import {
  buildAiriDraftStructuredOutputOptions,
  mergeAiriDraftOverActive,
  parseAiriDraftJson,
} from "@/lib/airi-chats/draft-output";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import { stageEvent, buildModelRunEvent } from "../progress";
import {
  AIRI_LONG_DRAFT_AI_TIMEOUT_MS,
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

const FLOW_DRAFT_STAGE = {
  id: "flow_draft",
  label: "Drafting WhatsApp Flow",
};

/**
 * The Flow a model answer describes, or null when it is not one: no
 * screens, or no screen left with a field after repair. An edit keeps what
 * the schema cannot express (routes, branch rules, provider links, layout)
 * from the open Flow.
 */
export function buildGeneratedWhatsAppFlowConfig(params: {
  generated: Record<string, unknown>;
  activeBuilder?: ActiveAiriBuilderInput | null;
}): WhatsAppFlowConfig | null {
  const merged =
    params.activeBuilder?.kind === "whatsapp_flow"
      ? mergeAiriDraftOverActive(
          AIRI_FLOW_DRAFT_RESPONSE_SCHEMA,
          params.activeBuilder.flowConfig,
          params.generated
        )
      : params.generated;
  const sanitized = sanitizeWhatsAppFlowConfig(merged);
  if (!sanitized) return null;
  // Repair what the artifact validator would reject (duplicate field ids,
  // over-long labels, choice fields without options) before saving.
  const flowConfig = repairAiriGeneratedFlowConfig(sanitized);
  return flowConfig.screens.some(screen => screen.fields.length > 0)
    ? flowConfig
    : null;
}

export function compactJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 12_000);
}

export function buildWhatsAppFlowDraftPrompt(params: {
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
  activeBuilder?: ActiveAiriBuilderInput | null;
}) {
  const activeFlow =
    params.activeBuilder?.kind === "whatsapp_flow"
      ? compactJsonValue(params.activeBuilder.flowConfig)
      : "No active Flow draft.";
  return `You draft WhatsApp Flow builder configs for Airi.chat workspaces.

Return ONLY valid JSON. Do not wrap it in markdown.

JSON shape:
{
  "templateId": "lead_generation",
  "ctaText": "Get Started",
  "bodyText": "Please complete this form.",
  "flowUiLocale": "en",
  "screens": [
    {
      "id": "LEAD_FORM",
      "title": "Contact Information",
      "fields": [
        { "id": "name", "label": "Full Name", "fieldType": "TextInput", "required": true },
        { "id": "interest", "label": "Interest", "fieldType": "Dropdown", "options": [{ "id": "demo", "title": "Demo" }] }
      ]
    }
  ]
}

Rules:
- Use ${params.airiLanguage} for user-facing labels when possible.
- Supported fieldType values: TextInput, TextArea, Dropdown, DatePicker, RadioButtonsGroup, CheckboxGroup.
- Keep IDs stable, uppercase screen IDs with underscores, and concise field IDs.
- Keep labels short enough for WhatsApp Flow limits.
- If an active Flow draft is provided, edit it instead of replacing it unless the user asks for a new Flow.

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

ACTIVE FLOW DRAFT:
${activeFlow}`;
}

export async function generateWhatsAppFlowDraft(params: {
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
  activeBuilder?: ActiveAiriBuilderInput | null;
  pendingActions: AiriChatPendingAction[];
  progress: AiriChatProgressRecorder;
  deadline: AiriTurnDeadline;
}) {
  await params.progress.emit(
    stageEvent(FLOW_DRAFT_STAGE.id, FLOW_DRAFT_STAGE.label, "running")
  );
  const response = await chatCompletionWithFallback({
    signal: params.signal,
    model: getHeavyTextModel(),
    messages: [
      {
        role: "user",
        content: buildWhatsAppFlowDraftPrompt(params),
      },
    ],
    temperature: 0.25,
    ...buildAiriDraftStructuredOutputOptions(AIRI_FLOW_DRAFT_RESPONSE_SCHEMA),
    resilience: {
      maxRetries: 2,
      initialRetryDelayMs: 300,
      maxRetryDelayMs: 2_000,
      timeoutMs: params.deadline.stepTimeoutMs(AIRI_LONG_DRAFT_AI_TIMEOUT_MS),
    },
    analytics: {
      workspaceId: params.workspaceId,
      conversationId: params.threadId,
      messageId: params.userMessageId || null,
      traceId: `${params.traceId}:whatsapp_flow_draft`,
      operation: "airi_chat.whatsapp_flow_draft",
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
  const flowConfig = parsed.ok
    ? buildGeneratedWhatsAppFlowConfig({
        generated: parsed.value,
        activeBuilder: params.activeBuilder,
      })
    : null;
  if (!flowConfig) {
    throw new AiriDraftOutputError(
      "whatsapp_flow",
      parsed.ok ? "invalid" : parsed.reason,
      toAiriDraftGeneration(response)
    );
  }
  const baseRevision =
    params.activeBuilder?.kind === "whatsapp_flow"
      ? params.activeBuilder.revision
      : 0;
  const patch = createFlowBuilderPatch({
    baseRevision,
    flowConfig,
    summary: "Updated WhatsApp Flow",
  });
  await params.progress.emit(
    stageEvent(FLOW_DRAFT_STAGE.id, FLOW_DRAFT_STAGE.label, "complete")
  );
  return {
    flowConfig,
    patch,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

export function buildWhatsAppFlowDraftAssistantContent(params: {
  flowConfig: WhatsAppFlowConfig;
  airiLanguage: string;
}) {
  const screenCount = params.flowConfig.screens.length;
  if (params.airiLanguage === "ru") {
    return `Готово. Я обновила WhatsApp Flow с ${screenCount} экран${screenCount === 1 ? "ом" : "ами"}. Проверьте боковую панель перед публикацией.`;
  }
  if (params.airiLanguage === "kz") {
    return `Дайын. WhatsApp Flow жаңартылды, экрандар саны: ${screenCount}. Жарияламас бұрын бүйірлік панельден тексеріңіз.`;
  }
  return `Done. I updated the WhatsApp Flow with ${screenCount} screen${screenCount === 1 ? "" : "s"}. Review it in the side panel before publishing.`;
}

/** The whatsapp_flow step of the turn. */
export async function handleWhatsAppFlowTurn(
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
    const flowDraft = await generateWhatsAppFlowDraft({
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
      activeBuilder,
      pendingActions,
      progress,
      deadline,
    });
    throwIfCancelled(params.signal);
    const artifactResult = await persistAiriBuilderArtifact({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userId: params.userId,
      userMessageId: params.userMessageId,
      activeBuilder,
      kind: "whatsapp_flow",
      snapshot: { flowConfig: flowDraft.flowConfig },
      changeSummary: flowDraft.patch.summary,
    });
    const receipt: AiriChatResourceReceipt = {
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels,
      resources: resourceItems,
      sourceIds: sourceContext.sourceIds,
      retrievalPath: sourceContext.retrievalPath,
      provider: flowDraft.provider,
      model: flowDraft.model,
      durationMs: Date.now() - startedAt,
    };
    await reportAiriBuilderArtifactInvalid(progress, artifactResult.invalid);
    return {
      content:
        buildWhatsAppFlowDraftAssistantContent({
          flowConfig: flowDraft.flowConfig,
          airiLanguage,
        }) +
        buildAiriBuilderArtifactInvalidNotice(
          artifactResult.invalid,
          airiLanguage
        ),
      metadata: {
        provider: flowDraft.provider,
        model: flowDraft.model,
        usage: flowDraft.usage,
        kbArticlesFound: searchResult.kbArticles.length,
        conversationsFound: searchResult.conversations.length,
        retrievalContextCount: sourceContext.sourceIds.length,
        sourceIds: sourceContext.sourceIds,
        selectedSources: selectedContext?.selectedSources ?? [],
        selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
        pendingActions: pendingActions.filter(
          action => action.kind !== "whatsapp_flow_draft"
        ),
        airiBuilderPatch: withAiriBuilderPatchTarget(
          flowDraft.patch,
          activeBuilder
        ),
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
        generationLatencyMs: flowDraft.latencyMs,
        generationModel: flowDraft.model ?? null,
        ...sourceContext,
      },
    };
  } catch (error) {
    if (error instanceof AiriDraftOutputError) {
      return buildAiriDraftFallbackReply(context, {
        error,
        stage: FLOW_DRAFT_STAGE,
      });
    }
    return recoverFromGeneratorFailure(error, FLOW_DRAFT_STAGE);
  }
}
