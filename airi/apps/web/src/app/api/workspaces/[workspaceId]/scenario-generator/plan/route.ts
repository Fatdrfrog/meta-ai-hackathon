import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getReasoningTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { buildCanvaTemplateSearchQuery } from "@/lib/canva/brand-templates";
import {
  buildCompanyStudioChatLimitExceededResponse,
  ensureCompanyStudioChatCapacity,
  recordCreativeStudioChat,
} from "@/lib/limits/company-limits";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { buildRecipientCohorts } from "@/lib/scenario-generator/recipients";
import { Conversation } from "@/models/conversation";
import {
  normalizeScenarioGeneratorChannels,
  normalizeScenarioGeneratorSourceContext,
  type ScenarioGeneratorChannel,
  ScenarioGeneratorPlanInput,
  ScenarioGeneratorRecipient,
  type ScenarioGeneratorSendMode,
  type ScenarioGeneratorSourceContext,
  type ScenarioGeneratorWorkflowKind,
} from "@icecore/scenario-contracts";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { NextRequest, NextResponse } from "next/server";

// The planner runs on the reasoning tier (Opus), slower than the 30 s AI
// default; pin the duration instead of relying on the platform default.
export const maxDuration = 300;

/** Below maxDuration, leaving room for the conversation lookup. */
const PLANNER_AI_TIMEOUT_MS = 120_000;

type Params = Promise<{ workspaceId: string }>;

type PlanBody = Partial<ScenarioGeneratorPlanInput>;

type PlannerQuestion = {
  question: string;
  context?: string;
};

type ConversationPlannerContext = {
  id: string;
  channel: string;
  sourceId?: string | null;
  identifier: string;
  summary?: string | null;
  category?: string | null;
  labels: string[];
  lastMessageAt?: string | null;
};

type PlannerAssetSummary = {
  id?: string;
  kind?: "image" | "video" | "audio" | "document";
  source?: "uploaded" | "higgsfield";
  fileName?: string;
  mimeType?: string;
  url?: string;
};

type LeanConversationForPlanner = {
  _id?: unknown;
  channel?: unknown;
  sourceId?: unknown;
  chat?: unknown;
  user?: unknown;
  participants?: {
    from?: unknown[];
    to?: unknown[];
  };
  history_summary?: unknown;
  classification?: {
    category?: unknown;
    summary?: unknown;
  };
  internal_labels?: unknown[];
  lastMessageAt?: unknown;
};

type AiPlannerDecision = {
  status: "needs_input" | "ready";
  questions: PlannerQuestion[];
  summary?: string | null;
  campaignName?: string | null;
  workflowKind?: ScenarioGeneratorWorkflowKind | null;
  sendMode?: ScenarioGeneratorSendMode | null;
  recipientSourceSummary?: string | null;
  templateSearchQuery?: string | null;
};

function buildFallbackCampaignName(prompt: string): string {
  const words = prompt
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length > 0 ? words.join(" ") : "Generated scenario";
}

function normalizeString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  const normalized = String(value).trim();
  return normalized === "[object Object]" ? "" : normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.map(item => normalizeString(item)).filter(item => item.length > 0)
    )
  ).slice(0, 20);
}

function normalizePlannerAssetKind(
  value: unknown
): PlannerAssetSummary["kind"] | null {
  const kind = normalizeString(value).toLowerCase();
  return kind === "image" ||
    kind === "video" ||
    kind === "audio" ||
    kind === "document"
    ? kind
    : null;
}

function normalizePlannerAssetSource(
  value: unknown
): PlannerAssetSummary["source"] | null {
  const source = normalizeString(value).toLowerCase();
  return source === "uploaded" || source === "higgsfield" ? source : null;
}

function normalizePlannerAssets(value: unknown): PlannerAssetSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const url = normalizeString(record.url);
      const id = normalizeString(record.id);
      const kind = normalizePlannerAssetKind(record.kind);
      const source = normalizePlannerAssetSource(record.source);
      if (!id && !url) return null;
      return {
        ...(id ? { id } : {}),
        ...(kind ? { kind } : {}),
        ...(source ? { source } : {}),
        ...(normalizeString(record.fileName)
          ? { fileName: normalizeString(record.fileName) }
          : {}),
        ...(normalizeString(record.mimeType)
          ? { mimeType: normalizeString(record.mimeType) }
          : {}),
        ...(url ? { url } : {}),
      };
    })
    .filter((item): item is PlannerAssetSummary => item !== null)
    .slice(0, 10);
}

function normalizeQuestionList(value: unknown): PlannerQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === "string") {
        return { question: item.trim() };
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const question = normalizeString(record.question);
      if (!question) return null;
      return {
        question,
        context: normalizeOptionalString(record.context) || undefined,
      };
    })
    .filter((item): item is PlannerQuestion => Boolean(item))
    .slice(0, 5);
}

function normalizePlannerDecision(
  value: Record<string, unknown>
): AiPlannerDecision {
  const questions = normalizeQuestionList(value.questions);
  const status =
    normalizeString(value.status).toLowerCase() === "needs_input" &&
    questions.length > 0
      ? "needs_input"
      : "ready";
  return {
    status,
    questions: status === "needs_input" ? questions : [],
    summary: normalizeOptionalString(value.summary),
    campaignName: normalizeOptionalString(value.campaignName),
    workflowKind:
      normalizeString(value.workflowKind) === "bulk_campaign" ||
      normalizeString(value.workflowKind) === "follow_up_workflow"
        ? (normalizeString(value.workflowKind) as ScenarioGeneratorWorkflowKind)
        : null,
    sendMode:
      normalizeString(value.sendMode) === "immediate" ||
      normalizeString(value.sendMode) === "trigger"
        ? (normalizeString(value.sendMode) as ScenarioGeneratorSendMode)
        : null,
    recipientSourceSummary: normalizeOptionalString(
      value.recipientSourceSummary
    ),
    templateSearchQuery: normalizeOptionalString(value.templateSearchQuery),
  };
}

function normalizeConversationIdentifier(
  conversation: LeanConversationForPlanner
): string {
  if (conversation.channel === "email") {
    const emails = [
      ...(conversation.participants?.from || []),
      ...(conversation.participants?.to || []),
    ]
      .map(item => normalizeString(item).toLowerCase())
      .filter(Boolean);
    return emails[0] || "email conversation";
  }
  return (
    normalizeString(conversation.chat) ||
    normalizeString(conversation.user) ||
    "conversation"
  );
}

async function loadConversationPlannerContext(params: {
  workspaceId: string;
  channels: ScenarioGeneratorChannel[];
  sourceIds: string[];
}): Promise<ConversationPlannerContext[]> {
  if (params.channels.length === 0) return [];

  await connectDB();

  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    channel: { $in: params.channels },
  };
  if (params.sourceIds.length > 0) {
    query.sourceId = { $in: params.sourceIds };
  }

  const conversations = await Conversation.find(query)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(30)
    .select(
      `_id channel sourceId chat user participants history_summary classification.category classification.summary internal_labels lastMessageAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
    )
    .lean<LeanConversationForPlanner[]>();

  return conversations.map(conversation => {
    const currentClassification = getCurrentConversationClassification<{
      category?: unknown;
      summary?: unknown;
    }>(conversation);
    return {
      id: normalizeString(conversation._id),
      channel: normalizeString(conversation.channel),
      sourceId: normalizeOptionalString(conversation.sourceId),
      identifier: normalizeConversationIdentifier(conversation),
      summary:
        normalizeOptionalString(conversation.history_summary) ||
        normalizeOptionalString(currentClassification?.summary),
      category: normalizeOptionalString(currentClassification?.category),
      labels: Array.isArray(conversation.internal_labels)
        ? conversation.internal_labels
            .map(item => normalizeString(item))
            .filter(Boolean)
            .slice(0, 8)
        : [],
      lastMessageAt:
        conversation.lastMessageAt instanceof Date
          ? conversation.lastMessageAt.toISOString()
          : normalizeOptionalString(conversation.lastMessageAt),
    };
  });
}

async function planWithAi(params: {
  workspaceId: string;
  prompt: string;
  answers: Array<{ question: string; answer: string }>;
  channels: Array<"whatsapp" | "telegram" | "email">;
  workflowKind: string;
  sendMode: string;
  recipientSourceSummary?: string;
  recipients: ScenarioGeneratorRecipient[];
  assetCount: number;
  assets: PlannerAssetSummary[];
  sourceContext: ScenarioGeneratorSourceContext[];
  conversationContext: ConversationPlannerContext[];
  presetSeed?: unknown;
}): Promise<AiPlannerDecision> {
  try {
    const result = await chatCompletionWithFallback({
      model: getReasoningTextModel(),
      resilience: { timeoutMs: PLANNER_AI_TIMEOUT_MS },
      messages: [
        {
          role: "system",
          content: [
            "You are planning a scenario generation request for a CRM and WhatsApp/email/Telegram campaign builder.",
            "Decide whether enough information exists to generate the scenario.",
            "Use only the selected channels and the provided conversation context. Do not invent unselected sources.",
            "Choose workflowKind and sendMode. Use bulk_campaign with immediate for outbound campaigns, product launches, announcements, promotions, and broadcast-style audience work. Use follow_up_workflow with trigger for customer-initiated inbound-message automation such as support intake, booking questions, qualification, or lifecycle conversations.",
            "Connected source context can inform the plan but is not a delivery channel unless it is also selectedChannels. If Google Calendar is connected, use it for booking/availability planning instead of inventing Calendly or other booking links.",
            "If important details are missing, return status needs_input and ask up to 3 concise questions.",
            "Each question must include a short context explaining why it matters, grounded in the prompt, selected channels, recipients, assets, or conversation context.",
            "If enough information exists, return status ready with a concise summary and optional campaignName, workflowKind, sendMode, recipientSourceSummary, and templateSearchQuery.",
            'Return JSON only: {"status":"needs_input","questions":[{"question":"...","context":"..."}]} or {"status":"ready","summary":"...","campaignName":"...","workflowKind":"bulk_campaign|follow_up_workflow","sendMode":"immediate|trigger","recipientSourceSummary":"...","templateSearchQuery":"..."}',
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt: params.prompt,
            answers: params.answers,
            workflowKind: params.workflowKind,
            sendMode: params.sendMode,
            selectedChannels: params.channels,
            recipientSourceSummary: params.recipientSourceSummary || null,
            recipientCount: params.recipients.length,
            sampleRecipients: params.recipients.slice(0, 10),
            assetCount: params.assetCount,
            assets: params.assets,
            sourceContext: params.sourceContext,
            conversationContext: params.conversationContext,
            presetSeed: params.presetSeed || null,
          }),
        },
      ],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      analytics: {
        workspaceId: params.workspaceId,
        operation: "scenario_generator.plan",
        sourceService: "web",
      },
    });
    return normalizePlannerDecision(extractJsonObject(result.content));
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return {
      status: "ready",
      questions: [],
      summary: null,
      campaignName: null,
      recipientSourceSummary: null,
      templateSearchQuery: null,
    };
  }
}

async function handlePOST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const studioChatCapacity = await ensureCompanyStudioChatCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!studioChatCapacity.allowed) {
    return buildCompanyStudioChatLimitExceededResponse(
      studioChatCapacity.limit
    );
  }

  const body = (await request.json().catch(() => ({}))) as PlanBody;
  const prompt = String(body.prompt || "").trim();
  const answers = Array.isArray(body.answers)
    ? body.answers
        .map(item => ({
          question: normalizeString(item.question),
          answer: normalizeString(item.answer),
        }))
        .filter(item => item.question && item.answer)
    : [];
  const channels = normalizeScenarioGeneratorChannels(body.channels);
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  const sourceIds = normalizeSourceIds(body.sourceIds);
  const assets = normalizePlannerAssets(body.assetRefs);
  const sourceContext = normalizeScenarioGeneratorSourceContext(
    body.sourceContext
  );
  const conversationContext = await loadConversationPlannerContext({
    workspaceId,
    channels,
    sourceIds,
  });
  const plannerDecision = await planWithAi({
    workspaceId,
    prompt,
    answers,
    channels,
    workflowKind: body.workflowKind || "bulk_campaign",
    sendMode: body.sendMode || "immediate",
    recipientSourceSummary: body.recipientSourceSummary,
    recipients,
    assetCount: assets.length,
    assets,
    sourceContext,
    conversationContext,
    presetSeed: body.presetSeed,
  });
  await recordCreativeStudioChat(workspaceId, "scenario_plan");

  if (plannerDecision.status === "needs_input") {
    logger.info("[ScenarioGenerator] plan_needs_input", {
      workspaceId,
      questionCount: plannerDecision.questions.length,
      channels,
      workflowKind: body.workflowKind || "bulk_campaign",
      sendMode: body.sendMode || "immediate",
    });
    return NextResponse.json({
      status: "needs_input",
      questions: plannerDecision.questions,
    });
  }

  const cohorts = buildRecipientCohorts(recipients);
  const workflowKind =
    plannerDecision.workflowKind || body.workflowKind || "bulk_campaign";
  const sendMode = plannerDecision.sendMode || body.sendMode || "immediate";

  logger.info("[ScenarioGenerator] plan_ready", {
    workspaceId,
    channelCount: channels.length,
    cohortCount: cohorts.length,
    assetCount: assets.length,
  });

  return NextResponse.json({
    status: "ready",
    templateSearchQuery:
      plannerDecision.templateSearchQuery ||
      buildCanvaTemplateSearchQuery({
        prompt,
        campaignName:
          plannerDecision.campaignName || buildFallbackCampaignName(prompt),
      }),
    blueprint: {
      summary: plannerDecision.summary || `Generate a scenario for: ${prompt}`,
      campaignName:
        plannerDecision.campaignName || buildFallbackCampaignName(prompt),
      workflowKind,
      sendMode,
      channels,
      recipientSourceSummary:
        plannerDecision.recipientSourceSummary ||
        body.recipientSourceSummary ||
        (recipients.length > 0
          ? `${recipients.length} selected recipients`
          : "Triggered audience"),
      cohorts,
    },
  });
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const { workspaceId } = await args[1].params;
  try {
    return await withWorkspaceTextAiAction(
      { workspaceId, actionId: `scenario-plan:${randomUUID()}` },
      () => handlePOST(...args)
    );
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    throw error;
  }
}
