/** opportunity_scan: ranks opportunities and saves the scan artifact. */

import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import {
  AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA,
  normalizeAiriOpportunityScan,
  type AiriOpportunityScan,
} from "@/lib/airi-chats/opportunity-scan";
import {
  buildAiriDraftStructuredOutputOptions,
  parseAiriDraftJson,
} from "@/lib/airi-chats/draft-output";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import { stageEvent, buildModelRunEvent } from "../progress";
import { buildMarketingToolAccessContext } from "../context";
import {
  AIRI_SHORT_DRAFT_AI_TIMEOUT_MS,
  type AiriTurnDeadline,
} from "../deadline";
import { persistAiriOpportunityScanArtifact } from "../artifacts";
import {
  AiriDraftOutputError,
  buildAiriDraftFallbackReply,
  toAiriDraftGeneration,
} from "../draft-fallback";

const OPPORTUNITY_SCAN_STAGE = {
  id: "opportunity_scan",
  label: "Scanning opportunities",
};

export function buildOpportunityScanPrompt(params: {
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
  access: AiriMarketingToolAccess;
}): string {
  return `You are Airi, creating a structured opportunity scan for an airi.chat workspace.

Return ONLY valid JSON. Do not wrap it in markdown.

JSON shape:
{
  "title": "Short scan title",
  "summary": "What the scan found and why it matters",
  "opportunities": [
    {
      "id": "stable-slug",
      "title": "Opportunity name",
      "priority": "high",
      "problem": "Customer/business problem to solve",
      "customerSignal": "Concrete signal from customer channels, chats, sources, or setup",
      "recommendedAction": "Concrete Airi action to take next",
      "evidence": ["Short grounded evidence"],
      "recommendedArtifacts": ["scenario", "whatsapp_template"],
      "missingInputs": ["Optional missing detail"]
    }
  ],
  "nextAction": "One concrete next action"
}

Allowed priority values: high, medium, low.
Allowed recommendedArtifacts values: whatsapp_template, whatsapp_flow, scenario, bulk_campaign, creative_asset, meta_ad, kb_article.

Rules:
- Use ${params.airiLanguage} for user-facing text when possible.
- This is an opportunity scan, not a generic answer and not an executable campaign package.
- Rank 3-6 opportunities when enough context exists; return 1-2 only when context is thin.
- Every opportunity must cite concrete evidence from attached sources, customer context, knowledge, or workspace readiness. If evidence is missing, mark missingInputs instead of inventing facts.
- Use TOOL AVAILABILITY only to decide which Airi actions are realistic in this workspace.
- Do not claim Airi sent, published, submitted, launched, generated, or connected anything.
- Prefer opportunities that can later become WhatsApp templates, Flows, scenarios, bulk campaigns, creative assets, Meta Ads plans, or KB improvements.
- Keep text concise and bounded.

TOOL AVAILABILITY:
${buildMarketingToolAccessContext(params.access)}

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

export async function generateOpportunityScan(params: {
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
  access: AiriMarketingToolAccess;
  progress: AiriChatProgressRecorder;
  deadline: AiriTurnDeadline;
}): Promise<{
  scan: AiriOpportunityScan;
  provider: string;
  model: string;
  usage: unknown;
  latencyMs: number | null;
}> {
  await params.progress.emit(
    stageEvent(
      OPPORTUNITY_SCAN_STAGE.id,
      OPPORTUNITY_SCAN_STAGE.label,
      "running"
    )
  );
  const response = await chatCompletionWithFallback({
    signal: params.signal,
    model: getHeavyTextModel(),
    messages: [
      {
        role: "user",
        content: buildOpportunityScanPrompt(params),
      },
    ],
    temperature: 0.2,
    ...buildAiriDraftStructuredOutputOptions(
      AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA
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
      traceId: `${params.traceId}:opportunity_scan`,
      operation: "airi_chat.opportunity_scan",
      sourceService: "web.airi_chat",
      inputText: params.userMessage,
      metadata: {
        toolAccess: params.access,
      },
    },
    onLifecycle: async event => {
      await params.progress.emit(buildModelRunEvent(event));
    },
  });

  const parsed = parseAiriDraftJson(response);
  const scan = parsed.ok ? normalizeAiriOpportunityScan(parsed.value) : null;
  if (!scan) {
    throw new AiriDraftOutputError(
      "opportunity_scan",
      parsed.ok ? "invalid" : parsed.reason,
      toAiriDraftGeneration(response)
    );
  }

  await params.progress.emit(
    stageEvent(
      OPPORTUNITY_SCAN_STAGE.id,
      OPPORTUNITY_SCAN_STAGE.label,
      "complete",
      `${scan.opportunities.length} opportunities`
    )
  );

  return {
    scan,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

export function buildOpportunityScanAssistantContent(params: {
  scan: AiriOpportunityScan;
  airiLanguage: string;
}): string {
  const highCount = params.scan.opportunities.filter(
    opportunity => opportunity.priority === "high"
  ).length;
  const count = params.scan.opportunities.length;
  if (params.airiLanguage === "ru") {
    return `Я подготовила **${params.scan.title}**: возможностей — ${count}${highCount ? `, из них с высоким приоритетом — ${highCount}` : ""}. Проверьте обзор ниже, прежде чем создавать шаблоны, Flow, сценарии, кампании или креативы.`;
  }
  if (params.airiLanguage === "kz") {
    return `**${params.scan.title}** дайын: мүмкіндіктер саны — ${count}${highCount ? `, оның ішінде жоғары басымдықтағысы — ${highCount}` : ""}. Үлгілерді, Flow, сценарийлерді, науқандарды немесе креативтерді жасамас бұрын төмендегі шолуды тексеріңіз.`;
  }
  return `I created **${params.scan.title}** with ${params.scan.opportunities.length} ranked opportunit${params.scan.opportunities.length === 1 ? "y" : "ies"}${highCount ? `, including ${highCount} high-priority item${highCount === 1 ? "" : "s"}` : ""}. Review the scan below before creating templates, flows, scenarios, campaigns, or creative assets.`;
}

/** The opportunity_scan step of the turn. */
export async function handleOpportunityScanTurn(
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
    getToolAccess,
    recoverFromGeneratorFailure,
  } = context;

  try {
    await progress.emit(
      stageEvent("tool_access", "Checking Airi actions", "running")
    );
    const toolAccess = await awaitWithCancellation(
      getToolAccess(),
      params.signal
    );
    await progress.emit(
      stageEvent("tool_access", "Checking Airi actions", "complete")
    );
    const opportunityScan = await generateOpportunityScan({
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
      access: toolAccess,
      progress,
      deadline,
    });
    throwIfCancelled(params.signal);
    const opportunityArtifact = await persistAiriOpportunityScanArtifact({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userId: params.userId,
      userMessageId: params.userMessageId,
      scan: opportunityScan.scan,
    });
    await progress.emit(
      stageEvent(
        "opportunity_artifact",
        "Saving opportunity scan",
        "complete",
        opportunityArtifact.id
      )
    );
    const receipt: AiriChatResourceReceipt = {
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels,
      resources: resourceItems,
      sourceIds: sourceContext.sourceIds,
      retrievalPath: sourceContext.retrievalPath,
      provider: opportunityScan.provider,
      model: opportunityScan.model,
      durationMs: Date.now() - startedAt,
    };
    return {
      content: buildOpportunityScanAssistantContent({
        scan: opportunityScan.scan,
        airiLanguage,
      }),
      metadata: {
        provider: opportunityScan.provider,
        model: opportunityScan.model,
        usage: opportunityScan.usage,
        kbArticlesFound: searchResult.kbArticles.length,
        conversationsFound: searchResult.conversations.length,
        retrievalContextCount: sourceContext.sourceIds.length,
        sourceIds: sourceContext.sourceIds,
        selectedSources: selectedContext?.selectedSources ?? [],
        selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
        pendingActions,
        airiOpportunityScan: opportunityScan.scan,
        airiOpportunityArtifact: opportunityArtifact,
        toolAccess,
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
        generationLatencyMs: opportunityScan.latencyMs,
        generationModel: opportunityScan.model,
        ...sourceContext,
      },
    };
  } catch (error) {
    if (error instanceof AiriDraftOutputError) {
      return buildAiriDraftFallbackReply(context, {
        error,
        stage: OPPORTUNITY_SCAN_STAGE,
      });
    }
    return recoverFromGeneratorFailure(error, OPPORTUNITY_SCAN_STAGE);
  }
}
