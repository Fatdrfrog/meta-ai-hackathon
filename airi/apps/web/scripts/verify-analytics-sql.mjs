import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PGLITE_MODULE_PATH)
  throw new Error(
    "Set PGLITE_MODULE_PATH to the installed test-only PGlite module. No application dependency is added."
  );
const { PGlite } = await import(
  pathToFileURL(process.env.PGLITE_MODULE_PATH).href
);
const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE conversions (
id uuid PRIMARY KEY, workspace_id uuid NOT NULL, conversation_id text NOT NULL,
conversion_type text NOT NULL, conversion_value numeric, currency text, converted_at timestamptz NOT NULL,
created_at timestamptz NOT NULL, external_source_id uuid, external_transaction_id text,
metadata jsonb NOT NULL DEFAULT '{}', meta_delivery_status text NOT NULL, meta_delivery_reason text
);
ALTER TABLE conversions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON conversions TO authenticated,service_role;
CREATE POLICY workspace_scope ON conversions TO authenticated USING (workspace_id::text = current_setting('app.workspace_id',true));`);
const migrationRoot = path.resolve("../../supabase/migrations");
const files = (await fs.readdir(migrationRoot))
  .filter(file =>
    /analytics_acquisition_ledger_projection|conversion_feedback_report|analytics_conversion_page_null_limit_guard/.test(
      file
    )
  )
  .sort();
assert.equal(files.length, 3);
for (const file of files)
  await db.exec(await fs.readFile(path.join(migrationRoot, file), "utf8"));
const workspace = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  source = "00000000-0000-4000-8000-000000000003";
const statuses = [
  "not_eligible",
  "pending",
  "queued",
  "sent",
  "rejected",
  "delivery_unknown",
];
for (let index = 0; index < statuses.length; index++)
  await db.query(
    `INSERT INTO conversions(id,workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,created_at,external_source_id,external_transaction_id,metadata,meta_delivery_status,meta_delivery_reason)
VALUES($1,$2,'conversation','sale',100,'USD','2026-09-01','2026-09-01',$3,$4,$5,$6,$7)`,
    [
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      workspace,
      index < 2 ? source : null,
      `purchase-${index}`,
      JSON.stringify({
        customerId: "stable-customer",
        commerceEvent: { purchaseTransactionId: "original-sale" },
        paymentEvidence: { text: "must not escape" },
      }),
      statuses[index],
      index === 4 ? "invalid_value" : null,
    ]
  );
await db.query(
  `INSERT INTO conversions VALUES($1,$2,'private','sale',999,'USD','2026-09-01','2026-09-01',null,null,'{}','sent',null)`,
  ["00000000-0000-4000-8000-000000000099", other]
);
await db.exec(`SET ROLE authenticated; SET app.workspace_id='${workspace}';`);
const feedback = async (ws = workspace, src = null) =>
  (
    await db.query(
      "SELECT get_conversion_feedback_report($1,$2,$3,$4) AS report",
      [ws, "2026-09-01", "2026-10-01", src]
    )
  ).rows[0].report;
const report = await feedback();
assert.equal(report.recorded, 6);
assert.equal(report.eligible, 5);
assert.equal(report.statuses.sent, 1);
assert.equal(report.statuses.delivery_unknown, 1);
assert.ok(report.oldestPendingAt);
assert.equal(
  (await feedback(other)).recorded,
  0,
  "Invoker RPC cannot bypass workspace RLS"
);
assert.equal((await feedback(workspace, source)).recorded, 2);
await assert.rejects(
  () => db.query("SELECT get_analytics_conversion_page($1,now())", [workspace]),
  /permission denied/
);
await assert.rejects(
  () =>
    db.query("SELECT get_conversion_feedback_report($1,$2,$3)", [
      workspace,
      "2026-10-01",
      "2026-09-01",
    ]),
  /invalid_report_interval/
);
await db.exec("RESET ROLE; SET ROLE service_role;");
const page = (
  await db.query(
    "SELECT get_analytics_conversion_page($1,$2,null,null,2) AS rows",
    [workspace, "2026-10-01"]
  )
).rows[0].rows;
assert.equal(page.length, 2);
assert.equal(page[0].customerId, "stable-customer");
assert.equal(page[0].purchaseTransactionId, "original-sale");
assert.equal(JSON.stringify(page).includes("must not escape"), false);
const next = (
  await db.query(
    "SELECT get_analytics_conversion_page($1,$2,$3,$4,2) AS rows",
    [
      workspace,
      "2026-10-01",
      page.at(-1).ledgerCreatedAt,
      page.at(-1).conversionId,
    ]
  )
).rows[0].rows;
assert.equal(next.length, 2);
assert.notEqual(next[0].conversionId, page[0].conversionId);
await assert.rejects(
  () =>
    db.query("SELECT get_analytics_conversion_page($1,now(),null,null,501)", [
      workspace,
    ]),
  /invalid_analytics_projection_scope/
);
await assert.rejects(
  () =>
    db.query("SELECT get_analytics_conversion_page($1,now(),null,null,null)", [
      workspace,
    ]),
  /invalid_analytics_projection_scope/
);
assert.deepEqual(
  (
    await db.query(`SELECT NOT p.prosecdef AS invoker,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
  has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role,
  EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
  FROM pg_proc p WHERE p.oid='public.get_analytics_conversion_page(uuid,timestamptz,timestamptz,uuid,integer)'::regprocedure`)
  ).rows[0],
  {
    invoker: true,
    anon: false,
    authenticated: false,
    service_role: true,
    public_execute: false,
  }
);
await db.exec("RESET ROLE; SET ROLE anon;");
await assert.rejects(() => feedback(), /permission denied/);
console.log(
  JSON.stringify({
    status: "passed",
    checks: 18,
    migrations: files,
    rls: "workspace-isolated",
    anonymousExecution: "denied",
  })
);
await db.close();
