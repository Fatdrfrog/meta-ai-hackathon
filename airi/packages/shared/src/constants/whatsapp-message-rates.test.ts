import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWhatsAppCampaignPricingReceiptPatch,
  resolveWhatsAppCampaignCostStatus,
  resolveWhatsAppCampaignReportedCost,
  resolveWhatsAppTariffEstimate,
} from "./whatsapp-message-rates";

test("provider receipts preserve actual free flags and conflicts after October service pricing changes", () => {
  const at = new Date("2026-10-02T01:00:00Z");
  assert.deepEqual(
    buildWhatsAppCampaignPricingReceiptPatch(
      { type: "free_customer_service", billable: false, category: "service" },
      at,
    ),
    {
      estimated_cost_usd: 0,
      cost_coverage: "provider_free",
      pricing_type: "free_customer_service",
      pricing_billable: false,
      pricing_category: "service",
      pricing_event_at: at.toISOString(),
    },
  );
  assert.equal(
    buildWhatsAppCampaignPricingReceiptPatch(
      { type: "free_entry_point", billable: true },
      at,
    )?.estimated_cost_usd,
    null,
  );
  assert.equal(
    buildWhatsAppCampaignPricingReceiptPatch({ category: "service" }, at)
      ?.cost_coverage,
    "unknown",
  );
  assert.equal(buildWhatsAppCampaignPricingReceiptPatch({}, at), undefined);
  assert.equal(
    buildWhatsAppCampaignPricingReceiptPatch(
      { billable: false },
      new Date("invalid"),
    ),
    undefined,
  );
});

test("reported campaign cost requires explicit complete coverage, including legacy zero", () => {
  assert.equal(
    resolveWhatsAppCampaignReportedCost({
      channel: "whatsapp",
      estimated_cost: 0,
    }),
    null,
  );
  assert.equal(
    resolveWhatsAppCampaignReportedCost({
      channel: "whatsapp",
      estimated_cost: 1,
      cost_coverage_started_at: "2026-10-02",
      unknown_cost_count: 1,
    }),
    null,
  );
  assert.equal(
    resolveWhatsAppCampaignReportedCost({
      channel: "whatsapp",
      estimated_cost: 0,
      cost_coverage_started_at: "2026-10-02",
      unknown_cost_count: 0,
    }),
    0,
  );
  assert.equal(
    resolveWhatsAppCampaignReportedCost({
      channel: "email",
      estimated_cost: 1,
    }),
    1,
  );
});

test("campaign cost status explains a missing amount instead of hiding it", () => {
  assert.deepEqual(
    resolveWhatsAppCampaignCostStatus({
      channel: "whatsapp",
      estimated_cost: null,
      cost_coverage_started_at: "2026-10-03T09:00:00Z",
      unknown_cost_count: 239,
    }),
    { status: "not_priced", amount: null, unpricedCount: 239 },
  );
  assert.deepEqual(
    resolveWhatsAppCampaignCostStatus({
      channel: "whatsapp",
      estimated_cost: 13.95,
      cost_coverage_started_at: null,
      unknown_cost_count: 0,
    }),
    { status: "not_tracked", amount: null, unpricedCount: null },
    "a legacy estimate stays hidden; the campaign predates cost tracking",
  );
  assert.deepEqual(
    resolveWhatsAppCampaignCostStatus({
      channel: "whatsapp",
      estimated_cost: 0.5,
      cost_coverage_started_at: "2026-10-03T09:00:00Z",
      unknown_cost_count: 0,
    }),
    { status: "reported", amount: 0.5, unpricedCount: 0 },
  );
  assert.deepEqual(
    resolveWhatsAppCampaignCostStatus({
      channel: "whatsapp",
      estimated_cost: null,
      cost_coverage_started_at: "2026-10-03T09:00:00Z",
      unknown_cost_count: null,
    }),
    { status: "not_priced", amount: null, unpricedCount: null },
  );
});

test("tariffs require explicit dimensions, one date-covered card and a version", () => {
  const tariff = {
    market: "KZ",
    currency: "USD",
    category: "service",
    tier: "list",
    effectiveFrom: "2026-10-01",
    effectiveUntil: "2026-10-03",
    rate: 0.01,
    version: "test-verified",
  };
  const context = {
    market: "kz",
    currency: "usd",
    category: "SERVICE",
    tier: "list",
    at: "2026-10-02",
    tariffs: [tariff],
  };
  assert.equal(resolveWhatsAppTariffEstimate(context)?.amount, 0.01);
  assert.equal(
    resolveWhatsAppTariffEstimate({ ...context, tariffs: [tariff, tariff] }),
    null,
  );
  assert.equal(
    resolveWhatsAppTariffEstimate({ ...context, at: "2026-10-03" }),
    null,
  );
  assert.equal(
    resolveWhatsAppTariffEstimate({ ...context, category: "" }),
    null,
  );
  assert.equal(resolveWhatsAppTariffEstimate({ ...context, tier: "" }), null);
  assert.equal(
    resolveWhatsAppTariffEstimate({
      ...context,
      tariffs: [{ ...tariff, version: "" }],
    }),
    null,
  );
});
