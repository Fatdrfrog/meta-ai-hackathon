import { createRequestLogger } from "@/lib/observability/server-logs";
import { enqueueWhatsAppWebhookEvents } from "@/lib/whatsapp/webhook-event-ingest";
import { buildWhatsAppWebhookLogSummary } from "@icecore/whatsapp/webhookLogSummary";
import {
  enforceMetaWebhookSignature,
  getMetaWebhookSignatureMode,
  logWebhookSecurityEvent,
  readRawBodyAndJson,
  verifyMetaSignature,
} from "@/lib/webhook-auth";
import connectDB from "@/lib/mongoose";
import { NextRequest, NextResponse } from "next/server";

export { GET } from "@/lib/whatsapp/webhook-verification";

export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  const routeTimings = {
    parseMs: 0,
    signatureMs: 0,
    connectDbMs: 0,
    enqueueMs: 0,
  };
  const mode = getMetaWebhookSignatureMode();
  const requestLogger = createRequestLogger("api.webhooks.whatsapp", request, {
    route: "/api/webhooks/whatsapp",
    signatureMode: mode,
    webhookKind: "event",
    ingestMode: "pubsub",
  });
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const appSecret = process.env.META_APP_SECRET;

  requestLogger.start("WhatsApp webhook payload received", {
    hasSignatureHeader: Boolean(signatureHeader),
    hasAppSecret: Boolean(appSecret),
  });

  let body: unknown;
  let rawBody = "";
  let webhookSummary: ReturnType<typeof buildWhatsAppWebhookLogSummary> | null =
    null;
  try {
    const parseStartedAt = Date.now();
    const parsed = await readRawBodyAndJson(request);
    rawBody = parsed.rawBody;
    body = parsed.body;
    webhookSummary = buildWhatsAppWebhookLogSummary({ body, rawBody });
    routeTimings.parseMs = Date.now() - parseStartedAt;
  } catch (error) {
    requestLogger.warn("WhatsApp webhook payload could not be parsed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  const signatureStartedAt = Date.now();
  const securityDecision = enforceMetaWebhookSignature({
    rawBody,
    signatureHeader,
    appSecret,
    mode,
  });
  // Log/off allow ingestion, but are not evidence of provider acceptance.
  // Preserve actual verification separately from the enforcement decision.
  const providerSignatureVerified = Boolean(
    appSecret && verifyMetaSignature(rawBody, signatureHeader, appSecret)
  );
  routeTimings.signatureMs = Date.now() - signatureStartedAt;

  if (securityDecision.reasonCode) {
    logWebhookSecurityEvent({
      provider: "whatsapp",
      route: "/api/webhooks/whatsapp",
      reasonCode: securityDecision.reasonCode,
      mode,
      status: securityDecision.allowed ? "allowed" : "denied",
    });
  }

  if (!securityDecision.allowed) {
    requestLogger.warn(
      "WhatsApp webhook request was denied by signature enforcement",
      {
        reasonCode: securityDecision.reasonCode ?? null,
        hasSignatureHeader: Boolean(signatureHeader),
        webhookSummary,
      }
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const connectStartedAt = Date.now();
    await connectDB();
    routeTimings.connectDbMs = Date.now() - connectStartedAt;
    const enqueueStartedAt = Date.now();
    const result = await enqueueWhatsAppWebhookEvents({
      body,
      rawBody,
      providerSignatureVerified,
    });
    routeTimings.enqueueMs = Date.now() - enqueueStartedAt;

    requestLogger.success("WhatsApp webhook events durably enqueued", {
      received: result.received,
      persisted: result.persisted,
      published: result.published,
      publishFailures: result.publishFailures,
      skippedAlreadyHandled: result.skippedAlreadyHandled,
      duplicateDeliveries: result.duplicateDeliveries,
      fields: result.fields,
      itemKinds: result.itemKinds,
      eventIds: result.eventIds.slice(0, 20),
      eventIdsTruncated: result.eventIdsTruncated,
      events: result.events,
      routeTimings: {
        ...routeTimings,
        totalBeforeResponseMs: Date.now() - routeStartedAt,
      },
      ingestTimings: result.timings,
      webhookSummary,
    });

    return NextResponse.json({
      status: "ok",
      ingest: "queued",
      received: result.received,
      persisted: result.persisted,
      published: result.published,
      publishFailures: result.publishFailures,
    });
  } catch (error) {
    requestLogger.error("WhatsApp webhook durable ingest failed", error, {
      routeTimings: {
        ...routeTimings,
        totalBeforeResponseMs: Date.now() - routeStartedAt,
      },
      webhookSummary,
    });
    return NextResponse.json(
      { error: "Failed to persist webhook event" },
      { status: 500 }
    );
  }
}
