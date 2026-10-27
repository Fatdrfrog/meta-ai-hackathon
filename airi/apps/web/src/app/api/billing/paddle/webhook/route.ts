import { getPaddleBillingConfig } from "@/lib/billing/config";
import { processPaddleWebhook } from "@/lib/billing/service";
import { verifyPaddleWebhookSignature } from "@/lib/billing/paddle-client";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

class PayloadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadParseError";
  }
}

function parseJsonPayload(rawBody: string): Record<string, unknown> {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new PayloadParseError("Malformed JSON payload");
  }
}

export async function POST(request: Request) {
  const config = getPaddleBillingConfig();
  if (!config.ok) {
    return NextResponse.json(
      {
        error: `Paddle is not configured. Missing: ${config.missing.join(", ")}`,
      },
      { status: 503 }
    );
  }

  try {
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("paddle-signature");
    const verified = verifyPaddleWebhookSignature({
      rawBody,
      signatureHeader,
      secret: config.webhookSecret,
    });
    if (!verified) {
      return NextResponse.json(
        { error: "Invalid Paddle signature" },
        { status: 401 }
      );
    }

    const payload = parseJsonPayload(rawBody);
    const result = await processPaddleWebhook(payload);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json({ ok: true, result: result.result });
  } catch (error) {
    if (error instanceof PayloadParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logger.error("billing.paddle.webhook_failed", error, {
      event: "billing.paddle.webhook_failed",
    });
    return NextResponse.json(
      { error: "Failed to process Paddle webhook" },
      { status: 500 }
    );
  }
}
