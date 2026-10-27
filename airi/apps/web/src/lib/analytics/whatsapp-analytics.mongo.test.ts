import mongoose from "mongoose";
import {
  buildWhatsAppAnalyticsPipeline,
  normalizeWhatsAppLocalAnalytics,
} from "./whatsapp-analytics";
import { buildTemplateObservationWrites } from "./whatsapp-provider-analytics";
import {
  WhatsAppTemplateAnalyticsDaily,
  ensureWhatsAppTemplateAnalyticsIndexes,
} from "@/models/whatsapp-template-analytics-daily";
import {
  WhatsAppAnalyticsHealthDaily,
  ensureWhatsAppAnalyticsHealthIndexes,
} from "@/models/whatsapp-analytics-health-daily";
import { buildWhatsAppMessageCostUsdExpr } from "@/lib/campaign/whatsapp-campaign-cost";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  queryWhatsAppAnalytics,
  syncWhatsAppAnalyticsSources,
} from "./whatsapp-analytics-service";

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (key: string, params: string[]) =>
    `${key}:${params.join(":")}`,
  cache: {
    get: jest.fn(async () => undefined),
    set: jest.fn(async () => undefined),
    acquireLock: jest.fn(async () => "unavailable"),
    compareAndDelete: jest.fn(async () => false),
  },
}));

// Opt-in, disposable local database only. Never inherit a production Mongo URI.
const uri = process.env.WHATSAPP_ANALYTICS_QA_URI;
const local = uri ? new URL(uri) : null;
if (
  local &&
  (local.hostname !== "127.0.0.1" ||
    !local.pathname.startsWith("/airi_analytics_qa_whatsapp_"))
)
  throw new Error(
    "WhatsApp regression requires its named disposable local database"
  );
const suite = uri ? describe : describe.skip;
suite("WhatsApp aggregation against actual Mongo", () => {
  const workspaceId = "synthetic-whatsapp-qa";
  const start = new Date("2026-10-01T00:00:00Z"),
    end = new Date("2026-10-02T00:00:00Z");
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 9, 1, 10, 0, seconds));
  const conversations = [
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
  ];
  beforeAll(async () => {
    await mongoose.connect(uri!, {
      autoIndex: false,
      serverSelectionTimeoutMS: 3000,
    });
    await mongoose.connection.dropDatabase();
    await ensureWhatsAppTemplateAnalyticsIndexes();
    await ensureWhatsAppAnalyticsHealthIndexes();
    await mongoose.connection
      .db!.collection("messages")
      .createIndex({ workspaceId: 1, channel: 1, direction: 1, date: 1 });
    await mongoose.connection.db!.collection("messages").createIndex({
      conversation: 1,
      workspaceId: 1,
      channel: 1,
      direction: 1,
      date: 1,
    });
    await mongoose.connection
      .db!.collection("messagedeliveryevents")
      .createIndex({ workspaceId: 1, messageId: 1, eventAt: 1 });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test("deduplicates provider WAMID, survives read-before-delivered/late failure, scopes replies and aggregates trends", async () => {
    const messages = mongoose.connection.db!.collection("messages"),
      events = mongoose.connection.db!.collection("messagedeliveryevents");
    const outbound = {
      workspaceId,
      channel: "whatsapp",
      direction: "outbound",
    };
    await messages.insertMany([
      {
        ...outbound,
        messageId: "wamid.a",
        conversation: conversations[0],
        date: at(0),
        origin: { kind: "manual", sourceId: "s1" },
        delivery: { status: "failed", failedAt: at(6) },
      },
      {
        ...outbound,
        messageId: "ws_wamid.a",
        conversation: conversations[0],
        date: at(1),
        origin: { kind: "manual", sourceId: "s1" },
      },
      {
        ...outbound,
        messageId: "wamid.b",
        conversation: conversations[1],
        date: at(10),
        origin: { kind: "scenario", sourceId: "s2", templateName: "Reminder" },
      },
      {
        ...outbound,
        messageId: "wamid.c",
        conversation: conversations[2],
        date: at(20),
        origin: {
          kind: "bulk_campaign",
          sourceId: "s2",
          templateName: "Offer",
        },
      },
      {
        workspaceId,
        channel: "whatsapp",
        direction: "inbound",
        conversation: conversations[0],
        date: at(7),
        messageId: "ws_wamid.reply",
      },
      {
        workspaceId: "another-workspace",
        channel: "whatsapp",
        direction: "inbound",
        conversation: conversations[1],
        date: at(11),
      },
      {
        workspaceId,
        channel: "whatsapp",
        direction: "inbound",
        conversation: conversations[1],
        date: new Date("2026-10-03"),
      },
      {
        ...outbound,
        workspaceId: "another-workspace",
        messageId: "wamid.z",
        conversation: conversations[0],
        date: at(30),
        delivery: { status: "read" },
      },
    ]);
    const receipt = {
      workspaceId,
      messageId: "wamid.a",
      phoneNumberId: "provider-phone-1",
      sourceId: "s1",
    };
    await events.insertMany([
      { ...receipt, status: "read", eventAt: at(5) },
      {
        ...receipt,
        status: "delivered",
        eventAt: at(3),
        pricingType: "regular",
        pricingBillable: true,
        pricingCategory: "service",
      },
      {
        ...receipt,
        status: "delivered",
        eventAt: at(3),
        pricingType: "regular",
        pricingBillable: true,
        pricingCategory: "service",
      },
      { ...receipt, status: "sent", eventAt: at(1) },
      { ...receipt, status: "failed", eventAt: at(6), errorCode: 999 },
      {
        workspaceId,
        messageId: "wamid.c",
        phoneNumberId: "provider-phone-2",
        sourceId: "s2",
        status: "failed",
        eventAt: at(22),
        errorCode: 131026,
      },
    ]);
    const [raw] = await messages
      .aggregate(buildWhatsAppAnalyticsPipeline({ workspaceId, start, end }), {
        maxTimeMS: 10000,
      })
      .toArray();
    const result = normalizeWhatsAppLocalAnalytics(raw);
    expect(result.delivery).toMatchObject({
      accepted: 3,
      sent: 1,
      delivered: 1,
      read: 1,
      replied: 1,
      failed: 1,
      pending: 1,
      medianDeliverySeconds: 3,
      medianReadSeconds: 5,
      topErrors: [{ code: "131026", count: 1 }],
    });
    expect(result.pricing).toMatchObject({ billable: 1, free: 0, unknown: 0 });
    expect(result.delivery.dailyDelivery[0]).toMatchObject({
      day: "2026-10-01",
      accepted: 3,
      failed: 1,
      pending: 1,
      topErrors: [{ code: "131026", count: 1 }],
    });
    expect(result.delivery.bySourcePhoneTemplate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "s1",
          phoneNumberId: "provider-phone-1",
          accepted: 1,
          delivered: 1,
        }),
      ])
    );
    const [scoped] = await messages
      .aggregate(
        buildWhatsAppAnalyticsPipeline({
          workspaceId,
          start,
          end,
          sourceId: "s2",
        })
      )
      .toArray();
    expect(normalizeWhatsAppLocalAnalytics(scoped).delivery.accepted).toBe(2);
    // Legacy sends can still be attributed by the provider delivery owner.
    await messages.insertOne({
      workspaceId,
      channel: "whatsapp",
      direction: "outbound",
      messageId: "wamid.legacy",
      date: at(25),
      conversation: new mongoose.Types.ObjectId(),
      text: "fixture",
    });
    await events.insertOne({
      workspaceId,
      messageId: "wamid.legacy",
      sourceId: "s2",
      status: "delivered",
      eventAt: at(26),
    });
    await events.insertOne({
      workspaceId,
      messageId: "wamid.legacy",
      sourceId: null,
      status: "read",
      eventAt: at(27),
    });
    const [withLegacy] = await messages
      .aggregate(
        buildWhatsAppAnalyticsPipeline({
          workspaceId,
          start,
          end,
          sourceId: "s2",
        })
      )
      .toArray();
    expect(normalizeWhatsAppLocalAnalytics(withLegacy).delivery.accepted).toBe(
      3
    );
  });

  test("ends reply attribution at the next different send and buckets days in the viewer zone", async () => {
    const tenant = "synthetic-whatsapp-reply-window";
    const messages = mongoose.connection.db!.collection("messages");
    const [first, second] = [
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
    ];
    const outbound = {
      workspaceId: tenant,
      channel: "whatsapp",
      direction: "outbound",
    };
    const inbound = {
      workspaceId: tenant,
      channel: "whatsapp",
      direction: "inbound",
    };
    await messages.insertMany([
      // 01:00 in Almaty on 2 October, still 1 October in UTC.
      {
        ...outbound,
        messageId: "wamid.early",
        conversation: first,
        date: new Date("2026-10-01T20:00:00Z"),
      },
      {
        ...outbound,
        messageId: "wamid.next",
        conversation: first,
        date: new Date("2026-10-01T20:05:00Z"),
      },
      {
        ...inbound,
        conversation: first,
        date: new Date("2026-10-01T20:10:00Z"),
      },
      // A stored copy of the same send does not end its reply window.
      {
        ...outbound,
        messageId: "wamid.copied",
        conversation: second,
        date: new Date("2026-10-01T10:00:00Z"),
      },
      {
        ...outbound,
        messageId: "ws_wamid.copied",
        conversation: second,
        date: new Date("2026-10-01T10:00:01Z"),
      },
      {
        ...inbound,
        conversation: second,
        date: new Date("2026-10-01T10:00:05Z"),
      },
    ]);
    const run = async (timeZone?: string) =>
      normalizeWhatsAppLocalAnalytics(
        (
          await messages
            .aggregate(
              buildWhatsAppAnalyticsPipeline({
                workspaceId: tenant,
                start: new Date("2026-10-01T00:00:00Z"),
                end: new Date("2026-10-02T00:00:00Z"),
                timeZone,
              })
            )
            .toArray()
        )[0]
      ).delivery;
    const utc = await run();
    expect(utc).toMatchObject({ accepted: 3, replied: 2 });
    expect(utc.dailyDelivery.map(day => [day.day, day.accepted])).toEqual([
      ["2026-10-01", 3],
    ]);
    const almaty = await run("Asia/Almaty");
    expect(almaty).toMatchObject({ accepted: 3, replied: 2 });
    expect(almaty.dailyDelivery.map(day => [day.day, day.accepted])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 2],
    ]);
  });

  test("retains read/click observations when later Meta retention resets the counters", async () => {
    const payload = (read: number, click: number) => ({
      template_analytics: {
        data: [
          {
            data_points: [
              {
                template_id: "template-1",
                start: start.getTime() / 1000,
                end: end.getTime() / 1000,
                sent: 8,
                delivered: 7,
                read,
                clicked: [
                  { type: "url_button", count: click },
                  { type: "unique_url_button", count: click },
                ],
                cost: [{ type: "amount_spent", value: 0.4 }],
              },
            ],
          },
        ],
      },
    });
    await WhatsAppTemplateAnalyticsDaily.bulkWrite(
      buildTemplateObservationWrites(
        workspaceId,
        "waba-1",
        payload(4, 2),
        "USD",
        end
      )
    );
    await WhatsAppTemplateAnalyticsDaily.bulkWrite(
      buildTemplateObservationWrites(
        workspaceId,
        "waba-1",
        payload(0, 0),
        "USD",
        new Date("2026-10-10")
      )
    );
    expect(
      await WhatsAppTemplateAnalyticsDaily.countDocuments({ workspaceId })
    ).toBe(1);
    expect(
      await WhatsAppTemplateAnalyticsDaily.findOne({ workspaceId }).lean()
    ).toMatchObject({ read: 4, clicked: 2, uniqueClicked: 2, cost: 0.4 });
    await WhatsAppTemplateAnalyticsDaily.bulkWrite(
      buildTemplateObservationWrites(
        workspaceId,
        "waba-1",
        {
          template_analytics: {
            data: [
              {
                data_points: [
                  {
                    template_id: "never-observed",
                    start: Date.parse("2026-09-01") / 1000,
                    end: Date.parse("2026-09-02") / 1000,
                    sent: 4,
                    delivered: 3,
                    read: 0,
                    clicked: [],
                  },
                ],
              },
            ],
          },
        },
        "KZT",
        end
      )
    );
    expect(
      await WhatsAppTemplateAnalyticsDaily.findOne({
        workspaceId,
        templateId: "never-observed",
      }).lean()
    ).toMatchObject({ read: null, clicked: null, cost: null, currency: "KZT" });
    await WhatsAppAnalyticsHealthDaily.updateOne(
      { workspaceId, sourceId: "s1", day: "2026-10-02" },
      {
        $set: {
          observedAt: end,
          accountStatus: "action_required",
          webhookStatus: "unknown",
        },
      },
      { upsert: true }
    );
    await WhatsAppAnalyticsHealthDaily.updateOne(
      { workspaceId, sourceId: "s1", day: "2026-10-02" },
      {
        $set: {
          observedAt: end,
          accountStatus: "healthy",
          webhookStatus: "healthy",
        },
      },
      { upsert: true }
    );
    expect(
      await WhatsAppAnalyticsHealthDaily.countDocuments({ workspaceId })
    ).toBe(1);
  });

  const healthSources = (
    tenant: string,
    credentials: Record<string, unknown>
  ) => {
    const result = Promise.resolve({
      data: [{ id: "health-source", workspace_id: tenant, credentials }],
      error: null,
    });
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      order: jest.fn(),
      limit: jest.fn(),
      gt: jest.fn(),
      abortSignal: jest.fn(),
      then: result.then.bind(result),
    };
    for (const field of [
      "select",
      "eq",
      "order",
      "limit",
      "gt",
      "abortSignal",
    ] as const)
      query[field].mockReturnValue(query);
    jest.mocked(supabaseAdmin.from).mockReturnValue(query as never);
  };
  const healthMessages = async (tenant: string, day = "2026-10-02") => {
    await mongoose.connection.db!.collection("messages").insertMany([
      {
        workspaceId: tenant,
        channel: "whatsapp",
        direction: "outbound",
        messageId: `wamid.${tenant}.pending`,
        date: new Date(`${day}T10:30:00Z`),
        origin: { kind: "manual", sourceId: "health-source" },
      },
      {
        workspaceId: tenant,
        channel: "whatsapp",
        direction: "outbound",
        messageId: `wamid.${tenant}.failed`,
        date: new Date(`${day}T10:30:00Z`),
        origin: { kind: "manual", sourceId: "health-source" },
        delivery: {
          status: "failed",
          failedAt: new Date(`${day}T10:31:00Z`),
        },
      },
    ]);
  };

  test("an older overlapping health request cannot regress either daily observation clock", async () => {
    const tenant = "synthetic-whatsapp-health-order";
    await healthMessages(tenant);
    healthSources(tenant, {
      quality_rating: "GREEN",
      webhook_subscribed: true,
    });
    const newer = new Date("2026-10-02T11:00:00Z"),
      older = new Date("2026-10-02T10:00:00Z");
    await syncWhatsAppAnalyticsSources({ workspaceId: tenant, now: newer });
    healthSources(tenant, {
      quality_rating: "RED",
      webhook_subscribed: false,
      webhook_requires_reconnect: true,
    });
    await syncWhatsAppAnalyticsSources({ workspaceId: tenant, now: older });
    await syncWhatsAppAnalyticsSources({ workspaceId: tenant, now: newer });
    expect(
      await WhatsAppAnalyticsHealthDaily.findOne({ workspaceId: tenant }).lean()
    ).toMatchObject({
      observedAt: newer,
      deliveryObservedAt: newer,
      phoneQuality: "GREEN",
      webhookStatus: "healthy",
      pending7d: 1,
      failed7d: 1,
    });
    expect(
      await WhatsAppAnalyticsHealthDaily.countDocuments({ workspaceId: tenant })
    ).toBe(1);
  });

  test("health and delivery advance independently and a health-only refresh retains delivery observations", async () => {
    const tenant = "synthetic-whatsapp-independent-clocks";
    const day = new Date().toISOString().slice(0, 10);
    await healthMessages(tenant, day);
    const healthAt = new Date(`${day}T12:00:00Z`),
      deliveryAt = new Date(`${day}T11:00:00Z`);
    await WhatsAppAnalyticsHealthDaily.create({
      workspaceId: tenant,
      sourceId: "health-source",
      day,
      observedAt: healthAt,
      phoneQuality: "GREEN",
      accountStatus: "healthy",
      webhookStatus: "healthy",
      deliveryObservedAt: new Date(`${day}T09:00:00Z`),
      pending7d: 9,
      failed7d: 8,
    });
    healthSources(tenant, {
      quality_rating: "RED",
      webhook_subscribed: false,
      webhook_requires_reconnect: true,
    });
    await syncWhatsAppAnalyticsSources({
      workspaceId: tenant,
      now: deliveryAt,
    });
    expect(
      await WhatsAppAnalyticsHealthDaily.findOne({ workspaceId: tenant }).lean()
    ).toMatchObject({
      observedAt: healthAt,
      phoneQuality: "GREEN",
      webhookStatus: "healthy",
      deliveryObservedAt: deliveryAt,
      pending7d: 1,
      failed7d: 1,
    });
    await syncWhatsAppAnalyticsSources({
      workspaceId: tenant,
      now: new Date(`${day}T10:00:00Z`),
    });
    await queryWhatsAppAnalytics({
      workspaceId: tenant,
      days: 7,
      refresh: true,
    });
    expect(
      await WhatsAppAnalyticsHealthDaily.findOne({
        workspaceId: tenant,
        day,
      }).lean()
    ).toMatchObject({
      deliveryObservedAt: deliveryAt,
      pending7d: 1,
      failed7d: 1,
    });

    const healthTenant = "synthetic-whatsapp-independent-health";
    await WhatsAppAnalyticsHealthDaily.create({
      workspaceId: healthTenant,
      sourceId: "health-source",
      day,
      observedAt: new Date(`${day}T09:00:00Z`),
      phoneQuality: "GREEN",
      accountStatus: "healthy",
      webhookStatus: "healthy",
      deliveryObservedAt: healthAt,
      pending7d: 9,
      failed7d: 8,
    });
    healthSources(healthTenant, {
      quality_rating: "RED",
      webhook_subscribed: false,
      webhook_requires_reconnect: true,
    });
    await syncWhatsAppAnalyticsSources({
      workspaceId: healthTenant,
      now: deliveryAt,
    });
    expect(
      await WhatsAppAnalyticsHealthDaily.findOne({
        workspaceId: healthTenant,
      }).lean()
    ).toMatchObject({
      observedAt: deliveryAt,
      phoneQuality: "RED",
      webhookStatus: "action_required",
      deliveryObservedAt: healthAt,
      pending7d: 9,
      failed7d: 8,
    });
  });

  test("atomic daily health publication treats dollar-prefixed provider values literally and keeps one upsert identity", async () => {
    const tenant = "synthetic-whatsapp-health-literals";
    healthSources(tenant, {
      quality_rating: "$provider.quality",
      whatsapp_business_manager_messaging_limit: "$portfolio.limit",
      webhook_subscribed: true,
    });
    const now = new Date("2026-10-02T13:00:00Z");
    await Promise.all([
      syncWhatsAppAnalyticsSources({ workspaceId: tenant, now }),
      syncWhatsAppAnalyticsSources({ workspaceId: tenant, now }),
    ]);
    expect(
      await WhatsAppAnalyticsHealthDaily.findOne({ workspaceId: tenant }).lean()
    ).toMatchObject({
      observedAt: now,
      deliveryObservedAt: now,
      phoneQuality: "$provider.quality",
      portfolioLimit: "$portfolio.limit",
      templateIssues: null,
      pending7d: 0,
      failed7d: 0,
    });
    expect(
      await WhatsAppAnalyticsHealthDaily.countDocuments({ workspaceId: tenant })
    ).toBe(1);
  });

  test("actual Mongo cost projection preserves unknown, contradictory and uncovered receipts", async () => {
    const collection = mongoose.connection.db!.collection("pricingfixtures");
    await collection.insertMany([
      { key: "unknown", wasDelivered: true },
      {
        key: "free",
        wasDelivered: true,
        pricingReceipt: {
          pricingType: "free_entry_point",
          pricingBillable: false,
        },
      },
      {
        key: "conflict",
        wasDelivered: true,
        pricingReceipt: {
          pricingType: "free_entry_point",
          pricingBillable: true,
        },
      },
      {
        key: "billable",
        wasDelivered: true,
        pricingReceipt: {
          pricingType: "regular",
          pricingBillable: true,
          pricingCategory: "service",
        },
      },
    ]);
    const results = await collection
      .aggregate([
        { $project: { key: 1, cost: buildWhatsAppMessageCostUsdExpr() } },
      ])
      .toArray();
    expect(Object.fromEntries(results.map(row => [row.key, row.cost]))).toEqual(
      { unknown: null, free: 0, conflict: null, billable: null }
    );
    await collection.updateOne(
      { key: "billable" },
      {
        $set: {
          recipientMarket: "kz",
          pricingCurrency: "usd",
          pricingTier: "list",
          date: new Date("2026-09-01"),
          "pricingReceipt.eventAt": new Date("2026-10-02"),
        },
      }
    );
    const tariff = {
      market: "KZ",
      currency: "USD",
      tier: "list",
      category: "service",
      effectiveFrom: "2026-10-01",
      effectiveUntil: "2026-10-03",
      rate: 0.01,
      version: "test-verified",
    };
    const cost = async (cards: (typeof tariff)[]) =>
      (
        await collection
          .aggregate([
            { $match: { key: "billable" } },
            { $project: { cost: buildWhatsAppMessageCostUsdExpr(cards) } },
          ])
          .toArray()
      )[0].cost;
    expect(await cost([tariff])).toBe(0.01);
    expect(await cost([tariff, tariff])).toBeNull();
    expect(
      await cost([{ ...tariff, effectiveUntil: "2026-10-02" }])
    ).toBeNull();
    await collection.updateOne(
      { key: "billable" },
      { $set: { "delivery.deliveredAt": new Date("2026-10-01") } }
    );
    expect(await cost([{ ...tariff, effectiveFrom: "2026-10-02" }])).toBeNull();
  });
});
