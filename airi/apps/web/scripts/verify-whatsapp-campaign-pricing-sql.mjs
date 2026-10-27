import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.PGLITE_MODULE_PATH)
  throw new Error(
    "Set PGLITE_MODULE_PATH to an installed test-only PGlite module; no production dependency is added."
  );
const { PGlite } = await import(
  pathToFileURL(process.env.PGLITE_MODULE_PATH).href
);
const db = new PGlite();
const migrationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations"
);
const { buildWhatsAppCampaignPricingReceiptPatch } = await import(
  pathToFileURL(
    path.resolve(
      migrationRoot,
      "../../packages/shared/src/constants/whatsapp-message-rates.ts"
    )
  ).href
);
const original = (
  await fs.readFile(
    path.join(migrationRoot, "20260727084019_bulk_campaign_sql_ledger.sql"),
    "utf8"
  )
).replaceAll("\r\n", "\n");
const extract = name => {
  const start = original.indexOf(`create or replace function public.${name}(`),
    end = original.indexOf("\n$$;", start);
  assert.ok(start >= 0 && end > start);
  return original.slice(start, end + 4);
};
// Fixture declares the columns referenced by the canonical ledger functions.
// Execute the original production function bodies/transition-table triggers,
// then the complete new migration; do not substitute mock rollup SQL.
await db.exec(`SET TIME ZONE 'UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE campaign_history (
 id uuid PRIMARY KEY, workspace_id uuid, channel text, total_recipients integer NOT NULL DEFAULT 0,
 audience_fingerprint text, successful_sends integer DEFAULT 0, failed_sends integer DEFAULT 0,
 delivered_count integer NOT NULL DEFAULT 0, read_count integer NOT NULL DEFAULT 0,
 opened_count integer NOT NULL DEFAULT 0, clicked_count integer NOT NULL DEFAULT 0,
 unsubscribed_count integer NOT NULL DEFAULT 0, bounced_count integer NOT NULL DEFAULT 0,
 delivery_ledger_started_at timestamptz, cost_ledger_started_at timestamptz,
 delivery_rate numeric, read_rate numeric, open_rate numeric, click_rate numeric, unsubscribe_rate numeric, bounce_rate numeric,
 estimated_cost numeric(18,6), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE campaign_messages (
 id uuid PRIMARY KEY, campaign_id uuid REFERENCES campaign_history(id), channel text DEFAULT 'whatsapp', status text,
 delivered_at timestamptz, read_at timestamptz, opened_at timestamptz, clicked_at timestamptz,
 unsubscribed_at timestamptz, bounced_at timestamptz, estimated_cost_usd numeric NOT NULL DEFAULT 0);
GRANT ALL ON campaign_history,campaign_messages TO service_role;
ALTER TABLE campaign_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON campaign_history TO authenticated;
CREATE POLICY fixture_workspace_scope ON campaign_history TO authenticated USING (workspace_id::text = current_setting('app.workspace_id',true));`);
for (const name of [
  "bulk_campaign_message_stat_contribution",
  "apply_bulk_campaign_stats_delta",
  "apply_bulk_campaign_message_insert_stats",
  "apply_bulk_campaign_message_update_stats",
  "apply_bulk_campaign_message_delete_stats",
  "recompute_bulk_campaign_stats",
])
  await db.exec(extract(name));
await db.exec(`CREATE TRIGGER fixture_insert_stats AFTER INSERT ON campaign_messages REFERENCING NEW TABLE AS new_messages FOR EACH STATEMENT EXECUTE FUNCTION apply_bulk_campaign_message_insert_stats();
CREATE TRIGGER fixture_update_stats AFTER UPDATE ON campaign_messages REFERENCING NEW TABLE AS new_messages OLD TABLE AS old_messages FOR EACH STATEMENT EXECUTE FUNCTION apply_bulk_campaign_message_update_stats();
CREATE TRIGGER fixture_delete_stats AFTER DELETE ON campaign_messages REFERENCING OLD TABLE AS old_messages FOR EACH STATEMENT EXECUTE FUNCTION apply_bulk_campaign_message_delete_stats();
REVOKE EXECUTE ON FUNCTION recompute_bulk_campaign_stats(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION recompute_bulk_campaign_stats(uuid) TO service_role;`);
const workspace = "00000000-0000-4000-8000-000000000001",
  legacy = "00000000-0000-4000-8000-000000000010",
  campaign = "00000000-0000-4000-8000-000000000020";
const id = index =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
await db.query(
  "INSERT INTO campaign_history(id,workspace_id,channel,total_recipients,cost_ledger_started_at,delivery_ledger_started_at,estimated_cost) VALUES($1,$2,'whatsapp',2,'2026-09-01','2026-09-01',1.2)",
  [legacy, workspace]
);
await db.query(
  "INSERT INTO campaign_messages(id,campaign_id,status,delivered_at) VALUES($1,$3,'delivered','2026-09-01'),($2,$3,'delivered','2026-09-01')",
  [id(11), id(12), legacy]
);
// Pre-release campaigns that only receive late receipts after the release:
// `erased` is hit before 20261005100210, `kept` only after it. The legacy
// ledger adds each delivered message estimate to the campaign total.
const erased = id(40),
  kept = id(50);
await db.query(
  "INSERT INTO campaign_history(id,workspace_id,channel,total_recipients,cost_ledger_started_at,delivery_ledger_started_at,estimated_cost,created_at) VALUES($1,$3,'whatsapp',2,'2026-09-21','2026-09-21',0,'2026-09-21'),($2,$3,'whatsapp',2,'2026-09-28','2026-09-28',0,'2026-09-28')",
  [erased, kept, workspace]
);
await db.query(
  "INSERT INTO campaign_messages(id,campaign_id,status,delivered_at,estimated_cost_usd) VALUES($1,$5,'delivered','2026-09-21',0.0604),($2,$5,'delivered','2026-09-21',0.0604),($3,$6,'delivered','2026-09-28',0.0604),($4,$6,'delivered','2026-09-28',0.0604)",
  [id(41), id(42), id(51), id(52), erased, kept]
);
const readMigration = name =>
  fs.readFile(path.join(migrationRoot, name), "utf8");
await db.exec(
  await readMigration("20261002095118_whatsapp_campaign_cost_coverage.sql")
);
const history = async value =>
  (await db.query("SELECT * FROM campaign_history WHERE id=$1", [value]))
    .rows[0];
const messageCost = async value =>
  (
    await db.query(
      "SELECT estimated_cost_usd FROM campaign_messages WHERE id=$1",
      [value]
    )
  ).rows[0].estimated_cost_usd;
const lateUnpricedRead = buildWhatsAppCampaignPricingReceiptPatch(
  { type: "regular", billable: true, category: "marketing_lite" },
  new Date("2026-10-03T14:57:14Z")
);
const applyLateRead = messageId =>
  db.query(
    "UPDATE campaign_messages SET status='read',read_at='2026-10-03T14:57:14Z',cost_coverage=$2,estimated_cost_usd=$3,pricing_type=$4,pricing_billable=$5,pricing_category=$6,pricing_event_at=$7 WHERE id=$1",
    [
      messageId,
      lateUnpricedRead.cost_coverage,
      lateUnpricedRead.estimated_cost_usd,
      lateUnpricedRead.pricing_type,
      lateUnpricedRead.pricing_billable,
      lateUnpricedRead.pricing_category,
      lateUnpricedRead.pricing_event_at,
    ]
  );
await applyLateRead(id(42));
assert.equal(
  (await history(erased)).estimated_cost,
  null,
  "20261002095118 alone erases a legacy estimate on a late receipt"
);
assert.equal(await messageCost(id(42)), null);
await db.exec(
  await readMigration(
    "20261005100210_preserve_legacy_whatsapp_campaign_cost.sql"
  )
);
await db.exec("SET ROLE service_role;");
await applyLateRead(id(52));
assert.equal(
  Number((await history(kept)).estimated_cost),
  0.1208,
  "a late unpriced receipt keeps the stored legacy campaign estimate"
);
assert.equal(
  Number(await messageCost(id(52))),
  0.0604,
  "a late unpriced receipt keeps the legacy message estimate"
);
assert.equal((await history(kept)).cost_coverage_started_at, null);
await db.query("UPDATE campaign_history SET estimated_cost=9 WHERE id=$1", [
  kept,
]);
assert.equal(
  Number((await history(kept)).estimated_cost),
  0.1208,
  "uncovered rows keep their stored amount on update"
);
const uncoveredInsert = id(60);
await db.query(
  "INSERT INTO campaign_history(id,workspace_id,channel,total_recipients,estimated_cost) VALUES($1,$2,'whatsapp',1,0.5)",
  [uncoveredInsert, workspace]
);
assert.equal(
  Number((await history(uncoveredInsert)).estimated_cost),
  0.5,
  "an insert without a cost ledger is not rewritten"
);
assert.equal(
  (await history(legacy)).cost_coverage_started_at,
  null,
  "migration does not claim a legacy zero/nonzero was verified"
);
await db.query("SELECT recompute_bulk_campaign_stats($1)", [legacy]);
assert.equal((await history(legacy)).estimated_cost, null);
assert.equal(Number((await history(legacy)).unknown_cost_count), 2);
await db.query(
  "INSERT INTO campaign_history(id,workspace_id,channel,total_recipients,audience_fingerprint,cost_ledger_started_at,delivery_ledger_started_at) VALUES($1,$2,'whatsapp',2,'fixture','2026-10-01','2026-10-01')",
  [campaign, workspace]
);
await db.query(
  "INSERT INTO campaign_messages(id,campaign_id,status,delivered_at) VALUES($1,$3,'delivered','2026-10-01'),($2,$3,'delivered','2026-10-01')",
  [id(21), id(22), campaign]
);
assert.equal((await history(campaign)).estimated_cost, null);
assert.equal(Number((await history(campaign)).unknown_cost_count), 2);
const actualFreePatch = buildWhatsAppCampaignPricingReceiptPatch(
  { type: "free_customer_service", billable: false, category: "service" },
  new Date("2026-10-01T00:00:00Z")
);
assert.ok(actualFreePatch);
await db.query(
  "UPDATE campaign_messages SET cost_coverage=$2,estimated_cost_usd=$3,pricing_type=$4,pricing_billable=$5,pricing_category=$6,pricing_event_at=$7 WHERE id=$1",
  [
    id(21),
    actualFreePatch.cost_coverage,
    actualFreePatch.estimated_cost_usd,
    actualFreePatch.pricing_type,
    actualFreePatch.pricing_billable,
    actualFreePatch.pricing_category,
    actualFreePatch.pricing_event_at,
  ]
);
assert.equal(
  (await history(campaign)).estimated_cost,
  null,
  "one free message does not cover the other missing receipt"
);
const tariff = {
  market: "KZ",
  currency: "USD",
  tier: "list",
  version: "synthetic-verified",
  category: "service",
  effective_from_epoch_ms: Date.parse("2026-10-01"),
  effective_until_epoch_ms: Date.parse("2026-10-03"),
  rate_usd: 0.01,
};
await db.query(
  "UPDATE campaign_messages SET cost_coverage='verified_tariff',estimated_cost_usd=0.01,pricing_type='regular',pricing_billable=true,pricing_category='service',pricing_event_at='2026-10-01T00:00:01Z',cost_tariff_context=$2 WHERE id=$1",
  [id(22), JSON.stringify(tariff)]
);
assert.equal(Number((await history(campaign)).estimated_cost), 0.01);
assert.equal(Number((await history(campaign)).unknown_cost_count), 0);
await db.query(
  "UPDATE campaign_messages SET pricing_event_at=pricing_event_at WHERE id=$1",
  [id(22)]
);
assert.equal(
  Number((await history(campaign)).estimated_cost),
  0.01,
  "duplicate updates cannot increment totals"
);
await db.query(
  "UPDATE campaign_messages SET cost_coverage='provider_free',estimated_cost_usd=0,pricing_type='free_entry_point',pricing_billable=false,pricing_event_at='2026-09-30' WHERE id=$1",
  [id(22)]
);
assert.equal(
  Number((await history(campaign)).estimated_cost),
  0.01,
  "late free receipt cannot overwrite newer billable evidence"
);
await db.query(
  "UPDATE campaign_messages SET cost_tariff_context=$2 WHERE id=$1",
  [
    id(22),
    JSON.stringify({
      ...tariff,
      effective_until_epoch_ms: Date.parse("2026-09-30"),
    }),
  ]
);
assert.equal(
  (await history(campaign)).estimated_cost,
  null,
  "expired service tariff does not cover the current receipt"
);
assert.equal(Number((await history(campaign)).unknown_cost_count), 1);
await db.query(
  "UPDATE campaign_messages SET cost_coverage='unknown',estimated_cost_usd=null,pricing_type='regular',pricing_billable=true,pricing_event_at='2026-10-02' WHERE id=$1",
  [id(22)]
);
assert.equal((await history(campaign)).estimated_cost, null);
await db.query(
  "UPDATE campaign_messages SET cost_coverage='provider_free',estimated_cost_usd=0,pricing_type='free_entry_point',pricing_billable=false,pricing_event_at='2026-10-02T00:00:01Z' WHERE id=$1",
  [id(22)]
);
assert.equal(
  Number((await history(campaign)).estimated_cost),
  0,
  "a complete actually free cohort is zero"
);
await db.query(
  "UPDATE campaign_messages SET cost_coverage='unknown',estimated_cost_usd=null,pricing_type='regular',pricing_billable=true,pricing_event_at='2026-10-02T00:00:02Z' WHERE id=$1",
  [id(22)]
);
await db.query("DELETE FROM campaign_messages WHERE id=$1", [id(22)]);
assert.equal(Number((await history(campaign)).unknown_cost_count), 0);
assert.equal(
  (await history(campaign)).estimated_cost,
  null,
  "deleted historical receipts do not become a free campaign"
);
await db.query("SELECT recompute_bulk_campaign_stats($1)", [campaign]);
assert.equal(
  (await history(campaign)).cost_coverage_started_at,
  null,
  "recompute cannot certify an incomplete recipient ledger"
);
const pending = id(30);
await db.query(
  "INSERT INTO campaign_history(id,workspace_id,channel,total_recipients,cost_ledger_started_at) VALUES($1,$2,'whatsapp',1,'2026-10-01')",
  [pending, workspace]
);
await db.query(
  "INSERT INTO campaign_messages(id,campaign_id,status) VALUES($1,$2,'pending')",
  [id(31), pending]
);
await db.query("DELETE FROM campaign_messages WHERE id=$1", [id(31)]);
assert.equal(
  (await history(pending)).estimated_cost,
  null,
  "deleting a pending receipt also invalidates recipient coverage"
);
await db.exec(
  `RESET ROLE; SET ROLE authenticated; SET app.workspace_id='${id(99)}';`
);
assert.equal((await db.query("SELECT * FROM campaign_history")).rows.length, 0);
await assert.rejects(
  () => db.query("SELECT recompute_bulk_campaign_stats($1)", [campaign]),
  /permission denied/
);
await db.exec("RESET ROLE; SET ROLE anon;");
await assert.rejects(
  () =>
    db.query(
      "SELECT whatsapp_campaign_message_cost_contribution(null::campaign_messages)"
    ),
  /permission denied/
);
await assert.rejects(
  () =>
    db.query(
      "SELECT apply_bulk_campaign_stats_delta($1,0,0,0,0,0,0,0,0,0,0::bigint)",
      [campaign]
    ),
  /permission denied/
);
// Exercise the reviewed operator repair exactly as written.
await db.exec("RESET ROLE;");
const repair = (
  await fs.readFile(
    path.resolve(
      migrationRoot,
      "../../docs/operations/2026-10-05-whatsapp-legacy-campaign-cost-repair.sql"
    ),
    "utf8"
  )
).replaceAll("\r\n", "\n");
const repairSection = name => {
  const start = repair.indexOf(`-- >>> ${name}`),
    end = repair.indexOf(`-- <<< ${name}`);
  assert.ok(start >= 0 && end > start, `repair section ${name}`);
  return repair.slice(start, end);
};
const preview = await db.query(repairSection("PREVIEW"));
assert.deepEqual(
  preview.rows.map(row => [
    row.id,
    Number(row.restore_estimated_cost),
    Number(row.delivered_without_estimate),
  ]),
  [[erased, 0.0604, 1]],
  "preview lists only erased legacy campaigns, with their stored estimates"
);
await db.exec(repairSection("APPLY"));
assert.equal(Number((await history(erased)).estimated_cost), 0.0604);
assert.equal(Number((await history(kept)).estimated_cost), 0.1208);
assert.equal((await history(campaign)).estimated_cost, null);
const [remaining, trigger] = await db.exec(repairSection("VERIFY"));
assert.equal(remaining.rows.length, 0);
assert.equal(trigger.rows[0].tgenabled, "O", "trigger is enabled again");
await db.exec(repairSection("APPLY"));
assert.equal(
  Number((await history(erased)).estimated_cost),
  0.0604,
  "re-running the repair is harmless"
);
await applyLateRead(id(41));
assert.equal(
  Number((await history(erased)).estimated_cost),
  0.0604,
  "a restored legacy estimate survives later receipts"
);
await db.close();
console.log(
  JSON.stringify({
    status: "passed",
    engine: "PGlite PostgreSQL",
    productionBodies: "canonical statement-level deltas + new migrations",
    legacyCoverage: "unknown",
    legacyEstimates: "preserved",
    legacyRepairSql: "verified",
    migrationAppliedToProduction: false,
  })
);
