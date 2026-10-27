import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import connectDB from "@/lib/mongoose";
import { normalizeWhatsAppQrProviderLink } from "@/lib/whatsapp/qr-entry-points/import-link";
import {
  renderWhatsAppQrPng,
  renderWhatsAppQrSvg,
} from "@/lib/whatsapp/qr-entry-points/render.server";
import {
  WhatsAppQrCode,
  type WhatsAppQrCodeRecord,
} from "@/models/whatsapp-qr-code";

export const runtime = "nodejs";

type Params = Promise<{ codeId: string }>;

const QuerySchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(256),
    format: z.enum(["png", "svg"]),
    disposition: z.enum(["inline", "attachment"]).default("attachment"),
  })
  .strict();

export async function GET(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  try {
    const { codeId } = await params;
    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      workspaceId: url.searchParams.get("workspaceId") ?? "",
      format: url.searchParams.get("format") ?? "",
      disposition: url.searchParams.get("disposition") ?? undefined,
    });
    if (!parsed.success || !codeId?.trim()) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const access = await getAuthenticatedWorkspaceMembership(
      parsed.data.workspaceId
    );
    if (access.error) return access.error;

    await connectDB();
    const code = await WhatsAppQrCode.findOne({
      workspaceId: parsed.data.workspaceId,
      codeId: codeId.trim(),
    })
      .select("codeId deepLink providerState")
      .lean<WhatsAppQrCodeRecord | null>();
    if (!code?.deepLink || code.providerState !== "ACTIVE") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let deepLink: string;
    try {
      deepLink = normalizeWhatsAppQrProviderLink(code.deepLink).deepLink;
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (parsed.data.format === "png") {
      const png = await renderWhatsAppQrPng(deepLink);
      return new NextResponse(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `${parsed.data.disposition}; filename="whatsapp-qr-${code.codeId}.png"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const svg = await renderWhatsAppQrSvg(deepLink);
    return new NextResponse(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `${parsed.data.disposition}; filename="whatsapp-qr-${code.codeId}.svg"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to render WhatsApp QR artwork" },
      { status: 500 }
    );
  }
}
