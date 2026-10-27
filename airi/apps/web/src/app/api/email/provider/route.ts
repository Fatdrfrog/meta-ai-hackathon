import { upsertWorkspaceEmailSourceFromProvider } from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  getWorkspaceEmailProviderRow,
  upsertWorkspaceEmailProviderConfig,
} from "@/lib/email/provider-config";
import {
  canManageEmailProvider,
  getWorkspaceMembershipRole,
} from "@/lib/email/provider-auth";
import { sanitizeProviderResponse } from "@/lib/email/provider-response";
import { postmarkValidateServerToken } from "@/lib/postmark";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

const StreamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9._-]+$/);

const PutBodySchema = z.object({
  workspaceId: z.string(),
  mode: z.enum(["manual"]).optional(),
  postmarkServerToken: z.string().trim().min(1).optional(),
  transactionalStream: StreamNameSchema.optional(),
  broadcastStream: StreamNameSchema.optional(),
  defaultFromAddress: z.string().email(),
  webhookToken: z.string().trim().min(12).max(120).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = String(
      new URL(req.url).searchParams.get("workspaceId") || ""
    ).trim();

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const role = await getWorkspaceMembershipRole({
      supabase,
      userId: user.id,
      workspaceId,
    });
    const canManage = canManageEmailProvider(role);

    const provider = await getWorkspaceEmailProviderConfig(workspaceId, true);
    if (!provider) {
      return NextResponse.json({
        provider: null,
        permissions: { canManage },
      });
    }

    return NextResponse.json({
      provider: sanitizeProviderResponse({
        config: provider,
        req,
        canManage,
      }),
      permissions: { canManage },
    });
  } catch (error) {
    console.error("[Email Provider] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load workspace email provider" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = PutBodySchema.safeParse(rawBody);
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
        { error: "Only admins can update email provider settings" },
        { status: 403 }
      );
    }

    const existingConfig = await getWorkspaceEmailProviderConfig(
      body.workspaceId,
      true
    );
    if (existingConfig?.mode === "platform_managed" && body.mode !== "manual") {
      return NextResponse.json(
        {
          error:
            "Workspace email provider is currently platform-managed. Use mode=manual to switch to fallback manual configuration.",
        },
        { status: 409 }
      );
    }

    const token = String(body.postmarkServerToken || "").trim();
    if (token) {
      const validation = await postmarkValidateServerToken({
        serverToken: token,
      });
      if (!validation.ok) {
        return NextResponse.json(
          {
            error: "Postmark token validation failed",
            details: validation.error,
          },
          { status: 400 }
        );
      }
    } else {
      const existing = await getWorkspaceEmailProviderRow(
        body.workspaceId,
        true
      );
      if (!existing?.postmark_server_token) {
        return NextResponse.json(
          { error: "postmarkServerToken is required for first-time setup" },
          { status: 400 }
        );
      }
    }

    const upsert = await upsertWorkspaceEmailProviderConfig({
      workspaceId: body.workspaceId,
      createdBy: user.id,
      mode: "manual",
      postmarkServerToken: token || undefined,
      transactionalStream: body.transactionalStream,
      broadcastStream: body.broadcastStream,
      defaultFromAddress: body.defaultFromAddress,
      webhookToken: body.webhookToken,
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
    console.error("[Email Provider] PUT failed", error);

    const message =
      error instanceof Error ? error.message : "Failed to save provider";
    if (
      message.includes("workspace_email_providers") ||
      message.toLowerCase().includes("column")
    ) {
      return NextResponse.json(
        {
          error:
            "Email provider database tables are missing. Apply the email provider migration first.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Failed to save workspace email provider" },
      { status: 500 }
    );
  }
}
