/** Prompt context and receipts built from the turn's gathered sources. */

import type { AiriChatReplyAnalytics } from "@/lib/airi-chats/analytics";
import {
  formatAiriChatConversationContextLine,
  type AiriChatSelectedGroundingContext,
} from "@/lib/airi-chats/sources";
import type { AiriChatAttachmentInput } from "@/lib/airi-chats/request-schemas";
import type { AiriChatSourceRef } from "@/lib/airi-chats/source-types";
import type { AiriChatIntentKind } from "@/lib/airi-chats/intent-classifier";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import type { AiriChatPendingAction } from "@/lib/airi-chats/pending-actions";
import type { AiriChatRunResource } from "@/lib/airi-chats/run-events";
import Message from "@/models/message";
import type {
  AskDataContextGatewayResponse,
  AskDataConversationResult,
  GatewayKnowledgeSource,
} from "@icecore/airi-runtime/ai-gateway";
import type { SerializedAiriChatMessage } from "./types";

export type CustomerMessageExcerptLike = {
  direction?: string | null;
  text?: string | null;
  date?: Date | string | null;
  channel?: string | null;
  origin?: {
    kind?: string | null;
  } | null;
};

export function buildSelectedSourceResources(
  selectedSources: AiriChatSourceRef[]
): AiriChatRunResource[] {
  return selectedSources.map(source => {
    const id =
      source.kind === "context"
        ? `selected:${source.optionId}`
        : source.kind === "context_item"
          ? `selected:${source.optionId}:${source.itemId}`
          : source.kind === "channel_source" ||
              source.kind === "workspace_source"
            ? `selected:${source.sourceId}`
            : source.kind === "connector"
              ? `selected:${source.connector}:${source.sourceId}`
              : source.kind === "skill"
                ? `selected:skill:${source.skillId}`
                : `selected:${source.threadId}`;
    return {
      id,
      label:
        source.kind === "connector"
          ? `WhatsApp connector: ${(source.capabilities || ["docs"]).join(", ")}`
          : `@${source.label}`,
      kind: source.kind === "connector" ? "connector" : "selected_source",
      status: "complete" as const,
    };
  });
}

export function buildRetrievedResources(params: {
  selectedSources: AiriChatSourceRef[];
  selectedSourceLabels: string[];
  conversationCount: number;
  kbCount: number;
  retrievalPath: string;
  retrievalEngine?: string | null;
  vectorIndex?: string | null;
  fallbackConversationCount?: number | null;
}): AiriChatRunResource[] {
  const resources = buildSelectedSourceResources(params.selectedSources);
  if (params.selectedSourceLabels.length > 0) {
    resources.push({
      id: "attached-sources",
      label: "Attached sources",
      kind: "selected_source",
      count: params.selectedSourceLabels.length,
      status: "complete",
    });
  }
  resources.push({
    id: "customer-chats",
    label: "Customer chats",
    kind: "customer_chat",
    count: params.conversationCount,
    status: "complete",
  });
  resources.push({
    id: "knowledge-base",
    label: "Knowledge base",
    kind: "knowledge_base",
    count: params.kbCount,
    status: "complete",
  });
  resources.push({
    id: "retrieval-engine",
    label:
      params.retrievalEngine === "vector_filter"
        ? "Atlas vector search"
        : params.retrievalEngine === "fallback_keyword_recent"
          ? "Keyword and recent chats"
          : params.retrievalEngine === "embedding_unavailable"
            ? "Recent chats fallback"
            : `Retrieval: ${params.retrievalPath}`,
    kind: "model",
    detail: params.vectorIndex || null,
    status: "complete",
  });
  if (params.fallbackConversationCount) {
    resources.push({
      id: "fallback-conversations",
      label: "Fallback chats",
      kind: "customer_chat",
      count: params.fallbackConversationCount,
      status: "complete",
    });
  }
  return resources;
}

export function buildThreadHistory(
  messages: SerializedAiriChatMessage[]
): string {
  return messages
    .slice(-12)
    .map(message => {
      const role =
        message.role === "assistant"
          ? "Airi"
          : message.role === "system"
            ? "System"
            : "User";
      return `${role}: ${message.content}`;
    })
    .join("\n");
}

export const AIRI_CAMPAIGN_EXCERPT_CONVERSATION_LIMIT = 5;
export const AIRI_CAMPAIGN_EXCERPT_MESSAGE_LIMIT = 5;
export const AIRI_CAMPAIGN_EXCERPT_TEXT_LIMIT = 420;

export function formatConversationContextLine(
  conversation: AskDataConversationResult,
  index: number
): string {
  const date = conversation.createdAt
    ? ` Last activity: ${conversation.createdAt}.`
    : "";
  return `${formatAiriChatConversationContextLine(conversation, index)}${date}`;
}

export function redactMessageExcerptText(value: unknown): string {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .slice(0, AIRI_CAMPAIGN_EXCERPT_TEXT_LIMIT);
}

export function formatMessageExcerpt(
  message: CustomerMessageExcerptLike
): string | null {
  const text = redactMessageExcerptText(message.text);
  if (!text) return null;
  const direction = message.direction === "outbound" ? "manager" : "customer";
  const date =
    message.date instanceof Date
      ? message.date.toISOString()
      : typeof message.date === "string"
        ? message.date
        : null;
  const datePrefix = date ? `${date} ` : "";
  return `- ${datePrefix}${direction}: ${text}`;
}

export async function fetchConversationMessageExcerpts(params: {
  workspaceId: string;
  conversationId: string;
}): Promise<string[]> {
  const messages = (await Message.find({
    workspaceId: params.workspaceId,
    conversation: params.conversationId,
  })
    .sort({ date: -1 })
    .limit(AIRI_CAMPAIGN_EXCERPT_MESSAGE_LIMIT)
    .select("direction text date channel origin.kind")
    .lean()) as CustomerMessageExcerptLike[];

  return messages
    .reverse()
    .map(formatMessageExcerpt)
    .filter((line): line is string => Boolean(line));
}

export async function buildAiriChatConversationContext(params: {
  workspaceId: string;
  conversations: AskDataConversationResult[];
  includeMessageExcerpts: boolean;
}): Promise<string> {
  if (params.conversations.length === 0) return "";
  const baseLines = params.conversations.map(formatConversationContextLine);

  if (!params.includeMessageExcerpts) {
    return baseLines.join("\n\n");
  }

  const conversationIds = params.conversations
    .map(conversation => conversation.id?.trim())
    .filter((id): id is string => Boolean(id))
    .slice(0, AIRI_CAMPAIGN_EXCERPT_CONVERSATION_LIMIT);
  const excerptsById = new Map(
    await Promise.all(
      conversationIds.map(async id => {
        const excerpts = await fetchConversationMessageExcerpts({
          workspaceId: params.workspaceId,
          conversationId: id,
        }).catch(() => []);
        return [id, excerpts] as const;
      })
    )
  );

  return params.conversations
    .map((conversation, index) => {
      const base =
        baseLines[index] ?? formatConversationContextLine(conversation, index);
      const excerpts = conversation.id
        ? (excerptsById.get(conversation.id) ?? [])
        : [];
      if (excerpts.length === 0) return base;
      return [
        base,
        "Recent customer-message excerpts for planning:",
        excerpts.join("\n"),
      ].join("\n");
    })
    .join("\n\n");
}

export function buildAttachedSourceContextText(
  selectedContext: AiriChatSelectedGroundingContext
): string {
  if (selectedContext.promptSections.length === 0) {
    return [
      "The user attached these sources:",
      selectedContext.selectedSourceLabels
        .map(label => `- ${label}`)
        .join("\n"),
      "",
      "No additional excerpts were found for those attached sources.",
    ].join("\n");
  }

  return [
    "The user attached these sources:",
    selectedContext.selectedSourceLabels.map(label => `- ${label}`).join("\n"),
    "",
    "Use these attached source notes as additional context. Workspace context below is still available:",
    selectedContext.promptSections.join("\n\n"),
  ].join("\n");
}

export function normalizeAiriChatAttachments(
  attachments: AiriChatAttachmentInput[] | null | undefined
): AiriChatAttachmentInput[] {
  if (!Array.isArray(attachments)) return [];

  const normalized: AiriChatAttachmentInput[] = [];
  for (const attachment of attachments) {
    const name = attachment.name.trim();
    if (!name) continue;

    normalized.push({
      name,
      type: attachment.type?.trim() || undefined,
      size: attachment.size,
      lastModified: attachment.lastModified,
      textExcerpt: attachment.textExcerpt?.trim() || undefined,
      truncated: attachment.truncated || undefined,
      creativeAssetId: attachment.creativeAssetId?.trim() || undefined,
    });
    if (normalized.length === 8) break;
  }

  return normalized;
}

export function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildAttachedFileContextText(
  attachments: AiriChatAttachmentInput[]
): string {
  return buildAttachedFilePromptSections(attachments).join("\n\n");
}

export function buildAttachedFilePromptSections(
  attachments: AiriChatAttachmentInput[]
): string[] {
  if (attachments.length === 0) return ["No files attached."];
  return attachments.map((attachment, index) => {
    const header = [
      `[File ${index + 1}] ${attachment.name.slice(0, 256)}`,
      attachment.type ? `type: ${attachment.type.slice(0, 128)}` : null,
      `size: ${formatAttachmentSize(attachment.size)}`,
      attachment.creativeAssetId
        ? `Creative Asset: ${attachment.creativeAssetId}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");
    if (!attachment.textExcerpt) {
      return `${header}\nNo text excerpt was extracted for this file.`;
    }
    return [
      header,
      attachment.truncated ? "Text excerpt (truncated):" : "Text excerpt:",
      attachment.textExcerpt,
    ].join("\n");
  });
}

export function buildUserMessageMetadata(params: {
  selectedSources: AiriChatSourceRef[];
  attachedFiles: AiriChatAttachmentInput[];
}): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  if (params.selectedSources.length > 0) {
    metadata.selectedSources = params.selectedSources;
  }
  if (params.attachedFiles.length > 0) {
    metadata.attachedFiles = params.attachedFiles;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function appendUniqueConversation(
  map: Map<string, AskDataConversationResult>,
  conversation: AskDataConversationResult
) {
  const id = String(conversation.id ?? "").trim();
  if (!id || map.has(id)) return;
  map.set(id, conversation);
}

export function appendUniqueKnowledge(
  map: Map<string, GatewayKnowledgeSource>,
  source: GatewayKnowledgeSource
) {
  const id = String(source.id ?? "").trim();
  if (!id || map.has(id)) return;
  map.set(id, source);
}

export function mergeAiriChatSearchResults(params: {
  workspaceResult: AskDataContextGatewayResponse;
  selectedContext: AiriChatSelectedGroundingContext | null;
}) {
  if (!params.selectedContext) {
    return params.workspaceResult;
  }

  const conversations = new Map<string, AskDataConversationResult>();
  const knowledge = new Map<string, GatewayKnowledgeSource>();

  params.selectedContext.conversations.forEach(conversation =>
    appendUniqueConversation(conversations, conversation)
  );
  params.workspaceResult.conversations.forEach(conversation =>
    appendUniqueConversation(conversations, conversation)
  );
  params.selectedContext.kbArticles.forEach(source =>
    appendUniqueKnowledge(knowledge, source)
  );
  params.workspaceResult.kbArticles.forEach(source =>
    appendUniqueKnowledge(knowledge, source)
  );

  return {
    ...params.workspaceResult,
    conversations: Array.from(conversations.values()),
    kbArticles: Array.from(knowledge.values()),
  } satisfies AskDataContextGatewayResponse;
}

export function mergeAiriChatSourceContext(params: {
  automatic: Pick<
    AiriChatReplyAnalytics,
    "sourceIds" | "conversationSourceIds" | "kbSourceIds" | "retrievalPath"
  >;
  selectedContext: AiriChatSelectedGroundingContext | null;
}) {
  if (!params.selectedContext) return params.automatic;
  const selected = params.selectedContext;
  const sourceIds = uniqueStrings([
    ...selected.sourceIds,
    ...params.automatic.sourceIds,
  ]);
  const conversationSourceIds = uniqueStrings([
    ...selected.conversationSourceIds,
    ...params.automatic.conversationSourceIds,
  ]);
  const kbSourceIds = uniqueStrings([
    ...selected.kbSourceIds,
    ...params.automatic.kbSourceIds,
  ]);
  return {
    ...params.automatic,
    sourceIds,
    conversationSourceIds,
    kbSourceIds,
    retrievalPath:
      selected.retrievalPath !== "none" &&
      params.automatic.retrievalPath !== "none"
        ? "blended"
        : selected.retrievalPath !== "none"
          ? selected.retrievalPath
          : params.automatic.retrievalPath,
  };
}

export function buildPendingWhatsAppActions(params: {
  workspaceId: string;
  intent: AiriChatIntentKind;
}): AiriChatPendingAction[] {
  const actions: AiriChatPendingAction[] = [];
  if (params.intent === "whatsapp_template") {
    actions.push({
      id: "whatsapp-template-draft",
      kind: "whatsapp_template_draft",
      label: "Review WhatsApp template",
      description:
        "Open the template builder and confirm before sending to Meta.",
      href: `/panel/w/${params.workspaceId}/messengers/whatsapp-templates`,
    });
  }
  if (params.intent === "whatsapp_flow") {
    actions.push({
      id: "whatsapp-flow-draft",
      kind: "whatsapp_flow_draft",
      label: "Review WhatsApp flow",
      description: "Open the flow builder and confirm before publishing.",
      href: `/panel/w/${params.workspaceId}/messengers/whatsapp-flows`,
    });
  }
  return actions;
}

export function buildMarketingToolAccessContext(
  access: AiriMarketingToolAccess
): string {
  return Object.entries(access)
    .map(([key, tool]) => {
      const status = tool.available ? "available" : "blocked";
      const source = tool.source ? ` via ${tool.source}` : "";
      const reason = tool.reason ? `; ${tool.reason}` : "";
      return `- ${key}: ${status}${source}${tool.sourceId ? ` (${tool.sourceId})` : ""}${reason}`;
    })
    .join("\n");
}
