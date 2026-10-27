import { POST as postCampaignBulkSend } from "@/app/api/campaigns/bulk-send/route";
import { NextResponse } from "next/server";
import { isRecord } from "@icecore/shared/lib/value-utils";

function adaptLegacyWhatsAppBulkSendBody(
  body: Record<string, unknown>
): Record<string, unknown> {
  const marketingMessagePricing = isRecord(body.marketingMessagePricing)
    ? body.marketingMessagePricing
    : null;
  const pricing =
    marketingMessagePricing?.perMessageBidMultiplier ??
    body.perMessageBidMultiplier ??
    body.per_message_bid_multiplier;

  return {
    ...body,
    channel: typeof body.channel === "string" ? body.channel : "whatsapp",
    ...(pricing === undefined || marketingMessagePricing
      ? {}
      : { marketingMessagePricing: { perMessageBidMultiplier: pricing } }),
  };
}

/**
 * Legacy compatibility endpoint.
 *
 * The canonical sender is `/api/campaigns/bulk-send`; keep this route as a
 * small adapter so old clients do not bypass opt-in, dispatch, history, or
 * recipient-limit checks.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  return postCampaignBulkSend(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(adaptLegacyWhatsAppBulkSendBody(body)),
    })
  );
}
