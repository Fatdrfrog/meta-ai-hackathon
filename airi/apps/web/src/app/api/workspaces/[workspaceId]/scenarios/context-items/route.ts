import { isScenarioContextOptionId } from "@icecore/scenario-contracts";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import AnswerSnippet, {
  ensureAnswerSnippetIndexes,
} from "@/models/answer-snippet";
import { Conversation } from "@/models/conversation";
import { QuickReply } from "@/models/quick-reply";
import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";
import { readDate } from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";

type Params = Promise<{ workspaceId: string }>;

type ContextItem = {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  updatedAt?: string | null;
  question?: string;
  answer?: string;
};

function truncateText(value: string, max = 140) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function formatDate(value: string | Date | null | undefined) {
  return readDate(value)?.toISOString() ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const rawContextOptionId =
      request.nextUrl.searchParams.get("contextOptionId");

    if (!rawContextOptionId) return requiredFieldResponse("contextOptionId");

    if (!isScenarioContextOptionId(rawContextOptionId)) {
      return NextResponse.json(
        { error: "Unsupported context option" },
        { status: 400 }
      );
    }

    const contextOptionId = rawContextOptionId;

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { supabase } = access;

    const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);

    let items: ContextItem[] = [];

    if (contextOptionId === "knowledge_base_articles") {
      const { data, error } = await supabase
        .from("kb_articles")
        .select("id,title,updated_at,published_at,status")
        .eq("workspace_id", workspaceId)
        .eq("status", "published")
        .order("updated_at", { ascending: false })
        .limit(250);

      if (error) throw error;

      items = (data ?? []).map(item => ({
        id: String(item.id),
        label: item.title || `Article ${item.id}`,
        description: "Knowledge Base article",
        meta: item.status || "published",
        updatedAt: formatDate(item.updated_at || item.published_at),
      }));
    } else if (contextOptionId === "indexed_public_urls") {
      if (!companyId) {
        items = [];
      } else {
        const { data, error } = await supabase
          .from("kb_indexed_urls")
          .select(
            "id,url,title,description,index_status,last_indexed_at,created_at"
          )
          .eq("company_id", companyId)
          .neq("index_status", "failed")
          .order("created_at", { ascending: false })
          .limit(250);

        if (error) throw error;

        items = (data ?? []).map(item => ({
          id: String(item.id),
          label: item.title || item.url || `URL ${item.id}`,
          description: truncateText(item.description || item.url || ""),
          meta: item.index_status || "indexed",
          updatedAt: formatDate(item.last_indexed_at || item.created_at),
        }));
      }
    } else if (
      contextOptionId === "conversation_timeline" ||
      contextOptionId === "answer_snippets" ||
      contextOptionId === "quick_replies" ||
      contextOptionId === "customer_profile" ||
      contextOptionId === "purchase_history" ||
      contextOptionId === "active_subscriptions"
    ) {
      await connectDB();

      if (contextOptionId === "conversation_timeline") {
        const conversations = await Conversation.find({ workspaceId })
          .sort({ lastMessageAt: -1, updatedAt: -1 })
          .limit(250)
          .select(
            `_id chat channel classification.category history_summary lastMessageAt updatedAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
          )
          .lean();

        items = conversations.map(conversation => {
          const currentClassification = getCurrentConversationClassification<{
            category?: string;
          }>(conversation);
          const currentCategory = currentClassification?.category;
          const chatLabel =
            conversation.chat === null || conversation.chat === undefined
              ? String(conversation._id)
              : String(conversation.chat);
          return {
            id: String(conversation._id),
            label: `${conversation.channel || "unknown"}: ${chatLabel}`,
            description: truncateText(
              conversation.history_summary ||
                currentCategory ||
                "Conversation context"
            ),
            meta: currentCategory || "conversation",
            updatedAt: formatDate(
              conversation.lastMessageAt || conversation.updatedAt
            ),
          };
        });
      }

      if (contextOptionId === "answer_snippets") {
        await ensureAnswerSnippetIndexes();
        const snippets = await AnswerSnippet.find({ workspaceId })
          .sort({ updatedAt: -1 })
          .limit(250)
          .select("_id question answer category tags updatedAt")
          .lean();

        items = snippets.map(snippet => ({
          id: String(snippet._id),
          label: truncateText(snippet.question || "Snippet"),
          description: truncateText(snippet.answer || "", 180),
          meta: snippet.category || "snippet",
          updatedAt: formatDate(snippet.updatedAt),
          question: snippet.question || "",
          answer: snippet.answer || "",
        }));
      }

      if (contextOptionId === "quick_replies") {
        const quickReplies = await QuickReply.find({ workspaceId })
          .sort({ order: 1, createdAt: -1 })
          .limit(250)
          .select("_id text category channel updatedAt")
          .lean();

        items = quickReplies.map(reply => ({
          id: String(reply._id),
          label: truncateText(reply.text || "Quick reply", 140),
          description: `Category: ${reply.category || "other"}`,
          meta: reply.channel || "all channels",
          updatedAt: formatDate(reply.updatedAt),
        }));
      }

      if (contextOptionId === "customer_profile") {
        const profiles = await Conversation.find({ workspaceId })
          .sort({ lastMessageAt: -1, updatedAt: -1 })
          .limit(250)
          .select(
            `_id chat channel preferred_language classification.category internal_labels churn_risk_level lastMessageAt updatedAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
          )
          .lean();

        items = profiles.map(profile => {
          const currentClassification = getCurrentConversationClassification<{
            category?: string;
          }>(profile);
          const currentCategory = currentClassification?.category;
          const chatLabel =
            profile.chat === null || profile.chat === undefined
              ? String(profile._id)
              : String(profile.chat);
          const stageLabel = Array.isArray(profile.internal_labels)
            ? profile.internal_labels.find(label =>
                String(label).toLowerCase().startsWith("stage:")
              )
            : null;
          return {
            id: String(profile._id),
            label: `${profile.channel || "unknown"}: ${chatLabel}`,
            description: truncateText(
              `Lang: ${profile.preferred_language || "unknown"} | Stage: ${
                stageLabel || currentCategory || "unknown"
              }`
            ),
            meta: profile.churn_risk_level || currentCategory || "profile",
            updatedAt: formatDate(profile.lastMessageAt || profile.updatedAt),
          };
        });
      }

      if (contextOptionId === "purchase_history") {
        const purchaseProfiles = await Conversation.find({
          workspaceId,
          $or: [
            { estimated_customer_ltv: { $gt: 0 } },
            {
              revenue_attribution_id: {
                $exists: true,
                $nin: [null, ""],
              },
            },
          ],
        })
          .sort({ lastMessageAt: -1, updatedAt: -1 })
          .limit(250)
          .select(
            "_id chat channel estimated_customer_ltv revenue_attribution_id lastMessageAt updatedAt"
          )
          .lean();

        items = purchaseProfiles.map(profile => {
          const chatLabel =
            profile.chat === null || profile.chat === undefined
              ? String(profile._id)
              : String(profile.chat);
          const ltv =
            typeof profile.estimated_customer_ltv === "number"
              ? profile.estimated_customer_ltv
              : null;
          const revenueId =
            typeof profile.revenue_attribution_id === "string"
              ? profile.revenue_attribution_id
              : null;
          return {
            id: String(profile._id),
            label: `${profile.channel || "unknown"}: ${chatLabel}`,
            description: truncateText(
              `LTV: ${ltv !== null ? ltv : "unknown"} | Revenue ID: ${
                revenueId || "none"
              }`
            ),
            meta: "purchase_history",
            updatedAt: formatDate(profile.lastMessageAt || profile.updatedAt),
          };
        });
      }

      if (contextOptionId === "active_subscriptions") {
        const subscriptionProfiles = await Conversation.find({
          workspaceId,
          $or: [
            {
              internal_labels: {
                $in: ["stage:active", "subscription:active"],
              },
            },
            {
              $and: [
                { "classification.category": "active" },
                buildCurrentConversationClassificationFilter(),
              ],
            },
          ],
        })
          .sort({ lastMessageAt: -1, updatedAt: -1 })
          .limit(250)
          .select(
            `_id chat channel internal_labels classification.category lastMessageAt updatedAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
          )
          .lean();

        items = subscriptionProfiles.map(profile => {
          const currentClassification = getCurrentConversationClassification<{
            category?: string;
          }>(profile);
          const currentCategory = currentClassification?.category;
          const chatLabel =
            profile.chat === null || profile.chat === undefined
              ? String(profile._id)
              : String(profile.chat);
          const stageLabel = Array.isArray(profile.internal_labels)
            ? profile.internal_labels.find(label =>
                String(label).toLowerCase().startsWith("stage:")
              )
            : null;
          return {
            id: String(profile._id),
            label: `${profile.channel || "unknown"}: ${chatLabel}`,
            description: truncateText(
              `Subscription stage: ${stageLabel || currentCategory || "active"}`
            ),
            meta: "active_subscription",
            updatedAt: formatDate(profile.lastMessageAt || profile.updatedAt),
          };
        });
      }
    } else {
      return NextResponse.json(
        { error: "Unsupported context option" },
        { status: 400 }
      );
    }

    return NextResponse.json({ items });
  } catch (error) {
    console.error("[Scenario Context Items API] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load context items" },
      { status: 500 }
    );
  }
}
