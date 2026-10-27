import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";
import { getHeavyTextModel } from "@/lib/ai";
import {
  analyzeConversationContext,
  buildHeuristicTips,
  checkProfanity,
} from "@/lib/airi/coach/coach-utils";
import {
  buildCoachConversationWindow,
  buildCoachProfileContextBlock,
  COACH_CUSTOMER_SELECT,
  COACH_MESSAGE_SELECT,
  getCoachMessageContent,
  type CoachConversationProfile,
  type CoachConversationMessage,
  type CoachCustomerProfile,
} from "@/lib/airi/coach/conversation-window";
import { detectLanguage } from "@/lib/airi/language-detector-server";
import { buildQueryFromConversation } from "@/lib/airi/conversation";
import { simpleCoachEngine } from "@/lib/airi/engine";
import { retrieveHybridContext } from "@/lib/airi/rag/pipeline/hybrid-retrieval";
import { trackAiriSession } from "@/lib/analytics";
import { buildCacheKey, cache } from "@/lib/cache";
import { ensureCompanyCoachCapacity } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { getWorkspaceCompanyInfo } from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
import Message from "@/models/message";
import { QuickReply } from "@/models/quick-reply";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import type mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";

type QuickReplyContext = { text: string; category?: string; channel?: string };

function selectRelevantQuickReplies(
  replies: QuickReplyContext[],
  queryText: string,
  limit = 8
): QuickReplyContext[] {
  if (!replies || replies.length === 0) return [];
  const tokens = (queryText || "")
    .toLowerCase()
    .split(/\W+/)
    .filter(token => token.length > 3);

  const uniqueTokens = Array.from(new Set(tokens));
  if (uniqueTokens.length === 0) {
    return replies.slice(0, limit);
  }

  const scored = replies.map(reply => {
    const text = reply.text.toLowerCase();
    let score = 0;
    for (const token of uniqueTokens) {
      if (text.includes(token)) score += 1;
    }
    return { reply, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const filtered = scored
    .filter(item => item.score > 0)
    .slice(0, limit)
    .map(item => item.reply);
  const fallback = filtered.length > 0 ? filtered : replies.slice(0, limit);

  const seen = new Set<string>();
  return fallback.filter(reply => {
    const key = reply.text.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    const { conversationId, text } = (await request.json()) as {
      conversationId: string;
      text: string;
    };

    if (!conversationId || !text) {
      return new NextResponse(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
      });
    }

    if (text.trim().length < 3) {
      return new NextResponse(
        JSON.stringify({
          tips: [],
          suggestedEdit: "",
          skipped: true,
          reason: "Draft too short",
        }),
        { status: 200 }
      );
    }

    await connectDB();

    const [convo, lastMsgs] = await Promise.all([
      Conversation.findById(conversationId)
        .select(
          `channel workspaceId handled_by_agent_id preferred_language airi_coach_enabled airi_enabled customerId status classification internal_labels quick_note ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
        )
        .lean() as Promise<{
        _id: mongoose.Types.ObjectId;
        channel?: string;
        workspaceId?: string;
        preferred_language?: ConversationPreferredLanguage;
        airi_coach_enabled?: boolean;
        airi_enabled?: boolean;
        customerId?: mongoose.Types.ObjectId | string | null;
        status?: string | null;
        classification?: CoachConversationProfile["classification"];
        classification_meta?: {
          source_revision?: number | null;
          analysis_revision_id?: string | null;
        } | null;
        internal_labels?: string[] | null;
        quick_note?: string | null;
      } | null>,
      Message.find({ conversation: conversationId })
        .sort({ date: -1 })
        .limit(15)
        .select(COACH_MESSAGE_SELECT)
        .lean() as Promise<CoachConversationMessage[]>,
    ]);

    if (!convo) {
      return new NextResponse(
        JSON.stringify({ error: "Conversation not found" }),
        { status: 404 }
      );
    }

    const workspaceId = convo.workspaceId;
    if (!workspaceId)
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 }
      );
    const access = await resolveUserWorkspaceMembership(
      supabase,
      user.id,
      workspaceId
    );
    if (!access.ok)
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );

    const coachEnabled = convo.airi_coach_enabled ?? convo.airi_enabled ?? true;
    if (!coachEnabled) {
      return NextResponse.json({
        tips: [],
        suggestedEdit: "",
        skipped: true,
        reason: "Coaching disabled for this conversation",
      });
    }

    return await withWorkspaceTextAiAction(
      { workspaceId, actionId: `coach-draft:${randomUUID()}` },
      async () => {
        const coachCapacity = await ensureCompanyCoachCapacity(
          supabaseAdmin,
          workspaceId
        );
        if (!coachCapacity.allowed) {
          return NextResponse.json(
            {
              tips: [],
              suggestedEdit: "",
              skipped: true,
              reason: "Coach session limit reached",
            },
            { status: 200 }
          );
        }

        let customerContext: CoachCustomerProfile | null = null;
        const customerId = convo.customerId ? String(convo.customerId) : "";
        if (customerId) {
          try {
            customerContext = await Customer.findOne({
              _id: customerId,
              workspaceId,
              status: "active",
            })
              .select(COACH_CUSTOMER_SELECT)
              .lean<CoachCustomerProfile | null>();
          } catch {
            customerContext = null;
          }
        }

        const ordered = [...lastMsgs].reverse();
        const currentClassification =
          getCurrentConversationClassification<
            NonNullable<CoachConversationProfile["classification"]>
          >(convo);
        const profileContextBlock = buildCoachProfileContextBlock({
          conversation: {
            channel: convo.channel,
            status: convo.status,
            preferred_language: convo.preferred_language,
            classification: currentClassification,
            internal_labels: convo.internal_labels,
            quick_note: convo.quick_note,
          },
          customer: customerContext,
        });
        const conversationWindow = [
          profileContextBlock,
          buildCoachConversationWindow(ordered),
        ]
          .filter(Boolean)
          .join("\n\n");

        let lastCustomerMessage = "";
        for (let i = ordered.length - 1; i >= 0; i -= 1) {
          const msg = ordered[i];
          const content = msg ? getCoachMessageContent(msg) : "";
          if (msg?.direction !== "outbound" && content) {
            lastCustomerMessage = content;
            break;
          }
        }

        const lastMessageAt =
          ordered.length > 0 && ordered[ordered.length - 1]?.date
            ? new Date(ordered[ordered.length - 1]?.date as Date).toISOString()
            : "";
        const normalizedDraft = (text || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const cacheHash = Buffer.from(
          `${normalizedDraft}|${lastCustomerMessage}|${lastMessageAt}`
        )
          .toString("base64")
          .slice(0, 64);
        const classificationCacheIdentity =
          currentClassification === undefined
            ? "no-current-classification"
            : `current-classification:${Buffer.from(
                JSON.stringify([
                  convo.classification_meta?.source_revision,
                  convo.classification_meta?.analysis_revision_id,
                ])
              ).toString("base64url")}`;
        const cacheKey = buildCacheKey("airi:coach", [
          workspaceId,
          conversationId,
          cacheHash,
          classificationCacheIdentity,
        ]);

        try {
          const cached = await cache.get<unknown>(cacheKey);
          if (cached) {
            return NextResponse.json(cached, { status: 200 });
          }
        } catch {}

        const draftLanguage = await detectLanguage(text);

        const conversationLanguage = (
          convo as { preferred_language?: ConversationPreferredLanguage }
        ).preferred_language;

        let workspaceCompany: Awaited<
          ReturnType<typeof getWorkspaceCompanyInfo>
        > | null = null;
        let workspaceLanguage: ConversationPreferredLanguage | undefined =
          undefined;
        try {
          workspaceCompany = await getWorkspaceCompanyInfo(
            supabase,
            workspaceId
          );
          if (workspaceCompany?.airi_language) {
            workspaceLanguage =
              workspaceCompany.airi_language as ConversationPreferredLanguage;
          }
        } catch {}

        const preferredLanguage =
          conversationLanguage || draftLanguage || workspaceLanguage || "en";
        const tipsLanguage = workspaceLanguage || "en";
        const fallbackConversationContext =
          ordered.length > 0
            ? analyzeConversationContext(
                ordered.map(m => ({
                  text: getCoachMessageContent(m),
                  direction: m.direction || "inbound",
                  date: m.date ? new Date(m.date) : undefined,
                }))
              )
            : undefined;
        const heuristicFallbackTipsRaw = buildHeuristicTips(
          text,
          tipsLanguage,
          fallbackConversationContext,
          draftLanguage
        ).slice(0, 3);
        const heuristicFallbackTips =
          heuristicFallbackTipsRaw.length > 0
            ? heuristicFallbackTipsRaw
            : [
                {
                  title: "Clarify next steps",
                  suggestion:
                    "Acknowledge the issue and share a concrete next step with timing.",
                  type: "clarity" as const,
                  confidence: 0.55,
                  reasoning:
                    "Fallback coaching when model output is unavailable.",
                },
              ];

        const { query: ragQuery, context: ragContext } =
          buildQueryFromConversation(
            conversationWindow,
            lastCustomerMessage || text
          );
        const ragLanguage = await detectLanguage(lastCustomerMessage || text);

        let hybridContext: Awaited<
          ReturnType<typeof retrieveHybridContext>
        > | null = null;
        try {
          hybridContext = await retrieveHybridContext(
            workspaceId,
            ragQuery,
            ragLanguage,
            {
              includeSnippets: true,
              includeKB: true,
              includeConversationSummaries: false,
              kbLimit: 3,
              kbThreshold: 0.82,
              snippetThreshold: 0.82,
              conversationContext: ragContext || conversationWindow,
            }
          );
        } catch {}

        let quickReplies: QuickReplyContext[] = [];
        try {
          const filter: Record<string, unknown> = { workspaceId };
          if (convo.channel) {
            filter.$or = [{ channel: convo.channel }, { channel: null }];
          }

          const replyDocs = await QuickReply.find(filter)
            .sort({ order: 1, createdAt: 1 })
            .limit(40)
            .select("text category channel")
            .lean();

          quickReplies = selectRelevantQuickReplies(
            replyDocs.map(doc => ({
              text: doc.text,
              category: doc.category,
              channel: doc.channel,
            })),
            `${lastCustomerMessage}\n${text}`.trim()
          );
        } catch {}

        const sessionStartTime = Date.now();
        let sessionId: string | null = null;

        try {
          const { data: sessionData } = await supabaseAdmin
            .from("airi_sessions")
            .insert({
              workspace_id: workspaceId,
              agent_id: user.id,
              conversation_id: conversationId,
              tip_count: 0,
              latency_ms: 0,
              skipped: false,
            })
            .select("id")
            .single();

          sessionId = sessionData?.id || null;
        } catch {
          // Session tracking must never block user-facing coaching.
          sessionId = null;
        }

        let result;
        let sessionLatency = 0;
        let tipCount = 0;
        let tokensUsed = 0;
        let estimatedCost = 0;

        try {
          result = await simpleCoachEngine.generate(text, {
            workspaceId,
            conversationId,
            conversationWindow,
            messages: ordered.map(m => ({
              text: getCoachMessageContent(m),
              direction: m.direction || "inbound",
              date: m.date ? new Date(m.date) : undefined,
            })),
            preferredLanguage,
            workspaceLanguage: workspaceLanguage || undefined,
            agentId: user.id,
            customerQuestion: lastCustomerMessage,
            knowledgeContext: {
              snippet: hybridContext?.snippet || null,
              kbArticles: hybridContext?.kbArticles || [],
              quickReplies,
            },
          });

          sessionLatency = Date.now() - sessionStartTime;
          tipCount = result.tips?.length || 0;
          tokensUsed = result.inference?.totalTokens || 0;
          estimatedCost = result.inference?.estimatedCostUsd || 0;

          if (sessionId && result.inference) {
            try {
              await supabaseAdmin
                .from("airi_sessions")
                .update({
                  tip_count: tipCount,
                  latency_ms: sessionLatency,
                  model_used: result.inference.model || getHeavyTextModel(),
                  prompt_tokens: result.inference.promptTokens || 0,
                  completion_tokens: result.inference.completionTokens || 0,
                  total_tokens: result.inference.totalTokens || 0,
                  estimated_cost_usd: estimatedCost,
                  skipped: false,
                })
                .eq("id", sessionId);
            } catch {}
          }

          try {
            if (workspaceCompany?.company_id) {
              trackAiriSession(
                workspaceCompany.company_id,
                workspaceId,
                user.id,
                tipCount,
                sessionLatency,
                result.inference?.model || getHeavyTextModel(),
                tokensUsed,
                estimatedCost,
                false
              );
            }
          } catch {}
        } catch (error) {
          if (isWorkspaceAiPolicyError(error)) throw error;
          if (sessionId) {
            try {
              await supabaseAdmin
                .from("airi_sessions")
                .update({
                  tip_count: 0,
                  latency_ms: Date.now() - sessionStartTime,
                  skipped: true,
                })
                .eq("id", sessionId);
            } catch {}
          }

          try {
            if (workspaceCompany?.company_id) {
              trackAiriSession(
                workspaceCompany.company_id,
                workspaceId,
                user.id,
                0,
                Date.now() - sessionStartTime,
                getHeavyTextModel(),
                0,
                0,
                true
              );
            }
          } catch {}

          return NextResponse.json(
            {
              suggestionId: `coach-fallback-${Date.now()}`,
              messageId: "draft",
              tips: heuristicFallbackTips,
              suggestedEdit: "",
              suggestedEditInCustomerLanguage: "",
              skipped: true,
              reason: "LLM unavailable - heuristic fallback",
              languages: {
                customer: preferredLanguage,
                manager: tipsLanguage,
              },
            },
            { status: 200 }
          );
        }

        const lang = await detectLanguage(text || "");
        const riskCalc = checkProfanity(lang, text || "");

        const payload = {
          suggestionId: `coach-${Date.now()}`,
          messageId: "draft",
          tips: result.tips || [],
          suggestedEdit: result.suggestedEdit || "",
          suggestedEditInCustomerLanguage:
            result.suggestedEditInCustomerLanguage ||
            result.suggestedEdit ||
            "",
          sources: {
            snippet: hybridContext?.snippet
              ? {
                  question: hybridContext.snippet.question,
                  score: hybridContext.snippet.score,
                }
              : undefined,
            kbArticles: (hybridContext?.kbArticles || [])
              .slice(0, 2)
              .map(a => ({
                id: a.id,
                title: a.title,
                similarity: a.similarity,
                url: a.url,
              })),
            quickReplies: quickReplies.slice(0, 5).map(reply => ({
              text: reply.text,
              category: reply.category,
              channel: reply.channel,
            })),
          },
          risk: {
            maxSeverity: riskCalc.maxSeverity,
            categories: riskCalc.categories,
          },
          inference: result.inference,
          languages: {
            customer: preferredLanguage,
            manager: tipsLanguage,
          },
        };

        try {
          await cache.set(cacheKey, payload, 45);
        } catch {}

        return NextResponse.json(payload, { status: 200 });
      }
    );
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    return NextResponse.json(
      {
        tips: [],
        suggestedEdit: "",
        skipped: true,
        reason: "Coaching temporarily unavailable",
      },
      { status: 200 }
    );
  }
}
