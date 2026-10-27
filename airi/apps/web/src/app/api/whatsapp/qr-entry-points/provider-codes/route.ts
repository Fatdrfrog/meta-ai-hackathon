import { NextResponse } from "next/server";
import { z } from "zod";

import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  listWhatsAppChatQrPage,
  WhatsAppChatQrProviderError,
} from "@/lib/whatsapp/qr-entry-points/provider";

export const runtime = "nodejs";

const QuerySchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(256),
    sourceId: z.string().trim().min(1).max(256),
    limit: z.coerce.number().int().min(1).max(100),
    cursor: z.string().min(1).max(16_384).optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      workspaceId: url.searchParams.get("workspaceId") ?? "",
      sourceId: url.searchParams.get("sourceId") ?? "",
      limit: url.searchParams.get("limit") ?? "",
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const access = await getWhatsAppWorkspaceContext(parsed.data.workspaceId, {
      requireManager: true,
      sourceId: parsed.data.sourceId,
      requirePhoneNumber: true,
      managerErrorMessage:
        "Only managers and admins can list WhatsApp QR codes",
    });
    if (access.error) return access.error;
    if (
      access.context.sourceId !== parsed.data.sourceId ||
      !access.context.accessToken ||
      !access.context.phoneNumberId
    ) {
      return NextResponse.json(
        { error: "WhatsApp source binding changed" },
        { status: 409 }
      );
    }

    const page = await listWhatsAppChatQrPage({
      phoneNumberId: access.context.phoneNumberId,
      accessToken: access.context.accessToken,
      limit: parsed.data.limit,
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    });
    return NextResponse.json({
      codes: page.data.map(qr => ({
        code: qr.code,
        prefilledMessage: qr.prefilledMessage,
        deepLink: qr.deepLink,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  } catch (error) {
    if (error instanceof WhatsAppChatQrProviderError) {
      return NextResponse.json(
        { error: "Failed to list WhatsApp QR codes", code: "PROVIDER_FAILED" },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "Failed to list WhatsApp QR codes" },
      { status: 500 }
    );
  }
}
