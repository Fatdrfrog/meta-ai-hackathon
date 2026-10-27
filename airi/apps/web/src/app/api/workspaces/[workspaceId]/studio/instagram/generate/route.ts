import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { decryptMaybeString } from "@/lib/crypto";
import {
  buildCompanyStudioChatLimitExceededResponse,
  ensureCompanyStudioChatCapacity,
  recordCreativeStudioChat,
} from "@/lib/limits/company-limits";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import {
  asNullableRecord,
  cleanString as clampText,
} from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ workspaceId: string }>;
type GenerateAction = "captions" | "calendar" | "insights_brief";

type GenerateStudioRequest = {
  action?: GenerateAction;
  topic?: string;
  audience?: string;
  goal?: string;
  tone?: string;
  language?: string;
  cta?: string;
  product?: string;
  focusQuestion?: string;
  metrics?: unknown;
};

type CaptionVariant = {
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  creativeBrief: string;
};

type CalendarItem = {
  day: string;
  format: string;
  idea: string;
  hook: string;
  cta: string;
};

type InstagramMetricPoint = {
  name: string;
  value: string;
  endTime: string;
};

type InsightBrief = {
  headline: string;
  summary: string;
  metricHighlights: Array<{
    metric: string;
    value: string;
    insight: string;
  }>;
  recommendations: string[];
  reviewerExplanation: string;
};

const STUDIO_INSIGHTS_METRIC_SETS = [
  "views,reach,profile_views",
  "views,reach",
  "reach,profile_views",
  "views",
  "reach",
  "profile_views",
] as const;

function normalizeHashtag(tag: string): string {
  const sanitized = tag
    .trim()
    .replace(/^#+/g, "")
    .replace(/[^\p{L}\p{N}_]/gu, "");
  return sanitized ? `#${sanitized}` : "";
}

function parseHashtags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeHashtag(typeof item === "string" ? item : ""))
      .filter(Boolean)
      .slice(0, 12);
  }

  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map(normalizeHashtag)
      .filter(Boolean)
      .slice(0, 12);
  }

  return [];
}

function parseStringArray(
  value: unknown,
  limit = 8,
  maxLength = 220
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => clampText(item, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function toIsoDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
}

function formatMetricValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US").format(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return new Intl.NumberFormat("en-US").format(parsed);
    }
    return clampText(value, 40);
  }
  return "0";
}

function normalizeMetricName(value: string): string {
  const normalized = value
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalized) return "Metric";
  return normalized.replace(/(^\w|\s\w)/g, match => match.toUpperCase());
}

function parseMetricPoints(value: unknown): InstagramMetricPoint[] {
  if (!Array.isArray(value)) return [];

  return value
    .map(item => {
      const metric = asNullableRecord(item);
      if (!metric) return null;

      const name = normalizeMetricName(clampText(metric.name, 80));
      const rawValues = Array.isArray(metric.values) ? metric.values : [];
      const latestPoint = asNullableRecord(rawValues[0]);
      const metricValue =
        latestPoint !== null
          ? formatMetricValue(latestPoint.value)
          : formatMetricValue(metric.value);
      const endTime =
        latestPoint !== null
          ? toIsoDate(latestPoint.end_time)
          : toIsoDate(metric.endTime || metric.end_time);

      if (!name) return null;

      return {
        name,
        value: metricValue,
        endTime,
      };
    })
    .filter((item): item is InstagramMetricPoint => Boolean(item))
    .slice(0, 8);
}

async function ensureWorkspaceAccessAndInstagram(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!(await checkUserWorkspaceAccess(supabase, userId, workspaceId))) {
    return { ok: false, status: 403, error: "Access denied to this workspace" };
  }

  const studioEnabled = await isWorkspaceFeatureEnabled(
    workspaceId,
    "instagram_studio"
  );
  if (!studioEnabled) {
    return {
      ok: false,
      status: 403,
      error: "Instagram Studio is disabled for this workspace",
    };
  }

  const { data: instagramSource } = await supabase
    .from("sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", "instagram")
    .limit(1)
    .maybeSingle();

  if (!instagramSource?.id) {
    return {
      ok: false,
      status: 400,
      error: "Instagram is not connected in this workspace",
    };
  }

  return { ok: true };
}

/** Tolerates a fenced or prose-wrapped object; Claude has no JSON mode. */
function parseJsonObject(content: string): Record<string, unknown> {
  try {
    return extractJsonObject(content);
  } catch {
    return {};
  }
}

async function fetchInstagramMetricsFromSource(
  workspaceId: string
): Promise<InstagramMetricPoint[]> {
  const source = await fetchSourceWithCredentials(undefined, "instagram", {
    workspace_id: workspaceId,
  });

  if (!source) return [];

  const creds = (source.credentials || {}) as Record<string, unknown>;
  const token = decryptMaybeString(creds.page_access_token);

  const authMethod = String(creds.auth_method || "");
  const instagramId =
    authMethod === "instagram_business_login"
      ? String(
          creds.instagram_scoped_id || creds.instagram_business_account_id || ""
        )
      : String(
          creds.instagram_business_account_id || creds.instagram_scoped_id || ""
        );

  if (!token || !instagramId) return [];

  const graphApiBase = resolveInstagramGraphBase(authMethod);

  for (const metrics of STUDIO_INSIGHTS_METRIC_SETS) {
    const url = new URL(
      `${graphApiBase}/${encodeURIComponent(instagramId)}/insights`
    );
    url.searchParams.set("metric", metrics);
    url.searchParams.set("period", "day");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      continue;
    }

    const result = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parsed = parseMetricPoints(result.data);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

async function generateCaptionVariants(
  workspaceId: string,
  input: Required<Pick<GenerateStudioRequest, "topic">> &
    Omit<GenerateStudioRequest, "action">
): Promise<CaptionVariant[]> {
  const systemPrompt = `
You are an expert Instagram content strategist for B2B and commerce brands.
Return only a valid JSON object using this exact shape:
{
  "variants": [
    {
      "title": "short internal label",
      "hook": "first sentence hook",
      "caption": "full caption text with line breaks if needed",
      "hashtags": ["#tag1", "#tag2"],
      "creativeBrief": "1-2 sentences on the visual to pair with this caption"
    }
  ]
}

Rules:
- Generate exactly 3 variants with clearly different angles.
- Keep each caption under 450 characters.
- Use natural language and avoid generic AI phrasing.
- Keep hashtags relevant (5 to 10 hashtags each).
- Respect requested language, tone and goal.
`.trim();

  const userPrompt = JSON.stringify({
    topic: input.topic,
    audience: input.audience || "General audience",
    goal: input.goal || "Engagement",
    tone: input.tone || "Confident",
    language: input.language || "English",
    cta: input.cta || "Send us a DM",
    product: input.product || "",
  });

  const response = await chatCompletionWithFallback({
    model: getHeavyTextModel(),
    temperature: 0.8,
    responseFormat: { type: "json_object" },
    analytics: {
      workspaceId,
      operation: "studio.instagram.generate.captions",
      sourceService: "web.studio.instagram",
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.content || "{}";
  const parsed = parseJsonObject(content);
  const variantsRaw = Array.isArray(parsed.variants) ? parsed.variants : [];

  const variants: CaptionVariant[] = variantsRaw
    .map(item => {
      const record = asNullableRecord(item);
      if (!record) return null;

      const title = clampText(record.title, 80) || "Variant";
      const hook = clampText(record.hook, 180);
      const caption = clampText(record.caption, 700);
      const hashtags = parseHashtags(record.hashtags);
      const creativeBrief = clampText(record.creativeBrief, 240);

      if (!caption) return null;

      return {
        title,
        hook,
        caption,
        hashtags,
        creativeBrief,
      };
    })
    .filter((item): item is CaptionVariant => Boolean(item))
    .slice(0, 3);

  if (variants.length > 0) return variants;

  return [
    {
      title: "Variant 1",
      hook: "Start with one bold insight.",
      caption: `Here is a first draft for "${input.topic}".`,
      hashtags: [],
      creativeBrief:
        "Use a simple product-focused visual with a clear value statement.",
    },
  ];
}

async function generateCalendar(
  workspaceId: string,
  input: Required<Pick<GenerateStudioRequest, "topic">> &
    Omit<GenerateStudioRequest, "action">
): Promise<CalendarItem[]> {
  const systemPrompt = `
You are an Instagram planner.
Return only a valid JSON object with this exact shape:
{
  "weekPlan": [
    {
      "day": "Monday",
      "format": "Reel | Carousel | Story | Photo",
      "idea": "content idea",
      "hook": "opening line",
      "cta": "call to action"
    }
  ]
}

Rules:
- Generate exactly 7 items (Monday to Sunday).
- Each idea should be specific and practical.
- Vary content format through the week.
- Keep each text field concise.
- Respect requested language, tone and goal.
`.trim();

  const userPrompt = JSON.stringify({
    topic: input.topic,
    audience: input.audience || "General audience",
    goal: input.goal || "Engagement",
    tone: input.tone || "Confident",
    language: input.language || "English",
    cta: input.cta || "Send us a DM",
    product: input.product || "",
  });

  const response = await chatCompletionWithFallback({
    model: getHeavyTextModel(),
    temperature: 0.7,
    responseFormat: { type: "json_object" },
    analytics: {
      workspaceId,
      operation: "studio.instagram.generate.calendar",
      sourceService: "web.studio.instagram",
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.content || "{}";
  const parsed = parseJsonObject(content);
  const weekPlanRaw = Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [];

  const weekPlan: CalendarItem[] = weekPlanRaw
    .map(item => {
      const record = asNullableRecord(item);
      if (!record) return null;

      const day = clampText(record.day, 24);
      const format = clampText(record.format, 32);
      const idea = clampText(record.idea, 220);
      const hook = clampText(record.hook, 180);
      const cta = clampText(record.cta, 120);

      if (!day || !idea) return null;

      return {
        day,
        format: format || "Post",
        idea,
        hook,
        cta,
      };
    })
    .filter((item): item is CalendarItem => Boolean(item))
    .slice(0, 7);

  if (weekPlan.length > 0) return weekPlan;

  return [
    {
      day: "Monday",
      format: "Post",
      idea: `Share one practical tip about "${input.topic}".`,
      hook: "One thing we learned this week:",
      cta: input.cta || "Message us for details",
    },
  ];
}

async function generateInsightBrief(
  workspaceId: string,
  input: {
    topic?: string;
    audience?: string;
    goal?: string;
    tone?: string;
    language?: string;
    cta?: string;
    product?: string;
    focusQuestion?: string;
    metrics: InstagramMetricPoint[];
  }
): Promise<InsightBrief> {
  const systemPrompt = `
You are a strategic Instagram insights analyst for a social CRM product.
Return only valid JSON with this exact shape:
{
  "headline": "short summary headline",
  "summary": "2-4 sentences explaining performance and implications",
  "metricHighlights": [
    {
      "metric": "Reach",
      "value": "1200",
      "insight": "what this number suggests in context"
    }
  ],
  "recommendations": ["action 1", "action 2", "action 3"],
  "reviewerExplanation": "1 short paragraph describing how this insight output is used in-product for business users"
}

Rules:
- Use only provided metrics and insight evidence.
- Do not invent unavailable numbers or trends.
- Keep recommendations specific and practical for social teams.
- Include 3 to 5 recommendations.
- Keep reviewerExplanation policy-safe and non-promotional.
`.trim();

  const userPrompt = JSON.stringify({
    context: {
      topic: input.topic || "",
      audience: input.audience || "General audience",
      goal: input.goal || "Engagement",
      tone: input.tone || "Confident",
      language: input.language || "English",
      cta: input.cta || "Send us a DM",
      product: input.product || "",
      focusQuestion: input.focusQuestion || "",
    },
    instagramMetrics: input.metrics,
  });

  const response = await chatCompletionWithFallback({
    model: getHeavyTextModel(),
    temperature: 0.5,
    responseFormat: { type: "json_object" },
    analytics: {
      workspaceId,
      operation: "studio.instagram.generate.insights_brief",
      sourceService: "web.studio.instagram",
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.content || "{}";
  const parsed = parseJsonObject(content);
  const metricHighlightsRaw = Array.isArray(parsed.metricHighlights)
    ? parsed.metricHighlights
    : [];

  const metricHighlights = metricHighlightsRaw
    .map(item => {
      const record = asNullableRecord(item);
      if (!record) return null;
      const metric = clampText(record.metric, 80);
      const value = clampText(record.value, 40);
      const insight = clampText(record.insight, 220);

      if (!metric || !value) return null;
      return {
        metric,
        value,
        insight,
      };
    })
    .filter(
      (item): item is { metric: string; value: string; insight: string } =>
        Boolean(item)
    )
    .slice(0, 6);

  const recommendations = parseStringArray(parsed.recommendations, 5, 220);

  if (metricHighlights.length > 0 && recommendations.length > 0) {
    return {
      headline:
        clampText(parsed.headline, 140) || "Instagram performance brief",
      summary:
        clampText(parsed.summary, 800) ||
        "Recent Instagram metrics were analyzed to guide next content decisions.",
      metricHighlights,
      recommendations,
      reviewerExplanation:
        clampText(parsed.reviewerExplanation, 480) ||
        "This brief is shown in Studio so managers can review account metrics and receive actionable recommendations before planning content.",
    };
  }

  const fallbackMetricHighlights =
    input.metrics.length > 0
      ? input.metrics.slice(0, 3).map(metric => ({
          metric: metric.name,
          value: metric.value,
          insight:
            "Track this value over time to validate which content themes perform best.",
        }))
      : [
          {
            metric: "Instagram Insights",
            value: "No data",
            insight:
              "Reconnect Instagram or generate new account activity to populate metrics.",
          },
        ];

  const fallbackRecommendations = [
    "Review the top metric shifts weekly and map them to the content format used.",
    "Use the 7-day plan to test one clear hook per day and compare reach vs profile views.",
    "Convert recurring support questions into content topics and FAQ posts.",
  ];

  return {
    headline: "Instagram performance brief",
    summary:
      "Studio used available Instagram metrics to prepare an action plan.",
    metricHighlights: fallbackMetricHighlights,
    recommendations: fallbackRecommendations,
    reviewerExplanation:
      "This insight brief helps managers interpret Instagram account data and prepare data-driven content actions within Studio.",
  };
}

async function handlePOST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const access = await ensureWorkspaceAccessAndInstagram(
      supabase,
      workspaceId,
      user.id
    );
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    const studioChatCapacity = await ensureCompanyStudioChatCapacity(
      supabaseAdmin,
      workspaceId
    );
    if (!studioChatCapacity.allowed) {
      return buildCompanyStudioChatLimitExceededResponse(
        studioChatCapacity.limit
      );
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as GenerateStudioRequest;
    const action: GenerateAction =
      body.action === "calendar"
        ? "calendar"
        : body.action === "insights_brief"
          ? "insights_brief"
          : "captions";

    if (action === "insights_brief") {
      const providedMetrics = parseMetricPoints(body.metrics);
      const sourceMetrics =
        providedMetrics.length > 0
          ? []
          : await fetchInstagramMetricsFromSource(workspaceId);
      const metrics =
        providedMetrics.length > 0 ? providedMetrics : sourceMetrics;

      const insightsBrief = await generateInsightBrief(workspaceId, {
        topic: clampText(body.topic, 220),
        audience: clampText(body.audience, 140),
        goal: clampText(body.goal, 80),
        tone: clampText(body.tone, 80),
        language: clampText(body.language, 40),
        cta: clampText(body.cta, 120),
        product: clampText(body.product, 140),
        focusQuestion: clampText(body.focusQuestion, 220),
        metrics,
      });
      await recordCreativeStudioChat(workspaceId, "instagram_generate");

      return NextResponse.json({
        ok: true,
        action,
        insightsBrief,
        evidence: {
          metricsCount: metrics.length,
        },
      });
    }

    const topic = clampText(body.topic, 220);
    if (topic.length < 3) {
      return NextResponse.json(
        { error: "Topic must contain at least 3 characters" },
        { status: 400 }
      );
    }

    const sharedInput: Omit<GenerateStudioRequest, "action" | "metrics"> & {
      topic: string;
    } = {
      topic,
      audience: clampText(body.audience, 140),
      goal: clampText(body.goal, 80),
      tone: clampText(body.tone, 80),
      language: clampText(body.language, 40),
      cta: clampText(body.cta, 120),
      product: clampText(body.product, 140),
      focusQuestion: clampText(body.focusQuestion, 220),
    };

    if (action === "calendar") {
      const weekPlan = await generateCalendar(workspaceId, sharedInput);
      await recordCreativeStudioChat(workspaceId, "instagram_generate");
      return NextResponse.json({ ok: true, action, weekPlan });
    }

    const variants = await generateCaptionVariants(workspaceId, sharedInput);
    await recordCreativeStudioChat(workspaceId, "instagram_generate");
    return NextResponse.json({ ok: true, action, variants });
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    const message =
      error instanceof Error ? error.message : "Failed to generate content";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const { workspaceId } = await args[1].params;
  try {
    return await withWorkspaceTextAiAction(
      { workspaceId, actionId: `instagram-studio:${randomUUID()}` },
      () => handlePOST(...args)
    );
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    throw error;
  }
}
