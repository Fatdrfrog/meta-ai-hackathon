import connectDB from "@/lib/mongoose";
import {
  createAiriArtifact,
  listAiriArtifacts,
} from "@/lib/airi-artifacts/service";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string }> };

const artifactKindSchema = z.enum([
  "whatsapp_template",
  "whatsapp_flow",
  "marketing_campaign",
  "opportunity_scan",
]);

const listArtifactsQuerySchema = z.object({
  threadId: z.string().trim().min(1).max(160).optional(),
  kind: artifactKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const createArtifactBodySchema = z.object({
  threadId: z.string().trim().min(1).max(160),
  kind: artifactKindSchema,
  snapshot: z.unknown(),
  sourceMessageId: z.string().trim().min(1).max(160).optional(),
  assistantMessageId: z.string().trim().min(1).max(160).optional(),
  changeSummary: z.string().trim().max(240).optional(),
});

async function resolveContext(request: NextRequest, workspaceId: string) {
  const auth = await getSupabaseRouteAuth(request);
  if (isSupabaseRouteAuthError(auth)) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const hasAccess = await verifyWorkspaceAccess(
    auth.supabase,
    auth.user.id,
    workspaceId
  );
  if (!hasAccess) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { supabase: auth.supabase, user: auth.user };
}

function parseQuery(request: NextRequest | Request) {
  const searchParams = new URL(request.url).searchParams;
  return listArtifactsQuerySchema.safeParse({
    threadId: searchParams.get("threadId") || undefined,
    kind: searchParams.get("kind") || undefined,
    limit: searchParams.get("limit") || undefined,
  });
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    const parsed = parseQuery(request);
    if (!parsed.success)
      return zodErrorResponse(parsed.error, { fallback: "Invalid query" });

    await connectDB();

    const artifacts = await listAiriArtifacts({
      workspaceId,
      threadId: parsed.data.threadId,
      kind: parsed.data.kind,
      limit: parsed.data.limit,
    });

    return NextResponse.json({ artifacts });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list Airi artifacts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const context = await resolveContext(request, workspaceId);
    if (context.error) return context.error;

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = createArtifactBodySchema.safeParse(bodyResult.body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    await connectDB();

    const artifact = await createAiriArtifact({
      workspaceId,
      threadId: parsed.data.threadId,
      userId: context.user.id,
      kind: parsed.data.kind,
      snapshot: parsed.data.snapshot,
      sourceMessageId: parsed.data.sourceMessageId,
      assistantMessageId: parsed.data.assistantMessageId,
      actor: { type: "user", id: context.user.id },
      changeSummary: parsed.data.changeSummary,
    });

    return NextResponse.json({ artifact }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create Airi artifact";
    const status =
      error instanceof Error && error.name === "AiriArtifactValidationError"
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
