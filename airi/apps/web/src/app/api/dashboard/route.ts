import { validateConversationChannelListParams } from "@/lib/api/conversation-channel-query";
import { getWorkspaceManagerReplyGuardConfig } from "@/lib/airi/reply/runtime/manager-reply-guard";
import { cache } from "@/lib/cache";
import { getConversionAttributionReport } from "@/lib/conversions/conversion-attribution";
import { getConversionFeedbackReport } from "@/lib/conversions/conversion-feedback-report";
import { buildDashboardCacheKey } from "@/lib/dashboard-cache-key";
import {
  normalizeDashboardCustomCalendarRange,
  resolveDashboardComparisonWindow,
} from "@/lib/dashboard-comparison";
import { calculateDashboardMetrics } from "@/lib/metrics-calculator";
import { fetchMetaAdsDashboardInsights } from "@/lib/meta-ads/meta-ads-insights";
import connectDB from "@/lib/mongoose";
import { withTiming } from "@/lib/performance-monitor";
import {
  getMembershipDisplayName,
  getUserProfilesByIds,
  WORKSPACE_ROLES,
} from "@/lib/supabase/company-users";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import type {
  AdvertisementAnalytics,
  DashboardComparisonInput,
  DashboardComparisonPeriod,
  DashboardManagerOption,
} from "@/types/dashboard";
import { NextResponse } from "next/server";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

async function getDashboardSales(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  period: DashboardComparisonPeriod
): Promise<
  Pick<
    AdvertisementAnalytics,
    | "conversionAttribution"
    | "conversionAttributionError"
    | "conversionFeedback"
    | "conversionFeedbackError"
  >
> {
  const { start, endExclusive: end } = period.current;
  const feedback = await getConversionFeedbackReport({
    supabase,
    workspaceId,
    start,
    end,
    timeZone: period.timeZone,
  })
    .then(conversionFeedback => ({
      conversionFeedback,
      conversionFeedbackError: null,
    }))
    .catch(() => ({
      conversionFeedback: null,
      conversionFeedbackError: "unavailable" as const,
    }));
  // Custom ranges are bounded in local calendar days. SQL needs their timezone
  // too, so a DST fall-back does not turn an accepted 366 days into an error.
  try {
    return {
      conversionAttribution: await getConversionAttributionReport({
        supabase,
        workspaceId,
        start,
        end,
        timeZone: period.timeZone,
      }),
      conversionAttributionError: null,
      ...feedback,
    };
  } catch {
    return {
      conversionAttribution: null,
      conversionAttributionError: "unavailable",
      ...feedback,
    };
  }
}

function normalizeList(values: string[]) {
  return readUniqueStringArray(values).sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeDashboardTimeZone(value: string | null) {
  const candidate = (value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(0)
    );
    return candidate;
  } catch {
    return "UTC";
  }
}

const DASHBOARD_PERIODS = new Map<string, DashboardComparisonInput>([
  ["7", 7],
  ["30", 30],
  ["90", 90],
  ["this_week", "this_week"],
  ["all", "all"],
]);

function invalidDashboardPeriodResponse() {
  return new Response(JSON.stringify({ error: "Invalid dashboard period" }), {
    status: 400,
  });
}

function getDashboardComparisonPeriod(
  searchParams: URLSearchParams,
  timeZone: string,
  requestAnchor: Date
): DashboardComparisonPeriod | Response {
  const hasFromParam = searchParams.has("from");
  const hasToParam = searchParams.has("to");

  if (hasFromParam || hasToParam) {
    const fromParam = searchParams.get("from")?.trim() || "";
    const toParam = searchParams.get("to")?.trim() || "";
    if (!hasFromParam || !hasToParam || !fromParam || !toParam) {
      return new Response(
        JSON.stringify({ error: "Invalid dashboard date range" }),
        { status: 400 }
      );
    }

    try {
      return resolveDashboardComparisonWindow(
        normalizeDashboardCustomCalendarRange(fromParam, toParam, timeZone),
        timeZone,
        requestAnchor
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid dashboard date range" }),
        { status: 400 }
      );
    }
  }

  const period = DASHBOARD_PERIODS.get(searchParams.get("period") || "30");
  if (period === undefined) return invalidDashboardPeriodResponse();
  return resolveDashboardComparisonWindow(period, timeZone, requestAnchor);
}

function isResponse(
  value: DashboardComparisonPeriod | Response
): value is Response {
  return value instanceof Response;
}

function getPeriodCacheParts(period: DashboardComparisonPeriod) {
  const identity = [
    "comparison",
    period.preset,
    period.strategy,
    period.timeZone,
  ];

  if (period.preset === "custom") {
    return [
      ...identity,
      period.current.start,
      period.current.endExclusive,
      period.previous?.start || "",
      period.previous?.endExclusive || "",
    ];
  }

  const ttlSeconds = period.preset === "last_12_months" ? 300 : 90;
  return [
    ...identity,
    "anchorBucket",
    Math.floor(Date.parse(period.current.endExclusive) / (ttlSeconds * 1000)),
  ];
}

async function getDashboardManagerOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string
): Promise<DashboardManagerOption[]> {
  const { data, error } = await supabase
    .from("company_users")
    .select("user_id, role, email")
    .eq("workspace_id", workspaceId)
    .in("role", [...WORKSPACE_ROLES]);

  if (error || !Array.isArray(data)) return [];

  const userIds = data
    .map(row => String((row as { user_id?: string | null }).user_id || ""))
    .map(userId => userId.trim())
    .filter(Boolean);
  const profilesById = await getUserProfilesByIds(supabase, userIds);
  const byId = new Map<string, DashboardManagerOption>();

  for (const row of data) {
    const typedRow = row as {
      user_id?: string | null;
      role?: string | null;
      email?: string | null;
    };
    const id = String(typedRow.user_id || "").trim();
    if (!id || byId.has(id)) continue;

    const profile = profilesById.get(id) ?? null;
    byId.set(id, {
      id,
      name: getMembershipDisplayName(
        {
          email: typedRow.email,
          users: profile,
        },
        "Manager"
      ),
      role: typedRow.role || null,
      email: typedRow.email || null,
      avatarUrl: profile?.avatar_url || null,
    });
  }

  return Array.from(byId.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

// This GET only updates an in-memory response cache after auth; it does not mutate user or workspace data.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  // MODIFIED: Get workspaceId from the query params
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const channelsRaw = searchParams.getAll("channels");
  const channelCheck = validateConversationChannelListParams(channelsRaw);
  if (!channelCheck.ok) {
    return channelCheck.response;
  }
  const channels = normalizeList(channelCheck.values);
  const categories = normalizeList(searchParams.getAll("categories"));
  const internalLabels = normalizeList(searchParams.getAll("internalLabels"));
  const managerIds = normalizeList(searchParams.getAll("managerIds"));
  const timeZone = normalizeDashboardTimeZone(searchParams.get("timezone"));
  const requestAnchor = new Date();
  const comparisonPeriod = getDashboardComparisonPeriod(
    searchParams,
    timeZone,
    requestAnchor
  );
  if (isResponse(comparisonPeriod)) {
    return comparisonPeriod;
  }

  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspaceId is required" }), {
      status: 400,
    });
  }

  // ADDED: Security check to ensure user has access to this workspace
  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
    });
  }

  try {
    const key = buildDashboardCacheKey([
      ["workspace", [workspaceId]],
      [
        "versions",
        [
          "responseContract:dashboardComparison:v2",
          "messageConversationVolume:v1",
          "firstResponseComparison:v1",
          "metaAdsInsightsAccounts:v2",
          "activityByMessageDate:v1",
          "conversionAttribution:v2",
          "metricTruth:v2",
          "cardPeriodComparisons:v1",
        ],
      ],
      ["period", getPeriodCacheParts(comparisonPeriod)],
      ["channels", channels],
      ["categories", categories],
      ["internalLabels", internalLabels],
      ["managerIds", managerIds],
      ["timeZone", [timeZone]],
    ]);
    const cached = await cache.get<unknown>(key);
    if (cached) {
      return NextResponse.json(cached);
    }

    const managerOptionsPromise = getDashboardManagerOptions(
      supabase,
      workspaceId
    );
    await withTiming("dashboard.db_connect", async () => await connectDB());
    const [managerOptions, managerReplyGuardConfig] = await Promise.all([
      managerOptionsPromise,
      getWorkspaceManagerReplyGuardConfig(workspaceId),
    ]);

    // MODIFIED: Pass workspaceId to the metrics calculator with performance monitoring
    const timingContext = {
      workspaceId,
      periodPreset: comparisonPeriod.preset,
      periodStrategy: comparisonPeriod.strategy,
      dateRange: `${comparisonPeriod.current.start}..${comparisonPeriod.current.endExclusive}`,
      channels: channels.join(","),
      categories: categories.join(","),
      internalLabels: internalLabels.join(","),
      managerIds: managerIds.join(","),
      timeZone,
    };
    const [stats, metaAdsInsights, sales] = await Promise.all([
      withTiming(
        "dashboard.calculate_metrics",
        async () =>
          await calculateDashboardMetrics(workspaceId, comparisonPeriod, {
            channels,
            categories,
            internalLabels,
            managerIds,
            managerOptions,
            managerUserLinks: managerReplyGuardConfig.managerUserLinks,
            timeZone,
          }),
        timingContext
      ),
      withTiming(
        "dashboard.meta_ads_insights",
        async () =>
          await fetchMetaAdsDashboardInsights({
            workspaceId,
            comparisonPeriod,
          }),
        timingContext
      ),
      withTiming(
        "dashboard.conversion_attribution",
        () => getDashboardSales(supabase, workspaceId, comparisonPeriod),
        timingContext
      ),
    ]);
    const dashboardStats = {
      ...stats,
      advertisement: {
        ...stats.advertisement,
        metaInsights: metaAdsInsights,
        ...sales,
      },
    };

    // Cache the computed stats. Longer TTL for 'all'.
    const ttlSeconds = comparisonPeriod.preset === "last_12_months" ? 300 : 90;
    await cache.set(key, dashboardStats, ttlSeconds);
    return NextResponse.json(dashboardStats);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(
      JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      }),
      { status: 500 }
    );
  }
}
