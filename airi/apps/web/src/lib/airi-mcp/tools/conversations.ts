import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { CUSTOMER_CONVERSATION_MAX_OFFSET } from "@/lib/customer-api/conversation-reads";
import { getConversationDisplayName, toStringId } from "@/lib/customers/shared";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import { readDate } from "@icecore/shared/lib/value-utils";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  CONVERSATION_STATUSES,
  isConversationStatus,
} from "@icecore/shared/types/conversation";
import {
  CONVERSATION_CHANNELS,
  isConversationChannel,
} from "@icecore/shared/types/sources";
import { z } from "zod";
import {
  boundedText,
  boundedTextList,
  maskConversationPhone,
  maskPhoneDigits,
} from "../redaction";
import type { AiriMcpAuthContext, AiriMcpConversationBundle } from "../types";
import {
  describeVisibilityCoverage,
  VISIBILITY_COVERAGE_PROPERTIES,
} from "./coverage";
import {
  arraySchema,
  BOOLEAN_SCHEMA,
  COUNT_SCHEMA,
  defineAiriMcpTool,
  enumSchema,
  NULLABLE_DATE_TIME_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  objectSchema,
  STRING_SCHEMA,
  UNTRUSTED_CONTENT_NOTICE,
} from "./define";

export const CONVERSATIONS_MAX_LIMIT = 50;
const CONVERSATIONS_DEFAULT_LIMIT = 20;
const MAX_PAGE = CUSTOMER_CONVERSATION_MAX_OFFSET + 1;

const DISPLAY_NAME_MAX_LENGTH = 120;
const TITLE_MAX_LENGTH = 200;
const SUMMARY_MAX_LENGTH = 600;
const CATEGORY_MAX_LENGTH = 120;
const LIST_MAX_ITEMS = 10;
const LIST_ITEM_MAX_LENGTH = 60;

export const listConversationsArgs = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(CONVERSATIONS_MAX_LIMIT)
      .default(CONVERSATIONS_DEFAULT_LIMIT),
    page: z.number().int().min(1).max(MAX_PAGE).default(1),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    channel: z.enum(CONVERSATION_CHANNELS).optional(),
  })
  .strict()
  .refine(
    args => (args.page - 1) * args.limit <= CUSTOMER_CONVERSATION_MAX_OFFSET,
    {
      message: `Pages may not start beyond the first ${CUSTOMER_CONVERSATION_MAX_OFFSET} conversations; narrow the status or channel filter.`,
      path: ["page"],
    }
  );

type CurrentClassification = {
  category?: unknown;
  summary?: unknown;
  tags?: unknown;
};

function isoOrNull(value: unknown): string | null {
  return readDate(value)?.toISOString() ?? null;
}

/** Profile names are sometimes a bare phone number; never echo it whole. */
function phoneSafeName(name: string | null): string | null {
  if (!name) return null;
  const digits = normalizeWhatsAppPhone(name);
  return digits ? maskPhoneDigits(digits) : name;
}

function conversationPanelUrl(auth: AiriMcpAuthContext, id: string): string {
  const path = panelWorkspaceHref(auth.workspaceId, "requests");
  return `${auth.appOrigin}${path}?conversation=${encodeURIComponent(id)}`;
}

export function serializeConversation(
  bundle: AiriMcpConversationBundle,
  auth: AiriMcpAuthContext
) {
  const { conversation, user, chat } = bundle;
  const id = toStringId(conversation._id) ?? "";
  const classification =
    getCurrentConversationClassification<CurrentClassification>(conversation);
  const displayName =
    getConversationDisplayName({
      conversation: { rename: conversation.rename },
      user,
      chat,
    }) ??
    boundedText(conversation.campaign_recipient_name, DISPLAY_NAME_MAX_LENGTH);

  return {
    id,
    channel: isConversationChannel(conversation.channel)
      ? conversation.channel
      : null,
    status: isConversationStatus(conversation.status)
      ? conversation.status
      : null,
    created_at: isoOrNull(conversation.createdAt),
    updated_at: isoOrNull(conversation.updatedAt),
    last_message_at: isoOrNull(conversation.lastMessageAt),
    masked_phone: maskConversationPhone(bundle),
    panel_url: conversationPanelUrl(auth, id),
    classification_is_current: classification !== undefined,
    untrusted_customer_content: {
      display_name: phoneSafeName(
        boundedText(displayName, DISPLAY_NAME_MAX_LENGTH)
      ),
      title: boundedText(conversation.subject, TITLE_MAX_LENGTH),
      summary: boundedText(classification?.summary, SUMMARY_MAX_LENGTH),
      category: boundedText(classification?.category, CATEGORY_MAX_LENGTH),
      tags: boundedTextList(
        classification?.tags,
        LIST_MAX_ITEMS,
        LIST_ITEM_MAX_LENGTH
      ),
      labels: boundedTextList(
        conversation.internal_labels,
        LIST_MAX_ITEMS,
        LIST_ITEM_MAX_LENGTH
      ),
    },
  };
}

const conversationSchema = objectSchema({
  id: STRING_SCHEMA,
  channel: { type: ["string", "null"], enum: [...CONVERSATION_CHANNELS, null] },
  status: { type: ["string", "null"], enum: [...CONVERSATION_STATUSES, null] },
  created_at: NULLABLE_DATE_TIME_SCHEMA,
  updated_at: NULLABLE_DATE_TIME_SCHEMA,
  last_message_at: NULLABLE_DATE_TIME_SCHEMA,
  masked_phone: NULLABLE_STRING_SCHEMA,
  panel_url: STRING_SCHEMA,
  classification_is_current: BOOLEAN_SCHEMA,
  untrusted_customer_content: objectSchema({
    display_name: NULLABLE_STRING_SCHEMA,
    title: NULLABLE_STRING_SCHEMA,
    summary: NULLABLE_STRING_SCHEMA,
    category: NULLABLE_STRING_SCHEMA,
    tags: arraySchema(STRING_SCHEMA, LIST_MAX_ITEMS),
    labels: arraySchema(STRING_SCHEMA, LIST_MAX_ITEMS),
  }),
});

export const listConversationsTool = defineAiriMcpTool({
  name: "list_conversations",
  title: "List conversations",
  description: `Recent conversations in this workspace, newest activity first, with status, channel, timestamps, a masked phone number and a link to the conversation in the Airi panel. Customer names, subjects and AI summaries are returned under untrusted_customer_content. ${UNTRUSTED_CONTENT_NOTICE} Message bodies and media are never returned. Follows the company plan's visibility limits.`,
  scope: "conversations",
  inputSchema: objectSchema(
    {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: CONVERSATIONS_MAX_LIMIT,
        default: CONVERSATIONS_DEFAULT_LIMIT,
        description: "Conversations per page.",
      },
      page: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PAGE,
        default: 1,
        description: `1-based page. A page may not start beyond the first ${CUSTOMER_CONVERSATION_MAX_OFFSET} conversations.`,
      },
      status: enumSchema(CONVERSATION_STATUSES),
      channel: enumSchema(CONVERSATION_CHANNELS),
    },
    []
  ),
  outputSchema: objectSchema({
    page: COUNT_SCHEMA,
    limit: COUNT_SCHEMA,
    returned: COUNT_SCHEMA,
    has_more: BOOLEAN_SCHEMA,
    /** More rows exist, but the next page would start past the depth limit. */
    truncated: BOOLEAN_SCHEMA,
    filters: objectSchema({
      status: NULLABLE_STRING_SCHEMA,
      channel: NULLABLE_STRING_SCHEMA,
    }),
    coverage: objectSchema(VISIBILITY_COVERAGE_PROPERTIES),
    conversations: arraySchema(conversationSchema, CONVERSATIONS_MAX_LIMIT),
  }),
  args: listConversationsArgs,
  async run({ limit, page, status, channel }, { auth, data }) {
    const result = await data.listConversations({
      workspaceId: auth.workspaceId,
      limit,
      offset: (page - 1) * limit,
      status,
      channel,
    });
    const conversations = result.rows
      .slice(0, limit)
      .map(row => serializeConversation(row, auth));
    // has_more only promises a page the arguments schema accepts.
    const nextPageAllowed = page * limit <= CUSTOMER_CONVERSATION_MAX_OFFSET;
    const hasMore = result.hasMore && nextPageAllowed;
    const truncated = result.hasMore && !nextPageAllowed;
    const more = hasMore
      ? " More are available on the next page."
      : truncated
        ? ` More exist beyond the first ${CUSTOMER_CONVERSATION_MAX_OFFSET} conversations that paging can reach; narrow the status or channel filter to see them.`
        : "";

    return {
      summary: `Returned ${conversations.length} conversation(s) on page ${page}.${more}`,
      structured: {
        page,
        limit,
        returned: conversations.length,
        has_more: hasMore,
        truncated,
        filters: { status: status ?? null, channel: channel ?? null },
        coverage: describeVisibilityCoverage(result.visibility),
        conversations,
      },
      itemCount: conversations.length,
    };
  },
});
