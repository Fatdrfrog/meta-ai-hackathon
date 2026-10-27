/** marketing_campaign: builds the package, its template and handoffs. */

import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import {
  buildAiriChatFailureFields,
  type AiriChatFailureDiagnostics,
} from "@/lib/airi-chats/failure-diagnostics";
import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import {
  AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA,
  normalizeAiriCampaignPackage,
  type AiriCampaignPackage,
  type AiriMarketingToolAccess,
} from "@/lib/airi-chats/marketing-package";
import {
  buildAiriDraftStructuredOutputOptions,
  parseAiriDraftJson,
} from "@/lib/airi-chats/draft-output";
import { buildAiriScenarioGeneratorDraft } from "@/lib/airi-chats/scenario-generator-draft";
import { buildAiriBulkCampaignDraft } from "@/lib/airi-chats/bulk-campaign-draft";
import { buildAiriCreativeAssetDrafts } from "@/lib/airi-chats/creative-asset-draft";
import type { AiriChatResourceReceipt } from "@/lib/airi-chats/run-events";
import type {
  GeneratedAiriChatReply,
  AiriChatProgressRecorder,
  AiriTurnContext,
} from "../types";
import { stageEvent, buildModelRunEvent } from "../progress";
import { buildMarketingToolAccessContext } from "../context";
import { recordAiriChatStepFailure } from "../failure";
import {
  AIRI_LONG_DRAFT_AI_TIMEOUT_MS,
  type AiriTurnDeadline,
} from "../deadline";
import { persistAiriCampaignArtifact } from "../artifacts";
import {
  AiriDraftOutputError,
  buildAiriDraftFallbackReply,
  toAiriDraftGeneration,
} from "../draft-fallback";
import { generateWhatsAppTemplateDraft } from "./whatsapp-template";

const CAMPAIGN_PACKAGE_STAGE = {
  id: "campaign_package",
  label: "Building campaign package",
};

export function buildMarketingPackagePrompt(params: {
  userMessage: string;
  airiLanguage: string;
  attachedSourceContext: string;
  attachedFileContext: string;
  kbContext: string;
  conversationContext: string;
  history: string;
  access: AiriMarketingToolAccess;
}) {
  return `You are Airi, building an executable marketing campaign package for an airi.chat workspace.

Return ONLY valid JSON. Do not wrap it in markdown.

JSON shape:
{
  "title": "Short package name",
  "goal": "Measurable campaign goal",
  "audience": "Specific audience segment and exclusions",
  "angle": "Creative angle grounded in the workspace context",
  "evidence": ["Short evidence from chats, KB, or attached sources"],
  "steps": [
    {
      "id": "whatsapp-template",
      "kind": "whatsapp_template",
      "title": "Draft WhatsApp template",
      "description": "What this step creates",
      "status": "ready",
      "tool": "whatsapp",
      "blockers": []
    }
  ],
  "checks": [
    { "label": "WhatsApp policy", "status": "pending", "detail": "Requires final review before submit" }
  ],
  "nextAction": "One concrete next action"
}

Allowed step.kind values: audience, whatsapp_template, whatsapp_flow, scenario, bulk_campaign, canva_design, visual_asset, audio_asset, meta_ad, measurement.
Allowed step.status values: ready, approval_required, blocked, needs_input.
Allowed step.tool values: whatsapp, scenarios, bulkCampaigns, canva, visualGeneration, audioGeneration, metaAds.
Allowed check.status values: passed, warning, blocked, pending.

Rules:
- Use ${params.airiLanguage} for user-facing text when possible.
- This must be a campaign package, not a generic answer.
- Use the real tool availability below as authority. If a tool is blocked, every step that needs it must be blocked and must list the blocker.
- Do not claim Higgsfield, ElevenLabs, Canva, Meta Ads, WhatsApp, or Google generation is available unless TOOL AVAILABILITY says it is available.
- Prefer WhatsApp template + scenario + bulk campaign as the first executable loop.
- Include visual/audio/design steps only when relevant to the user request or attached sources.
- Publishing, sending, ad launch, and template submission require approval_required or pending checks.
- Keep all text concise and bounded.

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

export function hasMaterializableCampaignTemplateStep(params: {
  packageDraft: AiriCampaignPackage;
  access: AiriMarketingToolAccess;
}): boolean {
  if (!params.access.whatsapp.available) return false;
  return params.packageDraft.steps.some(
    step =>
      step.kind === "whatsapp_template" &&
      step.tool === "whatsapp" &&
      (step.status === "ready" || step.status === "approval_required")
  );
}

export function buildCampaignTemplateDraftUserMessage(params: {
  originalMessage: string;
  packageDraft: AiriCampaignPackage;
}): string {
  const steps = params.packageDraft.steps
    .filter(step => step.kind === "whatsapp_template")
    .map(step => `- ${step.title}: ${step.description}`)
    .join("\n");
  return `${params.originalMessage}

CAMPAIGN PACKAGE:
Title: ${params.packageDraft.title}
Goal: ${params.packageDraft.goal}
Audience: ${params.packageDraft.audience}
Angle: ${params.packageDraft.angle}
Evidence:
${params.packageDraft.evidence.map(item => `- ${item}`).join("\n") || "- No evidence supplied."}
WhatsApp template steps:
${steps || "- Draft the safest campaign template for this package."}

Draft the WhatsApp template that should open in the builder for this campaign package.`;
}

export function enforceMarketingToolAccess(params: {
  packageDraft: Record<string, unknown>;
  access: AiriMarketingToolAccess;
}): Record<string, unknown> {
  const steps = Array.isArray(params.packageDraft.steps)
    ? params.packageDraft.steps.map(step => {
        if (!step || typeof step !== "object") return step;
        const record = step as Record<string, unknown>;
        const toolKey = record.tool;
        if (typeof toolKey !== "string" || !(toolKey in params.access)) {
          return record;
        }
        const tool = params.access[toolKey as keyof AiriMarketingToolAccess];
        const actionHref =
          typeof record.actionHref === "string"
            ? record.actionHref
            : tool.actionHref;
        if (tool.available) {
          return {
            ...record,
            ...(actionHref ? { actionHref } : {}),
          };
        }
        return {
          ...record,
          status: "blocked",
          blockers:
            Array.isArray(record.blockers) && record.blockers.length > 0
              ? record.blockers
              : [tool.reason || `Connect ${tool.label} to use this step.`],
          ...(actionHref ? { actionHref } : {}),
        };
      })
    : params.packageDraft.steps;

  return {
    ...params.packageDraft,
    tools: params.access,
    steps,
  };
}

export async function generateMarketingCampaignPackage(params: {
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
  packageDraft: AiriCampaignPackage;
  provider: string;
  model: string;
  usage: unknown;
  latencyMs: number | null;
}> {
  await params.progress.emit(
    stageEvent(
      CAMPAIGN_PACKAGE_STAGE.id,
      CAMPAIGN_PACKAGE_STAGE.label,
      "running"
    )
  );
  const response = await chatCompletionWithFallback({
    signal: params.signal,
    model: getHeavyTextModel(),
    messages: [
      {
        role: "user",
        content: buildMarketingPackagePrompt(params),
      },
    ],
    temperature: 0.25,
    ...buildAiriDraftStructuredOutputOptions(
      AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA
    ),
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
      traceId: `${params.traceId}:campaign_package`,
      operation: "airi_chat.campaign_package",
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
  const packageDraft = parsed.ok
    ? normalizeAiriCampaignPackage(
        enforceMarketingToolAccess({
          packageDraft: parsed.value,
          access: params.access,
        })
      )
    : null;
  if (!packageDraft) {
    throw new AiriDraftOutputError(
      "campaign_package",
      parsed.ok ? "invalid" : parsed.reason,
      toAiriDraftGeneration(response)
    );
  }

  await params.progress.emit(
    stageEvent(
      CAMPAIGN_PACKAGE_STAGE.id,
      CAMPAIGN_PACKAGE_STAGE.label,
      "complete",
      packageDraft.title
    )
  );

  return {
    packageDraft,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    latencyMs: response.latencyMs ?? null,
  };
}

export function buildMarketingCampaignPackageAssistantContent(params: {
  packageDraft: AiriCampaignPackage;
  airiLanguage: string;
  templateDraft?: AiriWhatsAppTemplateDraft | null;
  templateDraftFailed?: boolean;
}) {
  const blockedCount = params.packageDraft.steps.filter(
    step => step.status === "blocked"
  ).length;
  const stepCount = params.packageDraft.steps.length;
  if (params.airiLanguage === "ru") {
    const templateSuffix = params.templateDraft
      ? ` Также я подготовила **${params.templateDraft.name}** в конструкторе WhatsApp.`
      : params.templateDraftFailed
        ? " WhatsApp-шаблон для неё сейчас подготовить не удалось; попросите меня составить шаблон ещё раз."
        : "";
    return `Готово. Я подготовила пакет кампании **${params.packageDraft.title}**: шагов — ${stepCount}${blockedCount ? `; ${blockedCount} требуют подключённых инструментов` : ""}.${templateSuffix} Проверьте карточку ниже, прежде чем что-либо публиковать или отправлять.`;
  }
  if (params.airiLanguage === "kz") {
    const templateSuffix = params.templateDraft
      ? ` Сондай-ақ WhatsApp конструкторында **${params.templateDraft.name}** үлгісін дайындадым.`
      : params.templateDraftFailed
        ? " Бұл жолы оның WhatsApp үлгісін жасау мүмкін болмады; үлгіні қайта жасауды сұраңыз."
        : "";
    return `Дайын. **${params.packageDraft.title}** науқан пакеті дайын: қадамдар саны — ${stepCount}${blockedCount ? `; оның ${blockedCount} қадамына қосылған құралдар қажет` : ""}.${templateSuffix} Бірдеңе жарияламас не жібермес бұрын төмендегі карточканы тексеріңіз.`;
  }
  const templateSuffix = params.templateDraft
    ? ` I also prepared **${params.templateDraft.name}** in the WhatsApp builder.`
    : params.templateDraftFailed
      ? " I could not draft its WhatsApp template this time; ask me to draft the template again."
      : "";
  return `Done. I prepared the campaign package **${params.packageDraft.title}** with ${params.packageDraft.steps.length} step${params.packageDraft.steps.length === 1 ? "" : "s"}${blockedCount ? `; ${blockedCount} need connected tools` : ""}.${templateSuffix} Review the card below before anything is published or sent.`;
}

/** The marketing_campaign step of the turn. */
export async function handleMarketingCampaignTurn(
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
      stageEvent("tool_access", "Checking marketing tools", "running")
    );
    const toolAccess = await awaitWithCancellation(
      getToolAccess(),
      params.signal
    );
    await progress.emit(
      stageEvent("tool_access", "Checking marketing tools", "complete")
    );
    const campaignPackage = await generateMarketingCampaignPackage({
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
    let campaignTemplateDraft: Awaited<
      ReturnType<typeof generateWhatsAppTemplateDraft>
    > | null = null;
    let campaignTemplateFailure: AiriChatFailureDiagnostics | null = null;
    const scenarioGeneratorDraft = buildAiriScenarioGeneratorDraft({
      workspaceId: params.workspaceId,
      packageDraft: campaignPackage.packageDraft,
      access: toolAccess,
      sourceIds: sourceContext.sourceIds,
    });
    if (
      hasMaterializableCampaignTemplateStep({
        packageDraft: campaignPackage.packageDraft,
        access: toolAccess,
      })
    ) {
      try {
        campaignTemplateDraft = await generateWhatsAppTemplateDraft({
          signal: params.signal,
          workspaceId: params.workspaceId,
          threadId: params.threadId,
          userMessageId: params.userMessageId,
          userMessage: buildCampaignTemplateDraftUserMessage({
            originalMessage: params.userMessage,
            packageDraft: campaignPackage.packageDraft,
          }),
          airiLanguage,
          attachedSourceContext,
          attachedFileContext,
          kbContext,
          conversationContext,
          history: historyContext,
          traceId,
          pendingActions,
          // A campaign's template is a new draft, never an edit of the
          // template open in the builder.
          activeBuilder: null,
          progress,
          deadline,
        });
      } catch (error) {
        // The campaign package is already built: keep it and say the
        // template draft failed instead of failing the whole turn.
        campaignTemplateFailure = (
          await recordAiriChatStepFailure({
            error,
            signal: params.signal,
            progress,
            stage: {
              id: "template_draft",
              label: "Drafting WhatsApp template",
            },
          })
        ).diagnostics;
      }
    }
    const bulkCampaignDraft = buildAiriBulkCampaignDraft({
      workspaceId: params.workspaceId,
      packageDraft: campaignPackage.packageDraft,
      access: toolAccess,
      templateDraft: campaignTemplateDraft?.draft ?? null,
      sourceIds: sourceContext.sourceIds,
    });
    const creativeAssetDrafts = buildAiriCreativeAssetDrafts({
      workspaceId: params.workspaceId,
      packageDraft: campaignPackage.packageDraft,
      access: toolAccess,
      sourceIds: sourceContext.sourceIds,
    });
    throwIfCancelled(params.signal);
    const campaignArtifact = await persistAiriCampaignArtifact({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userId: params.userId,
      userMessageId: params.userMessageId,
      packageDraft: campaignPackage.packageDraft,
      scenarioGeneratorDraft,
      bulkCampaignDraft,
      creativeAssetDrafts,
    });
    await progress.emit(
      stageEvent(
        "campaign_artifact",
        "Saving campaign work plan",
        "complete",
        campaignArtifact.id
      )
    );
    const generationLatencyMs =
      campaignPackage.latencyMs === null &&
      campaignTemplateDraft?.latencyMs == null
        ? null
        : (campaignPackage.latencyMs ?? 0) +
          (campaignTemplateDraft?.latencyMs ?? 0);
    const receipt: AiriChatResourceReceipt = {
      selectedSources: selectedContext?.selectedSources ?? [],
      selectedSourceLabels,
      resources: resourceItems,
      sourceIds: sourceContext.sourceIds,
      retrievalPath: sourceContext.retrievalPath,
      provider: campaignTemplateDraft?.provider ?? campaignPackage.provider,
      model: campaignTemplateDraft?.model ?? campaignPackage.model,
      durationMs: Date.now() - startedAt,
    };
    return {
      content: buildMarketingCampaignPackageAssistantContent({
        packageDraft: campaignPackage.packageDraft,
        airiLanguage,
        templateDraft: campaignTemplateDraft?.draft ?? null,
        templateDraftFailed: Boolean(campaignTemplateFailure),
      }),
      metadata: {
        provider: campaignTemplateDraft?.provider ?? campaignPackage.provider,
        model: campaignTemplateDraft?.model ?? campaignPackage.model,
        usage: campaignTemplateDraft?.usage ?? campaignPackage.usage,
        kbArticlesFound: searchResult.kbArticles.length,
        conversationsFound: searchResult.conversations.length,
        retrievalContextCount: sourceContext.sourceIds.length,
        sourceIds: sourceContext.sourceIds,
        selectedSources: selectedContext?.selectedSources ?? [],
        selectedSourceLabels: selectedContext?.selectedSourceLabels ?? [],
        pendingActions,
        airiCampaignPackage: campaignPackage.packageDraft,
        airiCampaignArtifact: campaignArtifact,
        ...(scenarioGeneratorDraft
          ? { airiScenarioGeneratorDraft: scenarioGeneratorDraft }
          : {}),
        ...(bulkCampaignDraft
          ? { airiBulkCampaignDraft: bulkCampaignDraft }
          : {}),
        ...(creativeAssetDrafts.length > 0
          ? { airiCreativeAssetDrafts: creativeAssetDrafts }
          : {}),
        ...(campaignTemplateDraft
          ? {
              whatsappTemplateDraft: campaignTemplateDraft.draft,
              airiBuilderPatch: campaignTemplateDraft.patch,
            }
          : {}),
        ...(campaignTemplateFailure
          ? {
              airiCampaignTemplateDraftFailure: buildAiriChatFailureFields(
                campaignTemplateFailure
              ),
            }
          : {}),
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
        generationLatencyMs,
        generationModel:
          campaignTemplateDraft?.model ?? campaignPackage.model ?? null,
        ...sourceContext,
      },
    };
  } catch (error) {
    // The package itself is not usable. (A template answer that is not a
    // valid draft is handled above: the package is kept without it.)
    if (error instanceof AiriDraftOutputError) {
      return buildAiriDraftFallbackReply(context, {
        error,
        stage: CAMPAIGN_PACKAGE_STAGE,
      });
    }
    return recoverFromGeneratorFailure(error, CAMPAIGN_PACKAGE_STAGE);
  }
}
