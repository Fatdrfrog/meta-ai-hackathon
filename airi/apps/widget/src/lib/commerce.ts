import {
  COMMERCE_TRACKING_MAX_EVENTS_PER_REQUEST,
  normalizeCommerceTrackingEvent,
  type CommerceCartSummary,
  type CommerceCartsResponse,
  type CommerceEventsResponse,
  type CommerceHandoffResponse,
  type CommerceSessionResponse,
  type CommerceTrackingEvent,
  type CommerceTrackingEventType,
  type CommerceTrackingInput,
} from "@icecore/shared/types/commerce-tracking";
import { generateUUID } from "./storage";
import {
  shopifyCommerceInboxPrefix,
  widgetCommerceStorageKey,
} from "./commerce-storage-key";

const MAX_QUEUED_EVENTS = 100;
const MAX_RECENT_EVENT_IDS = 200;
const DEFAULT_FLUSH_DELAY_MS = 250;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 6;
const MAX_REQUEST_BYTES = 60 * 1024;
const MAX_CART_SUMMARIES = 100;
const DEFAULT_EXTERNAL_INBOX_POLL_MS = 1_000;
const CART_REFRESH_THROTTLE_MS = 2_000;
const CART_STATUSES = new Set([
  "cart",
  "checkout",
  "closed",
  "ordered",
  "purchase_reported",
  "paid",
]);

type CommerceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;

type PersistedCommerceState = {
  clientKey: string;
  sessionToken?: string;
  queue: CommerceTrackingEvent[];
  recentEvents: Array<{
    eventId: string;
    fingerprint: string;
    occurredAt: string;
  }>;
};

export type WidgetCommerceStatus =
  | "connecting"
  | "ready"
  | "retrying"
  | "disabled"
  | "error";

export type WidgetCommerceSnapshot = {
  status: WidgetCommerceStatus;
  enabled: boolean | null;
  carts: CommerceCartSummary[];
  pendingCount: number;
  error?: string;
};

export type WidgetCommerceListener = (snapshot: WidgetCommerceSnapshot) => void;

export type WidgetCommerceOptions = {
  clientKey: string;
  apiUrl: string;
  storage?: CommerceStorage | null;
  fetch?: typeof fetch;
  flushDelayMs?: number;
  retryBaseMs?: number;
  externalInboxPollMs?: number;
};

function getDefaultStorage(): CommerceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function storageKey(clientKey: string): string {
  return widgetCommerceStorageKey(clientKey);
}

function responseError(data: unknown, fallback: string): string {
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { error?: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function cloneSnapshot(
  snapshot: WidgetCommerceSnapshot,
): WidgetCommerceSnapshot {
  return {
    ...snapshot,
    carts: snapshot.carts.map((cart) => ({ ...cart })),
  };
}

function normalizeCartSummaries(value: unknown): CommerceCartSummary[] {
  if (!Array.isArray(value) || value.length > MAX_CART_SUMMARIES) {
    throw new Error("Cart activity returned an invalid response");
  }
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("Cart activity returned an invalid response");
    }
    const cart = candidate as Record<string, unknown>;
    if (
      typeof cart.cartId !== "string" ||
      !cart.cartId ||
      cart.cartId.length > 200 ||
      typeof cart.status !== "string" ||
      !CART_STATUSES.has(cart.status) ||
      typeof cart.itemCount !== "number" ||
      !Number.isSafeInteger(cart.itemCount) ||
      cart.itemCount < 0 ||
      typeof cart.total !== "number" ||
      !Number.isFinite(cart.total) ||
      cart.total < 0 ||
      typeof cart.currency !== "string" ||
      !/^[A-Z]{3}$/.test(cart.currency) ||
      typeof cart.linked !== "boolean"
    ) {
      throw new Error("Cart activity returned an invalid response");
    }
    let recoveryUrl: string | undefined;
    if (cart.recoveryUrl !== undefined) {
      if (typeof cart.recoveryUrl !== "string") {
        throw new Error("Cart activity returned an invalid response");
      }
      try {
        const parsed = new URL(cart.recoveryUrl);
        if (parsed.protocol !== "https:") throw new Error();
        recoveryUrl = parsed.toString();
      } catch {
        throw new Error("Cart activity returned an invalid response");
      }
    }
    return {
      cartId: cart.cartId,
      status: cart.status as CommerceCartSummary["status"],
      itemCount: cart.itemCount,
      total: cart.total,
      currency: cart.currency,
      ...(recoveryUrl ? { recoveryUrl } : {}),
      linked: cart.linked,
    };
  });
}

function eventFingerprint(event: CommerceTrackingEvent): string {
  const serialized = JSON.stringify(event);
  let first = 2_166_136_261;
  let second = 2_654_435_761;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 2_246_822_519);
  }
  return `${serialized.length}:${first >>> 0}:${second >>> 0}`;
}

export class WidgetCommerce {
  private readonly clientKey: string;
  private readonly endpoint: string;
  private readonly storage: CommerceStorage | null;
  private readonly fetcher: typeof fetch;
  private readonly flushDelayMs: number;
  private readonly retryBaseMs: number;
  private sessionToken: string | null = null;
  private queue: CommerceTrackingEvent[] = [];
  private recentEvents: Array<{
    eventId: string;
    fingerprint: string;
    occurredAt: string;
  }> = [];
  private listeners = new Set<WidgetCommerceListener>();
  private snapshot: WidgetCommerceSnapshot = {
    status: "connecting",
    enabled: null,
    carts: [],
    pendingCount: 0,
  };
  private sessionPromise: Promise<boolean> | null = null;
  private flushPromise: Promise<void> | null = null;
  private cartsPromise: Promise<void> | null = null;
  private lastCartRefreshAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly externalInboxPrefix: string;
  private externalInboxTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly abortController =
    typeof AbortController === "undefined" ? null : new AbortController();

  private readonly onOnline = () => {
    this.retryAttempt = 0;
    void this.initializeSession().then((enabled) => {
      if (enabled) void this.refreshCarts();
      this.scheduleFlush(0);
    });
  };

  private readonly onVisibilityChange = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      void this.flush();
    } else {
      void this.refreshCarts();
    }
  };

  private readonly onFocus = () => {
    void this.refreshCarts();
  };

  private readonly onPageHide = () => {
    void this.flush();
  };

  private readonly onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(this.externalInboxPrefix)) {
      this.drainExternalInbox();
    }
  };

  constructor(options: WidgetCommerceOptions) {
    if (!options.clientKey.trim()) {
      throw new Error("WidgetCommerce requires a clientKey");
    }
    this.clientKey = options.clientKey;
    this.endpoint = `${options.apiUrl.replace(/\/$/, "")}/commerce`;
    this.storage =
      options.storage === undefined ? getDefaultStorage() : options.storage;
    this.fetcher = options.fetch || fetch.bind(globalThis);
    this.flushDelayMs = Math.max(
      0,
      options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
    );
    this.retryBaseMs = Math.max(
      0,
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    );
    this.externalInboxPrefix = shopifyCommerceInboxPrefix(this.clientKey);

    this.restore();
    this.drainExternalInbox();
    this.updateSnapshot({ pendingCount: this.queue.length });

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("storage", this.onStorage);
      window.addEventListener("focus", this.onFocus);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (this.storage && typeof this.storage.key === "function") {
      this.externalInboxTimer = setInterval(
        () => this.drainExternalInbox(),
        Math.max(
          100,
          options.externalInboxPollMs ?? DEFAULT_EXTERNAL_INBOX_POLL_MS,
        ),
      );
    }

    void this.initializeSession().then((enabled) => {
      if (enabled) void this.refreshCarts();
      this.scheduleFlush(0);
    });
  }

  track(
    type: CommerceTrackingEventType,
    payload: CommerceTrackingInput,
  ): string {
    if (this.destroyed) throw new Error("WidgetCommerce has been destroyed");

    const knownQueuedEvent = payload.eventId
      ? this.queue.find((queued) => queued.eventId === payload.eventId)
      : undefined;
    const knownRecentEvent = payload.eventId
      ? this.recentEvents.find((recent) => recent.eventId === payload.eventId)
      : undefined;

    const event = normalizeCommerceTrackingEvent({
      ...payload,
      type,
      eventId: payload.eventId || generateUUID(),
      occurredAt:
        payload.occurredAt ||
        knownQueuedEvent?.occurredAt ||
        knownRecentEvent?.occurredAt ||
        new Date().toISOString(),
    });

    const queuedDuplicate = knownQueuedEvent;
    if (queuedDuplicate) {
      if (eventFingerprint(queuedDuplicate) !== eventFingerprint(event)) {
        throw new Error("eventId cannot be reused for different commerce data");
      }
      return event.eventId;
    }
    const recentDuplicate = knownRecentEvent;
    if (recentDuplicate) {
      if (recentDuplicate.fingerprint !== eventFingerprint(event)) {
        throw new Error("eventId cannot be reused for different commerce data");
      }
      return event.eventId;
    }

    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      const supersededIndex = this.queue.findIndex(
        (queued) =>
          queued.type === "cart_updated" && queued.cartId === event.cartId,
      );
      if (supersededIndex < 0) {
        throw new Error("commerce event queue is full");
      }
      this.queue.splice(supersededIndex, 1);
    }
    this.queue.push(event);
    this.persist();
    this.updateSnapshot({ pendingCount: this.queue.length, error: undefined });
    this.scheduleFlush(this.flushDelayMs);
    return event.eventId;
  }

  getSnapshot(): WidgetCommerceSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  subscribe(listener: WidgetCommerceListener): () => void {
    if (this.destroyed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  async createHandoff(cartId: string, locale?: string): Promise<string> {
    if (this.destroyed) throw new Error("WidgetCommerce has been destroyed");
    const normalizedCartId = cartId.trim();
    if (!normalizedCartId || normalizedCartId.length > 200) {
      throw new Error("cartId must contain 1-200 characters");
    }

    const enabled = await this.initializeSession();
    if (!enabled || !this.sessionToken) {
      throw new Error("Cart recovery is not enabled for this website");
    }

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      ...(this.abortController ? { signal: this.abortController.signal } : {}),
      body: JSON.stringify({
        action: "handoff",
        clientKey: this.clientKey,
        sessionToken: this.sessionToken,
        cartId: normalizedCartId,
        consent: true,
        ...(locale ? { locale } : {}),
      }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.resetSession();
      }
      throw new Error(
        responseError(data, "Failed to create cart recovery handoff"),
      );
    }

    const url = (data as Partial<CommerceHandoffResponse>).url;
    if (typeof url !== "string") {
      throw new Error("Cart recovery handoff returned an invalid URL");
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error();
      return parsed.toString();
    } catch {
      throw new Error("Cart recovery handoff returned an invalid URL");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController?.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.externalInboxTimer) clearInterval(this.externalInboxTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.externalInboxTimer = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("storage", this.onStorage);
      window.removeEventListener("focus", this.onFocus);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.listeners.clear();
  }

  private drainExternalInbox(): void {
    if (
      this.destroyed ||
      !this.storage ||
      typeof this.storage.key !== "function" ||
      typeof this.storage.length !== "number"
    ) {
      return;
    }
    try {
      const keys: string[] = [];
      const storageLength = Math.min(this.storage.length, 500);
      for (let index = 0; index < storageLength; index += 1) {
        const key = this.storage.key(index);
        if (key?.startsWith(this.externalInboxPrefix)) keys.push(key);
      }
      for (const key of keys.slice(0, MAX_QUEUED_EVENTS)) {
        if (this.queue.length >= MAX_QUEUED_EVENTS) break;
        const serialized = this.storage.getItem(key);
        if (!serialized) {
          this.storage.removeItem(key);
          continue;
        }
        let event: CommerceTrackingEvent;
        try {
          event = normalizeCommerceTrackingEvent(JSON.parse(serialized));
        } catch {
          this.storage.removeItem(key);
          continue;
        }
        const { type, eventId, occurredAt, ...payload } = event;
        this.track(type, { ...payload, eventId, occurredAt });
        this.storage.removeItem(key);
      }
    } catch {
      // Browser storage can become unavailable after consent/privacy changes.
    }
  }

  private async initializeSession(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.snapshot.enabled === false) return false;
    if (this.sessionToken && this.snapshot.enabled === true) return true;
    if (this.sessionPromise) return this.sessionPromise;

    this.updateSnapshot({ status: "connecting", error: undefined });
    this.sessionPromise = this.requestSession().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async refreshCarts(): Promise<void> {
    if (this.destroyed || this.snapshot.enabled === false) return;
    if (this.cartsPromise) return this.cartsPromise;
    if (Date.now() - this.lastCartRefreshAt < CART_REFRESH_THROTTLE_MS) return;
    this.cartsPromise = this.requestCarts().finally(() => {
      this.cartsPromise = null;
    });
    return this.cartsPromise;
  }

  private async requestCarts(): Promise<void> {
    const enabled = await this.initializeSession();
    if (!enabled || !this.sessionToken || this.destroyed) return;
    this.lastCartRefreshAt = Date.now();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        ...(this.abortController
          ? { signal: this.abortController.signal }
          : {}),
        body: JSON.stringify({
          action: "carts",
          clientKey: this.clientKey,
          sessionToken: this.sessionToken,
        }),
      });
      const data = await readJson(response);
      if (this.destroyed) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          this.resetSession();
        throw new Error(responseError(data, "Failed to refresh cart activity"));
      }
      const carts = normalizeCartSummaries(
        (data as Partial<CommerceCartsResponse>).carts,
      );
      this.updateSnapshot({ carts, error: undefined });
    } catch (error) {
      if (this.destroyed) return;
      this.updateSnapshot({
        error:
          error instanceof Error
            ? error.message
            : "Failed to refresh cart activity",
      });
    }
  }

  private async requestSession(): Promise<boolean> {
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        ...(this.abortController
          ? { signal: this.abortController.signal }
          : {}),
        body: JSON.stringify({
          action: "session",
          clientKey: this.clientKey,
          ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
        }),
      });
      const data = await readJson(response);
      if (this.destroyed) return false;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          this.resetSession();
        throw new Error(
          responseError(data, "Failed to initialize cart recovery"),
        );
      }

      const session = data as Partial<CommerceSessionResponse>;
      if (typeof session.enabled !== "boolean") {
        throw new Error("Cart recovery session returned an invalid response");
      }
      if (!session.enabled) {
        this.queue = [];
        this.persist();
        this.updateSnapshot({
          status: "disabled",
          enabled: false,
          pendingCount: 0,
          error: undefined,
        });
        return false;
      }
      if (typeof session.sessionToken !== "string" || !session.sessionToken) {
        throw new Error("Cart recovery session returned an invalid response");
      }

      this.sessionToken = session.sessionToken;
      this.retryAttempt = 0;
      this.persist();
      this.updateSnapshot({ status: "ready", enabled: true, error: undefined });
      return true;
    } catch (error) {
      if (this.destroyed) return false;
      this.updateSnapshot({
        status: "retrying",
        error:
          error instanceof Error
            ? error.message
            : "Cart recovery is unavailable",
      });
      this.scheduleRetry();
      return false;
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (
      this.destroyed ||
      this.snapshot.enabled === false ||
      this.queue.length === 0
    )
      return;
    if (this.flushTimer || this.flushPromise) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.destroyed || this.flushPromise || this.queue.length === 0) return;
    this.flushPromise = this.flushQueue().finally(() => {
      this.flushPromise = null;
      if (
        !this.destroyed &&
        this.queue.length > 0 &&
        this.snapshot.status === "ready"
      ) {
        this.scheduleFlush(0);
      }
    });
    return this.flushPromise;
  }

  private async flushQueue(): Promise<void> {
    const enabled = await this.initializeSession();
    if (!enabled || !this.sessionToken || this.queue.length === 0) return;

    const events = this.selectBatch();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        keepalive: true,
        ...(this.abortController
          ? { signal: this.abortController.signal }
          : {}),
        body: JSON.stringify({
          action: "events",
          clientKey: this.clientKey,
          sessionToken: this.sessionToken,
          events,
        }),
      });
      const data = await readJson(response);
      if (this.destroyed) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          this.resetSession();
        throw new Error(responseError(data, "Failed to save cart activity"));
      }
      const carts = normalizeCartSummaries(
        (data as Partial<CommerceEventsResponse>).carts,
      );

      const acknowledged = new Set(events.map((event) => event.eventId));
      this.queue = this.queue.filter(
        (event) => !acknowledged.has(event.eventId),
      );
      this.recentEvents.push(
        ...events.map((event) => ({
          eventId: event.eventId,
          fingerprint: eventFingerprint(event),
          occurredAt: event.occurredAt,
        })),
      );
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENT_IDS);
      this.retryAttempt = 0;
      this.persist();
      this.updateSnapshot({
        status: "ready",
        enabled: true,
        carts,
        pendingCount: this.queue.length,
        error: undefined,
      });
    } catch (error) {
      if (this.destroyed) return;
      this.updateSnapshot({
        status: "retrying",
        error:
          error instanceof Error
            ? error.message
            : "Failed to save cart activity",
      });
      this.scheduleRetry();
    }
  }

  private selectBatch(): CommerceTrackingEvent[] {
    const selected: CommerceTrackingEvent[] = [];
    for (const event of this.queue.slice(
      0,
      COMMERCE_TRACKING_MAX_EVENTS_PER_REQUEST,
    )) {
      const candidate = [...selected, event];
      const body = JSON.stringify({
        action: "events",
        clientKey: this.clientKey,
        sessionToken: this.sessionToken,
        events: candidate,
      });
      const byteLength =
        typeof TextEncoder === "undefined"
          ? body.length
          : new TextEncoder().encode(body).byteLength;
      if (selected.length > 0 && byteLength > MAX_REQUEST_BYTES) break;
      selected.push(event);
    }
    return selected;
  }

  private scheduleRetry(): void {
    if (this.destroyed || this.retryTimer || this.snapshot.enabled === false)
      return;
    if (this.retryAttempt >= MAX_RETRY_ATTEMPTS) {
      this.updateSnapshot({ status: "error" });
      return;
    }
    const delay = Math.min(
      this.retryBaseMs * Math.pow(2, this.retryAttempt),
      MAX_RETRY_DELAY_MS,
    );
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.initializeSession().then(() => this.scheduleFlush(0));
    }, delay);
  }

  private resetSession(): void {
    this.sessionToken = null;
    this.snapshot = { ...this.snapshot, enabled: null, status: "connecting" };
    this.persist();
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(storageKey(this.clientKey));
      if (!raw) return;
      const persisted = JSON.parse(raw) as Partial<PersistedCommerceState>;
      if (persisted.clientKey !== this.clientKey) {
        this.storage.removeItem(storageKey(this.clientKey));
        return;
      }
      this.sessionToken =
        typeof persisted.sessionToken === "string"
          ? persisted.sessionToken
          : null;
      this.recentEvents = Array.isArray(persisted.recentEvents)
        ? persisted.recentEvents
            .filter(
              (
                entry,
              ): entry is {
                eventId: string;
                fingerprint: string;
                occurredAt: string;
              } =>
                typeof entry === "object" &&
                entry !== null &&
                typeof entry.eventId === "string" &&
                typeof entry.fingerprint === "string" &&
                typeof entry.occurredAt === "string",
            )
            .slice(-MAX_RECENT_EVENT_IDS)
        : [];
      this.queue = Array.isArray(persisted.queue)
        ? persisted.queue
            .map((event) => {
              try {
                return normalizeCommerceTrackingEvent(event);
              } catch {
                return null;
              }
            })
            .filter((event): event is CommerceTrackingEvent => event !== null)
            .slice(-MAX_QUEUED_EVENTS)
        : [];
    } catch {
      try {
        this.storage.removeItem(storageKey(this.clientKey));
      } catch {
        // Storage denial must not break the host storefront.
      }
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const state: PersistedCommerceState = {
        clientKey: this.clientKey,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
        queue: this.queue,
        recentEvents: this.recentEvents,
      };
      this.storage.setItem(storageKey(this.clientKey), JSON.stringify(state));
    } catch {
      // Storage denial must not break the host storefront.
    }
  }

  private updateSnapshot(update: Partial<WidgetCommerceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
