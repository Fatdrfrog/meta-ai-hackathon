import { handleInstagramComment } from "@/lib/instagram/webhook-comments";
import {
  handleIncomingMessage,
  handleDelivery,
  handleOptin,
  handleMessageEcho,
  handlePostback,
  handleRead,
  handleReferral,
  handleReaction,
  handleStandby,
} from "@/lib/instagram/webhook-handlers";
import {
  buildInstagramMessagingDedupKey,
  classifyInstagramMessagingEvent,
  extractInstagramCommentEvents,
  extractInstagramMessagingEvents,
  normalizeInstagramMessagingEvent,
} from "@/lib/instagram/webhook-events";
import { logger } from "@/lib/logger";
import {
  normalizeInstagramWebhookComment,
  resolveInstagramWebhookSourceData,
} from "@/lib/instagram/webhook-source";
import connectDB from "@/lib/mongoose";
import {
  enforceMetaWebhookSignature,
  getMetaWebhookSignatureMode,
  logWebhookSecurityEvent,
  readRawBodyAndJson,
} from "@/lib/webhook-auth";
import { NextRequest, NextResponse } from "next/server";

// Meta subscription verification for Instagram
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Failed to verify webhook", { status: 403 });
}

/**
 * Instagram webhook handler with support for multiple entries and event types.
 * Handles: messages, echoes, reactions, postbacks, reads, referrals, opt-ins,
 * standby, comments, and live comments.
 */
export async function POST(request: NextRequest) {
  const mode = getMetaWebhookSignatureMode();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const appSecret =
    process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;

  let body: unknown = {};
  let rawBody = "";
  try {
    const parsed = await readRawBodyAndJson(request);
    rawBody = parsed.rawBody;
    body = parsed.body;
  } catch {
    return NextResponse.json(
      {
        status: "ignored",
        reason: "invalid_payload",
      },
      { status: 400 }
    );
  }

  const securityDecision = enforceMetaWebhookSignature({
    rawBody,
    signatureHeader,
    appSecret,
    mode,
  });

  if (securityDecision.reasonCode) {
    logWebhookSecurityEvent({
      provider: "instagram",
      route: "/api/webhooks/instagram",
      reasonCode: securityDecision.reasonCode,
      mode,
      status: securityDecision.allowed ? "allowed" : "denied",
    });
  }

  if (!securityDecision.allowed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await connectDB();

  try {
    const safeBody = body as { entry?: unknown[] };
    const entries = Array.isArray(safeBody?.entry) ? safeBody.entry : [];
    if (entries.length === 0) {
      return NextResponse.json({
        status: "ignored",
        reason: "invalid_payload",
      });
    }

    logger.info("instagram.webhook_received", {
      entries: entries.length,
    });

    let processed = 0;
    let ignored = 0;

    const seenEventKeys = new Set<string>();

    for (const rawEntry of entries) {
      const entry = (rawEntry || {}) as Record<string, unknown>;
      const entryId = String(entry.id || "");
      const messagingEvents = extractInstagramMessagingEvents(entry);

      const commentEvents = extractInstagramCommentEvents(entry);

      for (const comment of commentEvents) {
        const commentId = String(comment.id || "");
        if (seenEventKeys.has(`comment:${commentId}`)) {
          ignored++;
          continue;
        }
        seenEventKeys.add(`comment:${commentId}`);

        const sourceData = await resolveInstagramWebhookSourceData("", entryId);
        if (!sourceData) {
          ignored++;
          continue;
        }

        await handleInstagramComment(
          normalizeInstagramWebhookComment(comment),
          sourceData
        );
        processed++;
      }

      for (const messaging of messagingEvents) {
        const eventDedupKey = buildInstagramMessagingDedupKey(messaging);
        if (seenEventKeys.has(eventDedupKey)) {
          ignored++;
          continue;
        }
        seenEventKeys.add(eventDedupKey);

        if (!messaging?.recipient?.id || !messaging?.sender?.id) {
          ignored++;
          continue;
        }

        const recipientId = String(messaging.recipient.id);
        const sourceData = await resolveInstagramWebhookSourceData(
          recipientId,
          entryId
        );
        if (!sourceData) {
          ignored++;
          continue;
        }

        const normalizedEvent = normalizeInstagramMessagingEvent(messaging);

        const kind = classifyInstagramMessagingEvent(normalizedEvent);
        switch (kind) {
          case "message_echo":
            await handleMessageEcho(normalizedEvent, sourceData);
            processed++;
            break;
          case "message":
            await handleIncomingMessage(normalizedEvent, sourceData);
            processed++;
            break;
          case "reaction":
            await handleReaction(normalizedEvent, sourceData);
            processed++;
            break;
          case "postback":
            await handlePostback(normalizedEvent, sourceData);
            processed++;
            break;
          case "delivery":
            await handleDelivery(normalizedEvent, sourceData);
            processed++;
            break;
          case "read":
            await handleRead(normalizedEvent, sourceData);
            processed++;
            break;
          case "referral":
            await handleReferral(normalizedEvent, sourceData);
            processed++;
            break;
          case "optin":
            await handleOptin(normalizedEvent, sourceData);
            processed++;
            break;
          case "standby":
            await handleStandby(normalizedEvent, sourceData);
            processed++;
            break;
          default:
            ignored++;
            break;
        }
      }
    }

    return NextResponse.json({
      status: "ok",
      processed,
      ignored,
    });
  } catch (error) {
    logger.error("instagram.webhook_failed", error);
    return new Response(JSON.stringify({ error: "Server error: " + error }), {
      status: 500,
    });
  }
}
