import { resolveActiveEmailProvider, sendEmail } from "@/lib/email/send-email";
import {
  buildCompanyLimitExceededResponse,
  isCompanyConversationLimitExceeded,
} from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
export const runtime = "nodejs";

const BodySchema = z.object({
  workspaceId: z.string(),
  fromAddress: z.string().email(),
  to: z.union([z.string().email(), z.array(z.string().email())]),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  replyToMessageId: z.string().optional(),
});

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const body = await req.json();
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse(
      JSON.stringify({ error: "Invalid body", details: parsed.error.message }),
      { status: 400 }
    );
  }
  const {
    workspaceId,
    fromAddress,
    to,
    subject,
    text,
    html,
    replyToMessageId,
  } = parsed.data;

  const { verifyWorkspaceAccess } = await import("@/lib/sources/utils");
  const hasAccess = await verifyWorkspaceAccess(supabase, user.id, workspaceId);

  if (!hasAccess) {
    return new NextResponse(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  const provider = await resolveActiveEmailProvider(workspaceId);
  if (!provider.ok) {
    return NextResponse.json(
      { error: provider.error, code: provider.code },
      { status: 400 }
    );
  }
  const { providerConfig } = provider;

  const normalizedFromAddress = fromAddress.toLowerCase().trim();
  const { data: emailAddress, error: emailAddressErr } = await supabaseAdmin
    .from("workspace_email_addresses")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("full_address", normalizedFromAddress)
    .eq("status", "active")
    .maybeSingle();

  const matchesProviderDefault =
    providerConfig.defaultFromAddress === normalizedFromAddress;

  if ((emailAddressErr || !emailAddress) && !matchesProviderDefault) {
    return new NextResponse(
      JSON.stringify({
        error:
          "Unknown workspace/fromAddress. Add sender address to workspace or use provider default sender.",
      }),
      { status: 404 }
    );
  }

  try {
    const result = await sendEmail({
      workspaceId,
      fromAddress,
      to: toArray(to),
      subject,
      text,
      html,
      replyToMessageId,
      provider,
    });

    if (!result.ok) {
      return new NextResponse(
        JSON.stringify({ error: "Send failed", details: result.error }),
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      providerMessageId: result.providerMessageId,
    });
  } catch (e: unknown) {
    if (isCompanyConversationLimitExceeded(e)) {
      return buildCompanyLimitExceededResponse(e.limit);
    }
    const message = e instanceof Error ? e.message : "Send failed";
    return new NextResponse(
      JSON.stringify({ error: "Send failed", details: message }),
      { status: 500 }
    );
  }
}
