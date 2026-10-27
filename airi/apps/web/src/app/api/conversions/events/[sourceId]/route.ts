import { NextResponse } from "next/server";
import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import {
  CommerceEventError,
  recordCommerceEvent,
} from "@/lib/conversions/commerce-events";
import { decryptMaybeString } from "@/lib/crypto";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { verifyMetaSignature } from "@/lib/webhook-auth";
import { isRemovedWhatsAppSource } from "@/lib/integrations/source-status";
import {
  recordCustomerBehaviorEvent,
  CustomerBehaviorEventError,
} from "@/lib/customers/behavior-events";

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string }> }
) {
  try {
    const { sourceId } = await context.params;
    const timestamp = request.headers.get("x-airi-timestamp");
    if (
      !/^[0-9]{10}$/.test(timestamp || "") ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    ) {
      return NextResponse.json(
        { error: "Invalid webhook authentication" },
        { status: 401 }
      );
    }
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sourceId)) {
      return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    }
    const bytes = await readBodyBytesWithinLimit(request, 16 * 1024);
    const lookup = await fetchSourceWithCredentialsResult(sourceId, "whatsapp");
    if (!lookup.ok)
      return NextResponse.json(
        { error: "Source lookup unavailable" },
        { status: 503 }
      );
    const source = lookup.source;
    const credentials = source?.credentials as
      | Record<string, unknown>
      | undefined;
    const encryptedSecret = credentials?.sales_webhook_secret;
    const secret =
      encryptedSecret && typeof encryptedSecret === "object"
        ? decryptMaybeString(encryptedSecret)
        : "";
    const signedBytes = Buffer.concat([
      Buffer.from(timestamp + ".", "utf8"),
      bytes,
    ]);
    if (
      !source ||
      source.type !== "whatsapp" ||
      isRemovedWhatsAppSource(source) ||
      credentials?.sales_webhook_enabled !== true ||
      !secret ||
      !verifyMetaSignature(
        signedBytes,
        request.headers.get("x-airi-signature"),
        secret
      )
    ) {
      return NextResponse.json(
        { error: "Invalid webhook authentication" },
        { status: 401 }
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const eventType =
      input && typeof input === "object"
        ? (input as { eventType?: unknown }).eventType
        : null;
    if (
      [
        "checkout_started",
        "checkout_closed",
        "renewal_scheduled",
        "renewal_completed",
        "service_scheduled",
        "service_completed",
      ].includes(String(eventType))
    ) {
      return NextResponse.json(
        await recordCustomerBehaviorEvent({
          workspaceId: source.workspace_id,
          sourceId: source.id,
          event: input,
        })
      );
    }
    return NextResponse.json(await recordCommerceEvent({ source, input }));
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError)
      return NextResponse.json(
        { error: "Body exceeds 16 KiB" },
        { status: 413 }
      );
    if (
      error instanceof CommerceEventError ||
      error instanceof CustomerBehaviorEventError
    )
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    // Keep provider credentials and payloads out of the public error response.
    return NextResponse.json(
      { error: "Failed to record commerce event" },
      { status: 500 }
    );
  }
}
