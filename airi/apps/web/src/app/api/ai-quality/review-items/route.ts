import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import LlmEvaluationReviewItem, {
  LLM_EVALUATION_ISSUE_TYPES,
  LLM_EVALUATION_REVIEW_STATUSES,
} from "@/models/llm-evaluation-review-item";
import { NextRequest, NextResponse } from "next/server";
import { parsePositiveInt } from "@/lib/api/query-params";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

function isReviewStatus(
  value: string
): value is (typeof LLM_EVALUATION_REVIEW_STATUSES)[number] {
  return LLM_EVALUATION_REVIEW_STATUSES.includes(
    value as (typeof LLM_EVALUATION_REVIEW_STATUSES)[number]
  );
}

function isIssueType(
  value: string
): value is (typeof LLM_EVALUATION_ISSUE_TYPES)[number] {
  return LLM_EVALUATION_ISSUE_TYPES.includes(
    value as (typeof LLM_EVALUATION_ISSUE_TYPES)[number]
  );
}

function serializeReviewItem(item: Record<string, unknown>) {
  return {
    id: String(item._id),
    workspaceId: item.workspaceId,
    conversationId: item.conversationId || null,
    messageId: item.messageId || null,
    traceId: item.traceId || null,
    scoreEventId: item.scoreEventId || null,
    status: item.status,
    issueType: item.issueType,
    severity: item.severity,
    source: item.source,
    title: item.title,
    summary: item.summary || null,
    inputExcerpt: item.inputExcerpt || null,
    outputExcerpt: item.outputExcerpt || null,
    reasoningExcerpt: item.reasoningExcerpt || null,
    suggestedFix: item.suggestedFix || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = new URL(request.url).searchParams;
    const workspaceId = searchParams.get("workspaceId")?.trim();
    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rawStatus = searchParams.get("status")?.trim() || "open";
    if (!isReviewStatus(rawStatus)) {
      return NextResponse.json(
        { error: "Invalid review status" },
        { status: 400 }
      );
    }

    const rawIssueType = searchParams.get("issueType")?.trim() || "";
    if (rawIssueType && !isIssueType(rawIssueType)) {
      return NextResponse.json(
        { error: "Invalid issue type" },
        { status: 400 }
      );
    }

    const query: Record<string, unknown> = {
      workspaceId,
      status: rawStatus,
    };
    if (rawIssueType) query.issueType = rawIssueType;

    await connectDB();
    const items = await LlmEvaluationReviewItem.find(query)
      .sort({ createdAt: -1 })
      .limit(parsePositiveInt(searchParams.get("limit"), 25, 1, 100))
      .lean<Array<Record<string, unknown>>>();

    return NextResponse.json({
      items: items.map(serializeReviewItem),
    });
  } catch (error) {
    console.error("[AI Quality Review Items] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load review items" },
      { status: 500 }
    );
  }
}
