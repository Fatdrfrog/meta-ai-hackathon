import { createHash } from "node:crypto";

import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import WebsiteCommerceEvent, {
  type WebsiteCommerceEventRow,
} from "@/models/website-commerce-event";
import WebsiteCommerceSettings from "@/models/website-commerce-settings";
import { WebsiteCartError } from "./cart-state";
import type { ShopifyPurchaseCorrelation, StoreEvent } from "./integrations";

export type { StoreEvent } from "./integrations";

const STORE_EVENT_LEASE_MS = 60_000;
const STORE_EVENT_MAX_UNMATCHED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class WebsiteCommerceEventError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 500
  ) {
    super(message);
  }
}

function eventHashInput(event: StoreEvent) {
  return {
    eventId: event.eventId,
    provider: event.provider,
    workspaceId: event.workspaceId,
    widgetSourceId: event.widgetSourceId,
    cartId: event.cartId || null,
    checkoutId: event.checkoutId || null,
    orderId: event.orderId,
    type: event.type,
    occurredAt: event.occurredAt,
    transactionId: event.transactionId || null,
    purchaseTransactionId: event.purchaseTransactionId || null,
    value: event.value ?? null,
    currency: event.currency || null,
  };
}

export function websiteCommerceEventHash(event: StoreEvent): string {
  return createHash("sha256")
    .update(JSON.stringify(eventHashInput(event)))
    .digest("hex");
}

export function assertMatchingWebsiteCommerceEventReceipt(
  existing: Pick<WebsiteCommerceEventRow, "payloadHash"> | null,
  event: StoreEvent
): "new" | "duplicate" {
  if (!existing) return "new";
  if (existing.payloadHash !== websiteCommerceEventHash(event)) {
    throw new WebsiteCommerceEventError(
      "Store event ID already has different facts",
      409
    );
  }
  return "duplicate";
}

function persistedEvent(event: StoreEvent, payloadHash: string) {
  return {
    ...eventHashInput(event),
    cartId: event.cartId,
    checkoutId: event.checkoutId,
    transactionId: event.transactionId,
    purchaseTransactionId: event.purchaseTransactionId,
    value: event.value,
    currency: event.currency,
    occurredAt: new Date(event.occurredAt),
    payloadHash,
    status: "pending" as const,
    attempts: 0,
    nextAttemptAt: new Date(),
  };
}

export async function storeWebsiteCommerceEvent(event: StoreEvent): Promise<{
  created: boolean;
  payloadHash: string;
}> {
  await connectDB();
  const payloadHash = websiteCommerceEventHash(event);
  let created = false;
  try {
    await WebsiteCommerceEvent.create(persistedEvent(event, payloadHash));
    created = true;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const existing = await WebsiteCommerceEvent.findOne({
      widgetSourceId: event.widgetSourceId,
      provider: event.provider,
      eventId: event.eventId,
    })
      .select("payloadHash")
      .lean<Pick<WebsiteCommerceEventRow, "payloadHash"> | null>();
    if (!existing) {
      throw new WebsiteCommerceEventError(
        "Store event receipt could not be reconciled",
        500
      );
    }
    assertMatchingWebsiteCommerceEventReceipt(existing, event);
  }

  await WebsiteCommerceSettings.updateOne(
    {
      widgetSourceId: event.widgetSourceId,
      workspaceId: event.workspaceId,
    },
    { $max: { lastEventAt: new Date() } }
  );
  return { created, payloadHash };
}

export async function findShopifyPurchaseCorrelation(params: {
  widgetSourceId: string;
  orderId: string;
}): Promise<ShopifyPurchaseCorrelation | null> {
  await connectDB();
  const event = await WebsiteCommerceEvent.findOne({
    widgetSourceId: params.widgetSourceId,
    provider: "shopify",
    orderId: params.orderId,
    type: "purchase",
  })
    .sort({ occurredAt: -1, _id: -1 })
    .select("cartId checkoutId transactionId currency")
    .lean<Pick<
      WebsiteCommerceEventRow,
      "cartId" | "checkoutId" | "transactionId" | "currency"
    > | null>();
  if (!event?.transactionId || !event.currency) return null;
  return {
    ...(event.cartId ? { cartId: event.cartId } : {}),
    ...(event.checkoutId ? { checkoutId: event.checkoutId } : {}),
    transactionId: event.transactionId,
    currency: event.currency,
  };
}

function asStoreEvent(row: WebsiteCommerceEventRow): StoreEvent {
  return {
    eventId: row.eventId,
    provider: row.provider,
    workspaceId: row.workspaceId,
    widgetSourceId: row.widgetSourceId,
    ...(row.cartId ? { cartId: row.cartId } : {}),
    ...(row.checkoutId ? { checkoutId: row.checkoutId } : {}),
    orderId: row.orderId,
    type: row.type,
    occurredAt: new Date(row.occurredAt).toISOString(),
    ...(row.transactionId ? { transactionId: row.transactionId } : {}),
    ...(row.purchaseTransactionId
      ? { purchaseTransactionId: row.purchaseTransactionId }
      : {}),
    ...(row.value !== undefined ? { value: row.value } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
  };
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.min(8, attempts));
}

function safeError(error: unknown): string {
  return error instanceof Error && error.name
    ? `Store event processing failed (${error.name.slice(0, 80)})`
    : "Store event processing failed";
}

async function isPermanentStoreEventError(error: unknown): Promise<boolean> {
  if (error instanceof WebsiteCartError && error.status === 409) return true;
  const { CommerceEventError } = await import(
    "@/lib/conversions/commerce-events"
  );
  return error instanceof CommerceEventError && error.status === 409;
}

export type DrainWebsiteCommerceEventsResult = {
  claimed: number;
  completed: number;
  waiting: number;
  retried: number;
  unmatched: number;
};

export async function drainWebsiteCommerceEvents(params: {
  limit: number;
  deadlineAtMs: number;
}): Promise<DrainWebsiteCommerceEventsResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit || 1)));
  const result: DrainWebsiteCommerceEventsResult = {
    claimed: 0,
    completed: 0,
    waiting: 0,
    retried: 0,
    unmatched: 0,
  };
  await connectDB();

  for (let index = 0; index < limit; index += 1) {
    if (Date.now() >= params.deadlineAtMs) break;
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + STORE_EVENT_LEASE_MS);
    const claimed = await WebsiteCommerceEvent.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $lte: now } },
      {
        $set: { nextAttemptAt: leaseUntil },
        $inc: { attempts: 1 },
        $unset: { error: 1 },
      },
      { new: true, sort: { nextAttemptAt: 1, _id: 1 } }
    ).lean<(WebsiteCommerceEventRow & { _id: unknown }) | null>();
    if (!claimed) break;
    result.claimed += 1;

    try {
      const { applyWebsiteStoreEvent } = await import("./carts");
      const applied = await applyWebsiteStoreEvent(asStoreEvent(claimed));
      if (applied) {
        const completed = await WebsiteCommerceEvent.updateOne(
          { _id: claimed._id, status: "pending", attempts: claimed.attempts },
          {
            $set: { status: "completed", completedAt: new Date() },
            $unset: { error: 1 },
          }
        );
        if (completed.modifiedCount === 1) result.completed += 1;
        continue;
      }

      const expired =
        now.getTime() - new Date(claimed.createdAt).getTime() >=
        STORE_EVENT_MAX_UNMATCHED_AGE_MS;
      const waitingUpdate = expired
        ? {
            $set: {
              status: "unmatched",
              completedAt: new Date(),
              error: "Cart identity was not linked within 30 days",
            },
          }
        : {
            $set: {
              nextAttemptAt: new Date(
                now.getTime() + retryDelayMs(claimed.attempts)
              ),
              error: "Waiting for cart identity",
            },
          };
      const saved = await WebsiteCommerceEvent.updateOne(
        { _id: claimed._id, status: "pending", attempts: claimed.attempts },
        waitingUpdate
      );
      if (saved.modifiedCount === 1) {
        if (expired) result.unmatched += 1;
        else result.waiting += 1;
      }
    } catch (error) {
      if (await isPermanentStoreEventError(error)) {
        const unmatched = await WebsiteCommerceEvent.updateOne(
          { _id: claimed._id, status: "pending", attempts: claimed.attempts },
          {
            $set: {
              status: "unmatched",
              completedAt: new Date(),
              error: safeError(error),
            },
          }
        );
        if (unmatched.modifiedCount === 1) result.unmatched += 1;
        continue;
      }
      const retried = await WebsiteCommerceEvent.updateOne(
        { _id: claimed._id, status: "pending", attempts: claimed.attempts },
        {
          $set: {
            nextAttemptAt: new Date(
              now.getTime() + retryDelayMs(claimed.attempts)
            ),
            error: safeError(error),
          },
        }
      );
      if (retried.modifiedCount === 1) result.retried += 1;
    }
  }
  return result;
}
