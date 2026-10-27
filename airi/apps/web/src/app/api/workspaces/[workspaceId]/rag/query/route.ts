import { RagResponseService } from "@/lib/airi/rag/response/rag-response-service";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { getWorkspaceAiRequiredDetails } from "@/lib/ai/workspace-ai-errors";
import { fetchCompanyContextByWorkspace } from "@/lib/company-context";
import connectDB from "@/lib/mongoose";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string }>;

const BodySchema = z.object({
  mode: z.enum(["retrieve", "context", "answer"]),
  query: z.string().trim().min(1).max(12_000),
  language: z.string().trim().min(2).max(24).optional(),
  fastMode: z.boolean().optional(),
  conversationContext: z.string().max(100_000).optional(),
  conversationWindow: z.string().max(100_000).optional(),
  knowledgeSearchPrincipal: z
    .enum(["rag_auto_reply", "workspace_member_tool", "system_unrestricted"])
    .optional(),
  matchAllowedVisibilities: z
    .union([z.array(z.string().trim().min(1).max(64)).max(16), z.null()])
    .optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const raw = await request.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await connectDB();

    const {
      mode,
      query,
      language,
      fastMode,
      conversationContext,
      conversationWindow,
      knowledgeSearchPrincipal: bodyPrincipal,
      matchAllowedVisibilities: bodyVisibilities,
    } = parsed.data;

    const company = await fetchCompanyContextByWorkspace(workspaceId);
    const langRaw = language || company.airiLanguage || "en";
    const lang = typeof langRaw === "string" ? langRaw : "en";

    let knowledgeSearchPrincipal = bodyPrincipal;
    if (
      bodyVisibilities === undefined &&
      knowledgeSearchPrincipal === undefined
    ) {
      knowledgeSearchPrincipal = "workspace_member_tool";
    }

    const actionId = `rag-query:${randomUUID()}`;
    const result = await withWorkspaceTextAiAction(
      { workspaceId, actionId },
      () =>
        RagResponseService.generateResponse({
          workspaceId,
          conversationId: actionId,
          text: query,
          language: lang,
          conversationWindow: conversationWindow ?? "",
          conversationContext: conversationContext ?? "",
          companyContext: {
            businessContext: company.businessContext,
            dynamicTags: company.dynamicTags ?? [],
          },
          fastMode: fastMode ?? false,
          productMode: mode,
          knowledgeSearchPrincipal,
          matchAllowedVisibilities: bodyVisibilities,
        })
    );

    return NextResponse.json({
      ok: true,
      productMode: result.productMode ?? mode,
      result,
    });
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    return NextResponse.json(
      { error: "Failed to run RAG query" },
      { status: 500 }
    );
  }
}
