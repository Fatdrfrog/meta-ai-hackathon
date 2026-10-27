import connectDB from "@/lib/mongoose";
import LlmEvaluationRegressionCase from "@/models/llm-evaluation-regression-case";
import LlmEvaluationReviewItem from "@/models/llm-evaluation-review-item";
import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ id: string }>;

const patchBodySchema = z.object({
  workspaceId: z.string().trim().min(1),
  action: z.enum(["resolve", "ignore"]),
  ignoredReason: z.string().optional(),
  createRegressionCase: z.boolean().optional(),
  expectedBehavior: z.string().optional(),
  datasetDecision: z
    .enum(["candidate", "add_to_golden", "do_not_add", "needs_more_context"])
    .optional(),
  datasetSplit: z.enum(["train", "validation", "test"]).optional(),
  judgeExplanation: z.string().optional(),
  relevanceScore: z.number().min(0).max(1).optional(),
  trustworthinessScore: z.number().min(0).max(1).optional(),
  concisenessScore: z.number().min(0).max(1).optional(),
  completenessScore: z.number().min(0).max(1).optional(),
  safetyScore: z.number().min(0).max(1).optional(),
  overallScore: z.number().min(0).max(1).optional(),
});

export const runtime = "nodejs";

function serializeReviewItem(item: Record<string, unknown>) {
  return {
    id: String(item._id),
    workspaceId: item.workspaceId,
    conversationId: item.conversationId || null,
    messageId: item.messageId || null,
    traceId: item.traceId || null,
    status: item.status,
    issueType: item.issueType,
    severity: item.severity,
    title: item.title,
    summary: item.summary || null,
    suggestedFix: item.suggestedFix || null,
    updatedAt: item.updatedAt || null,
  };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json(
        { error: "Invalid review item id" },
        { status: 400 }
      );
    }

    const parsedBody = patchBodySchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    const body = parsedBody.data;
    const workspaceId = body.workspaceId;
    const action = body.action;

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { userId } = access;

    await connectDB();
    const existing = await LlmEvaluationReviewItem.findOne({
      _id: id,
      workspaceId,
    }).lean<Record<string, unknown> | null>();

    if (!existing) {
      return NextResponse.json(
        { error: "Review item not found" },
        { status: 404 }
      );
    }

    const existingInputExcerpt =
      typeof existing.inputExcerpt === "string"
        ? existing.inputExcerpt.trim()
        : "";
    if (
      action === "resolve" &&
      body.createRegressionCase &&
      !existingInputExcerpt
    ) {
      return NextResponse.json(
        { error: "inputExcerpt is required to create a regression case" },
        { status: 400 }
      );
    }

    const now = new Date();
    const humanEvaluation = {
      relevanceScore: body.relevanceScore ?? null,
      trustworthinessScore: body.trustworthinessScore ?? null,
      concisenessScore: body.concisenessScore ?? null,
      completenessScore: body.completenessScore ?? null,
      safetyScore: body.safetyScore ?? null,
      overallScore: body.overallScore ?? null,
      judgeExplanation: body.judgeExplanation?.trim() || null,
      datasetDecision:
        body.datasetDecision ||
        (body.createRegressionCase ? "add_to_golden" : "candidate"),
      datasetSplit: body.datasetSplit || "validation",
    };
    const updated = await LlmEvaluationReviewItem.findOneAndUpdate(
      { _id: id, workspaceId },
      {
        $set: {
          status: action === "resolve" ? "resolved" : "ignored",
          resolvedByUserId: userId,
          resolvedAt: now,
          ignoredReason:
            action === "ignore" ? body?.ignoredReason?.trim() || null : null,
          humanEvaluation,
        },
      },
      { new: true }
    ).lean<Record<string, unknown> | null>();

    if (!updated) {
      return NextResponse.json(
        { error: "Review item not found" },
        { status: 404 }
      );
    }

    let regressionCaseId: string | null = null;
    if (action === "resolve" && body?.createRegressionCase) {
      const regressionCase = await LlmEvaluationRegressionCase.create({
        workspaceId,
        reviewItemId: id,
        conversationId:
          typeof updated.conversationId === "string"
            ? updated.conversationId
            : null,
        messageId:
          typeof updated.messageId === "string" ? updated.messageId : null,
        traceId: typeof updated.traceId === "string" ? updated.traceId : null,
        issueType:
          typeof updated.issueType === "string" ? updated.issueType : "other",
        inputExcerpt:
          typeof updated.inputExcerpt === "string"
            ? updated.inputExcerpt
            : existingInputExcerpt,
        expectedBehavior:
          body.expectedBehavior?.trim() ||
          "Customer-approved fix should prevent this failure from recurring.",
        expectedSourceIds: [],
        datasetSplit: body.datasetSplit || "validation",
        createdByUserId: userId,
      });
      regressionCaseId = String(regressionCase._id);
    }

    return NextResponse.json({
      item: serializeReviewItem(updated),
      regressionCaseId,
    });
  } catch (error) {
    console.error("[AI Quality Review Items] PATCH failed", error);
    return NextResponse.json(
      { error: "Failed to update review item" },
      { status: 500 }
    );
  }
}
