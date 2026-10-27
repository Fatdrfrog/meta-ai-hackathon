import {
  canManageEmailProvider,
  getWorkspaceMembershipRole,
} from "@/lib/email/provider-auth";
import {
  buildEmailProviderWebhookUrl,
  sanitizeProviderResponse,
} from "@/lib/email/provider-response";
import { upsertWorkspaceEmailSourceFromProvider } from "@/lib/email/email-source";
import {
  generateWebhookToken,
  getWorkspaceEmailProviderConfig,
  getWorkspaceEmailProviderRow,
  upsertWorkspaceManagedEmailProviderConfig,
} from "@/lib/email/provider-config";
import {
  isPostmarkPlatformManagedEnabled,
  setupManagedWorkspacePostmark,
} from "@/lib/postmark-managed";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  workspaceId: z.string(),
  defaultFromAddress: z.string().email(),
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
        { error: "Only admins and owners can setup email provider settings" },
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

    const existingRow = await getWorkspaceEmailProviderRow(
      body.workspaceId,
      true
    );
    const existingConfig = await getWorkspaceEmailProviderConfig(
      body.workspaceId,
      true
    );

    const webhookToken = existingRow?.webhook_token
      ? String(existingRow.webhook_token)
      : generateWebhookToken();
    const webhookUrl = buildEmailProviderWebhookUrl(req, webhookToken);

    const setup = await setupManagedWorkspacePostmark({
      workspaceId: body.workspaceId,
      defaultFromAddress: body.defaultFromAddress,
      webhookUrl,
      existingServerToken:
        existingConfig?.mode === "platform_managed"
          ? existingConfig.postmarkServerToken
          : undefined,
      existingManagedState:
        existingConfig?.mode === "platform_managed"
          ? existingConfig.managedState
          : null,
    });

    const status =
      setup.managedState.verificationStatus === "verified"
        ? "active"
        : "inactive";

    const upsert = await upsertWorkspaceManagedEmailProviderConfig({
      workspaceId: body.workspaceId,
      createdBy: user.id,
      postmarkServerToken: setup.serverToken,
      transactionalStream: setup.transactionalStream,
      broadcastStream: setup.broadcastStream,
      defaultFromAddress: body.defaultFromAddress,
      webhookToken,
      postmarkManagedState: setup.managedState,
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
    console.error("[Email Provider Platform Setup] POST failed", error);

    const message =
      error instanceof Error ? error.message : "Failed to setup provider";
    const lower = message.toLowerCase();
    if (
      lower.includes("defaultfromaddress") ||
      lower.includes("valid domain") ||
      lower.includes("postmark request failed: 4")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Failed to setup platform-managed Postmark provider" },
      { status: 500 }
    );
  }
}
