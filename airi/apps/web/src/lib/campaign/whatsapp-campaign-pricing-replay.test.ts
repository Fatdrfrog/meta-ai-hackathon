import { replayWhatsAppCampaignPricingPage } from "./whatsapp-campaign-pricing-replay";
import { supabaseAdmin } from "@/lib/supabase/admin";
import MessageDeliveryEvent from "@/models/message-delivery-event";

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn(), rpc: jest.fn() },
}));
jest.mock("@/models/message-delivery-event", () => ({
  __esModule: true,
  default: { aggregate: jest.fn() },
}));

const from = supabaseAdmin.from as jest.Mock;
const rpc = supabaseAdmin.rpc as jest.Mock;
const aggregate = MessageDeliveryEvent.aggregate as jest.Mock;

function setup(
  rows: Array<{
    id: string;
    message_id?: string;
    estimated_cost_usd?: number | null;
    cost_coverage?: string;
  }>,
  receipts: unknown[] = [],
  owned = true,
  options: {
    campaign?: Record<string, unknown>;
    legacyMessageRows?: Array<{ id: string }>;
  } = {}
) {
  const campaign = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({
      data: owned ? { id: "campaign", ...options.campaign } : null,
      error: null,
    }),
  };
  const messages = {
    select: jest.fn(function (this: { columns?: string }, columns: string) {
      return { ...this, columns };
    }),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    then(this: { columns?: string }, resolve: (value: unknown) => unknown) {
      // The legacy-estimate probe selects only ids; pages select receipts.
      const data =
        this.columns === "id" ? options.legacyMessageRows || [] : rows;
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  const updates: Record<string, unknown>[] = [];
  const updateQuery = {
    eq: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ error: null }).then(resolve),
  };
  from.mockImplementation(table =>
    table === "campaign_history"
      ? campaign
      : {
          ...messages,
          update: jest.fn(patch => {
            updates.push(patch);
            return updateQuery;
          }),
        }
  );
  const eventQuery = {
    allowDiskUse: jest.fn().mockReturnThis(),
    option: jest.fn().mockResolvedValue(receipts),
  };
  aggregate.mockReturnValue(eventQuery);
  rpc.mockResolvedValue({ error: null });
  return { campaign, messages, updates, updateQuery, eventQuery };
}

beforeEach(() => jest.clearAllMocks());

it("checks workspace ownership before reading receipt or message pages", async () => {
  const mocks = setup([], [], false);
  await expect(
    replayWhatsAppCampaignPricingPage({
      workspaceId: "workspace",
      campaignId: "campaign",
      dryRun: false,
    })
  ).rejects.toThrow("unavailable in workspace");
  expect(mocks.campaign.eq).toHaveBeenCalledWith("workspace_id", "workspace");
  expect(aggregate).not.toHaveBeenCalled();
  expect(from).toHaveBeenCalledTimes(1);
});

it("defaults to a bounded dry run, preserves actual free flags and leaves unknown costs unknown", async () => {
  const mocks = setup(
    [
      { id: "1", message_id: "wamid.free" },
      { id: "2", message_id: "wamid.billable" },
      { id: "3", message_id: "wamid.missing" },
    ],
    [
      {
        _id: "wamid.free",
        receipt: {
          pricingType: "free_customer_service",
          pricingBillable: false,
          pricingCategory: "service",
          eventAt: new Date("2026-10-02T01:00:00Z"),
        },
      },
      {
        _id: "wamid.billable",
        receipt: {
          pricingType: "regular",
          pricingBillable: true,
          pricingCategory: "service",
          eventAt: new Date("2026-10-02T01:00:01Z"),
        },
      },
    ]
  );
  const result = await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
  });
  expect(result).toMatchObject({
    scanned: 3,
    observed: 2,
    free: 1,
    unknown: 2,
    hasMore: false,
    dryRun: true,
  });
  expect(mocks.updates).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
  expect(mocks.messages.limit).toHaveBeenCalledWith(251);
  expect(aggregate.mock.calls[0][0][0].$match).toMatchObject({
    workspaceId: "workspace",
    messageId: { $in: ["wamid.free", "wamid.billable", "wamid.missing"] },
  });
  expect(mocks.eventQuery.option).toHaveBeenCalledWith({ maxTimeMS: 15000 });
});

it("writes receipt metadata with nullable billable cost and recomputes only a completed page", async () => {
  const mocks = setup(
    [{ id: "1", message_id: "wamid.billable" }],
    [
      {
        _id: "wamid.billable",
        receipt: {
          pricingType: "regular",
          pricingBillable: true,
          pricingCategory: "service",
          eventAt: new Date("2026-10-02T01:00:01Z"),
        },
      },
    ]
  );
  await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
    dryRun: false,
  });
  expect(mocks.updates).toEqual([
    {
      estimated_cost_usd: null,
      cost_coverage: "unknown",
      pricing_type: "regular",
      pricing_billable: true,
      pricing_category: "service",
      pricing_event_at: "2026-10-02T01:00:01.000Z",
    },
  ]);
  expect(mocks.updateQuery.eq).toHaveBeenCalledWith("campaign_id", "campaign");
  expect(rpc).toHaveBeenCalledWith("recompute_bulk_campaign_stats", {
    p_campaign_id: "campaign",
  });
});

it("caps pages, uses a keyset cursor and avoids recomputing a partial repair", async () => {
  const mocks = setup(
    Array.from({ length: 501 }, (_, i) => ({ id: String(i + 1) }))
  );
  const result = await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
    limit: 10000,
    afterId: "previous",
    dryRun: false,
  });
  expect(mocks.messages.limit).toHaveBeenCalledWith(501);
  expect(mocks.messages.gt).toHaveBeenCalledWith("id", "previous");
  expect(result).toMatchObject({
    scanned: 500,
    hasMore: true,
    nextId: "500",
    unknown: 500,
  });
  expect(aggregate).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

const billableReceipt = {
  _id: "wamid.billable",
  receipt: {
    pricingType: "regular",
    pricingBillable: true,
    pricingCategory: "marketing_lite",
    eventAt: new Date("2026-10-03T14:57:14Z"),
  },
};

it("never writes or recomputes a campaign that still stores a legacy estimate", async () => {
  const mocks = setup(
    [
      {
        id: "1",
        message_id: "wamid.billable",
        estimated_cost_usd: 0.0604,
        cost_coverage: "unknown",
      },
    ],
    [billableReceipt],
    true,
    { campaign: { estimated_cost: 13.95, cost_coverage_started_at: null } }
  );
  const result = await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
    dryRun: false,
  });
  expect(result).toMatchObject({
    observed: 1,
    unknown: 1,
    skipped: "legacy_estimate",
  });
  expect(mocks.updates).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
});

it("treats a campaign whose erased total still has legacy message estimates as legacy", async () => {
  const mocks = setup(
    [{ id: "1", message_id: "wamid.billable" }],
    [billableReceipt],
    true,
    {
      campaign: { estimated_cost: null, cost_coverage_started_at: null },
      legacyMessageRows: [{ id: "1" }],
    }
  );
  const result = await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
    dryRun: false,
  });
  expect(result.skipped).toBe("legacy_estimate");
  expect(mocks.messages.gt).toHaveBeenCalledWith("estimated_cost_usd", 0);
  expect(mocks.updates).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
});

it("keeps a stored message estimate when replaying an unpriced receipt", async () => {
  const mocks = setup(
    [
      {
        id: "1",
        message_id: "wamid.billable",
        estimated_cost_usd: 0.0604,
        cost_coverage: "unknown",
      },
    ],
    [billableReceipt],
    true,
    { campaign: { cost_coverage_started_at: "2026-10-03T09:00:00Z" } }
  );
  const result = await replayWhatsAppCampaignPricingPage({
    workspaceId: "workspace",
    campaignId: "campaign",
    dryRun: false,
  });
  expect(result.skipped).toBeNull();
  expect(mocks.updates).toEqual([
    {
      cost_coverage: "unknown",
      pricing_type: "regular",
      pricing_billable: true,
      pricing_category: "marketing_lite",
      pricing_event_at: "2026-10-03T14:57:14.000Z",
    },
  ]);
  expect(rpc).toHaveBeenCalledTimes(1);
});
