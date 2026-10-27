import type { ScenarioContextOptionId } from "@icecore/scenario-contracts";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { getWorkspaceCompanyInfo } from "@/lib/supabase/company-users";
import AnswerSnippet from "@/models/answer-snippet";
import { Conversation } from "@/models/conversation";
import { QuickReply } from "@/models/quick-reply";
import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type Params = Promise<{ workspaceId: string }>;

type ContextOption = {
  id: ScenarioContextOptionId;
  title: string;
  description: string;
  source: string;
  count: number;
  available: boolean;
};

type MongoCounts = {
  conversationCount: number;
  snippetCount: number;
  quickReplyCount: number;
  purchaseHistoryCount: number;
  activeSubscriptionCount: number;
};

async function getMongoCounts(workspaceId: string): Promise<MongoCounts> {
  try {
    await connectDB();
    const [
      conversationCount,
      snippetCount,
      quickReplyCount,
      purchaseHistoryCount,
      activeSubscriptionCount,
    ] = await Promise.all([
      Conversation.countDocuments({ workspaceId }),
      AnswerSnippet.countDocuments({ workspaceId }),
      QuickReply.countDocuments({ workspaceId }),
      Conversation.countDocuments({
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
      }),
      Conversation.countDocuments({
        workspaceId,
        $or: [
          { internal_labels: { $in: ["stage:active", "subscription:active"] } },
          {
            $and: [
              { "classification.category": "active" },
              buildCurrentConversationClassificationFilter(),
            ],
          },
        ],
      }),
    ]);

    return {
      conversationCount,
      snippetCount,
      quickReplyCount,
      purchaseHistoryCount,
      activeSubscriptionCount,
    };
  } catch (error) {
    console.error("[Scenario Context API] Mongo counts failed:", error);
    return {
      conversationCount: 0,
      snippetCount: 0,
      quickReplyCount: 0,
      purchaseHistoryCount: 0,
      activeSubscriptionCount: 0,
    };
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { supabase } = access;
    const workspaceCompany = await getWorkspaceCompanyInfo(
      supabase,
      workspaceId
    );

    const [kbArticlesResult, mongoCounts] = await Promise.all([
      supabase
        .from("kb_articles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "published"),
      getMongoCounts(workspaceId),
    ]);

    let indexedUrlCount = 0;
    if (workspaceCompany?.company_id) {
      const { count, error: indexedUrlsError } = await supabase
        .from("kb_indexed_urls")
        .select("id", { count: "exact", head: true })
        .eq("company_id", workspaceCompany.company_id)
        .neq("index_status", "failed");

      if (indexedUrlsError) {
        throw indexedUrlsError;
      }

      indexedUrlCount = count ?? 0;
    }

    const publishedKbCount = kbArticlesResult.count ?? 0;

    const contextOptions: ContextOption[] = [
      {
        id: "conversation_timeline",
        title: "Chat & Customer Info",
        description:
          "Recent messages and customer profile (stage, labels, language) from the conversation.",
        source: "Chats",
        count: mongoCounts.conversationCount,
        available: mongoCounts.conversationCount > 0,
      },
      {
        id: "knowledge_base_articles",
        title: "Knowledge Base Articles",
        description:
          "Published KB articles indexed for retrieval-augmented responses.",
        source: "Knowledge Base",
        count: publishedKbCount,
        available: publishedKbCount > 0,
      },
      {
        id: "indexed_public_urls",
        title: "Indexed Public URLs",
        description:
          "External pages indexed via AI context settings and URL indexer.",
        source: "Knowledge Base",
        count: indexedUrlCount,
        available: indexedUrlCount > 0,
      },
      {
        id: "answer_snippets",
        title: "Q&A Answer Snippets",
        description:
          "Structured answer snippets used by Airi for recurring questions.",
        source: "AI Context",
        count: mongoCounts.snippetCount,
        available: mongoCounts.snippetCount > 0,
      },
      {
        id: "quick_replies",
        title: "Quick Replies",
        description:
          "Reusable canned replies for consistent messaging and faster handling.",
        source: "AI Context",
        count: mongoCounts.quickReplyCount,
        available: mongoCounts.quickReplyCount > 0,
      },
      {
        id: "purchase_history",
        title: "Purchase History",
        description:
          "Recent conversion and value signals for this customer (LTV and attribution data).",
        source: "CRM",
        count: mongoCounts.purchaseHistoryCount,
        available: mongoCounts.purchaseHistoryCount > 0,
      },
      {
        id: "active_subscriptions",
        title: "Active Subscriptions",
        description:
          "Subscription-stage signals to help retention and renewal conversations.",
        source: "CRM",
        count: mongoCounts.activeSubscriptionCount,
        available: mongoCounts.activeSubscriptionCount > 0,
      },
    ];

    return NextResponse.json({
      options: contextOptions,
      stats: {
        airiLanguage: workspaceCompany?.airi_language ?? "en",
        conversationCount: mongoCounts.conversationCount,
        kbArticlesCount: publishedKbCount,
        indexedUrlCount,
        answerSnippetCount: mongoCounts.snippetCount,
        quickReplyCount: mongoCounts.quickReplyCount,
        purchaseHistoryCount: mongoCounts.purchaseHistoryCount,
        activeSubscriptionCount: mongoCounts.activeSubscriptionCount,
      },
    });
  } catch (error) {
    console.error("[Scenario Context API] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load scenario context options" },
      { status: 500 }
    );
  }
}
