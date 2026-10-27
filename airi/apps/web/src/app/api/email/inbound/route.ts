import { detectAndUpdateConversationLanguage } from "@/lib/airi/coach/coach-utils-server";
import { invalidateRequestsForWorkspace } from "@/lib/cache";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  storeEmailInboundAttachment,
  resolveEmailInlineAttachments,
  type StoredEmailAttachment,
} from "@/lib/email/inbound-attachment";
import { getWorkspaceEmailSource } from "@/lib/email/email-source";
import findOrCreateEmailConversation from "@/lib/email/threading";
import {
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  isCompanyConversationLimitExceeded,
} from "@/lib/limits/company-limits";
import { ensureIndexes } from "@/lib/mongo";
import connectDB from "@/lib/mongoose";
import type { PostmarkInboundPayload } from "@/lib/postmark";
import { isTrustedPostmarkIp } from "@/lib/postmark";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyPostmarkWebhookToken } from "@/lib/webhook-auth";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InboundSchema = z.object({
  From: z.string().email(),
  To: z.string(),
  Subject: z.string().optional(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  MessageID: z.string(),
  Headers: z
    .array(z.object({ Name: z.string(), Value: z.string() }))
    .optional(),
  Attachments: z
    .array(
      z.object({
        Name: z.string(),
        Content: z.string().optional(),
        ContentLink: z.string().url().optional(),
        ContentType: z.string().optional(),
        ContentLength: z.number().optional(),
        ContentID: z.string().optional(),
      })
    )
    .optional(),
});

type Inbound = z.infer<typeof InboundSchema>;

function parseRecipients(rcpt: string): string[] {
  return rcpt
    .split(",")
    .map(s => s.trim())
    .map(s => {
      const match = s.match(/<([^>]+)>/);
      return match ? match[1] : s;
    })
    .filter(Boolean);
}

function toHeadersMap(list?: { Name: string; Value: string }[]) {
  const map: Record<string, string> = {};
  (list || []).forEach(h => {
    map[h.Name] = h.Value;
  });
  return map;
}

export async function POST(req: NextRequest) {
  const expectedInboundToken = process.env.POSTMARK_INBOUND_TOKEN;
  if (
    expectedInboundToken &&
    !verifyPostmarkWebhookToken(req, expectedInboundToken)
  ) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const forwardedFor = req.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || null;
  if (!isTrustedPostmarkIp(ip)) {
    if (process.env.POSTMARK_TRUSTED_CIDRS) {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      });
    }
  }

  let payload: PostmarkInboundPayload;
  try {
    const parsed: Inbound = InboundSchema.parse(await req.json());
    payload = parsed as PostmarkInboundPayload;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Invalid payload";
    return new NextResponse(
      JSON.stringify({ error: "Invalid payload", details: message }),
      { status: 400 }
    );
  }

  const toAddresses = parseRecipients(payload.To);
  const primaryRcpt = toAddresses[0];
  if (!primaryRcpt || primaryRcpt.split("@").length < 2) {
    return new NextResponse(JSON.stringify({ error: "Invalid recipient" }), {
      status: 400,
    });
  }

  // Supabase lookup for workspace mapping
  const { data: emailAddress, error: emailAddressErr } = await supabaseAdmin
    .from("workspace_email_addresses")
    .select("workspace_id")
    .eq("full_address", primaryRcpt.toLowerCase())
    .eq("status", "active")
    .maybeSingle();

  if (emailAddressErr || !emailAddress) {
    return new NextResponse(JSON.stringify({ error: "Unknown recipient" }), {
      status: 404,
    });
  }

  const workspaceId = emailAddress.workspace_id as string;
  const emailSource = await getWorkspaceEmailSource(workspaceId);
  const sourceId = emailSource?.id || undefined;

  try {
    await connectDB();
    await ensureIndexes();

    const headersMap = toHeadersMap(payload.Headers);

    const conversation = await findOrCreateEmailConversation({
      workspaceId,
      to: toAddresses.map(a => a.toLowerCase()),
      from: [payload.From.toLowerCase()],
      subject: payload.Subject || null,
      headers: headersMap,
      sourceId,
    });

    // Check if this conversation was just created by checking message count
    // If messages array is empty, it's a new conversation
    const conversationWithMessages = (await Conversation.findById(
      conversation._id
    )
      .select("messages createdAt")
      .lean()) as {
      messages?: unknown[];
      createdAt?: Date;
      _id: unknown;
    } | null;
    const isNewConversation =
      !conversationWithMessages?.messages ||
      (Array.isArray(conversationWithMessages.messages) &&
        conversationWithMessages.messages.length === 0);

    const messageDate = payload.Headers?.find(
      h => h.Name.toLowerCase() === "date"
    )?.Value
      ? new Date(
          payload.Headers!.find(h => h.Name.toLowerCase() === "date")!.Value
        )
      : payload.ReceivedAt
        ? new Date(payload.ReceivedAt)
        : new Date();

    const message = await Message.create({
      workspaceId,
      conversation: conversation._id,
      channel: "email",
      direction: "inbound",
      subject: payload.Subject || undefined,
      text: payload.TextBody || undefined,
      html: payload.HtmlBody || undefined,
      rawSourcePayload: buildRawSourcePayload({
        provider: "email",
        eventType: "inbound",
        capturedAt: messageDate,
        payload,
        redactKeys: ["Content"],
      }),
      headers: headersMap,
      external_ids: { messageId: payload.MessageID },
      date: messageDate,
    });

    const attachmentPromises = (payload.Attachments || []).map(att =>
      storeEmailInboundAttachment(workspaceId, String(message._id), {
        Name: att.Name,
        Content: att.Content,
        ContentLink: att.ContentLink,
        ContentType: att.ContentType,
        ContentLength: att.ContentLength,
      })
    );

    Promise.all(attachmentPromises).then(async stored => {
      const filtered = stored.filter((v): v is StoredEmailAttachment =>
        Boolean(v)
      );
      if (filtered.length > 0) {
        await Message.findByIdAndUpdate(message._id, {
          $push: {
            attachments: {
              $each: filtered.map(
                ({ filename, url, contentType, sizeBytes }) => ({
                  filename,
                  url,
                  contentType,
                  sizeBytes,
                })
              ),
            },
          },
        });

        const rows = filtered.map(f => ({
          id: randomUUID(),
          tenant_id: workspaceId,
          message_id: String(message._id),
          filename: f.filename,
          content_type: f.contentType,
          storage_path: f.storage_path,
          size_bytes: f.sizeBytes || null,
        }));
        await supabaseAdmin.from("email_attachments").insert(rows);

        if (message.html) {
          const html = resolveEmailInlineAttachments(
            message.html,
            payload.Attachments || [],
            stored
          );
          if (html !== message.html)
            await Message.findByIdAndUpdate(message._id, { html });
        }
      }
    });

    await appendMessageToConversationById(conversation._id, message._id, {
      lastMessageAt: messageDate,
      direction: "inbound",
    });

    const emailText = payload.TextBody || payload.Subject || "";
    if (emailText) {
      await detectAndUpdateConversationLanguage(
        String(conversation._id),
        emailText
      );
    }

    realtime
      .trigger(
        `tenant-${workspaceId}`,
        isNewConversation ? "requests.new" : "requests.update",
        {
          _id: String(conversation._id),
          workspaceId,
          conversationId: String(conversation._id),
          messageId: String(message._id),
        }
      )
      .catch(() => {});
    await invalidateRequestsForWorkspace(workspaceId);
    // Use singleton pattern - determine if new or update based on conversation state
    const { triggerConversationRealtime } = await import(
      "@/lib/realtime-updates"
    );
    triggerConversationRealtime(
      String(conversation._id),
      isNewConversation
    ).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if (isCompanyConversationLimitExceeded(e)) {
      console.warn(
        "[Email inbound] New conversation blocked by company limit",
        {
          workspaceId,
          code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        }
      );
      return NextResponse.json({
        ok: true,
        skipped: true,
        code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      });
    }
    const error = e instanceof Error ? e.message : "Server error";
    return new NextResponse(JSON.stringify({ error }), { status: 500 });
  }
}
