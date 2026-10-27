import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Local embedded PostgreSQL only; no application dependency or provider call.
if (!process.env.PGLITE_MODULE_PATH)
  throw new Error(
    "Set PGLITE_MODULE_PATH to the existing test-only PGlite module"
  );
const { PGlite } = await import(
  pathToFileURL(process.env.PGLITE_MODULE_PATH).href
);
const db = new PGlite();
let checks = 0;
const workspace = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const token1 = "00000000-0000-4000-8000-000000000010";
const token2 = "00000000-0000-4000-8000-000000000011";
const ids = [21, 22, 23].map(
  id => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`
);
const call = async (sql, args) => (await db.query(sql, args)).rows[0].result;
const claim = (token = token1, limit = 500, scope = workspace) =>
  call("SELECT claim_analytics_conversion_page($1,$2,$3) AS result", [
    scope,
    token,
    limit,
  ]);
const ack = rows =>
  call("SELECT ack_analytics_conversion_page($1,$2) AS result", [
    workspace,
    JSON.stringify(
      rows.map(({ conversionId, claimToken, claimFence }) => ({
        conversionId,
        claimToken,
        claimFence,
      }))
    ),
  ]);
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE conversions (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, conversation_id text NOT NULL,
      conversion_type text NOT NULL, conversion_value numeric, currency text,
      converted_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
      external_source_id uuid, external_transaction_id text, metadata jsonb NOT NULL DEFAULT '{}'
    );
    ALTER TABLE conversions ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON conversions TO authenticated;
    GRANT SELECT, UPDATE ON conversions TO service_role;`);
  const insert = (id, scope = workspace, created = "2026-09-01") =>
    db.query(
      `INSERT INTO conversions
    (id,workspace_id,conversation_id,conversion_type,conversion_value,currency,converted_at,created_at,metadata)
    VALUES ($1,$2,'conversation','sale',100,'USD','2026-09-01',$3,
      '{"customerId":"customer","paymentEvidence":{"text":"private evidence"}}')`,
      [id, scope, created]
    );
  await insert(ids[0]);
  await insert(ids[1]);
  await insert(ids[2], other);
  const file = path.resolve(
    "../../supabase/migrations/20261002095124_analytics_conversion_projection_intent.sql"
  );
  await db.exec(await fs.readFile(file, "utf8"));
  assert.equal(
    await call(
      "SELECT count(*)::integer AS result FROM conversions WHERE analytics_projection_status='pending'",
      []
    ),
    3
  );
  checks++;
  for (const role of ["authenticated", "anon"]) {
    await db.exec(`SET ROLE ${role};`);
    await assert.rejects(() => claim(), /permission denied/);
    checks++;
    await assert.rejects(
      () => ack([{ conversionId: ids[0], claimToken: token1, claimFence: 1 }]),
      /permission denied/
    );
    checks++;
    await db.exec("RESET ROLE;");
  }
  await db.exec("SET ROLE service_role;");
  const first = await claim(token1, 1);
  assert.equal(first.rows.length, 1);
  assert.equal(first.outstanding, true);
  checks++;
  assert.equal(first.rows[0].claimFence, 1);
  assert.equal(first.rows[0].claimToken, token1);
  checks++;
  assert.equal(JSON.stringify(first).includes("private evidence"), false);
  checks++;
  const second = await claim(token2, 1);
  assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0].conversionId, second.rows[0].conversionId);
  checks++;
  const busy = await claim(token2);
  assert.equal(busy.rows.length, 0);
  assert.equal(
    busy.outstanding,
    true,
    "Unexpired claims prevent false empty coverage"
  );
  checks++;
  await assert.rejects(
    () => ack([{ ...first.rows[0], claimToken: token2 }, ...second.rows]),
    /analytics_projection_claim_lost/
  );
  checks++;
  assert.equal(
    await call(
      "SELECT count(*)::integer AS result FROM conversions WHERE workspace_id=$1 AND analytics_projection_status='projected'",
      [workspace]
    ),
    0,
    "A partially valid acknowledgment rolls back the whole page"
  );
  checks++;
  assert.equal(await ack(first.rows), 1);
  checks++;
  await assert.rejects(
    () => ack(first.rows),
    /analytics_projection_claim_lost/
  );
  checks++;
  await db.query(
    "UPDATE conversions SET analytics_projection_claim_until=now()-interval '1 second' WHERE id=$1",
    [second.rows[0].conversionId]
  );
  const reclaimed = await claim(token1);
  assert.equal(reclaimed.rows[0].claimFence, 2);
  checks++;
  await assert.rejects(
    () => ack(second.rows),
    /analytics_projection_claim_lost/
  );
  checks++;
  assert.equal(await ack(reclaimed.rows), 1);
  checks++;
  assert.deepEqual(await claim(), { rows: [], outstanding: false });
  checks++;
  await assert.rejects(
    () => claim(token1, 501),
    /invalid_analytics_projection_scope/
  );
  checks++;
  await assert.rejects(
    () => claim(token1, null),
    /invalid_analytics_projection_scope/
  );
  checks++;
  await assert.rejects(() => ack([]), /invalid_analytics_projection_scope/);
  checks++;
  await assert.rejects(
    () => ack([reclaimed.rows[0], reclaimed.rows[0]]),
    /invalid_analytics_projection_scope/
  );
  checks++;
  await db.exec("RESET ROLE;");
  // The old transaction timestamp arrives after the initial queue was fully drained.
  // This reproduces the commit-order failure without needing two server sessions.
  const lateId = "00000000-0000-4000-8000-000000000024";
  await insert(lateId, workspace, "2000-01-01");
  await db.exec("SET ROLE service_role;");
  const late = await claim();
  assert.equal(
    late.rows[0].conversionId,
    lateId,
    "A late row remains pending regardless its transaction timestamp"
  );
  checks++;
  assert.equal(await ack(late.rows), 1);
  checks++;
  assert.deepEqual(await claim(), { rows: [], outstanding: false });
  checks++;
  assert.equal(
    (await claim(token2, 500, other)).rows[0].conversionId,
    ids[2],
    "Workspace drain cannot consume another workspace's intent"
  );
  checks++;
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      migration: path.basename(file),
      engine: "local-pglite",
      concurrentServerSessions: "not_exercised",
    })
  );
} finally {
  await db.close();
}
