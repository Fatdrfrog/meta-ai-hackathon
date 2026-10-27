import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { decryptMaybeString } from "@/lib/crypto";
import connectDB from "@/lib/mongoose";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import WebsiteCommerceSettingsModel, {
  type WebsiteCommerceSettings,
} from "@/models/website-commerce-settings";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import type {
  Source,
  WebWidgetCredentials,
  WhatsAppStoredCredentials,
} from "@icecore/shared/types/sources";

export const WEBSITE_COMMERCE_EVENT_BODY_LIMIT = 512 * 1024;
export const WEBSITE_COMMERCE_GENERIC_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
export const SHOPIFY_COMMERCE_TOPICS = [
  "orders/create",
  "orders/paid",
  "orders/cancelled",
  "refunds/create",
] as const;

export type StoreEvent = {
  eventId: string;
  provider: "generic" | "shopify" | "tilda";
  workspaceId: string;
  widgetSourceId: string;
  cartId?: string;
  checkoutId?: string;
  orderId: string;
  type: "order_placed" | "checkout_closed" | "purchase" | "refund";
  occurredAt: string;
  transactionId?: string;
  purchaseTransactionId?: string;
  value?: number;
  currency?: string;
};

type WidgetCommerceSource = Source & {
  type: "web_widget";
  credentials: WebWidgetCredentials;
};
type WhatsAppCommerceSource = Source & {
  type: "whatsapp";
  credentials: WhatsAppStoredCredentials;
};

export type WebsiteCommerceContext = {
  widgetSource: WidgetCommerceSource;
  settings: WebsiteCommerceSettings;
  whatsappSource: WhatsAppCommerceSource;
};

export class WebsiteCommerceIntegrationError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 503,
    readonly code:
      | "source_not_found"
      | "source_lookup_unavailable"
      | "commerce_disabled"
      | "whatsapp_unavailable"
  ) {
    super(message);
  }
}

export class StoreEventValidationError extends Error {
  constructor(
    message = "Invalid store event",
    readonly status = 400
  ) {
    super(message);
  }
}

export async function resolveWebsiteCommerceContext(
  widgetSourceId: string
): Promise<WebsiteCommerceContext> {
  const widgetLookup = await fetchSourceWithCredentialsResult(
    widgetSourceId,
    "web_widget"
  );
  if (!widgetLookup.ok) {
    throw new WebsiteCommerceIntegrationError(
      "Website commerce source lookup is unavailable",
      503,
      "source_lookup_unavailable"
    );
  }
  const widgetSource = widgetLookup.source;
  if (
    !widgetSource ||
    widgetSource.type !== "web_widget" ||
    widgetSource.id !== widgetSourceId ||
    (widgetSource.credentials as WebWidgetCredentials).status !== "active"
  ) {
    throw new WebsiteCommerceIntegrationError(
      "Website commerce source not found",
      404,
      "source_not_found"
    );
  }

  await connectDB();
  const settings = await WebsiteCommerceSettingsModel.findOne({
    widgetSourceId,
    workspaceId: widgetSource.workspace_id,
    enabled: true,
  }).lean<WebsiteCommerceSettings | null>();
  if (!settings?.whatsappSourceId) {
    throw new WebsiteCommerceIntegrationError(
      "Website commerce is disabled",
      409,
      "commerce_disabled"
    );
  }

  const whatsappLookup = await fetchSourceWithCredentialsResult(
    settings.whatsappSourceId,
    "whatsapp"
  );
  if (!whatsappLookup.ok) {
    throw new WebsiteCommerceIntegrationError(
      "WhatsApp source lookup is unavailable",
      503,
      "source_lookup_unavailable"
    );
  }
  const whatsappSource = whatsappLookup.source;
  const normalized = normalizeWhatsAppCredentials(whatsappSource?.credentials);
  if (
    !whatsappSource ||
    whatsappSource.type !== "whatsapp" ||
    whatsappSource.id !== settings.whatsappSourceId ||
    whatsappSource.workspace_id !== widgetSource.workspace_id ||
    isWhatsAppCloudApiMessagingSuspended(whatsappSource.credentials) ||
    !normalized.phoneNumberId ||
    !normalized.accessToken
  ) {
    throw new WebsiteCommerceIntegrationError(
      "Configured WhatsApp source is unavailable",
      409,
      "whatsapp_unavailable"
    );
  }

  return {
    widgetSource: widgetSource as WidgetCommerceSource,
    settings,
    whatsappSource: whatsappSource as WhatsAppCommerceSource,
  };
}

function invalid(message = "Invalid store event"): never {
  throw new StoreEventValidationError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function identity(value: unknown, label = "event identity"): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`Invalid ${label}`);
  }
  return value.trim();
}

function optionalIdentity(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : identity(value, label);
}

function providerIdentity(value: unknown, label: string): string {
  if (typeof value === "string") return identity(value, label);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return invalid(`Invalid ${label}`);
}

function occurredAt(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    return invalid("Invalid event time");
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ||
    date.getTime() >
      Date.now() + WEBSITE_COMMERCE_GENERIC_TIMESTAMP_TOLERANCE_SECONDS * 1000
  ) {
    return invalid("Invalid event time");
  }
  return date.toISOString();
}

function money(value: unknown): number {
  const amount =
    typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 99_999_999.99 ||
    Math.round(amount * 100) / 100 !== amount
  ) {
    return invalid("Invalid paid amount");
  }
  return amount;
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{3}$/i.test(value.trim())) {
    return invalid("Invalid currency");
  }
  return value.trim().toUpperCase();
}

function requireCorrelation(event: StoreEvent): StoreEvent {
  if (!event.cartId && !event.checkoutId) {
    return invalid("Store event is missing cart or checkout correlation");
  }
  return event;
}

function validateFinancialFields(event: StoreEvent): StoreEvent {
  if (event.type === "purchase") {
    if (
      !event.transactionId ||
      event.purchaseTransactionId ||
      event.value === undefined ||
      !event.currency
    ) {
      return invalid("Invalid purchase event");
    }
  } else if (event.type === "refund") {
    if (
      !event.transactionId ||
      !event.purchaseTransactionId ||
      event.value === undefined ||
      !event.currency
    ) {
      return invalid("Invalid refund event");
    }
  } else if (
    event.transactionId ||
    event.purchaseTransactionId ||
    event.value !== undefined ||
    event.currency
  ) {
    return invalid("Non-payment event contains payment fields");
  }
  return event;
}

export function normalizeGenericStoreEvent(
  input: unknown,
  scope: { workspaceId: string; widgetSourceId: string }
): StoreEvent {
  const data = record(input);
  const allowed = new Set([
    "eventId",
    "cartId",
    "checkoutId",
    "orderId",
    "type",
    "occurredAt",
    "transactionId",
    "purchaseTransactionId",
    "value",
    "currency",
  ]);
  if (Object.keys(data).some(key => !allowed.has(key))) return invalid();
  if (
    data.type !== "order_placed" &&
    data.type !== "checkout_closed" &&
    data.type !== "purchase" &&
    data.type !== "refund"
  ) {
    return invalid();
  }
  const event: StoreEvent = {
    eventId: identity(data.eventId, "event ID"),
    provider: "generic",
    workspaceId: scope.workspaceId,
    widgetSourceId: scope.widgetSourceId,
    ...(optionalIdentity(data.cartId, "cart ID")
      ? { cartId: optionalIdentity(data.cartId, "cart ID") }
      : {}),
    ...(optionalIdentity(data.checkoutId, "checkout ID")
      ? { checkoutId: optionalIdentity(data.checkoutId, "checkout ID") }
      : {}),
    orderId: identity(data.orderId, "order ID"),
    type: data.type,
    occurredAt: occurredAt(data.occurredAt),
    ...(data.transactionId !== undefined
      ? { transactionId: identity(data.transactionId, "transaction ID") }
      : {}),
    ...(data.purchaseTransactionId !== undefined
      ? {
          purchaseTransactionId: identity(
            data.purchaseTransactionId,
            "purchase transaction ID"
          ),
        }
      : {}),
    ...(data.value !== undefined ? { value: money(data.value) } : {}),
    ...(data.currency !== undefined
      ? { currency: currency(data.currency) }
      : {}),
  };
  return validateFinancialFields(requireCorrelation(event));
}

export function normalizeShopifyShopDomain(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return invalid("Invalid Shopify shop domain");
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length > 255 ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
  ) {
    return invalid("Invalid Shopify shop domain");
  }
  return domain;
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyShopifyWebhookSignature(
  rawBody: Uint8Array,
  signature: string | null,
  secret: string
): boolean {
  if (
    !signature ||
    !secret ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.trim())
  ) {
    return false;
  }
  const provided = Buffer.from(signature.trim(), "base64");
  if (provided.toString("base64") !== signature.trim()) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return equalBytes(provided, expected);
}

export function verifyTildaWebhookToken(
  provided: string | null,
  encryptedExpected: WebsiteCommerceSettings["tildaToken"]
): boolean {
  const expected = encryptedExpected
    ? decryptMaybeString(encryptedExpected)
    : "";
  if (!provided || !expected) return false;
  return equalBytes(Buffer.from(provided), Buffer.from(expected));
}

export function parseGenericWebhookTimestamp(
  value: string | null,
  nowMs = Date.now()
): string | null {
  if (!/^[0-9]{10}$/.test(value || "")) return null;
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(nowMs / 1000 - seconds) >
      WEBSITE_COMMERCE_GENERIC_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return null;
  }
  return String(seconds);
}

function shopifyOrderId(data: Record<string, unknown>, topic: string): string {
  const canonicalOrderId = (value: unknown) => {
    const normalized = providerIdentity(value, "Shopify order ID");
    if (normalized.startsWith("gid://shopify/Order/")) return normalized;
    return /^\d+$/.test(normalized)
      ? `gid://shopify/Order/${normalized}`
      : normalized;
  };
  if (topic === "refunds/create") {
    return canonicalOrderId(data.order_id);
  }
  return data.admin_graphql_api_id !== undefined
    ? canonicalOrderId(data.admin_graphql_api_id)
    : canonicalOrderId(data.id);
}

export function readShopifyOrderId(input: unknown, topic: string): string {
  return shopifyOrderId(record(input), topic);
}

/** Shopify serializes REST IDs as JSON numbers that can exceed JS safe integers. */
export function readShopifyOrderIdFromRawBody(
  rawBody: string,
  input: unknown,
  topic: string
): string {
  if (topic !== "refunds/create") return readShopifyOrderId(input, topic);
  const match = rawBody.match(
    /"order_id"\s*:\s*(?:"([0-9]{1,30})"|([0-9]{1,30}))/
  );
  const exactId = match?.[1] || match?.[2];
  if (!exactId) return readShopifyOrderId(input, topic);
  return `gid://shopify/Order/${exactId}`;
}

type ShopifyTransaction = {
  id: string;
  amount: number;
  currency?: string;
};

function transactionIdentity(data: Record<string, unknown>): string {
  return data.admin_graphql_api_id !== undefined
    ? providerIdentity(data.admin_graphql_api_id, "Shopify transaction ID")
    : providerIdentity(data.id, "Shopify transaction ID");
}

function relevantShopifyTransactions(
  input: unknown,
  kinds: ReadonlySet<string>
): ShopifyTransaction[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return invalid("Invalid Shopify transactions");
  const values: ShopifyTransaction[] = [];
  for (const item of input) {
    const data = record(item);
    const kind = typeof data.kind === "string" ? data.kind.toLowerCase() : "";
    const status =
      typeof data.status === "string" ? data.status.toLowerCase() : "";
    const gateway =
      typeof data.gateway === "string" ? data.gateway.toLowerCase() : "";
    if (
      !kinds.has(kind) ||
      status !== "success" ||
      gateway === "gift_card" ||
      gateway === "gift card"
    ) {
      continue;
    }
    values.push({
      id: transactionIdentity(data),
      amount: money(data.amount),
      ...(data.currency ? { currency: currency(data.currency) } : {}),
    });
  }
  return values;
}

function aggregateTransactionId(
  prefix: string,
  transactions: ShopifyTransaction[]
): string {
  const ids = [...transactions.map(transaction => transaction.id)].sort();
  if (ids.length === 1) return ids[0];
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(ids))
    .digest("hex")}`;
}

function assertTransactionCurrencies(
  transactions: ShopifyTransaction[],
  fallback: string
): string {
  const currencies = new Set(
    transactions.map(transaction => transaction.currency || fallback)
  );
  if (currencies.size !== 1)
    return invalid("Shopify transactions use mixed currencies");
  return [...currencies][0];
}

export type ShopifyPurchaseCorrelation = {
  cartId?: string;
  checkoutId?: string;
  transactionId?: string;
  currency?: string;
};

export function normalizeShopifyStoreEvent(
  input: unknown,
  metadata: {
    eventId: string;
    topic: string;
    triggeredAt?: string | null;
    workspaceId: string;
    widgetSourceId: string;
    previousPurchase?: ShopifyPurchaseCorrelation | null;
    orderId?: string;
  }
): StoreEvent {
  if (
    !(SHOPIFY_COMMERCE_TOPICS as readonly string[]).includes(metadata.topic)
  ) {
    return invalid("Unsupported Shopify webhook topic");
  }
  const data = record(input);
  const orderId = metadata.orderId || shopifyOrderId(data, metadata.topic);
  const cartId =
    optionalIdentity(data.cart_token, "Shopify cart token") ||
    metadata.previousPurchase?.cartId;
  const checkoutId =
    optionalIdentity(data.checkout_token, "Shopify checkout token") ||
    metadata.previousPurchase?.checkoutId;
  const at = occurredAt(
    metadata.triggeredAt ||
      data.processed_at ||
      data.updated_at ||
      data.created_at
  );
  const base = {
    eventId: identity(metadata.eventId, "Shopify webhook ID"),
    provider: "shopify" as const,
    workspaceId: metadata.workspaceId,
    widgetSourceId: metadata.widgetSourceId,
    ...(cartId ? { cartId } : {}),
    ...(checkoutId ? { checkoutId } : {}),
    orderId,
    occurredAt: at,
  };

  if (metadata.topic === "orders/create") {
    return requireCorrelation({ ...base, type: "order_placed" });
  }
  if (metadata.topic === "orders/cancelled") {
    return requireCorrelation({ ...base, type: "checkout_closed" });
  }
  if (metadata.topic === "orders/paid") {
    const transactionCurrency = currency(
      data.currency || data.presentment_currency
    );
    const transactions = relevantShopifyTransactions(
      data.transactions,
      new Set(["sale", "capture"])
    );
    const purchaseValue =
      transactions.length > 0
        ? Math.round(
            transactions.reduce(
              (sum, transaction) => sum + transaction.amount,
              0
            ) * 100
          ) / 100
        : money(data.current_total_price || data.total_price);
    const purchaseCurrency = assertTransactionCurrencies(
      transactions,
      transactionCurrency
    );
    const transactionId =
      transactions.length > 0
        ? aggregateTransactionId("shopify-paid", transactions)
        : `shopify-order-paid:${orderId}`;
    return validateFinancialFields(
      requireCorrelation({
        ...base,
        type: "purchase",
        transactionId,
        value: money(purchaseValue),
        currency: purchaseCurrency,
      })
    );
  }

  const previous = metadata.previousPurchase;
  if (!previous?.transactionId || !previous.currency) {
    return invalid("Shopify refund is missing its correlated purchase");
  }
  const transactions = relevantShopifyTransactions(
    data.transactions,
    new Set(["refund"])
  );
  if (transactions.length === 0) {
    return invalid("Shopify refund has no successful refundable transaction");
  }
  const refundCurrency = assertTransactionCurrencies(
    transactions,
    currency(previous.currency)
  );
  const refundValue =
    Math.round(
      transactions.reduce((sum, transaction) => sum + transaction.amount, 0) *
        100
    ) / 100;
  return validateFinancialFields(
    requireCorrelation({
      ...base,
      type: "refund",
      transactionId: aggregateTransactionId("shopify-refund", transactions),
      purchaseTransactionId: previous.transactionId,
      value: money(refundValue),
      currency: refundCurrency,
    })
  );
}

function oneFormValue(
  params: URLSearchParams,
  name: string
): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) return invalid(`Duplicate Tilda field ${name}`);
  return values[0];
}

export function normalizeTildaStoreEvent(
  params: URLSearchParams,
  scope: { workspaceId: string; widgetSourceId: string; receivedAt?: Date }
): StoreEvent {
  if ([...params.keys()].length > 200)
    return invalid("Too many Tilda form fields");
  for (const [key, value] of params) {
    if (key.length > 200 || value.length > 8_192) {
      return invalid("Tilda form field is too large");
    }
  }
  const tranid = identity(oneFormValue(params, "tranid"), "Tilda lead ID");
  const cartId = identity(
    oneFormValue(params, "airi_cart_id"),
    "Tilda cart ID"
  );
  const receivedAt = scope.receivedAt || new Date();
  if (!Number.isFinite(receivedAt.getTime()))
    return invalid("Invalid receive time");
  return {
    eventId: `form:${tranid}`,
    provider: "tilda",
    workspaceId: scope.workspaceId,
    widgetSourceId: scope.widgetSourceId,
    cartId,
    orderId: tranid,
    type: "order_placed",
    occurredAt: receivedAt.toISOString(),
  };
}
