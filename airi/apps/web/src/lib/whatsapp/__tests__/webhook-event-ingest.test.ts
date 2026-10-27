jest.mock("@/lib/whatsapp/source-resolver", () => ({
  resolveWhatsAppSourceByAccountIdentifiers: jest.fn(),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function waitForQueuedWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

jest.mock("@icecore/airi-runtime/whatsapp-webhook-event-indexes", () => ({
  ensureWhatsAppWebhookEventIndexes: jest.fn(async () => undefined),
}));

jest.mock("@/lib/whatsapp/webhook-pubsub", () => ({
  publishWhatsAppWebhookEventToPubSub: jest.fn(async () => ({
    ok: true,
    messageId: "pubsub-message-1",
  })),
}));

jest.mock("@icecore/airi-runtime/whatsapp-webhook-event-model", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(async () => ({
      _id: "event-1",
      status: "received",
      duplicateCount: 1,
      publishAttempts: 0,
    })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  },
}));

import {
  buildWhatsAppWebhookEventEnvelopes,
  enqueueWhatsAppWebhookEvents,
  getWhatsAppWebhookOrderingKey,
  getWhatsAppWebhookProcessorRoutingKey,
} from "@/lib/whatsapp/webhook-event-ingest";
import { ensureWhatsAppWebhookEventIndexes } from "@icecore/airi-runtime/whatsapp-webhook-event-indexes";
import WhatsAppWebhookEvent from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import { publishWhatsAppWebhookEventToPubSub } from "@/lib/whatsapp/webhook-pubsub";
import { resolveWhatsAppSourceByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";

const mockFindOneAndUpdate = WhatsAppWebhookEvent.findOneAndUpdate as jest.Mock;
const mockUpdateOne = WhatsAppWebhookEvent.updateOne as jest.Mock;
const mockPublishWhatsAppWebhookEventToPubSub =
  publishWhatsAppWebhookEventToPubSub as jest.Mock;
const mockResolveHistorySource =
  resolveWhatsAppSourceByAccountIdentifiers as jest.Mock;

describe("WhatsApp webhook event ingest", () => {
  function installEventStore() {
    const events = new Map<string, Record<string, unknown>>();
    mockFindOneAndUpdate.mockImplementation(async (filter, update) => {
      let event = events.get(filter.dedupeKey);
      if (!event) {
        event = {
          ...structuredClone(update.$setOnInsert),
          _id: `stored-${events.size + 1}`,
          duplicateCount: 0,
        };
        events.set(filter.dedupeKey, event);
      }
      Object.assign(event, update.$set);
      event.duplicateCount = Number(event.duplicateCount) + 1;
      return structuredClone(event);
    });
    mockUpdateOne.mockImplementation(async (filter, update) => {
      const event = [...events.values()].find(item => item._id === filter._id);
      if (!event) return { modifiedCount: 0 };
      if (filter.status?.$in && !filter.status.$in.includes(event.status)) {
        return { modifiedCount: 0 };
      }
      if (filter.status?.$nin?.includes(event.status)) {
        return { modifiedCount: 0 };
      }
      for (const key of [
        "status",
        "nextRetryAt",
        "processingStartedAt",
        "processingLeaseId",
      ]) {
        if (
          !(key in filter) ||
          (key === "status" && typeof filter.status === "object")
        ) {
          continue;
        }
        const isDateField = key === "nextRetryAt" || key === "processingStartedAt";
        const actual = isDateField && event[key] != null
          ? Number(event[key])
          : event[key] ?? null;
        const expected = isDateField && filter[key] != null
          ? Number(filter[key])
          : filter[key] ?? null;
        if (actual !== expected) return { modifiedCount: 0 };
      }
      Object.assign(event, update.$set);
      return { modifiedCount: 1 };
    });
    return events;
  }

  function messageBody(message: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                contacts: [
                  { wa_id: "15550001", profile: { name: "Customer" } },
                ],
                messages: [
                  {
                    id: "wamid.recovered",
                    from: "15550001",
                    timestamp: "1",
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  const unavailableMessage = {
    type: "unsupported",
    unsupported: { type: "unknown" },
    errors: [{ code: 131060, title: "This message is unavailable" }],
  };
  const attributedMessage = {
    type: "text",
    text: { body: "I would like to order a medal holder" },
    referral: { source_type: "ad", source_id: "ad-1", ctwa_clid: "click-1" },
  };

  async function ingestMessage(
    message: Record<string, unknown>,
    verified = true
  ) {
    const body = messageBody(message);
    return enqueueWhatsAppWebhookEvents({
      body,
      rawBody: JSON.stringify(body),
      providerSignatureVerified: verified,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveHistorySource.mockResolvedValue(null);
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "event-1",
      status: "received",
      duplicateCount: 1,
      publishAttempts: 0,
    });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockPublishWhatsAppWebhookEventToPubSub.mockResolvedValue({
      ok: true,
      messageId: "pubsub-message-1",
    });
  });

  it.each([true, false])(
    "preserves a consumer deferral while publication finishes with ok=%s",
    async ok => {
      const events = installEventStore();
      const nextRetryAt = new Date(Date.now() + 60_000);
      const lastError =
        "Company processing capacity unavailable; received work remains queued";
      mockPublishWhatsAppWebhookEventToPubSub.mockImplementation(async () => {
        const receipt = [...events.values()][0];
        Object.assign(receipt, {
          status: "received",
          nextRetryAt,
          processingStartedAt: new Date(),
          processingLeaseId: null,
          lastError,
        });
        return ok
          ? { ok: true, messageId: "pubsub-message-1" }
          : { ok: false, errorMessage: "Pub/Sub request timed out" };
      });

      await ingestMessage(attributedMessage);

      expect([...events.values()][0]).toMatchObject({
        status: "received",
        nextRetryAt,
        lastError,
        processingLeaseId: null,
      });
      expect([...events.values()][0]).not.toHaveProperty("publishedAt");
    }
  );

  it.each(["received", "failed", "dead"])(
    "keeps a %s receipt and its error when provider redelivery precedes retry time",
    async status => {
      const events = installEventStore();
      await ingestMessage(attributedMessage);
      const receipt = [...events.values()][0];
      const nextRetryAt = new Date(Date.now() + 60_000);
      const lastError = "Capacity unavailable";
      Object.assign(receipt, { status, nextRetryAt, lastError });
      mockPublishWhatsAppWebhookEventToPubSub.mockClear();
      mockUpdateOne.mockClear();

      const duplicate = await ingestMessage(attributedMessage);

      expect(duplicate).toMatchObject({
        persisted: 1,
        published: 0,
        publishFailures: 0,
        skippedAlreadyHandled: 1,
      });
      expect(receipt).toMatchObject({ status, nextRetryAt, lastError });
      expect(mockPublishWhatsAppWebhookEventToPubSub).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    }
  );

  it.each(["received", "failed"])(
    "publishes a %s receipt once its retry is due",
    async status => {
      const events = installEventStore();
      await ingestMessage(attributedMessage);
      const receipt = [...events.values()][0];
      Object.assign(receipt, {
        status,
        nextRetryAt: new Date(Date.now() - 60_000),
        lastError: "Capacity unavailable",
      });
      mockPublishWhatsAppWebhookEventToPubSub.mockClear();

      const duplicate = await ingestMessage(attributedMessage);

      expect(duplicate.published).toBe(1);
      expect(mockPublishWhatsAppWebhookEventToPubSub).toHaveBeenCalledTimes(1);
      expect(receipt).toMatchObject({ status: "published", lastError: null });
    }
  );

  it("preserves a new processing attempt even when status and retry time return to their observed values", async () => {
    const events = installEventStore();
    mockPublishWhatsAppWebhookEventToPubSub.mockImplementation(async () => {
      Object.assign([...events.values()][0], {
        processingStartedAt: new Date(),
        lastError: "Processing deferred",
      });
      return { ok: true, messageId: "pubsub-message-1" };
    });

    await ingestMessage(attributedMessage);

    expect([...events.values()][0]).toMatchObject({
      status: "received",
      lastError: "Processing deferred",
    });
    expect([...events.values()][0]).not.toHaveProperty("publishedAt");
  });

  it.each(["published", "failed", "dead"])(
    "does not replace an intervening %s state after a publication failure",
    async status => {
      const events = installEventStore();
      mockPublishWhatsAppWebhookEventToPubSub.mockImplementation(async () => {
        Object.assign([...events.values()][0], {
          status,
          lastError: "A newer processing result",
        });
        return { ok: false, errorMessage: "Pub/Sub request timed out" };
      });

      await ingestMessage(attributedMessage);

      expect([...events.values()][0]).toMatchObject({
        status,
        lastError: "A newer processing result",
      });
    }
  );

  it("does not revive a dead receipt without a scheduled retry on provider redelivery", async () => {
    const events = installEventStore();
    await ingestMessage(attributedMessage);
    const receipt = [...events.values()][0];
    Object.assign(receipt, {
      status: "dead",
      nextRetryAt: null,
      lastError: "Attempts exhausted",
    });
    mockPublishWhatsAppWebhookEventToPubSub.mockClear();

    const duplicate = await ingestMessage(attributedMessage);

    expect(duplicate.skippedAlreadyHandled).toBe(1);
    expect(mockPublishWhatsAppWebhookEventToPubSub).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      status: "dead",
      nextRetryAt: null,
      lastError: "Attempts exhausted",
    });
  });

  function historyBody() {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "phone-1" },
                historyImport: {
                  sessionId: "untrusted-session",
                  workspaceId: "other-workspace",
                },
                history: [
                  {
                    metadata: { progress: 100 },
                    threads: [
                      {
                        id: "15550001",
                        messages: [
                          {
                            id: "wamid.history-1",
                            type: "text",
                            from: "15550001",
                            timestamp: "1791630000",
                            text: { body: "History" },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  function historySource(sessionId?: string) {
    return {
      id: "source-1",
      workspace_id: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        ...(sessionId
          ? {
              history_sync: {
                session_id: sessionId,
                session_started_at: "2026-10-10T10:00:00Z",
                request_attempt_id: "attempt-1",
                request_attempted_at: "2026-10-10T10:00:01Z",
                range_days: 90,
              },
            }
          : {}),
      },
    };
  }

  it("does not enroll a delivery before the new session has claimed its provider request", async () => {
    const source = historySource("session-1");
    delete (source.credentials.history_sync as { request_attempt_id?: string })
      .request_attempt_id;
    mockResolveHistorySource.mockResolvedValue(source);
    const body = historyBody();
    await enqueueWhatsAppWebhookEvents({
      body,
      rawBody: JSON.stringify(body),
      providerSignatureVerified: true,
    });
    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert.historyImport).toBeUndefined();
    expect(update.$setOnInsert.dedupeKey).not.toContain(":session:");
  });

  it("binds a future history receipt to freshly resolved source state, never payload claims", async () => {
    mockResolveHistorySource.mockResolvedValue(historySource("session-1"));
    const body = historyBody();
    await enqueueWhatsAppWebhookEvents({
      body,
      rawBody: JSON.stringify(body),
      receivedAt: new Date("2026-10-10T10:01:00Z"),
      providerSignatureVerified: true,
    });
    expect(mockResolveHistorySource).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "phone-1", bypassCache: true })
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { dedupeKey: expect.stringContaining(":session:session-1") },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          historyImport: expect.objectContaining({
            role: "chunk",
            sessionId: "session-1",
            rangeDays: 90,
            workspaceId: "workspace-1",
          }),
        }),
      }),
      expect.anything()
    );
  });

  it("deduplicates delivery within a session while permitting the same chunk in a new onboarding", async () => {
    const events = installEventStore();
    const body = historyBody();
    const params = {
      body,
      rawBody: JSON.stringify(body),
      receivedAt: new Date("2026-10-10T10:01:00Z"),
      providerSignatureVerified: true,
    };
    mockResolveHistorySource.mockResolvedValue(historySource("session-1"));
    await enqueueWhatsAppWebhookEvents(params);
    await enqueueWhatsAppWebhookEvents(params);
    expect(events.size).toBe(1);
    mockResolveHistorySource.mockResolvedValue(historySource("session-2"));
    await enqueueWhatsAppWebhookEvents(params);
    expect(events.size).toBe(2);
  });

  it("preserves legacy history receipt identity without enrolling an existing company", async () => {
    mockResolveHistorySource.mockResolvedValue(historySource());
    const body = historyBody();
    const params = { body, rawBody: JSON.stringify(body) };
    const [legacy] = buildWhatsAppWebhookEventEnvelopes(params);
    await enqueueWhatsAppWebhookEvents(params);
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({
      dedupeKey: legacy.dedupeKey,
    });
    expect(
      mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.historyImport
    ).toBeUndefined();
  });

  it("does not acknowledge history when its current source cannot be established", async () => {
    const body = historyBody();
    await expect(
      enqueueWhatsAppWebhookEvents({ body, rawBody: JSON.stringify(body) })
    ).rejects.toThrow(/history.*source/i);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockPublishWhatsAppWebhookEventToPubSub).not.toHaveBeenCalled();
  });

  it("rejects a WABA fallback pointing to a different phone", async () => {
    mockResolveHistorySource.mockResolvedValue({
      ...historySource("session-1"),
      credentials: {
        ...historySource("session-1").credentials,
        phone_number_id: "another-phone",
      },
    });
    const body = historyBody();
    await expect(
      enqueueWhatsAppWebhookEvents({ body, rawBody: JSON.stringify(body) })
    ).rejects.toThrow(/history.*source/i);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "received",
    "published",
    "queued",
    "processing",
    "completed",
    "failed",
    "dead",
  ])(
    "durably delivers a verified richer message after its unavailable event is %s",
    async status => {
      const events = installEventStore();
      const original = await ingestMessage(unavailableMessage);
      const first = [...events.values()][0];
      first.status = status;
      const originalPayload = structuredClone(first.payload);
      const originalHash = first.originalPayloadHash;

      const recovered = await ingestMessage(attributedMessage);

      expect(events.size).toBe(2);
      expect(recovered.eventIds[0]).not.toBe(original.eventIds[0]);
      expect(recovered.published).toBe(1);
      expect(first.payload).toEqual(originalPayload);
      expect(first.originalPayloadHash).toBe(originalHash);
      expect(first.status).toBe(status);
      const revision = [...events.values()][1];
      expect(revision.providerSignatureVerified).toBe(true);
      expect(revision.orderingKey).toBe(first.orderingKey);
      expect(revision.payload).toMatchObject({
        body: messageBody(attributedMessage),
      });
    }
  );

  it("deduplicates concurrent retries of the same richer variant despite delivery timestamps and key ordering", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const results = await Promise.all([
      ingestMessage(attributedMessage),
      ingestMessage({
        referral: {
          ctwa_clid: "click-1",
          source_id: "ad-1",
          source_type: "ad",
        },
        text: { body: "I would like to order a medal holder" },
        type: "text",
        timestamp: "2",
      }),
    ]);
    expect(events.size).toBe(2);
    expect(results[0].eventIds).toEqual(results[1].eventIds);
    expect([...events.values()][0].payload).toMatchObject({
      body: messageBody(unavailableMessage),
    });
  });

  it("recovers missing ad attribution after a usable message and ignores a late unavailable duplicate", async () => {
    const events = installEventStore();
    await ingestMessage({ type: "text", text: { body: "Hello" } });
    const recovered = await ingestMessage(attributedMessage);
    const late = await ingestMessage(unavailableMessage);
    expect(events.size).toBe(2);
    expect(recovered.published).toBe(1);
    expect(late.published).toBe(0);
    expect([...events.values()][1].payload).toMatchObject({
      body: messageBody(attributedMessage),
    });
  });

  it("does not grant recovery authority to an unverified richer delivery", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const ignored = await ingestMessage(
      { ...attributedMessage, providerSignatureVerified: true },
      false
    );
    expect(events.size).toBe(1);
    expect(ignored.published).toBe(0);
  });

  it("keeps a verified revision separate from an unverified original placeholder", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage, false);
    await ingestMessage(attributedMessage);
    expect(events.size).toBe(2);
    expect(
      [...events.values()].map(event => event.providerSignatureVerified)
    ).toEqual([false, true]);
  });

  it("keeps the useful first delivery when an unavailable duplicate arrives later", async () => {
    const events = installEventStore();
    await ingestMessage(attributedMessage);
    const late = await ingestMessage(unavailableMessage);
    expect(events.size).toBe(1);
    expect(late.published).toBe(0);
    expect([...events.values()][0].payload).toMatchObject({
      body: messageBody(attributedMessage),
    });
  });

  it("recovers a missing click identifier without changing the original referral", async () => {
    const events = installEventStore();
    await ingestMessage({
      ...attributedMessage,
      referral: { source_type: "ad", source_id: "ad-1" },
    });
    const recovered = await ingestMessage(attributedMessage);
    expect(events.size).toBe(2);
    expect(recovered.published).toBe(1);
  });

  it("does not create additional revisions for expiring referral asset URLs", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const first = await ingestMessage({
      ...attributedMessage,
      referral: {
        ...attributedMessage.referral,
        image_url: "https://cdn.example/one",
      },
    });
    const retry = await ingestMessage({
      ...attributedMessage,
      referral: {
        ...attributedMessage.referral,
        image_url: "https://cdn.example/two",
      },
    });
    expect(events.size).toBe(2);
    expect(retry.eventIds).toEqual(first.eventIds);
    expect(retry.published).toBe(0);
  });

  it("does not recover a same-message-id delivery for a different sender", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const ignored = await ingestMessage({
      ...attributedMessage,
      from: "15559999",
    });
    expect(events.size).toBe(1);
    expect(ignored.published).toBe(0);
  });

  it("does not reopen a compacted receipt whose original payload cannot be compared", async () => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const first = [...events.values()][0];
    first.status = "completed";
    first.payloadCompactedAt = new Date();
    delete first.payload;
    const ignored = await ingestMessage(attributedMessage);
    expect(events.size).toBe(1);
    expect(ignored.published).toBe(0);
    expect(first).not.toHaveProperty("payload");
  });

  it.each([
    { type: "text", text: { body: "Recovered" } },
    { type: "image", image: { id: "media-1" } },
    { type: "audio", audio: { id: "media-1" } },
    { type: "document", document: { id: "media-1" } },
    { type: "location", location: { latitude: 0, longitude: 0 } },
    { type: "contacts", contacts: [{ name: { formatted_name: "Person" } }] },
    { type: "button", button: { payload: "choose_medal" } },
    {
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "medal" } },
    },
    {
      type: "order",
      order: {
        catalog_id: "catalog-1",
        product_items: [{ product_retailer_id: "medal" }],
      },
    },
  ])("retains real recovered $type content", async message => {
    const events = installEventStore();
    await ingestMessage(unavailableMessage);
    const result = await ingestMessage(message);
    expect(events.size).toBe(2);
    expect(result.published).toBe(1);
  });

  it.each([
    unavailableMessage,
    { type: "text", text: { body: " " } },
    { type: "image", image: {} },
    { type: "reaction", reaction: { emoji: "👍", message_id: "wamid.other" } },
    {
      type: "edit",
      edit: {
        original_message_id: "wamid.other",
        message: { text: { body: "Edited" } },
      },
    },
    { type: "revoke", revoke: { original_message_id: "wamid.other" } },
  ])(
    "does not treat $type without standalone content as recovery",
    async message => {
      const events = installEventStore();
      await ingestMessage(unavailableMessage);
      const result = await ingestMessage(message);
      expect(events.size).toBe(1);
      expect(result.published).toBe(0);
    }
  );

  it.each([undefined, false, true])(
    "persists only trusted verification metadata on the original event: %s",
    async providerSignatureVerified => {
      const body = {
        object: "whatsapp_business_account",
        providerSignatureVerified: true,
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "phone-1" },
                  statuses: [
                    {
                      id: "wamid.test",
                      status: "sent",
                      timestamp: "1",
                      recipient_id: "15550000001",
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await enqueueWhatsAppWebhookEvents({
        body,
        rawBody: JSON.stringify(body),
        providerSignatureVerified,
      });
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const update = mockFindOneAndUpdate.mock.calls[0][1];
      expect(update.$setOnInsert.providerSignatureVerified).toBe(
        providerSignatureVerified === true
      );
      // A duplicate delivery must neither promote nor downgrade the stored body.
      expect(update.$set).not.toHaveProperty("providerSignatureVerified");
    }
  );

  it("normalizes every entry/change pair into durable event envelopes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.1",
                    from: "15550001",
                    timestamp: "1",
                    type: "text",
                  },
                ],
              },
            },
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                statuses: [
                  {
                    id: "wamid.2",
                    status: "read",
                    timestamp: "2",
                    recipient_id: "15550002",
                  },
                ],
              },
            },
          ],
        },
        {
          id: "waba-2",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "phone-2" },
                history: [
                  {
                    metadata: {
                      phase: 1,
                      chunk_order: 3,
                      progress: 60,
                    },
                    messages: [
                      {
                        id: "wamid.history",
                        from: "15550003",
                        timestamp: "3",
                        type: "text",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-05-15T09:45:00.000Z"),
    });

    expect(envelopes).toHaveLength(3);
    expect(envelopes.map(envelope => envelope.field)).toEqual([
      "messages",
      "messages",
      "history",
    ]);
    expect(envelopes.map(envelope => envelope.itemKind)).toEqual([
      "message",
      "status",
      "history",
    ]);
    expect(envelopes.map(envelope => envelope.phoneNumberId)).toEqual([
      "phone-1",
      "phone-1",
      "phone-2",
    ]);
    expect(envelopes.map(envelope => envelope.wabaId)).toEqual([
      "waba-1",
      "waba-1",
      "waba-2",
    ]);
    expect(envelopes[0].orderingKey).toMatch(/^phone-1:message:[a-f0-9]{24}$/);
    expect(envelopes[1].orderingKey).toMatch(/^phone-1:status:[a-f0-9]{24}$/);
    expect(envelopes[2].orderingKey).toBe("phone-2:history");
    expect(new Set(envelopes.map(envelope => envelope.dedupeKey)).size).toBe(3);
    expect(envelopes[2].historyMetadata).toEqual({
      phase: 1,
      chunkOrder: 3,
      progress: 60,
    });
  });

  it("normalizes direct coexistence history event payloads into the canonical webhook envelope", () => {
    const payload = {
      id: "event-1",
      event: "history",
      data: {
        id: "waba-1",
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "+15550001",
          phone_number_id: "phone-1",
        },
        history: [
          {
            metadata: {
              phase: 2,
              chunk_order: 8,
              progress: 100,
            },
            threads: [
              {
                id: "15550002",
                messages: [
                  {
                    id: "wamid.history.1",
                    from: "15550002",
                    timestamp: "1780000000",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const [envelope] = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-06-06T09:45:00.000Z"),
    });

    expect(envelope).toMatchObject({
      object: "whatsapp_business_account",
      field: "history",
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
      orderingKey: "phone-1:history",
      historyMetadata: {
        phase: 2,
        chunkOrder: 8,
        progress: 100,
      },
    });
    expect(envelope.payload.body).toMatchObject({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "phone-1" },
                history: expect.any(Array),
              },
            },
          ],
        },
      ],
    });
  });

  it("uses the most specific stable routing key available", () => {
    expect(
      getWhatsAppWebhookOrderingKey({
        sourceId: "source-1",
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
      })
    ).toBe("source-1");
    expect(
      getWhatsAppWebhookOrderingKey({
        sourceId: null,
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
      })
    ).toBe("phone-1");
    expect(
      getWhatsAppWebhookOrderingKey({
        sourceId: null,
        phoneNumberId: null,
        wabaId: "waba-1",
      })
    ).toBe("waba-1");
  });

  it("stores account-model identifiers from webhook metadata when present", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "messaging-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone-1",
                  cs_id: "cs-1",
                  waac_id: "waac-1",
                  messaging_account_id: "messaging-1",
                },
                messages: [
                  {
                    id: "wamid.1",
                    from: "15550001",
                    timestamp: "1",
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [envelope] = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-06-03T09:45:00.000Z"),
    });

    expect(envelope).toMatchObject({
      phoneNumberId: "phone-1",
      csId: "cs-1",
      wabaId: "messaging-1",
      messagingAccountId: "messaging-1",
      waacId: "waac-1",
    });
    expect(envelope).not.toHaveProperty("paidMessagingAccountId");
  });

  it("keeps customer messages on the primary phone processor", () => {
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "message",
      })
    ).toBe("phone-1");
  });

  it("partitions customer messages by hashed chat identity", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  { id: "wamid.1", from: "15550001", type: "text" },
                  { id: "wamid.2", from: "15550001", type: "text" },
                  { id: "wamid.3", from: "15550002", type: "text" },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
    });
    const keys = envelopes.map(envelope => envelope.orderingKey);

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys.every(key => /^phone-1:message:[a-f0-9]{24}$/.test(key))).toBe(
      true
    );
    expect(keys.join(" ")).not.toContain("15550001");
    expect(keys.join(" ")).not.toContain("15550002");
  });

  it("partitions status events by provider message while preserving status order", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                statuses: [
                  { id: "wamid.1", status: "sent" },
                  { id: "wamid.1", status: "delivered" },
                  { id: "wamid.2", status: "sent" },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
    });
    const keys = envelopes.map(envelope => envelope.orderingKey);

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys.every(key => /^phone-1:status:[a-f0-9]{24}$/.test(key))).toBe(
      true
    );
    expect(keys.join(" ")).not.toContain("wamid.1");
  });

  it("isolates status and call webhooks from the ordered customer message processor", () => {
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "status",
      })
    ).toBe("phone-1:status");
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "call",
      })
    ).toBe("phone-1:call");
  });

  it("isolates echo webhooks from the ordered customer message processor", () => {
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "smb_message_echoes",
      })
    ).toBe("phone-1:smb_message_echoes");
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "message_echoes",
      })
    ).toBe("phone-1:message_echoes");
  });

  it("classifies smb_message_echoes payloads with message_echoes arrays as SMB echoes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "phone-1" },
                contacts: [
                  {
                    user_id: "US.1349.private",
                    parent_user_id: "US.parent.private",
                    profile: { username: "@private_customer" },
                  },
                ],
                message_echoes: [
                  {
                    id: "wamid.echo.1",
                    from: "15551234567",
                    to_user_id: "US.1349.private",
                    timestamp: "1781481600",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [envelope] = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-06-15T09:45:00.000Z"),
    });

    expect(envelope).toMatchObject({
      field: "smb_message_echoes",
      phoneNumberId: "phone-1",
    });
    expect(envelope.orderingKey).toMatch(
      /^phone-1:smb_message_echoes:[a-f0-9]{24}$/
    );
    expect(envelope.dedupeKey).toContain(":smb_message_echoes:");
    expect(envelope.payload.body).toMatchObject({
      entry: [
        {
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                message_echoes: [
                  expect.objectContaining({
                    id: "wamid.echo.1",
                    to_user_id: "US.1349.private",
                  }),
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it("isolates slow sync webhooks from the ordered message processor", () => {
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "smb_app_state_sync",
      })
    ).toBe("phone-1:smb_app_state_sync");
    expect(
      getWhatsAppWebhookProcessorRoutingKey({
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        itemKind: "history",
      })
    ).toBe("phone-1:history");
  });

  it("includes the status value in status event dedupe keys", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                statuses: [
                  { id: "wamid.1", status: "sent", timestamp: "1" },
                  { id: "wamid.1", status: "delivered", timestamp: "2" },
                  { id: "wamid.1", status: "read", timestamp: "3" },
                  { id: "wamid.1", status: "delivered", timestamp: "4" },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-05-15T09:45:00.000Z"),
    });

    expect(envelopes).toHaveLength(4);
    expect(new Set(envelopes.map(envelope => envelope.dedupeKey)).size).toBe(3);
    expect(new Set(envelopes.map(envelope => envelope.orderingKey)).size).toBe(
      1
    );
    expect(envelopes[0].orderingKey).toMatch(/^phone-1:status:[a-f0-9]{24}$/);
    expect(envelopes[0].dedupeKey).not.toBe(envelopes[1].dedupeKey);
    expect(envelopes[1].dedupeKey).not.toBe(envelopes[2].dedupeKey);
    expect(envelopes[1].dedupeKey).toBe(envelopes[3].dedupeKey);
  });

  it("does not carry sibling message arrays into split status envelopes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [{ id: "wamid.message", type: "text" }],
                statuses: [{ id: "wamid.status", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-05-15T09:45:00.000Z"),
    });

    const messageEntry = envelopes[0].payload.body.entry as Array<{
      changes: Array<{ value: Record<string, unknown> }>;
    }>;
    const statusEntry = envelopes[1].payload.body.entry as Array<{
      changes: Array<{ value: Record<string, unknown> }>;
    }>;
    const messageValue = messageEntry[0]!.changes[0]!.value;
    const statusValue = statusEntry[0]!.changes[0]!.value;
    expect(messageValue).toMatchObject({
      messages: [{ id: "wamid.message", type: "text" }],
    });
    expect(messageValue).not.toHaveProperty("statuses");
    expect(statusValue).toMatchObject({
      statuses: [{ id: "wamid.status", status: "delivered" }],
    });
    expect(statusValue).not.toHaveProperty("messages");
  });

  it("splits top-level value errors into explicit durable error events", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                contacts: [{ wa_id: "16505551234" }],
                messages: [{ id: "wamid.message", type: "text" }],
                statuses: [{ id: "wamid.status", status: "failed" }],
                errors: [
                  {
                    code: 131000,
                    title: "System unavailable",
                    message: "System unavailable",
                    href: "/docs/whatsapp/cloud-api/support/error-codes/",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-06-23T09:45:00.000Z"),
    });

    expect(envelopes.map(envelope => envelope.itemKind)).toEqual([
      "message",
      "status",
      "error",
    ]);
    expect(envelopes[0].orderingKey).toMatch(/^phone-1:message:[a-f0-9]{24}$/);
    expect(envelopes[1].orderingKey).toMatch(/^phone-1:status:[a-f0-9]{24}$/);
    expect(envelopes[2].orderingKey).toBe("phone-1:error");

    const values = envelopes.map(
      envelope =>
        (
          envelope.payload.body.entry as Array<{
            changes: Array<{ value: Record<string, unknown> }>;
          }>
        )[0]!.changes[0]!.value
    );
    expect(values[0]).toMatchObject({
      messages: [{ id: "wamid.message", type: "text" }],
    });
    expect(values[0]).not.toHaveProperty("statuses");
    expect(values[0]).not.toHaveProperty("errors");
    expect(values[1]).toMatchObject({
      statuses: [{ id: "wamid.status", status: "failed" }],
    });
    expect(values[1]).not.toHaveProperty("messages");
    expect(values[1]).not.toHaveProperty("errors");
    expect(values[2]).toMatchObject({
      errors: [
        expect.objectContaining({
          code: 131000,
          href: "/docs/whatsapp/cloud-api/support/error-codes/",
        }),
      ],
    });
    expect(values[2]).not.toHaveProperty("messages");
    expect(values[2]).not.toHaveProperty("statuses");
  });

  it("does not ensure Mongo indexes while enqueuing webhook events", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.message",
                    from: "15550001",
                    timestamp: "1",
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = await enqueueWhatsAppWebhookEvents({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-06-21T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      received: 1,
      persisted: 1,
      published: 1,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockPublishWhatsAppWebhookEventToPubSub).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(ensureWhatsAppWebhookEventIndexes).not.toHaveBeenCalled();
  });

  it("keeps compacted completed receipts deduplicated without restoring their payload", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.compacted",
                    from: "15550001",
                    type: "text",
                    text: { body: "redelivery" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const receivedAt = new Date("2026-10-02T12:00:00.000Z");
    const compactedAt = new Date("2026-10-01T12:00:00.000Z");
    const receipt: Record<string, unknown> = {
      _id: "event-compacted",
      dedupeKey: buildWhatsAppWebhookEventEnvelopes({
        body,
        rawBody: JSON.stringify(body),
      })[0].dedupeKey,
      status: "completed",
      completedAt: new Date("2026-08-01T12:00:00.000Z"),
      payloadCompactedAt: compactedAt,
      duplicateCount: 3,
      publishAttempts: 1,
      originalPayloadHash: "original-hash",
    };
    mockFindOneAndUpdate.mockImplementation(async (filter, update) => {
      expect(filter).toEqual({ dedupeKey: receipt.dedupeKey });
      expect(update.$set).not.toHaveProperty("payload");
      expect(update.$set).not.toHaveProperty("payloadCompactedAt");
      Object.assign(receipt, update.$set);
      receipt.duplicateCount =
        Number(receipt.duplicateCount) + update.$inc.duplicateCount;
      return receipt;
    });

    const result = await enqueueWhatsAppWebhookEvents({
      body,
      rawBody: JSON.stringify(body),
      receivedAt,
    });

    expect(result).toMatchObject({
      persisted: 1,
      published: 0,
      publishFailures: 0,
      skippedAlreadyHandled: 1,
    });
    expect(result.events[0]).toMatchObject({
      eventId: "event-compacted",
      status: "completed",
      duplicateCount: 4,
      skippedAlreadyHandled: true,
    });
    expect(mockPublishWhatsAppWebhookEventToPubSub).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(receipt).not.toHaveProperty("payload");
    expect(receipt).toMatchObject({
      status: "completed",
      payloadCompactedAt: compactedAt,
      originalPayloadHash: "original-hash",
      lastReceivedAt: receivedAt,
    });
  });

  it("persists distinct chat lanes concurrently without changing their result order", async () => {
    const first = createDeferred<{
      _id: string;
      status: string;
      duplicateCount: number;
      publishAttempts: number;
    }>();
    mockFindOneAndUpdate.mockImplementation((filter: { dedupeKey: string }) => {
      if (filter.dedupeKey.includes("wamid.concurrent.1")) {
        return first.promise;
      }
      return Promise.resolve({
        _id: "event-2",
        status: "received",
        duplicateCount: 1,
        publishAttempts: 0,
      });
    });

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.concurrent.1",
                    from: "15550001",
                    type: "text",
                  },
                  {
                    id: "wamid.concurrent.2",
                    from: "15550002",
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const pending = enqueueWhatsAppWebhookEvents({
      body: payload,
      rawBody: JSON.stringify(payload),
    });

    await waitForQueuedWork();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);

    first.resolve({
      _id: "event-1",
      status: "received",
      duplicateCount: 1,
      publishAttempts: 0,
    });
    const result = await pending;

    expect(result.eventIds).toEqual(["event-1", "event-2"]);
  });

  it("keeps the same chat lane sequential during durable ingress", async () => {
    const first = createDeferred<{
      _id: string;
      status: string;
      duplicateCount: number;
      publishAttempts: number;
    }>();
    mockFindOneAndUpdate.mockImplementation((filter: { dedupeKey: string }) => {
      if (filter.dedupeKey.includes("wamid.sequential.1")) {
        return first.promise;
      }
      return Promise.resolve({
        _id: "event-2",
        status: "received",
        duplicateCount: 1,
        publishAttempts: 0,
      });
    });

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.sequential.1",
                    from: "15550001",
                    type: "text",
                  },
                  {
                    id: "wamid.sequential.2",
                    from: "15550001",
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const pending = enqueueWhatsAppWebhookEvents({
      body: payload,
      rawBody: JSON.stringify(payload),
    });

    await waitForQueuedWork();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);

    first.resolve({
      _id: "event-1",
      status: "received",
      duplicateCount: 1,
      publishAttempts: 0,
    });
    await pending;
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("splits Calling API call objects into one durable event per call", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "calls",
              value: {
                metadata: { phone_number_id: "phone-1" },
                calls: [
                  { id: "wacid.1", event: "connect", timestamp: "1" },
                  { id: "wacid.2", event: "terminate", timestamp: "2" },
                ],
              },
            },
          ],
        },
      ],
    };

    const envelopes = buildWhatsAppWebhookEventEnvelopes({
      body: payload,
      rawBody: JSON.stringify(payload),
      receivedAt: new Date("2026-05-15T09:45:00.000Z"),
    });

    expect(envelopes).toHaveLength(2);
    expect(new Set(envelopes.map(envelope => envelope.dedupeKey)).size).toBe(2);
    expect(new Set(envelopes.map(envelope => envelope.orderingKey)).size).toBe(
      2
    );
    expect(
      envelopes.every(envelope =>
        /^phone-1:call:[a-f0-9]{24}$/.test(envelope.orderingKey)
      )
    ).toBe(true);
    const firstValue = (
      envelopes[0].payload.body.entry as Array<{
        changes: Array<{ value: Record<string, unknown> }>;
      }>
    )[0]!.changes[0]!.value;
    expect(firstValue).toMatchObject({
      calls: [{ id: "wacid.1", event: "connect" }],
    });
    expect(firstValue).not.toHaveProperty("statuses");
  });
});
