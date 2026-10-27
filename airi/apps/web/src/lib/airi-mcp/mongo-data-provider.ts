import "server-only";

import {
  applyCustomerConversationVisibility,
  buildCustomerAnalyticsCategoryPipeline,
  buildCustomerAnalyticsChannelPipeline,
  buildCustomerAnalyticsStatusPipeline,
  CUSTOMER_ANALYTICS_CATEGORY_LIMIT,
} from "@/lib/customer-api/conversation-reads";
import { loadConversationContactBundles } from "@/lib/customers/conversation-bundles";
import {
  getCompanyConversationVisibilityGate,
  type CompanyConversationVisibilityGate,
} from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { listWorkspaceScenarioSummaries } from "@/lib/scenarios/list-workspace-scenario-summaries";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT } from "@icecore/shared/lib/conversation-classification-freshness";
import { readNonNegativeCount } from "@icecore/shared/lib/value-utils";
import type {
  AiriMcpAnalyticsWindowCounts,
  AiriMcpChatRecord,
  AiriMcpConversationBundle,
  AiriMcpConversationRecord,
  AiriMcpCountRow,
  AiriMcpDataProvider,
  AiriMcpUserRecord,
  AiriMcpVisibility,
} from "./types";

/** Per-query server-side limit, well inside the route's 30 s budget. */
export const AIRI_MCP_QUERY_MAX_TIME_MS = 5_000;

/**
 * Like GET /api/v1/conversations but without `user`/`chat` ids in the output
 * shape: the provider resolves them to names and the tool masks the phone.
 */
export const AIRI_MCP_CONVERSATION_SELECT = [
  "_id status channel createdAt updatedAt lastMessageAt user chat",
  "rename subject campaign_recipient_name internal_labels",
  "classification.category classification.summary classification.tags",
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
].join(" ");

/** No email: the MCP never returns it. */
const USER_SELECT = "_id firstName lastName username whatsapp";
const CHAT_SELECT = "_id title first_name last_name username whatsapp";

const TEMPLATE_SELECT =
  "name language status category quality_rating rejected_reason components lastSyncedAt";

/**
 * Every capped plan (free included) gets an id list even when nothing is
 * hidden, so "limited" follows the panel's plan-gate notice instead: a
 * reason or a hidden count. The gate itself is applied to reads either way.
 */
function toVisibility(
  gate: CompanyConversationVisibilityGate
): AiriMcpVisibility {
  const hiddenConversationCount = readNonNegativeCount(
    gate.hiddenConversationCount
  );
  return {
    limited: gate.reason !== null || hiddenConversationCount > 0,
    hiddenConversationCount,
    reason: gate.reason,
  };
}

function readCountRows<K extends string>(
  rows: unknown,
  key: K
): AiriMcpCountRow<K>[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    const record = (row ?? {}) as Record<string, unknown>;
    const value = record[key];
    return {
      [key]: value === null || value === undefined ? null : String(value),
      count: readNonNegativeCount(record.count),
    } as AiriMcpCountRow<K>;
  });
}

async function readAnalyticsWindow(
  match: Record<string, unknown>
): Promise<AiriMcpAnalyticsWindowCounts> {
  const maxTimeMS = AIRI_MCP_QUERY_MAX_TIME_MS;
  const [total, byStatus, byChannel, byCategory] = await Promise.all([
    Conversation.countDocuments(match).maxTimeMS(maxTimeMS),
    Conversation.aggregate(buildCustomerAnalyticsStatusPipeline(match)).option({
      maxTimeMS,
    }),
    Conversation.aggregate(buildCustomerAnalyticsChannelPipeline(match)).option(
      { maxTimeMS }
    ),
    // One extra row tells whether the v1 top-20 list was cut.
    Conversation.aggregate(
      buildCustomerAnalyticsCategoryPipeline(
        match,
        CUSTOMER_ANALYTICS_CATEGORY_LIMIT + 1
      )
    ).option({ maxTimeMS }),
  ]);
  const categories = readCountRows(byCategory, "category");
  return {
    total: readNonNegativeCount(total),
    byStatus: readCountRows(byStatus, "status"),
    byChannel: readCountRows(byChannel, "channel"),
    byCategory: categories.slice(0, CUSTOMER_ANALYTICS_CATEGORY_LIMIT),
    categoriesTruncated: categories.length > CUSTOMER_ANALYTICS_CATEGORY_LIMIT,
  };
}

/** The customers service loader, without email and time-limited. */
function loadContactProfiles(
  conversations: AiriMcpConversationRecord[]
): Promise<AiriMcpConversationBundle[]> {
  return loadConversationContactBundles<
    AiriMcpConversationRecord,
    AiriMcpUserRecord,
    AiriMcpChatRecord
  >(conversations, {
    userSelect: USER_SELECT,
    chatSelect: CHAT_SELECT,
    maxTimeMS: AIRI_MCP_QUERY_MAX_TIME_MS,
  });
}

/**
 * Reads behind the Airi MCP tools: Mongo (and the cached plan gate) only.
 * Conversation reads apply the same company visibility gate as the v1 API.
 */
export function createAiriMcpMongoDataProvider(): AiriMcpDataProvider {
  return {
    async getAnalyticsCounts({ workspaceId, currentStart, previousStart }) {
      await connectDB();
      const gate = await getCompanyConversationVisibilityGate(
        supabaseAdmin,
        workspaceId
      );
      const [current, previous] = await Promise.all([
        readAnalyticsWindow(
          applyCustomerConversationVisibility(
            { workspaceId, createdAt: { $gte: currentStart } },
            gate
          )
        ),
        readAnalyticsWindow(
          applyCustomerConversationVisibility(
            {
              workspaceId,
              createdAt: { $gte: previousStart, $lt: currentStart },
            },
            gate
          )
        ),
      ]);
      return { current, previous, visibility: toVisibility(gate) };
    },

    async listConversations({ workspaceId, limit, offset, status, channel }) {
      await connectDB();
      const gate = await getCompanyConversationVisibilityGate(
        supabaseAdmin,
        workspaceId
      );
      const filter = {
        ...applyCustomerConversationVisibility({ workspaceId }, gate),
        ...(status ? { status } : {}),
        ...(channel ? { channel } : {}),
      };
      const rows = await Conversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(offset)
        .limit(limit + 1)
        .select(AIRI_MCP_CONVERSATION_SELECT)
        .maxTimeMS(AIRI_MCP_QUERY_MAX_TIME_MS)
        .lean<AiriMcpConversationRecord[]>();
      const page = rows.slice(0, limit);
      return {
        rows: await loadContactProfiles(page),
        hasMore: rows.length > limit,
        visibility: toVisibility(gate),
      };
    },

    async listWhatsAppTemplates({ workspaceId, limit, status }) {
      await connectDB();
      // The stored snapshot only: tool calls never refresh from Meta.
      const rows = await WhatsAppTemplateModel.find({
        workspaceId,
        ...(status ? { status } : {}),
      })
        .sort({ name: 1, language: 1 })
        .limit(limit + 1)
        .select(TEMPLATE_SELECT)
        .maxTimeMS(AIRI_MCP_QUERY_MAX_TIME_MS)
        .lean();
      return {
        rows: (rows as Record<string, unknown>[]).slice(0, limit),
        hasMore: rows.length > limit,
      };
    },

    async listScenarios({ workspaceId, limit, status, cursor }) {
      const page = await listWorkspaceScenarioSummaries({
        workspaceId,
        mode: "all",
        status,
        limit,
        cursor,
        maxTimeMS: AIRI_MCP_QUERY_MAX_TIME_MS,
      });
      return {
        items: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      };
    },
  };
}
