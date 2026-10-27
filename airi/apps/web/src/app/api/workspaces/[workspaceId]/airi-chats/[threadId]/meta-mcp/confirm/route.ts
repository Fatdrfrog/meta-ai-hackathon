import connectDB from "@/lib/mongoose";
import {
  confirmAiriChatMetaAdsMcpMutation,
  reconcileAiriChatMetaAdsMcpMutation,
} from "@/lib/airi-chats/service";
import { isAiriMetaAdsMcpConfirmationError } from "@/lib/airi-chats/meta-ads-mcp-confirmation";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string; threadId: string }> };

const locatorShape = {
  messageId: z.string().min(1).max(80),
  mutationId: z.string().min(1).max(120),
};

const transactionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const confirmationBodySchema = z
  .object({
    ...locatorShape,
    transactionDigest: transactionDigestSchema,
  })
  .strict();

const reconciliationBodySchema = z
  .object({
    ...locatorShape,
    transactionDigest: transactionDigestSchema.optional(),
    resolution: z.enum(["succeeded", "not_executed"]),
    note: z.string().trim().min(1).max(500),
    providerIdentifiers: z
      .array(
        z
          .object({
            kind: z.string().trim().min(1).max(100),
            id: z.string().trim().min(1).max(200),
          })
          .strict()
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (
      body.resolution === "not_executed" &&
      body.providerIdentifiers?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerIdentifiers"],
        message:
          "Provider identifiers are only accepted for a completed provider outcome",
      });
    }
  });

type RouteAction = "confirm" | "reconcile";

async function handleMutationRequest(
  request: NextRequest,
  { params }: Params,
  action: RouteAction
): Promise<NextResponse> {
  try {
    const { workspaceId, threadId } = await params;
    if (!Types.ObjectId.isValid(threadId)) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hasAccess = await verifyWorkspaceAccess(
      auth.supabase,
      auth.user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.body;
    const parsed =
      action === "confirm"
        ? confirmationBodySchema.safeParse(body)
        : reconciliationBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Meta Ads confirmation request" },
        { status: 400 }
      );
    }
    if (!Types.ObjectId.isValid(parsed.data.messageId)) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    await connectDB();
    const sharedInput = {
      supabase: auth.supabase,
      workspaceId,
      userId: auth.user.id,
      threadId,
      messageId: parsed.data.messageId,
      mutationId: parsed.data.mutationId,
    };
    if (action === "confirm") {
      const confirmation = parsed.data as z.infer<
        typeof confirmationBodySchema
      >;
      return NextResponse.json(
        await confirmAiriChatMetaAdsMcpMutation({
          ...sharedInput,
          transactionDigest: confirmation.transactionDigest,
        })
      );
    }
    const reconciliation = parsed.data as z.infer<
      typeof reconciliationBodySchema
    >;
    const result = await reconcileAiriChatMetaAdsMcpMutation({
      ...sharedInput,
      transactionDigest: reconciliation.transactionDigest,
      resolution: reconciliation.resolution,
      note: reconciliation.note,
      providerIdentifiers: reconciliation.providerIdentifiers,
    });

    return NextResponse.json(result);
  } catch (error) {
    const knownConfirmationError = isAiriMetaAdsMcpConfirmationError(error);
    const status = knownConfirmationError
      ? error.code === "CONFIRMATION_INVALID_REQUEST"
        ? 400
        : error.code === "CONFIRMATION_NOT_FOUND"
          ? 404
          : 409
      : error instanceof Error && error.message === "Airi chat thread not found"
        ? 404
        : 500;
    const message = knownConfirmationError
      ? error.message
      : status === 404
        ? "Chat not found"
        : "Failed to confirm Meta Ads MCP mutation";
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(
  request: NextRequest,
  context: Params
): Promise<NextResponse> {
  return handleMutationRequest(request, context, "confirm");
}

export async function PATCH(
  request: NextRequest,
  context: Params
): Promise<NextResponse> {
  return handleMutationRequest(request, context, "reconcile");
}
