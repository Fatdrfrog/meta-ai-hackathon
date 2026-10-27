import { NextResponse } from "next/server";

import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import {
  normalizeGenericStoreEvent,
  normalizeShopifyShopDomain,
  normalizeShopifyStoreEvent,
  normalizeTildaStoreEvent,
  parseGenericWebhookTimestamp,
  readShopifyOrderIdFromRawBody,
  resolveWebsiteCommerceContext,
  SHOPIFY_COMMERCE_TOPICS,
  StoreEventValidationError,
  verifyShopifyWebhookSignature,
  verifyTildaWebhookToken,
  WEBSITE_COMMERCE_EVENT_BODY_LIMIT,
  WebsiteCommerceIntegrationError,
} from "@/lib/commerce/integrations";
import {
  findShopifyPurchaseCorrelation,
  storeWebsiteCommerceEvent,
  WebsiteCommerceEventError,
} from "@/lib/commerce/store-events";
import { decryptMaybeString } from "@/lib/crypto";
import { verifyMetaSignature } from "@/lib/webhook-auth";

type RouteContext = {
  params: Promise<{ sourceId: string; provider: string }>;
};

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StoreEventValidationError("Invalid request encoding");
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof StoreEventValidationError) throw error;
    throw new StoreEventValidationError("Invalid JSON body");
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { sourceId, provider } = await params;
  if (
    provider !== "generic" &&
    provider !== "shopify" &&
    provider !== "tilda"
  ) {
    return jsonError("Unsupported commerce provider", 404);
  }

  try {
    const bytes = await readBodyBytesWithinLimit(
      request,
      WEBSITE_COMMERCE_EVENT_BODY_LIMIT
    );
    const context = await resolveWebsiteCommerceContext(sourceId);
    const scope = {
      workspaceId: context.widgetSource.workspace_id,
      widgetSourceId: context.widgetSource.id,
    };
    let event;

    if (provider === "generic") {
      const timestamp = parseGenericWebhookTimestamp(
        request.headers.get("x-airi-timestamp")
      );
      const secret = context.settings.webhookSecret
        ? decryptMaybeString(context.settings.webhookSecret)
        : "";
      const signedBytes = timestamp
        ? Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), bytes])
        : bytes;
      if (
        !timestamp ||
        !secret ||
        !verifyMetaSignature(
          signedBytes,
          request.headers.get("x-airi-signature"),
          secret
        )
      ) {
        return jsonError("Invalid webhook authentication", 401);
      }
      event = normalizeGenericStoreEvent(parseJson(bytes), scope);
    } else if (provider === "shopify") {
      const configuredDomain = context.settings.shopifyShopDomain;
      const secret = context.settings.shopifyWebhookSecret
        ? decryptMaybeString(context.settings.shopifyWebhookSecret)
        : "";
      let requestDomain: string | null = null;
      try {
        requestDomain = normalizeShopifyShopDomain(
          request.headers.get("x-shopify-shop-domain")
        );
      } catch {
        requestDomain = null;
      }
      if (
        !configuredDomain ||
        !secret ||
        requestDomain !== configuredDomain ||
        !verifyShopifyWebhookSignature(
          bytes,
          request.headers.get("x-shopify-hmac-sha256"),
          secret
        )
      ) {
        return jsonError("Invalid webhook authentication", 401);
      }
      const topic = request.headers.get("x-shopify-topic") || "";
      if (!(SHOPIFY_COMMERCE_TOPICS as readonly string[]).includes(topic)) {
        return jsonError("Unsupported Shopify webhook topic", 400);
      }
      const rawBody = decodeUtf8(bytes);
      const input = parseJson(bytes);
      const orderId = readShopifyOrderIdFromRawBody(rawBody, input, topic);
      const previousPurchase =
        topic === "refunds/create"
          ? await findShopifyPurchaseCorrelation({
              widgetSourceId: scope.widgetSourceId,
              orderId,
            })
          : null;
      event = normalizeShopifyStoreEvent(input, {
        ...scope,
        eventId: request.headers.get("x-shopify-webhook-id") || "",
        topic,
        triggeredAt: request.headers.get("x-shopify-triggered-at"),
        previousPurchase,
        orderId,
      });
    } else {
      if (
        !verifyTildaWebhookToken(
          new URL(request.url).searchParams.get("token"),
          context.settings.tildaToken
        )
      ) {
        return jsonError("Invalid webhook authentication", 401);
      }
      const contentType = request.headers.get("content-type") || "";
      if (
        !contentType
          .toLowerCase()
          .startsWith("application/x-www-form-urlencoded")
      ) {
        return jsonError("Invalid Tilda form body", 400);
      }
      event = normalizeTildaStoreEvent(
        new URLSearchParams(decodeUtf8(bytes)),
        scope
      );
    }

    const stored = await storeWebsiteCommerceEvent(event);
    return NextResponse.json(
      { accepted: true, deduplicated: !stored.created },
      {
        status: stored.created ? 202 : 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      return jsonError(
        `Body exceeds ${WEBSITE_COMMERCE_EVENT_BODY_LIMIT / 1024} KiB`,
        413
      );
    }
    if (error instanceof StoreEventValidationError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof WebsiteCommerceEventError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof WebsiteCommerceIntegrationError) {
      return jsonError(
        error.status === 503
          ? "Commerce integration lookup unavailable"
          : "Invalid webhook authentication",
        error.status === 503 ? 503 : 401
      );
    }
    return jsonError("Failed to accept commerce event", 500);
  }
}
