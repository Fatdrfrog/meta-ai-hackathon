"use server";

import connectDB from "@/lib/mongoose";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { findPrimaryWebWidgetSource } from "@/lib/widget/source-selection";
import { Conversation } from "@/models/conversation";
import type { Source, WebWidgetCredentials } from "@/types/supabase";
import {
  getPostHogQueryStatus,
  queryDeviceStats,
  queryPageviews,
  querySessionStats,
  queryTopPages,
  queryTrafficSources,
} from "./posthog-queries";

export interface WidgetAnalytics {
  source: {
    id: string;
    name: string;
    installedAt: string;
    status: "active" | "inactive" | "unknown";
    allowedDomains: string[];
    airiEnabled: boolean;
    helpTabEnabled: boolean;
    autoOpen: boolean;
    position: "bottom-right" | "bottom-left" | "unknown";
  } | null;
  // Conversation stats (MongoDB)
  conversations: {
    totalConversations: number;
    totalMessages: number;
    uniquePages: number;
    activeToday: number;
    topPages: Array<{
      url: string;
      count: number;
      lastActive: string | null;
    }>;
  };
  // Website analytics (PostHog)
  analytics: {
    pageviews: number;
    sessions: number;
    avgSessionDuration: number; // in seconds
    bounceRate: number; // percentage
    topPages: Array<{
      url: string;
      views: number;
      avgTime?: number;
    }>;
    trafficSources: Array<{
      source: string;
      visitors: number;
      percentage: number;
    }>;
    devices: {
      desktop: number;
      mobile: number;
      tablet: number;
    };
    timeSeriesData: Array<{
      date: string;
      pageviews: number;
    }>;
  };
  pages: Array<{
    url: string;
    views: number;
    conversations: number;
    lastActive: string | null;
    startRate: number | null;
  }>;
  summary: {
    chatStartRate: number | null;
    returningVisitorRate: number | null;
  };
  websiteAnalyticsStatus:
    | {
        state: "ready";
      }
    | {
        state: "unavailable";
        reason: "missing_config" | "query_failed";
      };
  // Engagement metrics derived from conversation data
  engagement: {
    statusBreakdown: {
      open: number;
      in_progress: number;
      closed: number;
    };
    sentimentBreakdown: {
      positive: number;
      neutral: number;
      negative: number;
    };
    avgResponseTimeSec: number;
    avgMessagesPerConversation: number;
    avgCsat: number;
    csatCount: number;
    returningVisitors: number;
    uniqueVisitors: number;
    conversationsByDay: Array<{
      date: string;
      count: number;
    }>;
    topCategories: Array<{
      name: string;
      count: number;
    }>;
  };
}

function asWebWidgetCredentials(
  credentials: Source["credentials"] | null | undefined
): WebWidgetCredentials | null {
  if (!credentials || typeof credentials !== "object") return null;

  const candidate = credentials as Partial<WebWidgetCredentials>;
  if (typeof candidate.client_key !== "string") return null;

  return {
    client_key: candidate.client_key,
    secret_key: candidate.secret_key,
    allowed_domains: Array.isArray(candidate.allowed_domains)
      ? candidate.allowed_domains.filter(
          domain => typeof domain === "string" && domain.trim().length > 0
        )
      : [],
    status: candidate.status === "inactive" ? "inactive" : "active",
    onboarding_test: candidate.onboarding_test,
    theme: candidate.theme,
    settings: candidate.settings,
    content: candidate.content,
    branding: candidate.branding,
    layout: candidate.layout,
  };
}

function toSourceMeta(source: Source | null): WidgetAnalytics["source"] {
  if (!source) return null;

  const credentials = asWebWidgetCredentials(source.credentials);

  return {
    id: source.id,
    name: source.name || "Web Widget",
    installedAt: source.created_at,
    status: credentials?.status ?? "unknown",
    allowedDomains: credentials?.allowed_domains ?? [],
    airiEnabled: credentials?.settings?.airi_enabled !== false,
    helpTabEnabled: credentials?.layout?.show_help_tab !== false,
    autoOpen: credentials?.settings?.auto_open === true,
    position: credentials?.settings?.position ?? "unknown",
  };
}

function mergePageStats({
  viewedPages,
  conversationPages,
}: {
  viewedPages: WidgetAnalytics["analytics"]["topPages"];
  conversationPages: WidgetAnalytics["conversations"]["topPages"];
}): WidgetAnalytics["pages"] {
  const pages = new Map<
    string,
    {
      url: string;
      views: number;
      conversations: number;
      lastActive: string | null;
    }
  >();

  for (const page of viewedPages) {
    const url = page.url?.trim() || "unknown";
    pages.set(url, {
      url,
      views: page.views,
      conversations: 0,
      lastActive: null,
    });
  }

  for (const page of conversationPages) {
    const url = page.url?.trim() || "unknown";
    const existing = pages.get(url);
    pages.set(url, {
      url,
      views: existing?.views ?? 0,
      conversations: page.count,
      lastActive: page.lastActive,
    });
  }

  return Array.from(pages.values())
    .map(page => ({
      ...page,
      startRate:
        page.views > 0 ? (page.conversations / page.views) * 100 : null,
    }))
    .sort((a, b) => {
      const trafficDelta = b.views - a.views;
      if (trafficDelta !== 0) return trafficDelta;
      return b.conversations - a.conversations;
    })
    .slice(0, 10);
}

/**
 * Get widget analytics from MongoDB
 * Queries conversations with channel='web_widget' for the workspace
 */
export async function getWidgetAnalytics(
  workspaceId: string
): Promise<{ data: WidgetAnalytics | null; error?: string }> {
  try {
    // Verify user has access to this workspace
    const supabase = await createReadOnlyClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { data: null, error: "Unauthorized" };
    }

    // Verify workspace access
    const { data: workspaceAccess } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .single();

    if (!workspaceAccess) {
      return { data: null, error: "Access denied" };
    }

    const { data: widgetSources } = await supabase
      .from("sources")
      .select(
        "id, name, created_at, company_id, workspace_id, type, credentials"
      )
      .eq("workspace_id", workspaceId)
      .eq("type", "web_widget")
      .order("created_at", { ascending: false })
      .limit(10);

    const widgetSource = findPrimaryWebWidgetSource(
      (widgetSources ?? []) as Source[]
    );
    const widgetSourceId = widgetSource?.id ?? null;

    // Dashboard metrics use the same 30-day window as widget analytics events.
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const dateRange = {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    };

    const sourceMatch = widgetSourceId
      ? {
          $or: [
            { sourceId: widgetSourceId },
            { sourceId: { $exists: false } },
            { sourceId: null },
          ],
        }
      : {};
    const widgetFilter = {
      workspaceId,
      channel: "web_widget" as const,
      ...sourceMatch,
    };
    const last30DaysFilter = {
      ...widgetFilter,
      createdAt: { $gte: startDate, $lte: endDate },
    };

    // Connect to MongoDB
    await connectDB();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    // --- MongoDB widget conversation metrics (parallel queries) ---
    const [
      totalConversations,
      messageStats,
      uniquePages,
      activeToday,
      topPagesData,
      statusAgg,
      sentimentAgg,
      responseTimeAgg,
      csatAgg,
      visitorAgg,
      dailyConvAgg,
      categoryAgg,
    ] = await Promise.all([
      // Total widget conversations
      Conversation.countDocuments(last30DaysFilter),
      // Total messages from widget conversations
      Conversation.aggregate([
        {
          $match: last30DaysFilter,
        },
        {
          $group: {
            _id: null,
            totalMessages: { $sum: "$message_count" },
          },
        },
      ]),
      // Unique pages
      Conversation.distinct("page_url", {
        ...last30DaysFilter,
        page_url: { $exists: true, $ne: null },
      }),
      // Conversations active in last 24h
      Conversation.countDocuments({
        ...widgetFilter,
        lastMessageAt: { $gte: yesterday },
      }),
      // Top 5 pages by conversation count
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            page_url: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: "$page_url",
            count: { $sum: 1 },
            lastActive: { $max: "$lastMessageAt" },
          },
        },
        {
          $sort: { count: -1 },
        },
        {
          $limit: 5,
        },
      ]),
      // Status breakdown
      Conversation.aggregate([
        { $match: last30DaysFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      // Sentiment breakdown (last 30 days, classified only)
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            "classification.sentiment": { $exists: true, $ne: null },
          },
        },
        { $group: { _id: "$classification.sentiment", count: { $sum: 1 } } },
      ]),
      // Average agent response time
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            "interaction_metrics.agent_response_time_avg_sec": {
              $exists: true,
              $gt: 0,
            },
          },
        },
        {
          $group: {
            _id: null,
            avg: { $avg: "$interaction_metrics.agent_response_time_avg_sec" },
          },
        },
      ]),
      // CSAT average
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            customer_satisfaction_score: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: null,
            avg: { $avg: "$customer_satisfaction_score" },
            count: { $sum: 1 },
          },
        },
      ]),
      // Unique vs returning visitors
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            visitor_id: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: "$visitor_id",
            conversationCount: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: null,
            uniqueVisitors: { $sum: 1 },
            returningVisitors: {
              $sum: { $cond: [{ $gt: ["$conversationCount", 1] }, 1, 0] },
            },
          },
        },
      ]),
      // Daily conversations (last 30 days)
      Conversation.aggregate([
        { $match: last30DaysFilter },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      // Top categories
      Conversation.aggregate([
        {
          $match: {
            ...last30DaysFilter,
            "classification.category": { $exists: true, $ne: null },
          },
        },
        { $group: { _id: "$classification.category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const totalMessages = messageStats[0]?.totalMessages || 0;
    const topPages = topPagesData.map(page => ({
      url: page._id || "unknown",
      count: page.count,
      lastActive: page.lastActive
        ? new Date(page.lastActive).toISOString()
        : null,
    }));

    // Build engagement result
    const statusMap: Record<string, number> = {};
    for (const s of statusAgg) statusMap[s._id] = s.count;

    const sentimentMap: Record<string, number> = {};
    for (const s of sentimentAgg) sentimentMap[s._id] = s.count;

    const engagement = {
      statusBreakdown: {
        open: statusMap["open"] || 0,
        in_progress: statusMap["in_progress"] || 0,
        closed: statusMap["closed"] || 0,
      },
      sentimentBreakdown: {
        positive: sentimentMap["positive"] || 0,
        neutral: sentimentMap["neutral"] || 0,
        negative: sentimentMap["negative"] || 0,
      },
      avgResponseTimeSec: responseTimeAgg[0]?.avg || 0,
      avgMessagesPerConversation:
        totalConversations > 0 ? totalMessages / totalConversations : 0,
      avgCsat: csatAgg[0]?.avg || 0,
      csatCount: csatAgg[0]?.count || 0,
      returningVisitors: visitorAgg[0]?.returningVisitors || 0,
      uniqueVisitors: visitorAgg[0]?.uniqueVisitors || 0,
      conversationsByDay: dailyConvAgg.map(
        (d: { _id: string; count: number }) => ({
          date: d._id,
          count: d.count,
        })
      ),
      topCategories: categoryAgg.map((c: { _id: string; count: number }) => ({
        name: c._id,
        count: c.count,
      })),
    };

    // Query PostHog for website analytics
    const posthogStatus = getPostHogQueryStatus();
    const websiteResults = posthogStatus.configured
      ? await Promise.all([
          queryPageviews(workspaceId, dateRange, widgetSourceId),
          querySessionStats(workspaceId, dateRange, widgetSourceId),
          queryTrafficSources(workspaceId, dateRange, 5, widgetSourceId),
          queryDeviceStats(workspaceId, dateRange, widgetSourceId),
          queryTopPages(workspaceId, dateRange, 10, widgetSourceId),
        ]).catch(() => null)
      : null;
    const [
      pageviewsData,
      sessionStats,
      trafficSources,
      deviceStats,
      topPagesAnalytics,
    ] = websiteResults ?? [
      { total: 0, timeSeries: [] },
      { totalSessions: 0, avgSessionDuration: 0, bounceRate: 0 },
      [],
      { desktop: 0, mobile: 0, tablet: 0 },
      [],
    ];

    const pages = mergePageStats({
      viewedPages: topPagesAnalytics,
      conversationPages: topPages,
    });
    const chatStartRate =
      sessionStats.totalSessions > 0
        ? (totalConversations / sessionStats.totalSessions) * 100
        : null;
    const returningVisitorRate =
      engagement.uniqueVisitors > 0
        ? (engagement.returningVisitors / engagement.uniqueVisitors) * 100
        : null;

    return {
      data: {
        source: toSourceMeta(widgetSource),
        conversations: {
          totalConversations,
          totalMessages,
          uniquePages: uniquePages.length,
          activeToday,
          topPages,
        },
        analytics: {
          pageviews: pageviewsData.total,
          sessions: sessionStats.totalSessions,
          avgSessionDuration: sessionStats.avgSessionDuration,
          bounceRate: sessionStats.bounceRate,
          topPages: topPagesAnalytics,
          trafficSources,
          devices: deviceStats,
          timeSeriesData: pageviewsData.timeSeries.map(
            (item: { date: string; count: number }) => ({
              date: item.date,
              pageviews: item.count,
            })
          ),
        },
        pages,
        summary: {
          chatStartRate,
          returningVisitorRate,
        },
        websiteAnalyticsStatus: websiteResults
          ? { state: "ready" }
          : {
              state: "unavailable",
              reason: posthogStatus.configured
                ? "query_failed"
                : posthogStatus.reason,
            },
        engagement,
      },
    };
  } catch (error) {
    // Error will be handled by client
    return {
      data: null,
      error:
        error instanceof Error ? error.message : "Failed to fetch analytics",
    };
  }
}
