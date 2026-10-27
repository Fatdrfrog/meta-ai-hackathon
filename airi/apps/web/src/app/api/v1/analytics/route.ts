import { authenticateRequest } from "@/lib/api-auth";
import { parsePositiveInt } from "@/lib/api/query-params";
import {
  applyCustomerConversationVisibility,
  buildCustomerAnalyticsCategoryPipeline,
  buildCustomerAnalyticsChannelPipeline,
  buildCustomerAnalyticsStatusPipeline,
  resolveCustomerAnalyticsWindow,
} from "@/lib/customer-api/conversation-reads";
import { canReadCustomerAnalytics } from "@/lib/customer-api/read-access";
import connectDB from "@/lib/mongoose";
import { getCompanyConversationVisibilityGate } from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";

/**
 * Public API v1 - Analytics
 * Requires read permission; explicit analytics:false denies access.
 * Legacy keys without a domain scope inherit their read permission.
 */

/**
 * GET - Get analytics/metrics for workspace
 */
export async function GET(request: Request) {
  // Authenticate request
  const { apiKey, error } = await authenticateRequest(request);
  if (error) return error;

  // Check permission
  if (!canReadCustomerAnalytics(apiKey!)) {
    return new Response(
      JSON.stringify({
        error: "API key does not have permission to read analytics",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const days = parsePositiveInt(searchParams.get("days"), 30, 1, 365);
    const metric = searchParams.get("metric"); // total, by_status, by_channel, by_category

    await connectDB();

    const { start: startDate, end: endDate } =
      resolveCustomerAnalyticsWindow(days);

    const visibility = await getCompanyConversationVisibilityGate(
      supabaseAdmin,
      apiKey!.workspace_id
    );
    const baseMatch = applyCustomerConversationVisibility(
      {
        workspaceId: apiKey!.workspace_id,
        createdAt: { $gte: startDate.toDate() },
      },
      visibility
    );

    if (!metric || metric === "total") {
      // Overall summary
      const [totalConversations, byStatus, byChannel] = await Promise.all([
        Conversation.countDocuments(baseMatch),
        Conversation.aggregate(buildCustomerAnalyticsStatusPipeline(baseMatch)),
        Conversation.aggregate(
          buildCustomerAnalyticsChannelPipeline(baseMatch)
        ),
      ]);

      return NextResponse.json({
        period: {
          days,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        metrics: {
          total: totalConversations,
          by_status: byStatus,
          by_channel: byChannel,
        },
      });
    }

    if (metric === "daily") {
      // Daily breakdown
      const dailyCounts = await Conversation.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { date: "$_id", count: 1, _id: 0 } },
      ]);

      return NextResponse.json({
        period: {
          days,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        daily: dailyCounts,
      });
    }

    if (metric === "by_category") {
      // Category breakdown
      const categories = await Conversation.aggregate(
        buildCustomerAnalyticsCategoryPipeline(baseMatch)
      );

      return NextResponse.json({
        period: {
          days,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        categories,
      });
    }

    // Default: return error for unknown metric
    return new Response(
      JSON.stringify({
        error: "Unknown metric. Supported: total, daily, by_category",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Get analytics error:", error);
    return NextResponse.json(
      {
        code: "ANALYTICS_UNAVAILABLE",
        error: "Analytics are temporarily unavailable.",
      },
      { status: 503 }
    );
  }
}
