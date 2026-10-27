import {
  assertSupportedOtpTemplate,
  deleteOtpTemplateBinding,
  listOtpTemplateBindings,
  upsertOtpTemplateBinding,
} from "@/lib/otp/otp-template-binding-service";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  findApprovedWhatsAppTemplateForSend,
  listApprovedWhatsAppTemplatesForSend,
} from "@/lib/whatsapp/templates/send-lookup";
import { upsertTemplateSnapshot } from "@/lib/whatsapp/templates/template-mirror";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BindingPayloadSchema = z.object({
  purpose: z.string().min(1).max(64).default("login"),
  templateName: z.string().min(1).max(512),
  languageCode: z.string().min(2).max(16),
  ttlSeconds: z.number().int().min(60).max(600).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
    });
    if (accessResult.error) return accessResult.error;

    const bindings = await listOtpTemplateBindings(workspaceId);
    return NextResponse.json({ success: true, bindings });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load OTP template bindings",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const payload = BindingPayloadSchema.parse(await request.json());

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: true,
      requireManager: true,
      requirePhoneNumber: true,
      managerErrorMessage: "Only managers and admins can configure OTP",
    });
    if (accessResult.error) return accessResult.error;

    const templates = await listApprovedWhatsAppTemplatesForSend(workspaceId);
    const liveTemplate = await findApprovedWhatsAppTemplateForSend({
      workspaceId,
      templateName: payload.templateName,
      languageCode: payload.languageCode,
      templates,
    });

    if (!liveTemplate) {
      return NextResponse.json(
        {
          success: false,
          error: "Approved WhatsApp authentication template not found",
        },
        { status: 404 }
      );
    }

    assertSupportedOtpTemplate(liveTemplate);
    await upsertTemplateSnapshot(workspaceId, liveTemplate);

    const binding = await upsertOtpTemplateBinding({
      workspaceId,
      purpose: payload.purpose,
      templateName: payload.templateName,
      languageCode: payload.languageCode,
      sourceId: accessResult.context.sourceId,
      phoneNumberId: accessResult.context.phoneNumberId,
      ttlSeconds: payload.ttlSeconds,
      maxAttempts: payload.maxAttempts,
      enabled: payload.enabled,
      userId: accessResult.context.user.id,
    });

    return NextResponse.json({ success: true, binding });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save OTP template binding",
      },
      { status }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
      requireManager: true,
      managerErrorMessage: "Only managers and admins can configure OTP",
    });
    if (accessResult.error) return accessResult.error;

    const purpose = new URL(request.url).searchParams.get("purpose");
    if (!purpose) {
      return NextResponse.json(
        { success: false, error: "purpose is required" },
        { status: 400 }
      );
    }

    const result = await deleteOtpTemplateBinding({ workspaceId, purpose });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete OTP template binding",
      },
      { status: 500 }
    );
  }
}
