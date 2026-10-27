import {
  canManageEmailProvider,
  getWorkspaceMembershipRole,
} from "@/lib/email/provider-auth";
import {
  getWorkspaceEmailAutomationSettings,
  upsertWorkspaceEmailAutomationSettings,
} from "@/lib/email/email-automation-settings";
import { sendRegistrationFollowUpEmail } from "@/lib/email/registration-follow-up";
import { getWorkspaceEmailConnectionStatus } from "@/lib/email/workspace-email-connection";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

type Params = Promise<{ workspaceId: string }>;

const PutBodySchema = z.object({
  registrationFollowUpEnabled: z.boolean().optional(),
  registrationFollowUpTemplate: z
    .object({
      subject: z.string().trim().min(1).max(180),
      markdown: z.string().trim().min(1).max(12000),
    })
    .optional(),
});

const PostBodySchema = z.object({
  testEmail: z.string().email().optional(),
});

async function getAuthorizedContext(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const hasAccess = await verifyWorkspaceAccess(supabase, user.id, workspaceId);
  if (!hasAccess) {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  const role = await getWorkspaceMembershipRole({
    supabase,
    userId: user.id,
    workspaceId,
  });

  return {
    supabase,
    user,
    canManage: canManageEmailProvider(role),
    response: null,
  };
}

export async function GET(_request: Request, { params }: { params: Params }) {
  try {
    const { workspaceId } = await params;
    const context = await getAuthorizedContext(workspaceId);
    if (context.response) return context.response;

    const [connection, settings] = await Promise.all([
      getWorkspaceEmailConnectionStatus(workspaceId),
      getWorkspaceEmailAutomationSettings(workspaceId),
    ]);

    return NextResponse.json({
      connected: connection.connected,
      providerStatus: connection.providerStatus,
      activeAddressCount: connection.activeAddressCount,
      settings,
      permissions: { canManage: context.canManage },
    });
  } catch (error) {
    console.error("[Email Automation] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load email automation settings" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, { params }: { params: Params }) {
  try {
    const { workspaceId } = await params;
    const context = await getAuthorizedContext(workspaceId);
    if (context.response) return context.response;

    if (!context.canManage) {
      return NextResponse.json(
        {
          error: "Only admins can update email automation settings",
        },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = PutBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const connection = await getWorkspaceEmailConnectionStatus(workspaceId);
    if (!connection.connected) {
      return NextResponse.json(
        { error: "Connect the email source before updating automation" },
        { status: 409 }
      );
    }

    const settings = await upsertWorkspaceEmailAutomationSettings({
      workspaceId,
      registrationFollowUpEnabled: parsed.data.registrationFollowUpEnabled,
      registrationFollowUpTemplate: parsed.data.registrationFollowUpTemplate,
      updatedBy: context.user.id,
    });

    return NextResponse.json({ settings });
  } catch (error) {
    console.error("[Email Automation] PUT failed", error);
    return NextResponse.json(
      { error: "Failed to save email automation settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request, { params }: { params: Params }) {
  try {
    const { workspaceId } = await params;
    const context = await getAuthorizedContext(workspaceId);
    if (context.response) return context.response;

    if (!context.canManage) {
      return NextResponse.json(
        { error: "Only admins can send test emails" },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsed = PostBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const connection = await getWorkspaceEmailConnectionStatus(workspaceId);
    if (!connection.connected) {
      return NextResponse.json(
        { error: "Connect the email source before sending test emails" },
        { status: 409 }
      );
    }

    const recipient = parsed.data.testEmail || context.user.email;
    if (!recipient) {
      return NextResponse.json(
        { error: "A recipient email is required" },
        { status: 400 }
      );
    }

    const settings = await getWorkspaceEmailAutomationSettings(workspaceId);
    const metadata = (context.user.user_metadata || {}) as Record<
      string,
      unknown
    >;
    const userName =
      typeof metadata.full_name === "string"
        ? metadata.full_name
        : typeof metadata.name === "string"
          ? metadata.name
          : context.user.email;

    const result = await sendRegistrationFollowUpEmail({
      userId: context.user.id,
      userEmail: recipient,
      userName,
      companyId: workspaceId,
      workspaceId,
      workspaceName: workspaceId,
      template: settings.registrationFollowUpTemplate,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: "Failed to send test email", details: result },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      providerMessageId: result.providerMessageId,
    });
  } catch (error) {
    console.error("[Email Automation] POST failed", error);
    return NextResponse.json(
      { error: "Failed to send test email" },
      { status: 500 }
    );
  }
}
