import { isRecord } from "../lib/value-utils";

export const COMMERCE_TRACKING_EVENT_TYPES = [
  "cart_updated",
  "checkout_started",
  "checkout_closed",
  "order_placed",
  "purchase_reported",
] as const;

export type CommerceTrackingEventType =
  (typeof COMMERCE_TRACKING_EVENT_TYPES)[number];

export type CommerceTrackingItem = {
  id: string;
  name: string;
  quantity: number;
  price: number;
};

export type CommerceTrackingEvent = {
  eventId: string;
  type: CommerceTrackingEventType;
  cartId: string;
  occurredAt: string;
  items?: CommerceTrackingItem[];
  currency?: string;
  recoveryUrl?: string;
  checkoutId?: string;
  orderId?: string;
};

export type CommerceTrackingInput = Omit<
  CommerceTrackingEvent,
  "eventId" | "occurredAt" | "type"
> & {
  eventId?: string;
  occurredAt?: string;
};

export type CommerceCartStatus =
  | "cart"
  | "checkout"
  | "closed"
  | "ordered"
  | "purchase_reported"
  | "paid";

export type CommerceCartSummary = {
  cartId: string;
  status: CommerceCartStatus;
  itemCount: number;
  total: number;
  currency: string;
  recoveryUrl?: string;
  linked: boolean;
};

export type CommerceSessionRequest = {
  clientKey: string;
  action: "session";
  sessionToken?: string;
};

export type CommerceSessionResponse = {
  sessionToken: string;
  enabled: boolean;
};

export type CommerceEventsRequest = {
  clientKey: string;
  sessionToken: string;
  action: "events";
  events: CommerceTrackingEvent[];
};

export type CommerceEventsResponse = {
  carts: CommerceCartSummary[];
};

export type CommerceCartsRequest = {
  clientKey: string;
  sessionToken: string;
  action: "carts";
};

export type CommerceCartsResponse = {
  carts: CommerceCartSummary[];
};

export type CommerceHandoffRequest = {
  clientKey: string;
  sessionToken: string;
  action: "handoff";
  cartId: string;
  consent: true;
  locale?: string;
};

export type CommerceHandoffResponse = {
  url: string;
};

export const COMMERCE_TRACKING_MAX_EVENTS_PER_REQUEST = 20;
export const COMMERCE_TRACKING_MAX_ITEMS = 100;
export const COMMERCE_TRACKING_MAX_EVENT_ID_LENGTH = 128;
export const COMMERCE_TRACKING_MAX_CART_ID_LENGTH = 200;
export const COMMERCE_TRACKING_MAX_ITEM_ID_LENGTH = 128;
export const COMMERCE_TRACKING_MAX_ITEM_NAME_LENGTH = 200;
export const COMMERCE_TRACKING_MAX_CART_TOTAL = 99_999_999.99;
export const COMMERCE_TRACKING_MAX_FUTURE_MS = 5 * 60 * 1000;
export const COMMERCE_TRACKING_MAX_PAST_MS = 24 * 60 * 60 * 1000;

const eventTypes = new Set<string>(COMMERCE_TRACKING_EVENT_TYPES);

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function requiredIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = requiredString(value, field, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return normalized;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredIdentifier(value, field, COMMERCE_TRACKING_MAX_CART_ID_LENGTH);
}

function normalizeItems(value: unknown): CommerceTrackingItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > COMMERCE_TRACKING_MAX_ITEMS) {
    throw new Error(
      `items must be an array with at most ${COMMERCE_TRACKING_MAX_ITEMS} entries`,
    );
  }

  const itemIds = new Set<string>();
  let itemCount = 0;
  let cartTotal = 0;
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`items[${index}] must be an object`);
    const quantity = item.quantity;
    const price = item.price;
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
        `items[${index}].quantity must be a positive safe integer`,
      );
    }
    if (
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0 ||
      price > COMMERCE_TRACKING_MAX_CART_TOTAL
    ) {
      throw new Error(
        `items[${index}].price must be between 0 and ${COMMERCE_TRACKING_MAX_CART_TOTAL}`,
      );
    }
    const id = requiredIdentifier(
      item.id,
      `items[${index}].id`,
      COMMERCE_TRACKING_MAX_ITEM_ID_LENGTH,
    );
    if (itemIds.has(id))
      throw new Error("items must not contain duplicate IDs");
    itemIds.add(id);
    itemCount += quantity;
    cartTotal += quantity * price;
    if (
      !Number.isSafeInteger(itemCount) ||
      !Number.isFinite(cartTotal) ||
      cartTotal > COMMERCE_TRACKING_MAX_CART_TOTAL
    ) {
      throw new Error("items exceed the supported cart size");
    }
    return {
      id,
      name: requiredString(
        item.name,
        `items[${index}].name`,
        COMMERCE_TRACKING_MAX_ITEM_NAME_LENGTH,
      ),
      quantity,
      price,
    };
  });
}

function normalizeCurrency(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[a-z]{3}$/i.test(value.trim())) {
    throw new Error("currency must be a three-letter ISO 4217 code");
  }
  return value.trim().toUpperCase();
}

function normalizeRecoveryUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("recoveryUrl must be an HTTPS URL");
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("recoveryUrl must be an HTTPS URL");
  }
}

/**
 * Validates and returns the canonical browser commerce event shape.
 * Browser timestamps are intentionally narrow: stale data should be replayed by
 * the authenticated store adapter, not accepted through an anonymous session.
 */
export function normalizeCommerceTrackingEvent(
  value: unknown,
  nowMs = Date.now(),
): CommerceTrackingEvent {
  if (!isRecord(value)) throw new Error("commerce event must be an object");
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite");

  const type = value.type;
  if (typeof type !== "string" || !eventTypes.has(type)) {
    throw new Error("type is not a supported commerce event");
  }

  const occurredAt =
    typeof value.occurredAt === "string" ? value.occurredAt : "";
  const occurredAtIsIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      occurredAt,
    );
  const occurredAtMs = occurredAtIsIso ? Date.parse(occurredAt) : NaN;
  if (!Number.isFinite(occurredAtMs)) {
    throw new Error("occurredAt must be a valid ISO timestamp");
  }
  if (occurredAtMs > nowMs + COMMERCE_TRACKING_MAX_FUTURE_MS) {
    throw new Error("occurredAt is too far in the future");
  }
  if (occurredAtMs < nowMs - COMMERCE_TRACKING_MAX_PAST_MS) {
    throw new Error("occurredAt is too old");
  }

  const items = normalizeItems(value.items);
  const currency = normalizeCurrency(value.currency);
  if (
    (type === "cart_updated" || type === "checkout_started") &&
    (!items || !currency)
  ) {
    throw new Error(`${type} requires a full items snapshot and currency`);
  }
  if ((items && !currency) || (!items && currency)) {
    throw new Error(
      "items and currency must be supplied together as a snapshot",
    );
  }

  const recoveryUrl = normalizeRecoveryUrl(value.recoveryUrl);
  const checkoutId = optionalIdentifier(value.checkoutId, "checkoutId");
  const orderId = optionalIdentifier(value.orderId, "orderId");

  return {
    eventId: requiredIdentifier(
      value.eventId,
      "eventId",
      COMMERCE_TRACKING_MAX_EVENT_ID_LENGTH,
    ),
    type: type as CommerceTrackingEventType,
    cartId: requiredIdentifier(
      value.cartId,
      "cartId",
      COMMERCE_TRACKING_MAX_CART_ID_LENGTH,
    ),
    occurredAt: new Date(occurredAtMs).toISOString(),
    ...(items ? { items } : {}),
    ...(currency ? { currency } : {}),
    ...(recoveryUrl ? { recoveryUrl } : {}),
    ...(checkoutId ? { checkoutId } : {}),
    ...(orderId ? { orderId } : {}),
  };
}
