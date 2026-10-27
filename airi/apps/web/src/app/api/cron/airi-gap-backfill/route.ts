import { detectLanguage } from "@/lib/airi/language-detector-server";
import { selectBestContext } from "@/lib/airi/rag/decision/decision-engine";
import {
  detectFactualIntent,
  evaluateFactualGroundingGuard,
} from "@/lib/airi/grounding/factual-grounding-guard";
import { retrieveHybridContext } from "@/lib/airi/rag/pipeline/hybrid-retrieval";
import { createNeutralRetrievalIntent } from "@/lib/airi/rag/query/retrieval-intent-classifier";
import { trackMissingKnowledgeGap } from "@/lib/airi/rag/knowledge/knowledge-gap-tracker";
import { verifyCronAuth } from "@/lib/cron-auth";
import connectDB from "@/lib/mongoose";
import Message from "@/models/message";
import type { Channel } from "@/types/models";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function clampInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeChannel(value: unknown): Channel {
  const channel = String(value || "").trim();
  if (
    channel === "telegram" ||
    channel === "whatsapp" ||
    channel === "email" ||
    channel === "instagram" ||
    channel === "web_widget"
  ) {
    return channel;
  }
  return "web_widget";
}

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const workspaceId = (searchParams.get("workspaceId") || "").trim();
    const days = clampInteger(searchParams.get("days"), 30, 1, 90);
    const limit = clampInteger(searchParams.get("limit"), 200, 1, 1000);
    const strategy = (searchParams.get("strategy") || "deep")
      .trim()
      .toLowerCase();
    const deepMode = strategy !== "light";

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    await connectDB();

    const messageFilter: Record<string, unknown> = {
      direction: "inbound",
      date: { $gte: since },
      text: { $type: "string", $ne: "" },
    };
    if (workspaceId) {
      messageFilter.workspaceId = workspaceId;
    }

    const messages = await Message.find(messageFilter)
      .select("_id workspaceId conversation channel text date")
      .sort({ date: -1 })
      .limit(limit)
      .lean<
        Array<{
          _id?: unknown;
          workspaceId?: string;
          conversation?: unknown;
          channel?: string;
          text?: string;
          date?: Date;
        }>
      >();

    let scanned = 0;
    let factualIntentsDetected = 0;
    let blockedAsGaps = 0;
    let persistedGapEvents = 0;
    let skippedNoWorkspace = 0;
    let skippedNoConversation = 0;
    let skippedFailedWorkspace = 0;
    let ctaTriggered = 0;
    // One workspace's failure (e.g. its AI allowance is used up) skips only
    // that workspace's messages instead of failing the whole run.
    const failedWorkspaceIds = new Set<string>();

    const guardCache = new Map<
      string,
      {
        shouldBlock: boolean;
        reason: string;
        priority: string;
      }
    >();

    for (const message of messages) {
      scanned += 1;
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const eventWorkspaceId = String(message.workspaceId || "").trim();
      const conversationId = String(message.conversation || "").trim();
      const messageId = String(message._id || "").trim();

      if (!eventWorkspaceId) {
        skippedNoWorkspace += 1;
        continue;
      }
      if (!conversationId || !messageId) {
        skippedNoConversation += 1;
        continue;
      }
      if (!text) continue;
      if (failedWorkspaceIds.has(eventWorkspaceId)) {
        skippedFailedWorkspace += 1;
        continue;
      }

      const factualIntent = detectFactualIntent(text);
      if (!factualIntent) continue;

      factualIntentsDetected += 1;

      try {
        const cacheKey = `${eventWorkspaceId}:${factualIntent}:${text.toLowerCase()}`;
        let guardSummary = guardCache.get(cacheKey);

        if (!guardSummary) {
          if (deepMode) {
            const detectedLanguage = await detectLanguage(text || "");
            const hybridContext = await retrieveHybridContext(
              eventWorkspaceId,
              text,
              detectedLanguage,
              {
                includeConversationSummaries: false,
                kbLimit: 2,
                kbThreshold: 0.82,
                snippetThreshold: 0.82,
                enableReranking: false,
                enableVerification: false,
                enableHyDE: false,
                enableTranslation: false,
                // Historical gap discovery is infrastructure, not a new customer AI action.
                retrievalIntent: createNeutralRetrievalIntent({
                  query: text,
                  language: detectedLanguage,
                }),
                skipLlmRetrievalPlanner: true,
              }
            );
            const decision = selectBestContext(hybridContext);
            const snippet = hybridContext.snippet;
            const guard = evaluateFactualGroundingGuard({
              query: text,
              decision,
              channel: normalizeChannel(message.channel),
              snippet,
              kbArticles: hybridContext.kbArticles,
            });

            guardSummary = {
              shouldBlock: guard.shouldBlock,
              reason: guard.reason,
              priority: decision.priority,
            };
          } else {
            guardSummary = {
              shouldBlock: true,
              reason: "prelaunch_backfill_light_mode_assumed_gap",
              priority: "generic",
            };
          }
          guardCache.set(cacheKey, guardSummary);
        }

        if (!guardSummary.shouldBlock) continue;

        blockedAsGaps += 1;

        const tracked = await trackMissingKnowledgeGap({
          workspaceId: eventWorkspaceId,
          conversationId,
          messageId,
          channel: normalizeChannel(message.channel),
          intent: factualIntent,
          query: text,
          reason: guardSummary.reason,
          source: "backfill",
          retrievalPriority: guardSummary.priority,
        });

        if (tracked.persisted) persistedGapEvents += 1;
        if (tracked.shouldPromptWorkspace) ctaTriggered += 1;
      } catch (error) {
        failedWorkspaceIds.add(eventWorkspaceId);
        skippedFailedWorkspace += 1;
        console.warn("[Cron] Airi gap backfill skipped a workspace", {
          workspaceId: eventWorkspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      workspaceId: workspaceId || null,
      strategy: deepMode ? "deep" : "light",
      scanned,
      factualIntentsDetected,
      blockedAsGaps,
      persistedGapEvents,
      skippedNoWorkspace,
      skippedNoConversation,
      skippedFailedWorkspace,
      failedWorkspaces: failedWorkspaceIds.size,
      ctaTriggered,
      days,
      limit,
    });
  } catch (error) {
    console.error("[Cron] Airi gap backfill failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
