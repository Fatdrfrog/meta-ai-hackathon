/** Executes actual migrations in ephemeral PostgreSQL; never connects to a live database.
 * Pass an externally installed @electric-sql/pglite/dist/index.js path as argv[2].
 * This QA runtime is deliberately not an application dependency.
 */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.argv[2])
  throw new Error(
    "Usage: node .github/scripts/verify-commerce-conversions-sql.mjs /path/to/@electric-sql/pglite/dist/index.js",
  );
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL("../..", import.meta.url)).replaceAll(
  "\\",
  "/",
);

async function verifyLedger() {
  const db = new PGlite();
  let checks = 0;
  const expectError = async (sql, params, pattern) => {
    await assert.rejects(db.query(sql, params), pattern);
    checks++;
  };
  await db.exec(`
  CREATE SCHEMA auth;
  CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE TABLE workspaces(id uuid PRIMARY KEY);
  CREATE TABLE company_users(user_id uuid, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE);
  CREATE TABLE sources(id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, type text);
`);
  for (const file of [
    "20251030050645_create_session_feedback_table.sql",
    "20260910160622_conversion_payment_evidence_confirmation.sql",
  ])
    await db.exec(
      await readFile(`${root}/supabase/migrations/${file}`, "utf8"),
    );
  await db.exec(
    `GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;`,
  );
  await db.exec(
    await readFile(
      `${root}/supabase/migrations/20260910175815_verified_commerce_conversions.sql`,
      "utf8",
    ),
  );
  checks++;

  const historicalWorkspace = "99999999-9999-4999-8999-999999999999";
  await db.query("INSERT INTO workspaces VALUES ($1)", [historicalWorkspace]);
  const historical = (await db.query("INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value) VALUES ($1,'aaaaaaaaaaaaaaaaaaaaaaaa','sale',100) RETURNING id", [historicalWorkspace])).rows[0];
  await db.exec(await readFile(`${root}/supabase/migrations/20260911045231_confirmed_payment_scenario_intent.sql`, "utf8"));
  await db.exec(await readFile(`${root}/supabase/migrations/20260911053212_scenario_conversion_report.sql`, "utf8"));
  // Legacy malformed rows predate the new constraint and must not block rollout.
  await db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata)
    SELECT $1,'legacy-report',kind,value,currency,'2026-09-05','{"scenarioId":"1234567890abcdef12345678"}'::jsonb
    FROM (VALUES ('sale',100::numeric,'KZT'),('refund',25,'KZT'),('sale',-900,'KZT'),('refund',-50,'KZT'),
      ('sale',200,'invalid'),('sale',300,NULL),('sale',NULL,'USD'),('refund',0,'USD'),('sale','NaN'::numeric,'USD')) AS fixture(kind,value,currency)`, [historicalWorkspace]);
  await db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,source,meta_delivery_status,meta_delivery_snapshot)
    SELECT $1,'old-manual-'||status,'sale',50,'USD','manual',status,'{"datasetId":"old-dataset"}'::jsonb
    FROM unnest(ARRAY['pending','queued','delivery_unknown','sent','rejected']) AS status`, [historicalWorkspace]);
  await db.exec(await readFile(`${root}/supabase/migrations/20260912102045_conversion_transaction_identity_and_report_guards.sql`, "utf8"));
  const legacy = (await db.query("SELECT get_scenario_conversion_report($1,'1234567890abcdef12345678','2026-09-01','2026-09-11') AS result", [historicalWorkspace])).rows[0].result;
  assert.deepEqual(legacy.totals, { sales: 6, refunds: 3, bookings: 0, signups: 0 });
  assert.deepEqual(legacy.currencies, [{ currency: 'KZT', sales: 1, refunds: 1, grossRevenue: 100, refundedRevenue: 25, netRevenue: 75 }]);
  const oldManual = (await db.query("SELECT conversation_id,meta_delivery_status,meta_delivery_snapshot FROM conversions WHERE conversation_id LIKE 'old-manual-%' ORDER BY conversation_id")).rows;
  for (const row of oldManual) {
    const originalStatus = row.conversation_id.replace('old-manual-', '');
    assert.equal(row.meta_delivery_status, ['pending','queued'].includes(originalStatus) ? 'not_eligible' : originalStatus);
    assert.deepEqual(row.meta_delivery_snapshot, ['pending','queued'].includes(originalStatus) ? null : { datasetId: 'old-dataset' });
  }
  await db.query("UPDATE conversions SET meta_delivery_reason='legacy-audit' WHERE workspace_id=$1 AND conversation_id='legacy-report'", [historicalWorkspace]);
  await db.query("UPDATE conversions SET meta_delivery_status='sent' WHERE conversation_id='old-manual-delivery_unknown'");
  await expectError("UPDATE conversions SET meta_delivery_status='pending' WHERE conversation_id='old-manual-pending'", [], /conversions_manual_meta_transaction/);
  checks++;
  for (const [type,value,currency] of [['sale',-1,'USD'],['refund',-1,'USD'],['sale',null,'USD'],['sale',0,'USD'],['sale',1,null],['sale',1,'invalid'],['sale','NaN','USD']]) {
    await expectError("INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency) VALUES ($1,'invalid-money',$2,$3,$4)", [historicalWorkspace,type,value,currency], /conversions_positive_money/);
  }
  const historicalIntent = (await db.query("SELECT scenario_effect_status,scenario_effect_snapshot FROM conversions WHERE id=$1", [historical.id])).rows[0];
  assert.deepEqual(historicalIntent, { scenario_effect_status: "not_applicable", scenario_effect_snapshot: null });
  await db.query("DELETE FROM workspaces WHERE id=$1", [historicalWorkspace]);
  checks++;

  const workspace = "11111111-1111-4111-8111-111111111111";
  const otherWorkspace = "22222222-2222-4222-8222-222222222222";
  const source = "33333333-3333-4333-8333-333333333333";
  const otherSource = "44444444-4444-4444-8444-444444444444";
  const user = "55555555-5555-4555-8555-555555555555";
  await db.query("INSERT INTO workspaces VALUES ($1), ($2)", [
    workspace,
    otherWorkspace,
  ]);
  await db.query(
    "INSERT INTO sources VALUES ($1,$2,'whatsapp'),($3,$4,'whatsapp')",
    [source, workspace, otherSource, otherWorkspace],
  );
  await db.query("INSERT INTO company_users VALUES ($1,$2)", [user, workspace]);
  const base = {
    workspace_id: workspace,
    conversation_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    source: "integration",
    conversion_type: "sale",
    conversion_value: 10000,
    currency: "KZT",
    external_source_id: source,
    external_event_id: "sale-1",
    external_transaction_id: "payment-1",
    event_payload_hash: "a".repeat(64),
    converted_at: "2026-09-09T10:00:00Z",
    meta_delivery_status: "pending",
    scenario_effect_status: "pending",
    scenario_effect_snapshot: {
      sourceId: source,
      scenarioId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      scenarioUpdatedAt: "2026-09-09T08:00:00.000Z",
      pendingConditionNodeId: "payment-condition",
      pendingSourceActionNodeId: "request-payment",
      pendingStartedAt: "2026-09-09T09:00:00.000Z",
      pendingLastOutboundMessageId: "cccccccccccccccccccccccc",
      occurredAt: "2026-09-09T10:00:00.000Z",
    },
    metadata: {
      customerId: "customer-1",
      sourceId: source,
      whatsappReferral: {
        sourceType: "ad",
        sourceId: "ad-1",
        campaignId: "campaign-1",
        campaignName: "Campaign A",
      },
    },
  };
  const record = async (payload, purchase = null) =>
    (
      await db.query(
        "SELECT record_commerce_conversion($1::jsonb, $2) AS result",
        [JSON.stringify(payload), purchase],
      )
    ).rows[0].result;
  await db.exec("SET ROLE service_role");
  const sale = await record(base);
  assert.equal(sale.deduplicated, false);
  assert.equal(sale.conversion.meta_delivery_status, "pending");
  assert.equal(sale.conversion.scenario_effect_status, "pending");
  assert.deepEqual(sale.conversion.scenario_effect_snapshot, base.scenario_effect_snapshot);
  checks++;
  const retry = await record({ ...base, scenario_effect_snapshot: { ...base.scenario_effect_snapshot, pendingConditionNodeId: "later-wait" } });
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.conversion.id, sale.conversion.id);
  assert.deepEqual(retry.conversion.scenario_effect_snapshot, base.scenario_effect_snapshot);
  checks++;
  await expectError("UPDATE conversions SET scenario_effect_status='unknown' WHERE id=$1", [sale.conversion.id], /check constraint/);
  await expectError("UPDATE conversions SET scenario_effect_snapshot=NULL WHERE id=$1", [sale.conversion.id], /check constraint/);
  await expectError("UPDATE conversions SET conversion_value=0 WHERE id=$1", [sale.conversion.id], /conversions_positive_money/);
  const queued = "UPDATE conversions SET scenario_effect_status='queued' WHERE id=$1 AND scenario_effect_status='pending' RETURNING id";
  assert.equal((await db.query(queued, [sale.conversion.id])).rows.length, 1);
  await db.query("UPDATE conversions SET scenario_effect_status='processed' WHERE id=$1", [sale.conversion.id]);
  assert.equal((await db.query(queued, [sale.conversion.id])).rows.length, 0);
  checks++;
  await assert.rejects(
    record({ ...base, event_payload_hash: "b".repeat(64) }),
    /commerce_event_conflict/,
  );
  checks++;
  await assert.rejects(
    record({
      ...base,
      external_event_id: "different-id",
      event_payload_hash: "b".repeat(64),
    }),
    /commerce_event_conflict/,
  );
  checks++;
  await assert.rejects(
    record({
      ...base,
      external_event_id: "wrong-source",
      external_transaction_id: "wrong-source",
      external_source_id: otherSource,
    }),
    /invalid_commerce_event/,
  );
  checks++;
  for (const [key, value] of [
    ["currency", null],
    ["conversion_type", null],
    ["event_payload_hash", null],
    ["conversation_id", null],
    ["conversion_value", 1.001],
  ]) {
    await assert.rejects(
      record({
        ...base,
        external_event_id: `invalid-${key}`,
        external_transaction_id: `invalid-${key}`,
        [key]: value,
      }),
      /invalid_commerce_event/,
    );
    checks++;
  }
  const refund = {
    ...base,
    conversion_type: "refund",
    conversion_value: 3000,
    external_event_id: "refund-1",
    external_transaction_id: "refund-1",
    event_payload_hash: "c".repeat(64),
    converted_at: "2026-09-09T11:00:00Z",
    metadata: { customerId: "forged", whatsappReferral: { sourceId: "wrong" } },
  };
  const refunded = await record(refund, "payment-1");
  assert.equal(refunded.conversion.original_conversion_id, sale.conversion.id);
  assert.equal(refunded.conversion.metadata.whatsappReferral.sourceId, "ad-1");
  assert.equal(refunded.conversion.scenario_effect_status, "not_applicable");
  assert.equal(refunded.conversion.scenario_effect_snapshot, null);
  checks++;
  assert.equal((await record(refund, "payment-1")).deduplicated, true);
  checks++;
  await assert.rejects(
    record(
      {
        ...refund,
        external_event_id: "over-refund",
        external_transaction_id: "over-refund",
        event_payload_hash: "d".repeat(64),
        conversion_value: 7000.01,
      },
      "payment-1",
    ),
    /refund_exceeds_purchase/,
  );
  checks++;
  await assert.rejects(
    record(
      {
        ...refund,
        external_event_id: "wrong-currency",
        external_transaction_id: "wrong-currency",
        event_payload_hash: "d".repeat(64),
        currency: "USD",
      },
      "payment-1",
    ),
    /refund_purchase_mismatch/,
  );
  checks++;
  await record(
    {
      ...refund,
      external_event_id: "refund-2",
      external_transaction_id: "refund-2",
      event_payload_hash: "d".repeat(64),
      conversion_value: 7000,
    },
    "payment-1",
  );
  checks++;
  const claim =
    "UPDATE conversions SET meta_delivery_status='delivery_unknown' WHERE id=$1 AND meta_delivery_status IN ('pending','queued') RETURNING id";
  assert.equal((await db.query(claim, [sale.conversion.id])).rows.length, 1);
  assert.equal((await db.query(claim, [sale.conversion.id])).rows.length, 0);
  checks++;
  await record({
    ...base,
    external_event_id: "usd-sale",
    external_transaction_id: "usd-sale",
    event_payload_hash: "e".repeat(64),
    currency: "USD",
    conversion_value: 20,
    metadata: {},
  });
  await record({
    ...base,
    external_event_id: "other-tenant",
    external_transaction_id: "other-tenant",
    event_payload_hash: "f".repeat(64),
    workspace_id: otherWorkspace,
    external_source_id: otherSource,
    conversion_value: 999,
  });
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec("SET ROLE authenticated");
  const visible = await db.query("SELECT id FROM conversions");
  assert.equal(visible.rows.length, 4);
  checks++;
  const report = (
    await db.query(
      "SELECT get_conversion_attribution_report($1,$2,$3) AS result",
      [workspace, "2026-09-01", "2026-10-01"],
    )
  ).rows[0].result;
  assert.equal(report.rows.length, 2);
  const kzt = report.rows.find((row) => row.currency === "KZT");
  assert.deepEqual(
    [
      kzt.sales,
      kzt.refunds,
      kzt.grossRevenue,
      kzt.refundedRevenue,
      kzt.netRevenue,
      kzt.payingCustomers,
      kzt.paidConversations,
    ],
    [1, 2, 10000, 10000, 0, 1, 1],
  );
  assert.equal(report.rows.find((row) => row.currency === "USD").adId, null);
  checks++;
  const hidden = (
    await db.query(
      "SELECT get_conversion_attribution_report($1,$2,$3) AS result",
      [otherWorkspace, "2026-09-01", "2026-10-01"],
    )
  ).rows[0].result;
  assert.equal(hidden.rows.length, 0);
  checks++;
  await expectError(
    "UPDATE conversions SET meta_delivery_status='sent' WHERE id=$1",
    [sale.conversion.id],
    /permission denied/,
  );
  await expectError("UPDATE conversions SET scenario_effect_status='pending' WHERE id=$1", [sale.conversion.id], /permission denied/);
  await expectError(
    "INSERT INTO conversions (workspace_id,conversation_id,conversion_type) VALUES ($1,$2,$3)",
    [workspace, "aaaaaaaaaaaaaaaaaaaaaaaa", "sale"],
    /permission denied/,
  );
  await expectError(
    "SELECT record_commerce_conversion($1::jsonb,NULL)",
    [JSON.stringify(base)],
    /permission denied/,
  );
  await expectError("TRUNCATE conversions CASCADE", [], /permission denied/);
  checks += await verifyScenarioReporting(db, { workspace, otherWorkspace });
  checks += await verifySharedTransactionAndReportGuards(db, { workspace, source, base, record });
  checks += await verifyCustomerBehaviorFacts(db, { workspace, otherWorkspace });
  await db.exec("RESET ROLE");
  await db.query("DELETE FROM sources WHERE id=$1", [source]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM conversions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].count,
    4,
  );
  checks++;
  await db.query("DELETE FROM workspaces WHERE id=$1", [workspace]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM conversions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].count,
    0,
  );
  checks++;
  await db.close();
  return checks;
}

async function verifyCustomerBehaviorFacts(db, { workspace, otherWorkspace }) {
  await db.exec("RESET ROLE");
  await db.exec(
    await readFile(
      `${root}/supabase/migrations/20260912110559_customer_behavior_journeys.sql`,
      "utf8",
    ),
  );
  let checks = 0;
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM conversions WHERE customer_event_pending",
      )
    ).rows[0].count,
    0,
  );
  checks++;
  await db.exec("BEGIN; SET LOCAL TIME ZONE 'UTC'; SET ROLE service_role");
  const customer = "behavior-customer";
  const insert = async (
    type,
    value,
    currency,
    conversation,
    selectedWorkspace = workspace,
    at = "2026-09-10T10:00:00Z",
  ) =>
    (
      await db.query(
        "INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,customer_event_pending",
        [
          selectedWorkspace,
          conversation,
          type,
          value,
          currency,
          at,
          JSON.stringify({ customerId: customer }),
        ],
      )
    ).rows[0];
  const first = await insert("sale", 10000, "KZT", "behavior-a");
  assert.equal(first.customer_event_pending, true);
  checks++;
  await insert("refund", 2000, "KZT", "behavior-a");
  await insert("sale", 30, "USD", "behavior-b");
  await insert("sale", 999999, "KZT", "behavior-other", otherWorkspace);
  await insert("booking", 888, "KZT", "behavior-a");
  const sql = "SELECT get_customer_purchase_facts($1,$2,$3,$4,$5) AS facts";
  const facts = async (
    after = null,
    exclude = null,
    scopedWorkspace = workspace,
  ) =>
    (
      await db.query(sql, [
        scopedWorkspace,
        customer,
        ["behavior-a", "behavior-b"],
        after,
        exclude,
      ])
    ).rows[0].facts;
  assert.deepEqual((await facts()).netSpend, { KZT: 8000, USD: 30 });
  checks++;
  assert.equal((await facts()).purchaseCount, 2);
  checks++;
  assert.equal((await facts()).convertedSince, false);
  checks++;
  assert.equal(
    (await facts("2026-09-10T10:00:00Z", first.id)).convertedSince,
    true,
  );
  checks++;
  assert.equal(
    (await facts("2026-09-10T10:00:01Z", first.id)).convertedSince,
    false,
  );
  checks++;
  assert.deepEqual((await facts(null, null, otherWorkspace)).netSpend, {
    KZT: 999999,
  });
  checks++;
  const empty = (await db.query(sql, [workspace, "unknown", [], null, null]))
    .rows[0].facts;
  assert.deepEqual(empty, {
    purchaseCount: 0,
    lastPurchaseAt: null,
    netSpend: {},
    convertedSince: false,
  });
  checks++;
  await db.query(
    "UPDATE conversions SET customer_event_pending=false WHERE id=$1",
    [first.id],
  );
  assert.equal(
    (
      await db.query(
        "SELECT customer_event_pending FROM conversions WHERE id=$1",
        [first.id],
      )
    ).rows[0].customer_event_pending,
    false,
  );
  checks++;
  await db.exec("ROLLBACK; SET ROLE authenticated");
  await assert.rejects(
    db.query(sql, [workspace, customer, [], null, null]),
    /permission denied/,
  );
  checks++;
  await db.exec("RESET ROLE; SET ROLE anon");
  await assert.rejects(
    db.query(sql, [workspace, customer, [], null, null]),
    /permission denied/,
  );
  checks++;
  await db.exec("RESET ROLE");
  return checks;
}

async function verifyScenarioReporting(db, { workspace, otherWorkspace }) {
  let checks = 0;
  const scenarioId = "1234567890abcdef12345678";
  const otherScenarioId = "1234567890abcdef12345679";
  const reportSql = "SELECT get_scenario_conversion_report($1,$2,$3,$4) AS result";
  const report = async (selectedWorkspace = workspace, selectedScenario = scenarioId, start = "2026-09-01", end = "2026-09-11") =>
    (await db.query(reportSql, [selectedWorkspace, selectedScenario, start, end])).rows[0].result;
  const insert = async ({ type = "sale", value = 100, currency = "KZT", at = "2026-09-05", selectedWorkspace = workspace, selectedScenario = scenarioId }) =>
    db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata)
      VALUES($1,'report-conversation',$2,$3,$4,$5,$6::jsonb)`,
      [selectedWorkspace, type, value, currency, at, JSON.stringify({ scenarioId: selectedScenario, scenarioName: "Same name" })]);
  // Isolate reporting fixtures so original ledger/RLS regression assertions stay unchanged.
  await db.exec("BEGIN; SET LOCAL TIME ZONE 'UTC'; RESET ROLE; SET ROLE service_role");
  await insert({ value: 10000, at: "2026-09-01" });
  await insert({ type: "refund", value: 2500 });
  await insert({ currency: "USD", value: 20 });
  await insert({ currency: "EUR", value: 30 });
  await insert({ type: "booking", value: 99999, currency: "EUR" });
  await insert({ type: "signup", value: 200 });
  await insert({ type: "custom", value: 99999 });
  await insert({ type: "sale", value: 9000, selectedScenario: otherScenarioId });
  await insert({ type: "sale", value: 9000, selectedWorkspace: otherWorkspace });
  await insert({ type: "sale", value: 9000, selectedScenario: null });
  await insert({ type: "sale", value: 9000, at: "2026-08-31T23:59:59Z" });
  await insert({ type: "sale", value: 9000, at: "2026-09-11" });
  await db.exec("RESET ROLE; SET ROLE authenticated");
  const initial = await report();
  assert.deepEqual(initial.totals, { sales: 3, refunds: 1, bookings: 1, signups: 1 });
  checks++;
  assert.deepEqual(initial.currencies.find(row => row.currency === "KZT"), {
    currency: "KZT", sales: 1, refunds: 1,
    grossRevenue: 10000, refundedRevenue: 2500, netRevenue: 7500,
  });
  checks++;
  assert.deepEqual(initial.currencies.find(row => row.currency === "USD"), {
    currency: "USD", sales: 1, refunds: 0,
    grossRevenue: 20, refundedRevenue: 0, netRevenue: 20,
  });
  assert.equal(initial.currencies.find(row => row.currency === "EUR").grossRevenue, 30);
  checks++;
  assert.equal(initial.currencies.some(row => row.currency === ""), false);
  checks++;
  assert.equal(initial.truncated, false);
  assert.deepEqual((await report(otherWorkspace)).totals, { sales: 0, refunds: 0, bookings: 0, signups: 0 });
  assert.deepEqual((await report(otherWorkspace)).currencies, []);
  checks++;
  assert.deepEqual((await report(workspace, otherScenarioId)).totals, { sales: 1, refunds: 0, bookings: 0, signups: 0 });
  checks++;
  const empty = await report(workspace, scenarioId, "2026-07-01", "2026-07-02");
  assert.deepEqual(empty, { totals: { sales: 0, refunds: 0, bookings: 0, signups: 0 }, currencies: [], truncated: false });
  checks++;
  const refundPeriod = await report(workspace, scenarioId, "2026-09-02", "2026-09-10");
  assert.equal(refundPeriod.currencies.find(row => row.currency === "KZT").netRevenue, -2500);
  checks++;
  // A full 90-day window remains accepted at both the HTTP and direct RPC boundaries.
  assert.equal((await report(workspace, scenarioId, "2026-06-13", "2026-09-11")).totals.sales, 4);
  checks++;
  for (const params of [
    [workspace, scenarioId, "2026-01-01", "2026-09-11"],
    [workspace, scenarioId, "2026-09-11", "2026-09-01"],
    [workspace, scenarioId, null, "2026-09-11"],
    [workspace, "invalid", "2026-09-01", "2026-09-11"],
    [null, scenarioId, "2026-09-01", "2026-09-11"],
  ]) {
    await db.exec("SAVEPOINT invalid_scope");
    await assert.rejects(db.query(reportSql, params), /invalid_scenario_report_scope/);
    await db.exec("ROLLBACK TO SAVEPOINT invalid_scope");
    checks++;
  }
  await db.exec("RESET ROLE; SET ROLE service_role");
  await db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata)
    SELECT $1,'large-report','sale',1,'KZT','2026-09-05',jsonb_build_object('scenarioId',$2::text)
    FROM generate_series(1,1100)`, [workspace, scenarioId]);
  await db.exec("RESET ROLE; SET ROLE authenticated");
  const large = await report();
  assert.equal(large.totals.sales, 1103);
  assert.equal(large.currencies.find(row => row.currency === "KZT").grossRevenue, 11100);
  checks++;
  await db.exec("RESET ROLE; SET ROLE service_role");
  await db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata)
    SELECT $1,'currency-report','sale',1,'A'||chr(65+(n/26)::int)||chr(65+(n%26)::int),'2026-09-05',jsonb_build_object('scenarioId',$2::text)
    FROM generate_series(0,200) n`, [workspace, scenarioId]);
  await db.exec("RESET ROLE; SET ROLE authenticated");
  const bounded = await report();
  assert.equal(bounded.totals.sales, 1304);
  assert.equal(bounded.currencies.length, 200);
  assert.equal(bounded.truncated, true);
  checks++;
  await db.exec("RESET ROLE; ANALYZE conversions; SET LOCAL enable_seqscan = off");
  const plan = await db.query(`EXPLAIN (FORMAT JSON) SELECT conversion_type,conversion_value,currency FROM conversions
    WHERE workspace_id=$1 AND metadata->>'scenarioId'=$2 AND converted_at >= '2026-09-01' AND converted_at < '2026-09-11'
    AND conversion_type IN ('sale','refund','booking','signup')`, [workspace, otherScenarioId]);
  assert.match(JSON.stringify(plan.rows), /conversions_workspace_scenario_outcome_time/);
  checks++;
  await db.exec("SET ROLE anon; SAVEPOINT anonymous_scope");
  await assert.rejects(report(), /permission denied for function get_scenario_conversion_report/);
  await db.exec("ROLLBACK TO SAVEPOINT anonymous_scope; ROLLBACK");
  checks++;
  return checks;
}

async function verifySharedTransactionAndReportGuards(db, { workspace, source, base, record }) {
  let checks = 0;
  await db.exec("BEGIN; RESET ROLE; SET ROLE service_role");
  const snapshot = { datasetId: "dataset", wabaId: "waba", ctwaClid: "click" };
  for (const manualFirst of [true, false]) {
    const transactionId = `cross-intake-${manualFirst}`;
    const manual = { ...base, source: "manual", external_transaction_id: transactionId,
      external_event_id: undefined, event_payload_hash: undefined, meta_delivery_snapshot: snapshot,
      payment_evidence_message_id: manualFirst ? "111111111111111111111111" : "222222222222222222222222" };
    const signed = { ...base, external_transaction_id: transactionId, external_event_id: transactionId, event_payload_hash: "1".repeat(64),
      meta_delivery_snapshot: { ...snapshot, datasetId: "later-dataset" } };
    const first = await record(manualFirst ? manual : signed);
    const second = await record(manualFirst ? signed : manual);
    assert.equal(second.deduplicated, true);
    assert.equal(second.conversion.id, first.conversion.id);
    assert.equal(second.conversion.source, first.conversion.source);
    assert.deepEqual(second.conversion.meta_delivery_snapshot, first.conversion.meta_delivery_snapshot);
    assert.deepEqual(second.conversion.scenario_effect_snapshot, first.conversion.scenario_effect_snapshot);
    assert.equal(second.conversion.external_event_id, transactionId);
    assert.equal(second.conversion.event_payload_hash, signed.event_payload_hash);
    assert.equal(second.conversion.payment_evidence_message_id, manual.payment_evidence_message_id);
    checks++;
    for (const payload of [{ ...signed, conversion_value: 1 }, { ...manual, currency: "USD" }, { ...manual, conversation_id: "bbbbbbbbbbbbbbbbbbbbbbbb" }, { ...signed, event_payload_hash: "2".repeat(64) }]) {
      await db.exec("SAVEPOINT shared_conflict");
      await assert.rejects(record(payload), /commerce_event_conflict/);
      await db.exec("ROLLBACK TO SAVEPOINT shared_conflict");
      checks++;
    }
    // Concurrently scheduled callers must share one durable row and one claim.
    // PGlite serializes the connection; the database unique index is also checked below.
    const concurrent = await Promise.all([record(manual), record(signed)]);
    assert.ok(concurrent.every(result => result.conversion.id === first.conversion.id && result.deduplicated));
    const claims = await Promise.all([0,1].map(() => db.query("UPDATE conversions SET meta_delivery_status='delivery_unknown' WHERE id=$1 AND meta_delivery_status='pending' RETURNING id", [first.conversion.id])));
    assert.equal(claims.reduce((sum, result) => sum + result.rows.length, 0), 1);
    checks++;
  }
  await db.exec("SAVEPOINT duplicate_transaction");
  await assert.rejects(db.query(`INSERT INTO conversions(workspace_id,conversation_id,source,conversion_type,conversion_value,currency,external_source_id,external_transaction_id)
    VALUES($1,'aaaaaaaaaaaaaaaaaaaaaaaa','manual','sale',10000,'KZT',$2,'cross-intake-true')`, [workspace,source]), /conversions_external_transaction_unique/);
  await db.exec("ROLLBACK TO SAVEPOINT duplicate_transaction");
  checks++;
  // The DB repeats the missing-purchase snapshot guard before persisting a refund.
  const refund = await record({ ...base, conversion_type: "refund", conversion_value: 1, external_event_id: "cross-refund", external_transaction_id: "cross-refund", event_payload_hash: "3".repeat(64), meta_delivery_snapshot: snapshot }, "usd-sale").catch(error => error);
  // Currency mismatch is independently enforced; create a matching local-only original.
  assert.match(refund.message, /refund_purchase_mismatch/);
  await db.exec("ROLLBACK; BEGIN; RESET ROLE; SET ROLE service_role");
  const original = await record({ ...base, external_event_id: "local-original", external_transaction_id: "local-original", meta_delivery_status: "not_eligible", meta_delivery_snapshot: null });
  const localRefund = await record({ ...base, conversion_type: "refund", conversion_value: 1, external_event_id: "local-refund", external_transaction_id: "local-refund", meta_delivery_snapshot: snapshot }, "local-original");
  assert.equal(localRefund.conversion.original_conversion_id, original.conversion.id);
  assert.equal(localRefund.conversion.meta_delivery_status, "not_eligible");
  assert.equal(localRefund.conversion.meta_delivery_reason, "purchase_not_eligible");
  assert.equal(localRefund.conversion.meta_delivery_snapshot, null);
  checks++;
  // Ordered top-200 selection must preserve the highest groups at both limits.
  await db.query(`INSERT INTO conversions(workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,metadata)
    SELECT $1,'bounded','sale',n,'USD','2026-08-15',jsonb_build_object('whatsappReferral', jsonb_build_object('sourceType','ad','sourceId',lpad(n::text,3,'0')))
    FROM generate_series(1,205) n`, [workspace]);
  const bounded = (await db.query("SELECT get_conversion_attribution_report($1,'2026-08-01','2026-09-01') AS result", [workspace])).rows[0].result;
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.rows.map(row => row.grossRevenue), Array.from({length:200}, (_,i) => 205-i));
  checks++;
  const calendarSql = "SELECT get_conversion_attribution_report($1,$2,$3,NULL,$4) AS result";
  const ny = [workspace,"2023-11-05T04:00:00Z","2024-11-05T05:00:00Z","America/New_York"];
  assert.ok((await db.query(calendarSql,ny)).rows[0].result);
  checks++;
  for (const params of [[...ny.slice(0,2),"2024-11-06T05:00:00Z",ny[3]], [...ny.slice(0,3),"UTC"]]) {
    await db.exec("SAVEPOINT invalid_calendar");
    await assert.rejects(db.query(calendarSql,params), /invalid_report_interval/);
    await db.exec("ROLLBACK TO SAVEPOINT invalid_calendar");
    checks++;
  }
  await db.exec("ROLLBACK; SET ROLE authenticated");
  return checks;
}

async function verifySourceGuard() {
  const db = new PGlite();
  const migration = `${root}/supabase/migrations/20260910181111_protect_source_commerce_credentials.sql`;
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.sources(id text PRIMARY KEY,workspace_id text,type text,credentials jsonb);
  GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
  GRANT ALL ON public.sources TO anon,authenticated,service_role;`);
  await db.exec(await readFile(migration, "utf8"));
  let checks = 0;
  const denied = async (sql, params = []) => {
    await assert.rejects(
      db.query(sql, params),
      /source_commerce_credentials_managed/,
    );
    checks++;
  };
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    for (const key of [
      "conversions_api",
      "sales_webhook_secret",
      "sales_webhook_enabled",
    ]) {
      await denied("INSERT INTO sources VALUES($1,$2,$3,$4::jsonb)", [
        `${role}-${key}`,
        "workspace-1",
        "whatsapp",
        JSON.stringify({
          [key]: key === "conversions_api" ? { enabled: true } : true,
        }),
      ]);
      await denied("INSERT INTO sources VALUES($1,$2,$3,$4::jsonb)", [
        `${role}-other-${key}`,
        "workspace-1",
        "telegram",
        JSON.stringify({ [key]: null }),
      ]);
    }
    await db.query(
      "INSERT INTO sources VALUES($1,'workspace-1','whatsapp',$2::jsonb)",
      [role, JSON.stringify({ waba_id: "123", access_token: "old" })],
    );
    checks++;
    await db.query(
      'UPDATE sources SET credentials=credentials||\'{"access_token":"rotated"}\' WHERE id=$1',
      [role],
    );
    checks++;
    await denied(
      'UPDATE sources SET credentials=credentials||\'{"sales_webhook_secret":"plaintext"}\' WHERE id=$1',
      [role],
    );
    for (const key of [
      "waba_id",
      "wabaId",
      "messaging_account_id",
      "messagingAccountId",
    ]) {
      await denied(
        "UPDATE sources SET credentials=credentials||$1::jsonb WHERE id=$2",
        [JSON.stringify({ [key]: "new-waba" }), role],
      );
    }
    await denied(
      "UPDATE sources SET type='telegram',credentials=credentials-'waba_id' WHERE id=$1",
      [role],
    );
    await db.query("UPDATE sources SET type='telegram' WHERE id=$1", [role]);
    await denied(
      'UPDATE sources SET credentials=credentials||\'{"waba_id":"bypass"}\' WHERE id=$1',
      [role],
    );
    await db.query("UPDATE sources SET type='whatsapp' WHERE id=$1", [role]);
  }
  await db.exec("SET ROLE service_role");
  const secret = { iv: "iv", tag: "tag", ciphertext: "secret" };
  const config = {
    enabled: true,
    dataset_id: "111",
    waba_id: "123",
    configured_at: "2026-09-10T00:00:00.000Z",
  };
  await db.query(
    "UPDATE sources SET credentials=credentials||$1::jsonb WHERE id='authenticated'",
    [
      JSON.stringify({
        conversions_api: config,
        sales_webhook_secret: secret,
        sales_webhook_enabled: true,
      }),
    ],
  );
  checks++;
  await db.exec("SET ROLE authenticated");
  for (const key of [
    "conversions_api",
    "sales_webhook_secret",
    "sales_webhook_enabled",
  ]) {
    await denied(
      "UPDATE sources SET credentials=credentials-$1 WHERE id='authenticated'",
      [key],
    );
    await denied(
      "UPDATE sources SET credentials=jsonb_set(credentials,ARRAY[$1], 'null'::jsonb) WHERE id='authenticated'",
      [key],
    );
  }
  await denied(
    "UPDATE sources SET type='telegram',credentials=credentials||'{\"sales_webhook_enabled\":false}' WHERE id='authenticated'",
  );
  await db.query(
    "UPDATE sources SET credentials=credentials||'{\"access_token\":\"same-waba-reconnect\"}' WHERE id='authenticated'",
  );
  checks++;
  assert.deepEqual(
    (
      await db.query(
        "SELECT credentials->'conversions_api' AS config FROM sources WHERE id='authenticated'",
      )
    ).rows[0].config,
    config,
  );
  checks++;
  await db.exec("SET ROLE service_role");
  await db.query(
    "UPDATE sources SET credentials=jsonb_set(credentials,'{conversions_api,enabled}','false') WHERE id='authenticated'",
  );
  checks++;
  await db.exec("RESET ROLE");
  await db.query(
    "UPDATE sources SET credentials=jsonb_set(credentials,'{sales_webhook_enabled}','false') WHERE id='authenticated'",
  );
  checks++;
  await db.close();

  return checks;
}

const ledgerChecks = await verifyLedger();
const sourceChecks = await verifySourceGuard();
console.log(
  JSON.stringify({
    ledgerChecks,
    sourceChecks,
    result: "passed",
    database: "ephemeral PostgreSQL only",
  }),
);
