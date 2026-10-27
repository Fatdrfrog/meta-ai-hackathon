/** product_capability: answers from airi.chat product context and KB. */

import { awaitWithCancellation } from "@/lib/ai/cancellation";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { buildBoundedAiriChatPrompt } from "@/lib/airi-chats/prompt-budget";
import {
  buildAiriChatFailureFields,
  type AiriChatFailureDiagnostics,
} from "@/lib/airi-chats/failure-diagnostics";
import {
  getAiriResponseLanguageInstruction,
  type AiriLanguage,
} from "@/lib/airi/shared/language-policy";
import type { AiriChatReplyAnalytics } from "@/lib/airi-chats/analytics";
import {
  buildAiriProductCapabilityPromptContext,
  buildAiriProductWorkspaceReadinessContext,
  getAiriProductContextMetadata,
} from "@/lib/airi-product-context";
import type { AiriChatSelectedGroundingContext } from "@/lib/airi-chats/sources";
import type { AiriChatIntentKind } from "@/lib/airi-chats/intent-classifier";
import {
  AIRI_PRODUCT_KB_COMPANY_SLUG,
  formatAiriProductKbPromptContext,
  retrieveAiriProductKbArticles,
  type AiriProductKbArticle,
} from "@/lib/airi-chats/product-knowledge";
import { resolveAiriMarketingToolAccess } from "@/lib/airi-chats/marketing-tool-access";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import {
  createAiriChatRunEventAt,
  type AiriChatResourceReceipt,
  type AiriChatRunResource,
} from "@/lib/airi-chats/run-events";
import type { AskDataContextGatewayResponse } from "@icecore/airi-runtime/ai-gateway";
import type {
  SupabaseClient,
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import {
  stageEvent,
  createAssistantDeltaStream,
  buildModelRunEvent,
} from "../progress";
import { mergeAiriChatSourceContext } from "../context";
import {
  AIRI_TURN_DEFAULT_STEP_TIMEOUT_MS,
  type AiriTurnDeadline,
} from "../deadline";
import {
  getRetryableAiriChatErrorMessage,
  resolveFailedAiriChatGenerationTarget,
  recordAiriChatGeneratorFailure,
} from "../failure";

export function appendAiriProductContextResource(
  resources: AiriChatRunResource[],
  version: string
): AiriChatRunResource[] {
  return [
    ...resources,
    {
      id: "airi-product-context",
      label: "airi.chat capabilities",
      kind: "model",
      detail: `Version ${version}`,
      status: "complete",
    },
  ];
}

export function appendAiriProductKbResources(
  resources: AiriChatRunResource[],
  articles: AiriProductKbArticle[]
): AiriChatRunResource[] {
  if (articles.length === 0) return resources;
  return [
    ...resources,
    ...articles.map(article => ({
      id: `airi-product-kb:${article.id}`,
      label: article.title,
      kind: "knowledge_base" as const,
      status: "complete" as const,
      detail: article.url,
    })),
  ];
}

export function buildAiriProductCapabilityPrompt(params: {
  airiLanguage: AiriLanguage;
  workspaceReadinessContext: string;
  productKbContext: string;
  historyContext: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  userMessage: string;
}) {
  return buildBoundedAiriChatPrompt({
    header: `You are Airi, a workspace assistant for WhatsApp campaigns, customer chats, knowledge, analytics, and creative planning.\n\nLANGUAGE REQUIREMENT: ${getAiriResponseLanguageInstruction(params.airiLanguage)}`,
    stableSections: [
      {
        label: "AIRI.CHAT PRODUCT CAPABILITIES",
        content: buildAiriProductCapabilityPromptContext(),
      },
      {
        label: "WORKSPACE READINESS",
        content: params.workspaceReadinessContext,
      },
      {
        label: "PUBLISHED AIRI.CHAT PRODUCT KB",
        content: params.productKbContext,
      },
      { label: "ATTACHED SOURCES", content: params.attachedSourceContext },
      {
        label: "ATTACHED FILES",
        content: params.attachedFileContext.split(/\n\n(?=\[File \d+\])/u),
      },
      {
        label: "WORKSPACE KNOWLEDGE",
        content: params.kbContext || "No relevant KB articles found.",
      },
      {
        label: "RECENT CUSTOMER CONTEXT",
        content:
          params.conversationContext || "No relevant conversations found.",
      },
    ],
    history: params.historyContext,
    userMessage: params.userMessage,
    instructions: `- Answer platform how-to and product capability questions from AIRI.CHAT PRODUCT CAPABILITIES and PUBLISHED AIRI.CHAT PRODUCT KB.
- Do not invent setup, connection, registration, or onboarding steps that are not in those sections.
- WORKSPACE KNOWLEDGE and RECENT CUSTOMER CONTEXT belong to this tenant. Never refuse a platform how-to because the tenant KB or chats are empty. Do not copy tenant content into product how-to steps.
- Distinguish product support from this workspace's current readiness.
- If a capability is supported but not ready in this workspace, say what needs to be connected or reviewed next.
- If published product KB is missing the needed how-to, say so and point to https://www.airi.chat help or support@airi.chat. Do not guess.
- Do not claim an asset, ad, WhatsApp template, WhatsApp Flow, bulk campaign, scenario, integration, send, publish, or approval was created unless a backend action actually completed it.
- Keep the answer concrete, concise, and action-oriented.`,
  });
}

export type AiriProductCapabilityReplyParams = {
  signal?: AbortSignal;
  supabase: SupabaseClient;
  workspaceId: string;
  threadId: string;
  userMessageId?: string | null;
  userMessage: string;
  airiLanguage: AiriLanguage;
  selectedContext: AiriChatSelectedGroundingContext | null;
  selectedSourceLabels: string[];
  resourceItems: AiriChatRunResource[];
  sourceContext: ReturnType<typeof mergeAiriChatSourceContext>;
  searchResult: AskDataContextGatewayResponse;
  pendingActions: AiriChatPendingAction[];
  traceId: string;
  progress: AiriChatProgressRecorder;
  startedAt: number;
  deadline: AiriTurnDeadline;
  historyContext: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  /** Started earlier in the turn so it overlaps retrieval. */
  toolAccessPromise?: Promise<AiriMarketingToolAccess>;
  safetyNet?: {
    fromIntent: AiriChatIntentKind;
    reason: "empty_tenant_platform_safety_net";
  } | null;
};

export type AiriProductCapabilityResultParams = Pick<
  AiriProductCapabilityReplyParams,
  | "selectedContext"
  | "selectedSourceLabels"
  | "sourceContext"
  | "searchResult"
  | "pendingActions"
  | "traceId"
  | "progress"
  | "startedAt"
  | "safetyNet"
> & {
  productContextMetadata: ReturnType<typeof getAiriProductContextMetadata>;
  productKbArticles: AiriProductKbArticle[];
  toolAccess: AiriMarketingToolAccess;
  productResourceItems: AiriChatRunResource[];
  provider: string | null;
  model: string | null;
  usage: unknown;
  retryable?: true;
  errorCode?: string | null;
  failure?: AiriChatFailureDiagnostics;
};

export function buildAiriProductCapabilityReceipt(
  params: AiriProductCapabilityResultParams
): AiriChatResourceReceipt {
  return {
    selectedSources: params.selectedContext?.selectedSources ?? [],
    selectedSourceLabels: params.selectedSourceLabels,
    resources: params.productResourceItems,
    sourceIds: params.sourceContext.sourceIds,
    retrievalPath: params.sourceContext.retrievalPath,
    provider: params.provider,
    model: params.model,
    retryable: params.retryable,
    errorCode: params.errorCode,
    ...(params.failure ? buildAiriChatFailureFields(params.failure) : {}),
    durationMs: Date.now() - params.startedAt,
  };
}

export function buildAiriProductCapabilityMetadata(
  params: AiriProductCapabilityResultParams & {
    receipt: AiriChatResourceReceipt;
  }
): Record<string, unknown> {
  return {
    provider: params.provider,
    model: params.model,
    usage: params.usage,
    kbArticlesFound: params.searchResult.kbArticles.length,
    conversationsFound: params.searchResult.conversations.length,
    retrievalContextCount: params.sourceContext.sourceIds.length,
    sourceIds: params.sourceContext.sourceIds,
    selectedSources: params.selectedContext?.selectedSources ?? [],
    selectedSourceLabels: params.selectedSourceLabels,
    pendingActions: params.pendingActions,
    airiProductContext: params.productContextMetadata,
    airiProductKb: {
      companySlug: AIRI_PRODUCT_KB_COMPANY_SLUG,
      articleIds: params.productKbArticles.map(article => article.id),
    },
    airiProductKbSafetyNet: params.safetyNet ?? null,
    workspaceToolReadiness: params.toolAccess,
    traceId: params.traceId,
    ...(params.retryable
      ? {
          retryable: true,
          errorCode: params.errorCode,
          ...(params.failure ? buildAiriChatFailureFields(params.failure) : {}),
        }
      : {}),
    resourceReceipt: params.receipt,
    thinkingTrace: {
      stages: params.progress.stages,
      resources: params.productResourceItems,
    },
  };
}

export async function generateAiriProductCapabilityReply(
  params: AiriProductCapabilityReplyParams
): Promise<{
  content: string;
  metadata: Record<string, unknown>;
  analytics: AiriChatReplyAnalytics;
}> {
  const productContextMetadata = getAiriProductContextMetadata();
  await params.progress.emit(
    stageEvent("product_context", "Reading airi.chat capabilities", "running")
  );
  const toolAccess = await awaitWithCancellation(
    params.toolAccessPromise ??
      resolveAiriMarketingToolAccess({
        supabase: params.supabase,
        workspaceId: params.workspaceId,
      }),
    params.signal
  );
  await params.progress.emit(
    stageEvent(
      "product_context",
      "Reading airi.chat capabilities",
      "complete",
      `Version ${productContextMetadata.version}`
    )
  );
  await params.progress.emit(
    stageEvent("product_kb", "Reading published airi.chat help", "running")
  );
  const productKbArticles = await awaitWithCancellation(
    retrieveAiriProductKbArticles({
      signal: params.signal,
      query: params.userMessage,
      locale: params.airiLanguage,
    }),
    params.signal
  );
  await params.progress.emit(
    stageEvent(
      "product_kb",
      "Reading published airi.chat help",
      "complete",
      productKbArticles.length > 0
        ? `${productKbArticles.length} article${productKbArticles.length === 1 ? "" : "s"}`
        : "No matching published articles"
    )
  );
  const productResourceItems = appendAiriProductKbResources(
    appendAiriProductContextResource(
      params.resourceItems,
      productContextMetadata.version
    ),
    productKbArticles
  );
  await params.progress.emit({
    type: "resources",
    id: "retrieved_resources",
    label: "Resources used",
    status: "complete",
    resources: productResourceItems,
    at: createAiriChatRunEventAt(),
  });
  const prompt = buildAiriProductCapabilityPrompt({
    airiLanguage: params.airiLanguage,
    workspaceReadinessContext:
      buildAiriProductWorkspaceReadinessContext(toolAccess),
    productKbContext: formatAiriProductKbPromptContext(productKbArticles),
    historyContext: params.historyContext,
    attachedSourceContext: params.attachedSourceContext,
    attachedFileContext: params.attachedFileContext,
    kbContext: params.kbContext,
    conversationContext: params.conversationContext,
    userMessage: params.userMessage,
  });

  let response: Awaited<ReturnType<typeof chatCompletionWithFallback>>;
  const answerStream = createAssistantDeltaStream({
    threadId: params.threadId,
    progress: params.progress,
  });
  try {
    await params.progress.emit(
      stageEvent("generation", "Generating answer", "running")
    );
    response = await chatCompletionWithFallback({
      ...(answerStream.onDelta ? { onDelta: answerStream.onDelta } : {}),
      signal: params.signal,
      model: getHeavyTextModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35,
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
        traceId: params.traceId,
        operation: "airi_chat.product_capabilities",
        sourceService: "web.airi_chat",
        inputText: params.userMessage,
        metadata: {
          airiProductContext: productContextMetadata,
          airiProductKb: {
            companySlug: AIRI_PRODUCT_KB_COMPANY_SLUG,
            articleIds: productKbArticles.map(article => article.id),
          },
          airiProductKbSafetyNet: params.safetyNet ?? null,
          workspaceToolReadiness: toolAccess,
          kbArticlesFound: params.searchResult.kbArticles.length,
          conversationsFound: params.searchResult.conversations.length,
          retrievalContextCount: params.sourceContext.sourceIds.length,
          sourceIds: params.sourceContext.sourceIds,
          selectedSources: params.selectedContext?.selectedSources ?? [],
          pendingActions: params.pendingActions,
        },
      },
      onLifecycle: async event => {
        await params.progress.emit(buildModelRunEvent(event));
      },
    }).finally(answerStream.stop);
    await params.progress.emit(
      stageEvent("generation", "Generating answer", "complete")
    );
  } catch (error) {
    const failure = await recordAiriChatGeneratorFailure({
      error,
      signal: params.signal,
      progress: params.progress,
      stage: { id: "generation", label: "Generating answer" },
    });
    const failedTarget = resolveFailedAiriChatGenerationTarget(
      error,
      getHeavyTextModel()
    );
    const resultParams: AiriProductCapabilityResultParams = {
      ...params,
      productContextMetadata,
      productKbArticles,
      toolAccess,
      productResourceItems,
      provider: failedTarget.provider,
      model: failedTarget.model,
      usage: null,
      retryable: true,
      errorCode: failure.code,
      failure: failure.diagnostics,
    };
    const receipt = buildAiriProductCapabilityReceipt(resultParams);
    return {
      content: getRetryableAiriChatErrorMessage(params.airiLanguage),
      metadata: buildAiriProductCapabilityMetadata({
        ...resultParams,
        receipt,
      }),
      analytics: {
        traceId: params.traceId,
        durationMs: Date.now() - params.startedAt,
        generationLatencyMs: null,
        generationModel: failedTarget.model,
        ...params.sourceContext,
      },
    };
  }

  const resultParams: AiriProductCapabilityResultParams = {
    ...params,
    productContextMetadata,
    productKbArticles,
    toolAccess,
    productResourceItems,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
  };
  const receipt = buildAiriProductCapabilityReceipt(resultParams);

  return {
    content: response.content || "No answer generated.",
    metadata: buildAiriProductCapabilityMetadata({
      ...resultParams,
      receipt,
    }),
    analytics: {
      traceId: params.traceId,
      durationMs: Date.now() - params.startedAt,
      generationLatencyMs: response.latencyMs ?? null,
      generationModel: response.model ?? null,
      ...params.sourceContext,
    },
  };
}

/**
 * The product_capability step, and the empty-tenant safety net that sends a
 * platform question here from another intent.
 */
export function handleProductCapabilityTurn(
  context: AiriTurnContext,
  safetyNet?: AiriProductCapabilityReplyParams["safetyNet"]
): Promise<GeneratedAiriChatReply> {
  const { params } = context;
  return generateAiriProductCapabilityReply({
    signal: params.signal,
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    userMessageId: params.userMessageId,
    userMessage: params.userMessage,
    airiLanguage: context.airiLanguage,
    selectedContext: context.selectedContext,
    selectedSourceLabels: context.selectedSourceLabels,
    resourceItems: context.resourceItems,
    sourceContext: context.sourceContext,
    searchResult: context.searchResult,
    pendingActions: context.pendingActions,
    traceId: context.traceId,
    progress: context.progress,
    startedAt: context.startedAt,
    deadline: context.deadline,
    historyContext: context.historyContext,
    attachedSourceContext: context.attachedSourceContext,
    attachedFileContext: context.attachedFileContext,
    kbContext: context.kbContext,
    conversationContext: context.conversationContext,
    toolAccessPromise: context.getToolAccess(),
    ...(safetyNet ? { safetyNet } : {}),
  });
}
