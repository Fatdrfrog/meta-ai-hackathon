import {
  canManageEmailProvider,
  getWorkspaceMembershipRole,
} from "@/lib/email/provider-auth";
import { sanitizeProviderResponse } from "@/lib/email/provider-response";
import { upsertWorkspaceEmailSourceFromProvider } from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  getWorkspaceEmailProviderRow,
  upsertWorkspaceManagedEmailProviderConfig,
} from "@/lib/email/provider-config";
import {
  isPostmarkPlatformManagedEnabled,
  verifyManagedWorkspaceDomain,
} from "@/lib/postmark-managed";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  workspaceId: z.string(),
});

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const body = parsed.data;
    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      body.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const role = await getWorkspaceMembershipRole({
      supabase,
      userId: user.id,
      workspaceId: body.workspaceId,
    });
    if (!canManageEmailProvider(role)) {
      return NextResponse.json(
        { error: "Only admins and owners can verify email provider settings" },
        { status: 403 }
      );
    }

    if (!isPostmarkPlatformManagedEnabled()) {
      return NextResponse.json(
        {
          error:
            "Platform-managed Postmark is not configured. Set POSTMARK_ACCOUNT_TOKEN on the server.",
        },
        { status: 500 }
      );
    }

    const existing = await getWorkspaceEmailProviderConfig(
      body.workspaceId,
      true
    );
    if (!existing || !existing.managedState) {
      return NextResponse.json(
        {
          error:
            "No platform-managed Postmark setup found for this workspace. Run setup first.",
        },
        { status: 400 }
      );
    }

    const managedState = await verifyManagedWorkspaceDomain({
      managedState: existing.managedState,
    });

    const status =
      managedState.verificationStatus === "verified" ? "active" : "inactive";

    const upsert = await upsertWorkspaceManagedEmailProviderConfig({
      workspaceId: body.workspaceId,
      createdBy: user.id,
      postmarkServerToken: existing.postmarkServerToken,
      transactionalStream: existing.transactionalStream,
      broadcastStream: existing.broadcastStream,
      defaultFromAddress: existing.defaultFromAddress,
      webhookToken: existing.webhookToken,
      postmarkManagedState: managedState,
      status,
    });

    if (!upsert.ok) {
      return NextResponse.json({ error: upsert.error }, { status: 400 });
    }

    const providerRow = await getWorkspaceEmailProviderRow(
      body.workspaceId,
      true
    );
    await upsertWorkspaceEmailSourceFromProvider(
      body.workspaceId,
      providerRow,
      upsert.config
    );

    return NextResponse.json({
      provider: sanitizeProviderResponse({
        config: upsert.config,
        req,
        canManage: true,
      }),
      permissions: { canManage: true },
    });
  } catch (error) {
    console.error("[Email Provider Platform Verify] POST failed", error);
    const message =
      error instanceof Error ? error.message : "Failed to verify provider";
    const lower = message.toLowerCase();
    if (lower.includes("postmark request failed: 4")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to verify platform-managed Postmark provider" },
      { status: 500 }
    );
  }
}
