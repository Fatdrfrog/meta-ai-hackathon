import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import "server-only";

import connectDB from "@/lib/mongoose";
import pLimit from "p-limit";
import { searchAskDataContextLocal } from "@/lib/ai/ask-data-search-local";
import { retrieveWorkspaceIndexedUrlSources } from "@/lib/airi/rag/workspace-knowledge";
import { getEffectiveKBArticleContent } from "@/lib/kb/article-content";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import AnswerSnippet from "@/models/answer-snippet";
import { AiriChatMessage } from "@/models/airi-chat-message";
import { AiriChatThread } from "@/models/airi-chat-thread";
import { Conversation } from "@/models/conversation";
import { QuickReply } from "@/models/quick-reply";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import type { createClient } from "@/lib/supabase/server";
import type {
  AskDataConversationResult,
  GatewayKnowledgeSource,
} from "@icecore/airi-runtime/ai-gateway";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  CONVERSATION_CHANNELS,
  isOnboardingTestSource,
  type SourceType,
} from "@icecore/shared/types/sources";
import { Types } from "mongoose";
import { escapeRegExp } from "@/lib/regex-utils";
import { AiriChatSelectedSourceError } from "./errors";
import { buildMetaAdsSkillCatalogOption } from "./meta-skill-catalog";
import {
  buildAiriChatSourceOptionId,
  isAiriChatContextOptionId,
  normalizeAiriChatSelectedSources,
  type AiriChatSourceOption,
  type AiriChatSourceRef,
} from "./source-types";
import { readDate } from "@icecore/shared/lib/value-utils";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** Selected sources resolved at once; each may hit Mongo, Supabase or search. */
const AIRI_SELECTED_SOURCE_CONCURRENCY = 4;

type SelectedSourceContribution = {
  conversations: AskDataConversationResult[];
  knowledge: GatewayKnowledgeSource[];
  channelSourceIds: string[];
};

type CatalogSourceRow = {
  id: string;
  type: string;
  name?: string | null;
  credentials?: unknown;
};

export type AiriChatSourceCatalogMode = "sources" | "chats";

type LeanConversationItem = {
  _id: Types.ObjectId | string;
  classification?: {
    category?: string | null;
    priority?: string | null;
    summary?: string | null;
  } | null;
  history_summary?: string | null;
  createdAt?: Date | string | null;
  lastMessageAt?: Date | string | null;
};

type LeanQuickReplyItem = {
  _id: Types.ObjectId | string;
  text?: string | null;
  category?: string | null;
};

type LeanAiriChatThreadItem = {
  _id: Types.ObjectId | string;
  title?: string | null;
  updatedAt?: Date | string | null;
};

type LeanAiriChatMessageItem = {
  role?: string | null;
  content?: string | null;
  createdAt?: Date | string | null;
};

type LeanWhatsAppTemplateItem = {
  name?: string | null;
  language?: string | null;
  status?: string | null;
  category?: string | null;
  quality_rating?: string | null;
  updatedAt?: Date | string | null;
};

export type AiriChatSelectedGroundingContext = {
  selectedSources: AiriChatSourceRef[];
  selectedSourceLabels: string[];
  conversations: AskDataConversationResult[];
  kbArticles: GatewayKnowledgeSource[];
  promptSections: string[];
  sourceIds: string[];
  conversationSourceIds: string[];
  kbSourceIds: string[];
  retrievalPath: "snippet" | "kb" | "blended" | "none";
};

const WHATSAPP_CONNECTOR_CAPABILITIES = ["docs", "templates", "flows"] as const;

const WHATSAPP_CONNECTOR_GUIDE = [
  "WhatsApp connector capabilities:",
  "- Answer WhatsApp setup, template, campaign, and flow questions using the connected workspace context.",
  "- Draft message templates with name, language, category, body, examples, and buttons when enough details are present.",
  "- Draft WhatsApp Flow specs with name, screens, fields, validation, CTA text, and publish readiness notes.",
  "- Do not create, publish, send, or mutate WhatsApp resources unless the user confirms an explicit action.",
].join("\n");

const CONNECTED_SOURCE_DESCRIPTIONS: Record<string, string> = {
  whatsapp: "Templates, flows, docs, and WhatsApp customer context",
  instagram: "Instagram conversations and account work",
  telegram: "Telegram customer conversations",
  email: "Postmark email support and campaign context",
  web_widget: "Website chat conversations",
  teams: "Microsoft Teams source",
  intercom: "Intercom source",
  google_calendar: "Calendar availability and booking context",
  canva: "Canva design and campaign planning",
  meta_ads: "Meta ads account and campaign planning",
  higgsfield: "Higgsfield visual generation planning",
  elevenlabs: "ElevenLabs audio and voice planning",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  email: "Postmark",
  google_calendar: "Google Calendar",
  meta_ads: "Meta Ads",
  web_widget: "Website Widget",
};

function compactText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesQuery(
  option: {
    label?: string | null;
    description?: string | null;
    meta?: string | null;
  },
  query: string
): boolean {
  if (!query) return true;
  const haystack = [option.label, option.description, option.meta]
    .map(value => compactText(value).toLowerCase())
    .join(" ");
  return haystack.includes(query.toLowerCase());
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => !!value))
  );
}

function formatDate(value: string | Date | null | undefined): string | null {
  return readDate(value)?.toISOString() ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function firstCompactText(values: unknown[]): string {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return "";
}

function sourceTypeLabel(type: string): string {
  const label = SOURCE_TYPE_LABELS[type];
  if (label) return label;

  return type
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sourceDisplayLabel(source: CatalogSourceRow): string {
  const credentials = asRecord(source.credentials);

  if (source.type === "instagram") {
    const profileName = firstCompactText([
      credentials.name,
      credentials.business_name,
      credentials.instagram_business_account_name,
      credentials.account_name,
    ]);
    if (profileName) return profileName;

    const username = firstCompactText([
      credentials.username,
      credentials.instagram_username,
      credentials.instagram_business_account_username,
    ]);
    if (username) return username.startsWith("@") ? username : `@${username}`;
  }

  if (source.type === "email") {
    return "Postmark";
  }

  if (source.type === "web_widget") {
    return "Website Widget";
  }

  return compactText(source.name) || sourceTypeLabel(source.type);
}

function sourceDisplayDescription(source: CatalogSourceRow): string {
  const base =
    CONNECTED_SOURCE_DESCRIPTIONS[source.type] ||
    `${sourceTypeLabel(source.type)} source`;

  if (source.type === "instagram") {
    const credentials = asRecord(source.credentials);
    const username = firstCompactText([credentials.username]);
    if (username) {
      return `${base} for @${username.replace(/^@/, "")}`;
    }
  }

  return base;
}

function assertSelectedSourcesLimit(sources: AiriChatSourceRef[]) {
  if (sources.length > 12) {
    throw new AiriChatSelectedSourceError("Select up to 12 sources");
  }
}

export function filterAvailableAiriChatChannelSources(
  sources: CatalogSourceRow[]
): CatalogSourceRow[] {
  const allowedChannels = new Set<string>(CONVERSATION_CHANNELS);
  return sources.filter(source => {
    if (!allowedChannels.has(source.type)) return false;
    if (isOnboardingTestSource(source)) return false;
    return true;
  });
}

export function filterAvailableAiriChatIntegrationSources(
  sources: CatalogSourceRow[]
): CatalogSourceRow[] {
  return sources.filter(source => !isOnboardingTestSource(source));
}

export function buildAiriChatCatalogOptions(params: {
  channelSources: CatalogSourceRow[];
  query?: string | null;
  limit?: number;
}): AiriChatSourceOption[] {
  const query = compactText(params.query).toLowerCase();
  const limit = Math.max(1, Math.min(100, params.limit || 50));

  const skillOptions = [
    buildMetaAdsSkillCatalogOption({
      channelSources: filterAvailableAiriChatIntegrationSources(
        params.channelSources
      ),
      query,
    }),
  ].filter((option): option is AiriChatSourceOption => Boolean(option));

  const connectedSourceOptions = filterAvailableAiriChatIntegrationSources(
    params.channelSources
  )
    .filter(source =>
      matchesQuery(
        {
          label: sourceDisplayLabel(source),
          description: sourceDisplayDescription(source),
          meta: source.type,
        },
        query
      )
    )
    .map(source => {
      const label = sourceDisplayLabel(source);
      const description = sourceDisplayDescription(source);
      const ref: AiriChatSourceRef =
        source.type === "whatsapp"
          ? {
              kind: "connector",
              connector: "whatsapp",
              sourceId: source.id,
              label,
              capabilities: [...WHATSAPP_CONNECTOR_CAPABILITIES],
            }
          : {
              kind: "workspace_source",
              sourceId: source.id,
              sourceType: source.type as SourceType,
              label,
            };
      return {
        id: buildAiriChatSourceOptionId(ref),
        ref,
        group: "Sources",
        label,
        description,
        disabled: false,
      };
    });

  const chooseChatsOption: AiriChatSourceOption[] =
    matchesQuery(
      {
        label: "Choose from chats",
        description: "Attach a previous Airi chat as context",
        meta: "chat thread history",
      },
      query
    ) || !query
      ? [
          {
            type: "action" as const,
            id: "action:choose_chats",
            action: "choose_chats" as const,
            group: "Chats",
            label: "Choose from chats",
            description: "Use a previous Airi chat as context",
            disabled: false,
          },
        ]
      : [];

  return [
    ...skillOptions,
    ...connectedSourceOptions,
    ...chooseChatsOption,
  ].slice(0, limit);
}

export async function listAiriChatThreadSourceOptions(params: {
  workspaceId: string;
  userId: string;
  query?: string | null;
  limit?: number;
}): Promise<AiriChatSourceOption[]> {
  await connectDB();
  const query = compactText(params.query);
  const limit = Math.max(1, Math.min(100, params.limit || 50));
  const filter: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
    status: "active",
  };
  if (query) {
    filter.title = { $regex: escapeRegExp(query), $options: "i" };
  }

  const threads = (await AiriChatThread.find(filter)
    .sort({ pinnedAt: -1, updatedAt: -1 })
    .limit(limit)
    .select("_id title updatedAt")
    .lean()) as LeanAiriChatThreadItem[];

  return threads.map(thread => {
    const label = compactText(thread.title) || "Untitled chat";
    const ref: AiriChatSourceRef = {
      kind: "chat_thread",
      threadId: String(thread._id),
      label,
    };
    return {
      id: buildAiriChatSourceOptionId(ref),
      ref,
      group: "Chats",
      label,
      description: formatDate(thread.updatedAt) || "Airi chat history",
      disabled: false,
    };
  });
}

export async function listAiriChatSourceOptions(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  query?: string | null;
  limit?: number;
  mode?: AiriChatSourceCatalogMode;
}): Promise<AiriChatSourceOption[]> {
  const limit = Math.max(1, Math.min(100, params.limit || 50));
  if (params.mode === "chats") {
    return listAiriChatThreadSourceOptions({
      workspaceId: params.workspaceId,
      userId: params.userId,
      query: params.query,
      limit,
    });
  }

  const sourcesResult = await params.supabase
    .from("sources")
    .select("id,type,name,credentials")
    .eq("workspace_id", params.workspaceId);
  if (sourcesResult.error) throw sourcesResult.error;

  return buildAiriChatCatalogOptions({
    channelSources: (sourcesResult.data ?? []) as CatalogSourceRow[],
    query: params.query,
    limit,
  });
}

function appendUniqueConversation(
  map: Map<string, AskDataConversationResult>,
  conversation: AskDataConversationResult
) {
  const id = compactText(conversation.id);
  if (!id || map.has(id)) return;
  map.set(id, conversation);
}

function appendUniqueKnowledge(
  map: Map<string, GatewayKnowledgeSource>,
  source: GatewayKnowledgeSource
) {
  const id = compactText(source.id);
  if (!id || map.has(id)) return;
  map.set(id, source);
}

export function formatAiriChatConversationContextLine(
  conversation: AskDataConversationResult,
  index: number
): string {
  const category = conversation.category || "";
  const priority = conversation.priority || "";
  const classificationLabel = category
    ? priority
      ? `${category} (${priority})`
      : category
    : priority
      ? `(${priority})`
      : "";
  return `[Conversation ${index + 1}]${classificationLabel ? ` ${classificationLabel}` : ""}: ${conversation.summary || "No summary available."}`;
}

function knowledgeToPrompt(source: GatewayKnowledgeSource, index: number) {
  const label =
    source.source_type === "external_url" ? "Indexed URL" : "Knowledge";
  const location = source.url ? ` - ${source.url}` : "";
  return `[${label} ${index + 1}] "${source.title}"${location}\n${source.content.slice(0, 1200)}`;
}

function selectedSourceUnavailable(ref: AiriChatSourceRef): Error {
  return new AiriChatSelectedSourceError(
    `Selected source is unavailable: ${ref.label}`
  );
}

async function fetchConversationItem(
  workspaceId: string,
  itemId: string
): Promise<AskDataConversationResult> {
  if (!Types.ObjectId.isValid(itemId)) {
    throw new AiriChatSelectedSourceError(
      "Selected conversation source is invalid"
    );
  }
  const conversation = (await Conversation.findOne({
    _id: itemId,
    workspaceId,
  })
    .select(
      `_id classification.category classification.priority classification.summary history_summary createdAt lastMessageAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
    )
    .lean()) as LeanConversationItem | null;
  if (!conversation) {
    throw new AiriChatSelectedSourceError(
      "Selected conversation source is unavailable"
    );
  }
  const currentClassification =
    getCurrentConversationClassification<
      NonNullable<LeanConversationItem["classification"]>
    >(conversation);
  return {
    id: String(conversation._id),
    category: currentClassification?.category || undefined,
    priority: currentClassification?.priority || undefined,
    summary:
      currentClassification?.summary ||
      conversation.history_summary ||
      "Conversation context",
    createdAt: formatDate(conversation.createdAt || conversation.lastMessageAt),
  };
}

async function fetchKnowledgeArticleItem(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  itemId: string;
}): Promise<GatewayKnowledgeSource> {
  const { data, error } = await params.supabase
    .from("kb_articles")
    .select(
      "id,title,draft_content_mdx,status,kb_article_versions(content_mdx,version,created_at)"
    )
    .eq("workspace_id", params.workspaceId)
    .eq("status", "published")
    .eq("id", params.itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new AiriChatSelectedSourceError("Selected KB article is unavailable");
  return {
    id: String(data.id),
    title: data.title || "Knowledge base article",
    content: getEffectiveKBArticleContent({
      draftContent: data.draft_content_mdx,
      versions: data.kb_article_versions,
      fallback: "",
    }),
    relevance_score: 1,
    source_type: "article",
  };
}

async function fetchIndexedUrlItem(params: {
  supabase: SupabaseClient;
  companyId: string | null;
  itemId: string;
}): Promise<GatewayKnowledgeSource> {
  if (!params.companyId) {
    throw new AiriChatSelectedSourceError(
      "Selected indexed URL is unavailable"
    );
  }
  const { data, error } = await params.supabase
    .from("kb_indexed_urls")
    .select("id,url,title,description,content_text,index_status")
    .eq("company_id", params.companyId)
    .neq("index_status", "failed")
    .eq("id", params.itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new AiriChatSelectedSourceError(
      "Selected indexed URL is unavailable"
    );
  return {
    id: String(data.id),
    title: data.title || data.url || "Indexed URL",
    content: data.content_text || data.description || data.url || "",
    relevance_score: 1,
    source_type: "external_url",
    url: data.url || undefined,
  };
}

async function fetchSnippetItem(
  workspaceId: string,
  itemId: string
): Promise<GatewayKnowledgeSource> {
  if (!Types.ObjectId.isValid(itemId)) {
    throw new AiriChatSelectedSourceError("Selected answer snippet is invalid");
  }
  const snippet = await AnswerSnippet.findOne({ _id: itemId, workspaceId })
    .select("_id question answer category")
    .lean();
  if (!snippet) {
    throw new AiriChatSelectedSourceError(
      "Selected answer snippet is unavailable"
    );
  }
  return {
    id: `snippet:${snippet._id}`,
    title: snippet.question || "Answer snippet",
    content: `Q: ${snippet.question || ""}\nA: ${snippet.answer || ""}`,
    relevance_score: 1,
  };
}

async function fetchQuickReplyItem(
  workspaceId: string,
  itemId: string
): Promise<GatewayKnowledgeSource> {
  if (!Types.ObjectId.isValid(itemId)) {
    throw new AiriChatSelectedSourceError("Selected quick reply is invalid");
  }
  const reply = (await QuickReply.findOne({ _id: itemId, workspaceId })
    .select("_id text category channel")
    .lean()) as LeanQuickReplyItem | null;
  if (!reply) {
    throw new AiriChatSelectedSourceError(
      "Selected quick reply is unavailable"
    );
  }
  return {
    id: `quick_reply:${reply._id}`,
    title: reply.category || "Quick reply",
    content: reply.text || "",
    relevance_score: 1,
  };
}

async function searchAnswerSnippets(
  workspaceId: string,
  query: string
): Promise<GatewayKnowledgeSource[]> {
  const trimmed = compactText(query);
  const filter = trimmed
    ? {
        workspaceId,
        $or: [
          { question: { $regex: escapeRegExp(trimmed), $options: "i" } },
          { answer: { $regex: escapeRegExp(trimmed), $options: "i" } },
          { tags: { $in: [new RegExp(escapeRegExp(trimmed), "i")] } },
        ],
      }
    : { workspaceId };
  const snippets = await AnswerSnippet.find(filter)
    .sort({ updatedAt: -1 })
    .limit(5)
    .select("_id question answer category")
    .lean();
  return snippets.map(snippet => ({
    id: `snippet:${snippet._id}`,
    title: snippet.question || "Answer snippet",
    content: `Q: ${snippet.question || ""}\nA: ${snippet.answer || ""}`,
    relevance_score: 1,
  }));
}

async function searchQuickReplies(
  workspaceId: string,
  query: string
): Promise<GatewayKnowledgeSource[]> {
  const trimmed = compactText(query);
  const filter = trimmed
    ? {
        workspaceId,
        text: { $regex: escapeRegExp(trimmed), $options: "i" },
      }
    : { workspaceId };
  const replies = await QuickReply.find(filter)
    .sort({ order: 1, createdAt: -1 })
    .limit(5)
    .select("_id text category channel")
    .lean();
  return replies.map(reply => ({
    id: `quick_reply:${reply._id}`,
    title: reply.category || "Quick reply",
    content: reply.text || "",
    relevance_score: 1,
  }));
}

type SourceBackedRef = Extract<
  AiriChatSourceRef,
  { kind: "channel_source" | "workspace_source" | "connector" }
>;

function isSourceBackedRef(ref: AiriChatSourceRef): ref is SourceBackedRef {
  return (
    ref.kind === "channel_source" ||
    ref.kind === "workspace_source" ||
    ref.kind === "connector"
  );
}

/** One query for every source-backed selection instead of one per ref. */
async function loadSelectedSourceRows(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  refs: SourceBackedRef[];
}): Promise<Map<string, CatalogSourceRow>> {
  const ids = Array.from(new Set(params.refs.map(ref => ref.sourceId)));
  if (ids.length === 0) return new Map();
  const { data, error } = await params.supabase
    .from("sources")
    .select("id,type,name,credentials")
    .eq("workspace_id", params.workspaceId)
    .in("id", ids);
  if (error) throw error;
  return new Map(
    ((data ?? []) as CatalogSourceRow[]).map(row => [String(row.id), row])
  );
}

function validateSelectedSourceRow(
  ref: SourceBackedRef,
  source: CatalogSourceRow | undefined
): CatalogSourceRow {
  if (!source) throw selectedSourceUnavailable(ref);
  const available =
    ref.kind === "workspace_source"
      ? !isOnboardingTestSource(source)
      : (ref.kind !== "connector" || source.type === "whatsapp") &&
        filterAvailableAiriChatChannelSources([source]).length > 0;
  if (!available) throw selectedSourceUnavailable(ref);
  return source;
}

async function buildWhatsAppConnectorKnowledge(
  workspaceId: string
): Promise<GatewayKnowledgeSource> {
  const templates = (await WhatsAppTemplateModel.find({ workspaceId })
    .sort({ updatedAt: -1 })
    .limit(8)
    .select("name language status category quality_rating updatedAt")
    .lean()) as LeanWhatsAppTemplateItem[];

  const templateSummary =
    templates.length > 0
      ? templates
          .map(template => {
            const parts = [
              template.name || "Unnamed template",
              template.language ? `language ${template.language}` : null,
              template.category ? `category ${template.category}` : null,
              template.status ? `status ${template.status}` : null,
              template.quality_rating
                ? `quality ${template.quality_rating}`
                : null,
            ].filter(Boolean);
            return `- ${parts.join(", ")}`;
          })
          .join("\n")
      : "- No cached WhatsApp templates found for this workspace.";

  return {
    id: "whatsapp_connector:workspace",
    title: "WhatsApp connector",
    content: [
      WHATSAPP_CONNECTOR_GUIDE,
      "",
      "Recent templates:",
      templateSummary,
    ]
      .filter(Boolean)
      .join("\n"),
    relevance_score: 1,
  };
}

function isConversationSourceType(type: string): boolean {
  return (CONVERSATION_CHANNELS as readonly string[]).includes(type);
}

function buildWorkspaceSourceKnowledge(
  source: CatalogSourceRow
): GatewayKnowledgeSource {
  const typeLabel = sourceTypeLabel(source.type);
  const title = sourceDisplayLabel(source) || typeLabel;
  const description = sourceDisplayDescription(source);
  const capabilityNotes: Record<string, string> = {
    canva:
      "Canva is connected. Help plan design briefs, social posts, brand-safe creative directions, and hand off concrete design instructions. Do not claim a Canva design was created unless an explicit Canva tool flow confirms it.",
    higgsfield:
      "Higgsfield is connected. Help plan image or video generation prompts and shot directions. Do not claim media was generated unless a confirmed generation workflow runs.",
    elevenlabs:
      "ElevenLabs is connected. Help plan voiceover, speech, sound effect, dubbing, subtitle, and transcript work. Do not claim audio was generated unless a confirmed generation workflow runs.",
    google_calendar:
      "Google Calendar is connected. Use it for booking and availability planning when the user asks, but do not create calendar events without explicit confirmation.",
    meta_ads:
      "Meta Ads is connected. With Ads MCP enabled via @meta, live reporting tools can run; mutations require explicit user confirmation in chat before execution.",
    instagram:
      "Instagram is connected. Use Instagram conversation context and content planning when relevant.",
    telegram:
      "Telegram is connected. Use Telegram customer conversation context when relevant.",
    email:
      "Postmark is connected. Use email support and campaign context when relevant.",
    web_widget:
      "Website chat is connected. Use website chat conversation context when relevant.",
  };

  return {
    id: `workspace_source:${source.id}`,
    title: `Connected source: ${title}`,
    content: [
      `${title} (${source.type})`,
      description,
      capabilityNotes[source.type] ||
        "This workspace source is connected. Use it as an explicit user-selected source when relevant, without exposing credentials or claiming external mutations.",
    ].join("\n"),
    relevance_score: 1,
  };
}

async function fetchAiriChatThreadContext(params: {
  workspaceId: string;
  userId?: string | null;
  threadId: string;
}): Promise<GatewayKnowledgeSource> {
  if (!Types.ObjectId.isValid(params.threadId)) {
    throw new AiriChatSelectedSourceError("Selected Airi chat is invalid");
  }
  const threadFilter: Record<string, unknown> = {
    _id: params.threadId,
    workspaceId: params.workspaceId,
    status: "active",
  };
  if (params.userId) {
    threadFilter.createdByUserId = params.userId;
  }
  const thread = (await AiriChatThread.findOne(threadFilter)
    .select("_id title updatedAt")
    .lean()) as LeanAiriChatThreadItem | null;
  if (!thread) {
    throw new AiriChatSelectedSourceError("Selected Airi chat is unavailable");
  }

  const messages = (await AiriChatMessage.find({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
  })
    .sort({ createdAt: -1 })
    .limit(12)
    .select("role content createdAt")
    .lean()) as LeanAiriChatMessageItem[];

  const content = messages
    .reverse()
    .map(message => {
      const role = message.role === "assistant" ? "Airi" : "User";
      return `${role}: ${compactText(message.content)}`;
    })
    .filter(Boolean)
    .join("\n");

  return {
    id: `airi_chat:${thread._id}`,
    title: `Airi chat: ${compactText(thread.title) || "Untitled chat"}`,
    content: content || "No messages in the selected Airi chat.",
    relevance_score: 1,
  };
}

export async function buildSelectedAiriChatGroundingContext(params: {
  signal?: AbortSignal;
  supabase: SupabaseClient;
  workspaceId: string;
  userId?: string | null;
  query: string;
  selectedSources: unknown;
}): Promise<AiriChatSelectedGroundingContext | null> {
  throwIfCancelled(params.signal);
  const selectedSources = normalizeAiriChatSelectedSources(
    params.selectedSources
  );
  assertSelectedSourcesLimit(selectedSources);
  if (selectedSources.length === 0) return null;

  await awaitWithCancellation(connectDB(), params.signal);

  // Validate every source-backed ref in one query, in selection order, before
  // any retrieval starts.
  const sourceBackedRefs = selectedSources.filter(isSourceBackedRef);
  const sourceRows = await awaitWithCancellation(
    loadSelectedSourceRows({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      refs: sourceBackedRefs,
    }),
    params.signal
  );
  const validatedSources = new Map<SourceBackedRef, CatalogSourceRow>(
    sourceBackedRefs.map(ref => [
      ref,
      validateSelectedSourceRow(ref, sourceRows.get(ref.sourceId)),
    ])
  );

  // Only indexed-URL items need the company id.
  let companyIdPromise: Promise<string | null> | null = null;
  const getCompanyId = () =>
    (companyIdPromise ??= getCompanyIdForWorkspace(
      params.supabase,
      params.workspaceId
    ));
  let connectorKnowledgePromise: Promise<GatewayKnowledgeSource> | null = null;
  const getConnectorKnowledge = () =>
    (connectorKnowledgePromise ??= buildWhatsAppConnectorKnowledge(
      params.workspaceId
    ));

  const resolveRef = async (
    ref: AiriChatSourceRef
  ): Promise<SelectedSourceContribution> => {
    const contribution: SelectedSourceContribution = {
      conversations: [],
      knowledge: [],
      channelSourceIds: [],
    };
    if (ref.kind === "context") {
      if (!isAiriChatContextOptionId(ref.optionId)) {
        throw selectedSourceUnavailable(ref);
      }
      if (ref.optionId === "conversation_timeline") {
        const result = await awaitWithCancellation(
          searchAskDataContextLocal({
            signal: params.signal,
            workspaceId: params.workspaceId,
            query: params.query,
            conversationLimit: 5,
            includeKnowledge: false,
          }),
          params.signal
        );
        contribution.conversations.push(...result.conversations);
      }
      if (ref.optionId === "knowledge_base_articles") {
        const result = await awaitWithCancellation(
          searchAskDataContextLocal({
            signal: params.signal,
            workspaceId: params.workspaceId,
            query: params.query,
            kbLimit: 5,
            includeConversations: false,
          }),
          params.signal
        );
        contribution.knowledge.push(...result.kbArticles);
      }
      if (ref.optionId === "indexed_public_urls") {
        contribution.knowledge.push(
          ...(await awaitWithCancellation(
            retrieveWorkspaceIndexedUrlSources({
              workspaceId: params.workspaceId,
              query: params.query,
              limit: 5,
            }),
            params.signal
          ))
        );
      }
      if (ref.optionId === "answer_snippets") {
        contribution.knowledge.push(
          ...(await awaitWithCancellation(
            searchAnswerSnippets(params.workspaceId, params.query),
            params.signal
          ))
        );
      }
      if (ref.optionId === "quick_replies") {
        contribution.knowledge.push(
          ...(await awaitWithCancellation(
            searchQuickReplies(params.workspaceId, params.query),
            params.signal
          ))
        );
      }
    }

    if (ref.kind === "context_item") {
      if (ref.optionId === "conversation_timeline") {
        contribution.conversations.push(
          await awaitWithCancellation(
            fetchConversationItem(params.workspaceId, ref.itemId),
            params.signal
          )
        );
      } else if (ref.optionId === "knowledge_base_articles") {
        contribution.knowledge.push(
          await awaitWithCancellation(
            fetchKnowledgeArticleItem({
              supabase: params.supabase,
              workspaceId: params.workspaceId,
              itemId: ref.itemId,
            }),
            params.signal
          )
        );
      } else if (ref.optionId === "indexed_public_urls") {
        const companyId = await awaitWithCancellation(
          getCompanyId(),
          params.signal
        );
        contribution.knowledge.push(
          await awaitWithCancellation(
            fetchIndexedUrlItem({
              supabase: params.supabase,
              companyId,
              itemId: ref.itemId,
            }),
            params.signal
          )
        );
      } else if (ref.optionId === "answer_snippets") {
        contribution.knowledge.push(
          await awaitWithCancellation(
            fetchSnippetItem(params.workspaceId, ref.itemId),
            params.signal
          )
        );
      } else if (ref.optionId === "quick_replies") {
        contribution.knowledge.push(
          await awaitWithCancellation(
            fetchQuickReplyItem(params.workspaceId, ref.itemId),
            params.signal
          )
        );
      }
    }

    if (isSourceBackedRef(ref)) {
      const source = validatedSources.get(ref)!;
      if (ref.kind === "channel_source") {
        contribution.channelSourceIds.push(source.id);
      }
      if (ref.kind === "workspace_source") {
        if (isConversationSourceType(source.type)) {
          contribution.channelSourceIds.push(source.id);
        }
        contribution.knowledge.push(buildWorkspaceSourceKnowledge(source));
      }
      if (ref.kind === "connector") {
        contribution.channelSourceIds.push(source.id);
        contribution.knowledge.push(
          await awaitWithCancellation(getConnectorKnowledge(), params.signal)
        );
      }
    }

    if (ref.kind === "chat_thread") {
      contribution.knowledge.push(
        await awaitWithCancellation(
          fetchAiriChatThreadContext({
            workspaceId: params.workspaceId,
            userId: params.userId,
            threadId: ref.threadId,
          }),
          params.signal
        )
      );
    }
    return contribution;
  };

  // Refs resolve concurrently (bounded); contributions merge in selection
  // order so the prompt stays deterministic. A failure stops queued refs.
  const limit = pLimit(AIRI_SELECTED_SOURCE_CONCURRENCY);
  let failed = false;
  const contributions = await awaitWithCancellation(
    Promise.all(
      selectedSources.map(ref =>
        limit(async () => {
          throwIfCancelled(params.signal);
          if (failed) return null;
          try {
            return await resolveRef(ref);
          } catch (error) {
            failed = true;
            throw error;
          }
        })
      )
    ),
    params.signal
  );
  throwIfCancelled(params.signal);

  const conversations = new Map<string, AskDataConversationResult>();
  const knowledge = new Map<string, GatewayKnowledgeSource>();
  const channelSourceIds: string[] = [];
  for (const contribution of contributions) {
    if (!contribution) continue;
    contribution.conversations.forEach(conversation =>
      appendUniqueConversation(conversations, conversation)
    );
    contribution.knowledge.forEach(source =>
      appendUniqueKnowledge(knowledge, source)
    );
    channelSourceIds.push(...contribution.channelSourceIds);
  }

  if (channelSourceIds.length > 0) {
    const result = await awaitWithCancellation(
      searchAskDataContextLocal({
        signal: params.signal,
        workspaceId: params.workspaceId,
        query: params.query,
        conversationLimit: 8,
        includeKnowledge: false,
        sourceIds: channelSourceIds,
      }),
      params.signal
    );
    result.conversations.forEach(conversation =>
      appendUniqueConversation(conversations, conversation)
    );
  }

  const conversationList = Array.from(conversations.values());
  const knowledgeList = Array.from(knowledge.values());
  const conversationSourceIds = conversationList.map(conversation =>
    conversation.id ? `conversation:${conversation.id}` : null
  );
  const kbSourceIds = knowledgeList.map(source => {
    const id = compactText(source.id);
    if (!id) return null;
    if (id.startsWith("snippet:") || id.startsWith("quick_reply:")) return id;
    if (id.startsWith("airi_chat:") || id.startsWith("whatsapp_connector:")) {
      return id;
    }
    return source.source_type === "external_url" ? `url:${id}` : `kb:${id}`;
  });
  const sourceIds = uniqueStrings([...conversationSourceIds, ...kbSourceIds]);
  const promptSections = [
    ...conversationList.map(formatAiriChatConversationContextLine),
    ...knowledgeList.map(knowledgeToPrompt),
  ];
  const retrievalPath =
    conversationList.length > 0 && knowledgeList.length > 0
      ? "blended"
      : knowledgeList.length > 0
        ? "kb"
        : conversationList.length > 0
          ? "snippet"
          : "none";

  return {
    selectedSources,
    selectedSourceLabels: selectedSources.map(ref => ref.label),
    conversations: conversationList,
    kbArticles: knowledgeList,
    promptSections,
    sourceIds,
    conversationSourceIds: uniqueStrings(conversationSourceIds),
    kbSourceIds: uniqueStrings(kbSourceIds),
    retrievalPath,
  };
}
