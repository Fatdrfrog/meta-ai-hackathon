/** Run the actual circuit migration in ephemeral PostgreSQL; never connects to a live database.
 * Reuses the external PGlite QA runtime convention from verify-commerce-conversions-sql.mjs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2])
  throw new Error("Pass an external @electric-sql/pglite/dist/index.js path");
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const migrations = new URL("../../supabase/migrations/", import.meta.url);
const readMigration = (name) => readFile(new URL(name, migrations), "utf8");
const extractFunction = (sql, name) => {
  const start = sql
    .toLowerCase()
    .indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `Existing ${name} definition is available`);
  const delimiter = /\bas\s+(\$\w*\$)/i.exec(sql.slice(start));
  assert.ok(delimiter, `Existing ${name} dollar quote is available`);
  const bodyStart = start + delimiter.index + delimiter[0].length;
  const end = sql.indexOf(`${delimiter[1]};`, bodyStart);
  assert.notEqual(end, -1);
  return sql.slice(start, end + delimiter[1].length + 1);
};
const db = new PGlite();
let checks = 0;
try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE companies (id uuid PRIMARY KEY, subscription_type text NOT NULL);
    CREATE TABLE workspaces (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id));
    INSERT INTO companies VALUES ('11111111-1111-4111-8111-111111111111','pro');
    INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111');
    CREATE TABLE campaign_history (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
      workflow_id text, dispatch_status text NOT NULL DEFAULT 'running',
      total_recipients integer NOT NULL DEFAULT 3,
      processed_count integer NOT NULL DEFAULT 0,
      accepted_count integer NOT NULL DEFAULT 0,
      failed_sends integer NOT NULL DEFAULT 0,
      successful_sends integer NOT NULL DEFAULT 0,
      attempted_count integer NOT NULL DEFAULT 0,
      not_attempted_count integer NOT NULL DEFAULT 3,
      stop_reason text, progress_at timestamptz, finished_at timestamptz, expired_at timestamptz,
      provider_circuit_state text NOT NULL DEFAULT 'closed',
      provider_circuit_provider text, provider_circuit_code text,
      provider_circuit_opened_at timestamptz,
      provider_circuit_acknowledged_at timestamptz, provider_circuit_acknowledged_by uuid,
      retry_of_campaign_id uuid
    );
    ALTER TABLE campaign_history ADD COLUMN audience_fingerprint text DEFAULT 'snapshot',
      ADD COLUMN delivery_ledger_started_at timestamptz DEFAULT now(),
      ADD COLUMN cost_ledger_started_at timestamptz DEFAULT now(),
      ADD COLUMN cancelled_at timestamptz,
      ADD COLUMN channel text DEFAULT 'whatsapp',
      ADD COLUMN delivered_count integer DEFAULT 0,
      ADD COLUMN read_count integer DEFAULT 0,
      ADD COLUMN opened_count integer DEFAULT 0,
      ADD COLUMN clicked_count integer DEFAULT 0,
      ADD COLUMN unsubscribed_count integer DEFAULT 0,
      ADD COLUMN bounced_count integer DEFAULT 0,
      ADD COLUMN estimated_cost numeric DEFAULT 0,
      ADD COLUMN delivery_rate numeric,
      ADD COLUMN read_rate numeric,
      ADD COLUMN open_rate numeric,
      ADD COLUMN click_rate numeric,
      ADD COLUMN unsubscribe_rate numeric,
      ADD COLUMN bounce_rate numeric;
    ALTER TABLE campaign_history ADD COLUMN name text, ADD COLUMN template_name text,
      ADD COLUMN template_language text, ADD COLUMN message_text text,
      ADD COLUMN sent_by uuid, ADD COLUMN sent_at timestamptz,
      ADD COLUMN scheduled_for timestamptz, ADD COLUMN scenario_id text,
      ADD COLUMN scenario_node_id text, ADD COLUMN execution_source text,
      ADD COLUMN requested_at timestamptz, ADD COLUMN queued_at timestamptz,
      ADD COLUMN scheduled_at timestamptz, ADD COLUMN dispatch_expires_at timestamptz,
      ADD COLUMN started_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now(),
      ADD COLUMN audience_hash_version text, ADD COLUMN audience_source_type text,
      ADD COLUMN audience_count integer, ADD COLUMN audience_metadata jsonb,
      ADD COLUMN audience_original_filename text, ADD COLUMN audience_uploaded_at timestamptz,
      ADD COLUMN audience_uploaded_by uuid, ADD COLUMN audience_content_hash text,
      ADD COLUMN audience_replacement_history jsonb, ADD COLUMN retry_kind text,
      ADD COLUMN bulk_quota_reserved_at timestamptz;
    CREATE TABLE campaign_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid NOT NULL REFERENCES campaign_history(id),
      channel text NOT NULL DEFAULT 'whatsapp', provider text DEFAULT 'meta',
      message_id text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'sent',
      error_code integer, failure_scope text, failure_reason text,
      failed_at timestamptz, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
    );
    ALTER TABLE campaign_messages ADD COLUMN delivered_at timestamptz,
      ADD COLUMN read_at timestamptz, ADD COLUMN opened_at timestamptz,
      ADD COLUMN clicked_at timestamptz, ADD COLUMN unsubscribed_at timestamptz,
      ADD COLUMN bounced_at timestamptz, ADD COLUMN estimated_cost_usd numeric,
      ADD COLUMN attempted_at timestamptz, ADD COLUMN error_message text,
      ADD COLUMN dispatch_snapshot jsonb DEFAULT '{}'::jsonb;
    ALTER TABLE campaign_messages ADD COLUMN phone text, ADD COLUMN recipient text,
      ADD COLUMN scenario_id text, ADD COLUMN scenario_node_id text,
      ADD COLUMN execution_source text, ADD COLUMN recipient_hash text,
      ADD COLUMN snapshot_ordinal integer, ADD COLUMN snapshot_created_at timestamptz;
  `);
  const ledger = await readMigration(
    "20260727084019_bulk_campaign_sql_ledger.sql",
  );
  for (const name of [
    "resolve_bulk_campaign_failure_scope",
    "is_bulk_campaign_message_retryable",
    "normalize_bulk_campaign_retry_snapshot",
    "bulk_campaign_message_stat_contribution",
    "apply_bulk_campaign_stats_delta",
    "apply_bulk_campaign_message_insert_stats",
    "apply_bulk_campaign_message_update_stats",
    "apply_bulk_campaign_message_delete_stats",
    "normalize_bulk_campaign_message_failure_scope",
  ]) {
    await db.exec(extractFunction(ledger, name));
  }
  // Execute the production statement triggers, including their transition tables.
  await db.exec(
    ledger.slice(
      ledger.indexOf(
        "drop trigger if exists campaign_messages_normalize_failure_scope",
      ),
      ledger.indexOf(
        "drop index if exists public.campaign_messages_failed_snapshot_idx",
      ),
    ),
  );
  const safety = await readMigration("20260724115832_bulk_campaign_safety.sql");
  for (const name of [
    "update_bulk_campaign_progress",
    "reconcile_bulk_campaign_cancellation",
    "finalize_bulk_campaign_dispatch",
  ]) {
    await db.exec(extractFunction(safety, name));
  }
  const admissionInner = await readMigration(
    "20260824153853_bulk_campaign_dispatch_item_identity_admit_inner.sql",
  );
  const admissionWrapper = await readMigration(
    "20260824153602_bulk_campaign_dispatch_item_identity_admit_wrapper.sql",
  );
  const recipientContract = await readMigration(
    "20260824153956_bulk_campaign_dispatch_item_identity_contract.sql",
  );
  const recipientState = await readMigration(
    "20260820090349_add_whatsapp_prior_failure_recipient_state.sql",
  );
  await db.exec(
    recipientState.slice(
      0,
      recipientState.indexOf(
        "create or replace function public.sync_campaign_recipient_delivery_state",
      ),
    ),
  );
  await db.exec(
    extractFunction(
      recipientState,
      "get_prior_failed_bulk_campaign_recipient_hashes",
    ),
  );
  await db.exec(
    extractFunction(admissionInner, "admit_bulk_campaign_non_idempotent"),
  );
  await db.exec(extractFunction(admissionWrapper, "admit_bulk_campaign"));
  await db.exec(
    extractFunction(
      recipientContract,
      "normalize_bulk_campaign_retry_snapshot",
    ),
  );
  await db.exec(
    extractFunction(recipientContract, "get_bulk_campaign_retryable_snapshots"),
  );
  await db.exec(
    extractFunction(
      recipientContract,
      "get_campaign_recipient_delivery_state_contract",
    ),
  );
  const canonicalOwners = [
    "admit_bulk_campaign",
    "admit_bulk_campaign_non_idempotent",
    "get_campaign_recipient_delivery_state_contract",
  ];
  for (const name of canonicalOwners) {
    const acl = new RegExp(
      `revoke all on function public\\.${name}\\([\\s\\S]*?to service_role;`,
      "i",
    ).exec(recipientContract);
    assert.ok(acl, `Existing ${name} service-only ACL is available`);
    await db.exec(acl[0]);
  }
  const readCanonicalOwners = async () =>
    (
      await db.query(
        `
    SELECT p.proname, p.pronargs, p.proacl::text, p.prosecdef, p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])
    ORDER BY p.proname,p.pronargs
  `,
        [canonicalOwners],
      )
    ).rows;
  const ownersBefore = await readCanonicalOwners();
  const recipientProbe = async () =>
    (
      await db.query(
        "SELECT get_campaign_recipient_delivery_state_contract() AS result",
      )
    ).rows[0].result;
  const recipientContractBefore = await recipientProbe();
  assert.equal(
    recipientContractBefore.admission_metadata_projection_exact,
    true,
  );
  const circuitMigration = await readMigration(
    "20260915173802_campaign_async_provider_circuit.sql",
  );
  await db.exec(circuitMigration);
  const recipientContractAfter = await recipientProbe();
  assert.equal(
    recipientContractAfter.admission_metadata_projection_exact,
    true,
  );
  assert.notEqual(
    recipientContractAfter.admission_inner_md5,
    recipientContractBefore.admission_inner_md5,
  );
  assert.deepEqual(
    {
      ...recipientContractAfter,
      admission_inner_md5: recipientContractBefore.admission_inner_md5,
    },
    recipientContractBefore,
    "Every existing recipient contract field survives except the corrected inner body hash",
  );
  checks++;
  const ownersAfter = await readCanonicalOwners();
  assert.deepEqual(
    ownersAfter,
    ownersBefore,
    "CREATE OR REPLACE preserves canonical signatures and service-only ACLs",
  );
  assert.deepEqual(
    ownersAfter.map(({ proname, pronargs }) => [proname, pronargs]),
    [
      ["admit_bulk_campaign", 33],
      ["admit_bulk_campaign_non_idempotent", 33],
      ["get_campaign_recipient_delivery_state_contract", 0],
    ],
  );
  for (const owner of ownersAfter) {
    assert.equal(owner.anon_execute, false);
    assert.equal(owner.authenticated_execute, false);
    assert.equal(owner.service_execute, true);
  }
  checks++;

  const workspace = "11111111-1111-4111-8111-111111111111";
  const createCampaign = async (total = 3) => {
    const result = await db.query(
      "INSERT INTO campaign_history(id,workspace_id,total_recipients,not_attempted_count) VALUES(gen_random_uuid(),$1,$2,$2) RETURNING id",
      [workspace, total],
    );
    return result.rows[0].id;
  };
  const readCampaign = async (id) =>
    (await db.query("SELECT * FROM campaign_history WHERE id=$1", [id]))
      .rows[0];
  const seedMessage = async (id, status = "sent", suffix = "") => {
    const messageId = `wamid.${id}${suffix}`;
    await db.query(
      "INSERT INTO campaign_messages(campaign_id,message_id,status) VALUES($1,$2,$3)",
      [id, messageId, status],
    );
    return messageId;
  };
  const failMessage = (id, code, at = "2026-09-15T10:59:00Z") =>
    db.query(
      "UPDATE campaign_messages SET status='failed',error_code=$2,failed_at=$3 WHERE campaign_id=$1 AND message_id='wamid.' || $1::text AND status IN('sent','accepted','failed')",
      [id, code, at],
    );
  const finalize = async (id) =>
    (
      await db.query(
        "SELECT finalize_bulk_campaign_dispatch($1,'completed',3,3,0,3,0,NULL,'closed',NULL,NULL,'2026-09-15T11:00:00Z') AS result",
        [id],
      )
    ).rows[0].result;

  const campaign = await createCampaign();
  const untouched = await createCampaign();
  await seedMessage(campaign);
  await seedMessage(campaign, "sent", "-2");
  await seedMessage(campaign, "sent", "-3");
  await failMessage(campaign, 131048);
  let row = await readCampaign(campaign);
  assert.equal(
    row.provider_circuit_state,
    "open",
    "A durable asynchronous131048 must open the circuit",
  );
  assert.equal(row.provider_circuit_provider, "meta");
  assert.equal(row.provider_circuit_code, "131048");
  assert.equal(row.stop_reason, "provider_circuit_open");
  assert.equal(row.dispatch_status, "running");
  assert.equal(row.processed_count, 0);
  assert.equal(
    (await readCampaign(untouched)).provider_circuit_state,
    "closed",
  );
  checks++;

  const openedAt = row.provider_circuit_opened_at;
  await failMessage(campaign, 131048, "2026-09-15T11:01:00Z");
  assert.deepEqual(
    (await readCampaign(campaign)).provider_circuit_opened_at,
    openedAt,
  );
  checks++;

  assert.equal((await finalize(campaign)).applied, true);
  row = await readCampaign(campaign);
  assert.equal(row.provider_circuit_state, "open");
  assert.equal(row.provider_circuit_code, "131048");
  assert.equal(row.dispatch_status, "completed");
  assert.equal(row.accepted_count, 3);
  assert.equal(row.failed_sends, 1);
  assert.equal(row.successful_sends, 2);
  assert.equal(row.stop_reason, "provider_circuit_open");
  assert.equal((await finalize(campaign)).outcome, "already_finalized");
  checks++;

  const late = await createCampaign();
  await seedMessage(late);
  await seedMessage(late, "sent", "-2");
  await seedMessage(late, "sent", "-3");
  await finalize(late);
  const completed = await readCampaign(late);
  await failMessage(late, 131042);
  row = await readCampaign(late);
  assert.equal(row.provider_circuit_state, "open");
  assert.equal(row.dispatch_status, "completed");
  assert.deepEqual(row.finished_at, completed.finished_at);
  assert.equal(row.accepted_count, 3);
  assert.equal(row.failed_sends, 1);
  assert.equal(row.successful_sends, 2);
  assert.equal((await finalize(late)).outcome, "already_finalized");
  checks++;

  const progress = async (
    id,
    processed,
    accepted,
    failed,
    attempted,
    notAttempted,
  ) =>
    (
      await db.query(
        "SELECT update_bulk_campaign_progress($1,$2,$3,$4,$5,$6,'2026-09-15T11:00:00Z') AS result",
        [id, processed, accepted, failed, attempted, notAttempted],
      )
    ).rows[0].result;
  const finalizeStopped = async (id) =>
    (
      await db.query(
        "SELECT finalize_bulk_campaign_dispatch($1,'failed',6,3,0,3,3,'provider_circuit_open','closed',NULL,NULL,'2026-09-15T11:02:00Z') AS result",
        [id],
      )
    ).rows[0].result;
  const cancelStopped = async (id) =>
    (
      await db.query(
        "SELECT reconcile_bulk_campaign_cancellation($1,$2,6,3,0,3,3,'workflow_cancelled','closed',NULL,NULL,'2026-09-15T11:02:00Z') AS result",
        [id, workspace],
      )
    ).rows[0].result;
  const acceptedFirstBatch = async () => {
    const id = await createCampaign(6);
    await seedMessage(id);
    await seedMessage(id, "sent", "-2");
    await seedMessage(id, "sent", "-3");
    assert.equal((await progress(id, 3, 3, 0, 3, 3)).applied, true);
    await failMessage(id, 131048);
    const current = await readCampaign(id);
    assert.equal(current.successful_sends, 2);
    assert.equal(current.failed_sends, 1);
    assert.equal(current.accepted_count, 3);
    assert.equal(current.attempted_count, 3);
    return id;
  };

  const stopped = await acceptedFirstBatch();
  // The circuit suppresses the next three recipients without attempting them.
  assert.equal((await progress(stopped, 6, 3, 0, 3, 3)).applied, true);
  row = await readCampaign(stopped);
  assert.equal(row.successful_sends, 2);
  assert.equal(row.failed_sends, 1);
  assert.equal((await finalizeStopped(stopped)).applied, true);
  row = await readCampaign(stopped);
  assert.equal(row.dispatch_status, "failed");
  assert.equal(row.processed_count, 6);
  assert.equal(row.not_attempted_count, 3);
  assert.equal(row.attempted_count, 3);
  assert.equal(row.accepted_count, 3);
  assert.equal(row.successful_sends, 2);
  assert.equal(row.failed_sends, 1);
  assert.equal((await finalizeStopped(stopped)).outcome, "already_finalized");
  checks++;

  const cancelled = await acceptedFirstBatch();
  assert.equal((await cancelStopped(cancelled)).outcome, "cancelled");
  const firstCancellation = await readCampaign(cancelled);
  assert.equal(firstCancellation.provider_circuit_state, "open");
  assert.equal(firstCancellation.successful_sends, 2);
  assert.equal(firstCancellation.failed_sends, 1);
  assert.equal(firstCancellation.not_attempted_count, 3);
  assert.equal((await cancelStopped(cancelled)).outcome, "already_cancelled");
  row = await readCampaign(cancelled);
  assert.deepEqual(row.progress_at, firstCancellation.progress_at);
  assert.deepEqual(row.finished_at, firstCancellation.finished_at);
  assert.equal(row.successful_sends, 2);
  assert.equal(row.failed_sends, 1);
  checks++;

  const synchronousFailure = await createCampaign(6);
  await seedMessage(synchronousFailure);
  await seedMessage(synchronousFailure, "failed", "-rejected");
  assert.equal(
    (await progress(synchronousFailure, 2, 1, 1, 2, 4)).applied,
    true,
  );
  row = await readCampaign(synchronousFailure);
  assert.equal(row.successful_sends, 1);
  assert.equal(row.failed_sends, 1);
  await assert.rejects(
    progress(synchronousFailure, 2, 2, 0, 2, 4),
    /count regression/,
  );
  await assert.rejects(
    progress(synchronousFailure, 3, 1, 1, 3, 3),
    /exceeds persisted/,
  );
  checks++;

  const legacy = await createCampaign();
  await db.query(
    "UPDATE campaign_history SET audience_fingerprint=NULL,delivery_ledger_started_at=NULL,cost_ledger_started_at=NULL WHERE id=$1",
    [legacy],
  );
  assert.equal((await progress(legacy, 3, 2, 1, 3, 0)).applied, true);
  row = await readCampaign(legacy);
  assert.equal(row.successful_sends, 2);
  assert.equal(row.failed_sends, 1);
  await assert.rejects(progress(legacy, 3, 3, 0, 3, 0), /count regression/);
  checks++;

  for (const code of [368, 131031, 190]) {
    const id = await createCampaign();
    await seedMessage(id);
    await failMessage(id, code);
    assert.equal(
      (await readCampaign(id)).provider_circuit_state,
      "open",
      `Provider code${code} uses the canonical classifier`,
    );
    checks++;
  }
  for (const code of [131049, 130472, 131026, 999999]) {
    const id = await createCampaign();
    await seedMessage(id);
    await failMessage(id, code);
    assert.equal(
      (await readCampaign(id)).provider_circuit_state,
      "closed",
      `Recipient/unknown code${code} cannot open the provider circuit`,
    );
    checks++;
  }
  for (const status of ["delivered", "read"]) {
    const id = await createCampaign();
    await seedMessage(id, status);
    await failMessage(id, 131048);
    assert.equal((await readCampaign(id)).provider_circuit_state, "closed");
    checks++;
  }

  const rollback = await createCampaign();
  await seedMessage(rollback);
  await db.exec("BEGIN");
  await failMessage(rollback, 131048);
  assert.equal((await readCampaign(rollback)).provider_circuit_state, "open");
  await db.exec("ROLLBACK");
  assert.equal((await readCampaign(rollback)).provider_circuit_state, "closed");
  await failMessage(rollback, 131048);
  assert.equal((await readCampaign(rollback)).provider_circuit_state, "open");
  checks++;

  await db.query(
    "UPDATE campaign_history SET dispatch_status='cancelled',stop_reason='cancelled_by_operator',provider_circuit_state='closed',provider_circuit_provider=NULL,provider_circuit_code=NULL,provider_circuit_opened_at=NULL WHERE id=$1",
    [rollback],
  );
  row = await readCampaign(rollback);
  assert.equal(row.provider_circuit_state, "open");
  assert.equal(row.stop_reason, "cancelled_by_operator");
  assert.equal(row.dispatch_status, "cancelled");
  checks++;

  const retry = await createCampaign();
  await db.query(
    "UPDATE campaign_history SET retry_of_campaign_id=$2,provider_circuit_acknowledged_at=now(),provider_circuit_acknowledged_by=$3 WHERE id=$1",
    [retry, campaign, workspace],
  );
  assert.equal((await readCampaign(retry)).provider_circuit_state, "closed");
  assert.equal((await readCampaign(campaign)).provider_circuit_state, "open");
  checks++;

  const deliveryCounts = async (id, requestedWorkspace = workspace) =>
    (
      await db.query(
        "SELECT get_bulk_campaign_delivery_counts_batch($1,ARRAY[$2::uuid]) AS result",
        [requestedWorkspace, id],
      )
    ).rows[0].result;
  // Simulate a saved pre-migration campaign; reading it must not rewrite history.
  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const historical = await createCampaign(6);
  await seedMessage(historical, "delivered");
  await db.query(
    "INSERT INTO campaign_messages(campaign_id,message_id,status,error_code,failure_scope,dispatch_snapshot) SELECT $1,gen_random_uuid()::text,'failed',code,'recipient',NULL FROM unnest(ARRAY[131048,131048,131042]) AS code",
    [historical],
  );
  await db.exec(
    "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const historicalBefore = await readCampaign(historical);
  assert.equal(historicalBefore.provider_circuit_state, "closed");
  let historicalCounts = (await deliveryCounts(historical))[0];
  assert.equal(historicalCounts.delivered, 1);
  assert.equal(historicalCounts.common_provider_failure_provider, "meta");
  assert.equal(historicalCounts.common_provider_failure_code, "131048");
  assert.equal(historicalCounts.common_provider_failure_count, 2);
  assert.equal(historicalCounts.retryable_failed_recipient_count, 0);
  assert.deepEqual(await readCampaign(historical), historicalBefore);
  assert.deepEqual(
    await deliveryCounts(historical, "22222222-2222-4222-8222-222222222222"),
    [],
  );
  checks++;

  const singleRestriction = await createCampaign();
  await seedMessage(singleRestriction);
  await failMessage(singleRestriction, 131048);
  historicalCounts = (await deliveryCounts(singleRestriction))[0];
  assert.equal(historicalCounts.common_provider_failure_code, "131048");
  assert.equal(historicalCounts.common_provider_failure_count, 1);
  checks++;

  const recipientFailure = await createCampaign();
  await seedMessage(recipientFailure);
  await failMessage(recipientFailure, 131049);
  historicalCounts = (await deliveryCounts(recipientFailure))[0];
  assert.equal(historicalCounts.common_provider_failure_provider, null);
  assert.equal(historicalCounts.common_provider_failure_count, 0);
  checks++;

  const otherProvider = await createCampaign(2);
  await db.query(
    `INSERT INTO campaign_messages(campaign_id,message_id,status,provider,failure_scope,failure_reason)
     SELECT $1,gen_random_uuid()::text,'failed','postmark','provider','{"providerCode":"500"}' FROM generate_series(1,2)`,
    [otherProvider],
  );
  historicalCounts = (await deliveryCounts(otherProvider))[0];
  assert.equal(historicalCounts.common_provider_failure_provider, "postmark");
  assert.equal(historicalCounts.common_provider_failure_code, "500");
  assert.equal(historicalCounts.common_provider_failure_count, 2);
  checks++;

  for (const code of [131049, 999999]) {
    const id = await createCampaign(2);
    await db.query(
      "INSERT INTO campaign_messages(campaign_id,message_id,status,error_code,failure_scope) SELECT $1,gen_random_uuid()::text,'failed',$2,'provider' FROM generate_series(1,2)",
      [id, code],
    );
    assert.equal(
      (await deliveryCounts(id))[0].common_provider_failure_count,
      0,
    );
    assert.equal((await readCampaign(id)).provider_circuit_state, "closed");
    checks++;
  }
  const staleScope = await createCampaign();
  await db.query(
    "INSERT INTO campaign_messages(campaign_id,message_id,status,error_code,failure_scope) VALUES($1,gen_random_uuid()::text,'failed',131048,'recipient')",
    [staleScope],
  );
  assert.equal((await readCampaign(staleScope)).provider_circuit_state, "open");
  checks++;

  for (const [canonicalCode, legacyCode, expectedCode] of [
    [131049, "131048", null],
    [131048, "contact_frequency_limit", "131048"],
    [null, "131048", "131048"],
    [null, " 131048 ", "131048"],
    [null, "131049", null],
    [null, "999999", null],
    [null, "contact_frequency_limit", null],
    [null, "131048.0", null],
  ]) {
    const id = await createCampaign();
    const legacyReason = JSON.stringify({
      providerCode: legacyCode,
      providerScope: "provider",
    });
    await db.exec(
      "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
    );
    await db.query(
      "INSERT INTO campaign_messages(campaign_id,message_id,status,error_code,failure_reason) VALUES($1,gen_random_uuid()::text,'failed',$2,$3)",
      [id, canonicalCode, legacyReason],
    );
    await db.exec(
      "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
    );
    const historicalResult = (await deliveryCounts(id))[0];
    assert.equal(historicalResult.common_provider_failure_code, expectedCode);
    assert.equal(
      historicalResult.common_provider_failure_count,
      expectedCode ? 1 : 0,
    );
    assert.equal((await readCampaign(id)).provider_circuit_state, "closed");
    // Replay of the existing structured representation must use the same code
    // as the read path, including updates that only supply failure_reason.
    await db.query(
      "UPDATE campaign_messages SET failure_reason=$2 WHERE campaign_id=$1",
      [id, legacyReason],
    );
    row = await readCampaign(id);
    assert.equal(row.provider_circuit_state, expectedCode ? "open" : "closed");
    assert.equal(row.provider_circuit_code, expectedCode);
    checks++;
  }

  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const admissionSource = await createCampaign();
  await seedMessage(admissionSource);
  await db.query(
    "UPDATE campaign_messages SET recipient='fixture-recipient',recipient_hash=$2,snapshot_ordinal=0 WHERE campaign_id=$1",
    [admissionSource, "c".repeat(64)],
  );
  await failMessage(admissionSource, 131048);
  await seedMessage(admissionSource, "delivered", "-delivered");
  await db.query(
    "UPDATE campaign_history SET dispatch_status='completed' WHERE id=$1",
    [admissionSource],
  );
  await db.exec(
    "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const admissionChild = (await db.query("SELECT gen_random_uuid() AS id"))
    .rows[0].id;
  const admit = async (acknowledgedBy, overrides = {}) => {
    const args = {
      p_campaign_id: admissionChild,
      p_workspace_id: workspace,
      p_channel: "whatsapp",
      p_name: "fixture retry",
      p_template_name: "fixture",
      p_template_language: "en",
      p_message_text: null,
      p_sent_by: workspace,
      p_scenario_id: null,
      p_scenario_node_id: null,
      p_execution_source: "ad_hoc",
      p_workflow_id: "fixture-workflow",
      p_dispatch_status: "queued",
      p_requested_at: "2026-09-15T11:00:00Z",
      p_scheduled_at: null,
      p_dispatch_expires_at: "2026-09-15T12:00:00Z",
      p_audience_fingerprint: "a".repeat(64),
      p_audience_hash_version: "v1",
      p_audience_source_type: "retry",
      p_audience_count: 1,
      p_audience_metadata: "{}",
      p_audience_original_filename: null,
      p_audience_uploaded_at: null,
      p_audience_uploaded_by: null,
      p_audience_content_hash: "d".repeat(64),
      p_audience_replacement_history: "[]",
      p_retry_of_campaign_id: admissionSource,
      p_retry_kind: "failed_only",
      p_expected_subscription_type: "pro",
      p_company_bulk_campaign_limit: null,
      p_provider_circuit_acknowledged_by: acknowledgedBy,
      p_confirmation_fingerprint: null,
      p_messages: JSON.stringify([
        {
          recipient: "fixture-recipient",
          recipient_hash: "c".repeat(64),
          snapshot_ordinal: 0,
          dispatch_snapshot: {},
        },
      ]),
      ...overrides,
    };
    const entries = Object.entries(args);
    return (
      await db.query(
        `SELECT admit_bulk_campaign(${entries.map(([name], index) => `${name} => $${index + 1}`).join(",")}) AS result`,
        entries.map(([, value]) => value),
      )
    ).rows[0].result;
  };
  assert.equal(
    (await admit(null)).code,
    "provider_circuit_acknowledgement_required",
  );
  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  await db.query(
    "UPDATE campaign_messages SET error_code=NULL,failure_reason=$2 WHERE campaign_id=$1 AND status='failed'",
    [
      admissionSource,
      JSON.stringify({ providerCode: "131048", providerScope: "provider" }),
    ],
  );
  await db.exec(
    "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  assert.equal(
    (await deliveryCounts(admissionSource))[0].common_provider_failure_code,
    "131048",
  );
  assert.equal(
    (await admit(null)).code,
    "provider_circuit_acknowledgement_required",
  );
  checks++;
  assert.equal(await readCampaign(admissionChild), undefined);
  assert.equal((await admit(workspace)).status, "admitted");
  const admittedChild = await readCampaign(admissionChild);
  assert.equal(admittedChild.provider_circuit_state, "closed");
  assert.equal(admittedChild.provider_circuit_acknowledged_by, workspace);
  assert.ok(admittedChild.provider_circuit_acknowledged_at);
  assert.equal(
    (await readCampaign(admissionSource)).provider_circuit_state,
    "closed",
  );
  assert.equal((await admit(null)).idempotent_replay, true);
  assert.deepEqual(
    (await readCampaign(admissionChild)).provider_circuit_acknowledged_at,
    admittedChild.provider_circuit_acknowledged_at,
  );
  checks++;

  // The canonical August admission owns company limits as well as item identity.
  // A new overload must never route around either of these checks.
  const freshId = async () =>
    (await db.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  const limitedChild = await freshId();
  const standalone = {
    p_campaign_id: limitedChild,
    p_retry_of_campaign_id: null,
    p_retry_kind: null,
    p_audience_source_type: "manual",
    p_audience_fingerprint: "e".repeat(64),
    p_messages: JSON.stringify([
      {
        recipient: "fixture-standalone",
        recipient_hash: "f".repeat(64),
        snapshot_ordinal: 0,
        dispatch_snapshot: {},
      },
    ]),
  };
  assert.equal(
    (await admit(null, { ...standalone, p_expected_subscription_type: "free" }))
      .code,
    "company_plan_changed",
  );
  assert.equal(await readCampaign(limitedChild), undefined);
  checks++;
  assert.equal(
    (await admit(null, { ...standalone, p_company_bulk_campaign_limit: 0 }))
      .code,
    "company_bulk_campaign_limit_exceeded",
  );
  assert.equal(await readCampaign(limitedChild), undefined);
  checks++;

  const duplicateItems = [0, 1].map((snapshot_ordinal) => ({
    recipient: "fixture-standalone",
    recipient_hash: "f".repeat(64),
    snapshot_ordinal,
    dispatch_snapshot: {},
  }));
  const itemAdmission = await admit(null, {
    ...standalone,
    p_audience_count: 2,
    p_messages: JSON.stringify(duplicateItems),
  });
  assert.equal(itemAdmission.status, "admitted");
  assert.equal(itemAdmission.item_count, 2);
  assert.equal(itemAdmission.unique_recipient_count, 1);
  const itemCampaign = await readCampaign(limitedChild);
  assert.equal(itemCampaign.total_recipients, 2);
  assert.equal(itemCampaign.audience_count, 1);
  assert.deepEqual(
    (
      await db.query(
        "SELECT snapshot_ordinal FROM campaign_messages WHERE campaign_id=$1 ORDER BY snapshot_ordinal",
        [limitedChild],
      )
    ).rows,
    [{ snapshot_ordinal: 0 }, { snapshot_ordinal: 1 }],
  );
  checks++;
  await db.query(
    "UPDATE campaign_messages SET status='failed',error_code=131049 WHERE campaign_id=$1",
    [limitedChild],
  );
  await db.query(
    "UPDATE campaign_history SET dispatch_status='completed' WHERE id=$1",
    [limitedChild],
  );
  const collapsedChild = await freshId();
  await assert.rejects(
    admit(null, {
      ...standalone,
      p_campaign_id: collapsedChild,
      p_retry_of_campaign_id: limitedChild,
      p_retry_kind: "failed_only",
      p_audience_source_type: "retry",
    }),
    /retry candidate must exactly match current failed snapshot multiset/,
  );
  assert.equal(await readCampaign(collapsedChild), undefined);
  checks++;

  // Historical spreadsheet formatting is part of immutable retry intent. The
  // caller must preserve it for admission and normalize only at send time.
  const spreadsheetSource = await createCampaign(5);
  const spreadsheetRows = [
    [0, "77010000001", "'+77010000001", "failed", "provider"],
    [1, "77010000001", "'+77010000001", "failed", "provider"],
    [2, "77010000002", "77010000002", "accepted", null],
    [3, "77010000003", "77010000003", "delivered", null],
    [4, "77010000004", "'+77010000004", "failed", "unknown"],
  ];
  const spreadsheetMessages = [];
  for (const [ordinal, recipient, phone, status, scope] of spreadsheetRows) {
    const message = {
      recipient,
      recipient_hash: String(ordinal < 2 ? 1 : ordinal).repeat(64),
      snapshot_ordinal: ordinal,
      dispatch_snapshot: {
        workspaceId: workspace,
        campaignId: spreadsheetSource,
        channel: "whatsapp",
        snapshotOrdinal: ordinal,
        recipient: { phone },
        phoneNumberId: "fixture-phone",
        templateName: "fixture",
        templateCategory: "MARKETING",
      },
    };
    spreadsheetMessages.push(message);
    await db.query(
      `INSERT INTO campaign_messages(
        campaign_id,message_id,status,recipient,recipient_hash,
        snapshot_ordinal,dispatch_snapshot,failure_scope
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        spreadsheetSource,
        `fixture-spreadsheet-${spreadsheetSource}-${ordinal}`,
        status,
        recipient,
        message.recipient_hash,
        ordinal,
        JSON.stringify(message.dispatch_snapshot),
        scope,
      ],
    );
  }
  await db.query(
    "UPDATE campaign_history SET dispatch_status='completed' WHERE id=$1",
    [spreadsheetSource],
  );
  const spreadsheetRetryable = (
    await db.query(
      "SELECT get_bulk_campaign_retryable_snapshots($1,$2) AS result",
      [workspace, spreadsheetSource],
    )
  ).rows[0].result;
  assert.deepEqual(
    spreadsheetRetryable.map(({ snapshot_ordinal }) => snapshot_ordinal),
    [0, 1],
    "Accepted, delivered, and unknown-outcome rows cannot enter failed-only retry",
  );
  checks++;
  const spreadsheetChild = await freshId();
  const retrySpreadsheet = (messages, id = spreadsheetChild) =>
    admit(null, {
      p_campaign_id: id,
      p_retry_of_campaign_id: spreadsheetSource,
      p_audience_fingerprint: "8".repeat(64),
      p_audience_content_hash: "9".repeat(64),
      p_audience_count: messages.length,
      p_messages: JSON.stringify(messages),
    });
  await assert.rejects(
    retrySpreadsheet(
      spreadsheetMessages.slice(0, 2).map(message => ({
        ...message,
        dispatch_snapshot: {
          ...message.dispatch_snapshot,
          recipient: { phone: "77010000001" },
        },
      })),
    ),
    /retry candidate must exactly match current failed snapshot multiset/,
  );
  assert.equal(await readCampaign(spreadsheetChild), undefined);
  checks++;
  await assert.rejects(
    retrySpreadsheet(spreadsheetMessages),
    /retry candidate must exactly match current failed snapshot multiset/,
  );
  assert.equal(await readCampaign(spreadsheetChild), undefined);
  checks++;
  const spreadsheetAdmission = await retrySpreadsheet(
    spreadsheetMessages.slice(0, 2),
  );
  assert.equal(spreadsheetAdmission.status, "admitted");
  assert.equal(spreadsheetAdmission.item_count, 2);
  assert.equal(spreadsheetAdmission.unique_recipient_count, 1);
  assert.deepEqual(
    (
      await db.query(
        `SELECT snapshot_ordinal,dispatch_snapshot #>> '{recipient,phone}' AS phone
        FROM campaign_messages WHERE campaign_id=$1 ORDER BY snapshot_ordinal`,
        [spreadsheetChild],
      )
    ).rows,
    [
      { snapshot_ordinal: 0, phone: "'+77010000001" },
      { snapshot_ordinal: 1, phone: "'+77010000001" },
    ],
  );
  checks++;

  const contract = async () =>
    (
      await db.query(
        "SELECT get_campaign_provider_circuit_contract() AS result",
      )
    ).rows[0].result;
  assert.deepEqual(await contract(), {
    version: 1,
    message_trigger_enabled: true,
    history_trigger_enabled: true,
    security_invoker: true,
    empty_search_path: true,
    finalization_preserves_circuit: true,
    lifecycle_preserves_delivery_counts: true,
    historical_restrictions_visible: true,
  });
  const historyBeforeReplay = (
    await db.query("SELECT * FROM campaign_history ORDER BY id")
  ).rows;
  await db.exec(circuitMigration);
  assert.deepEqual(
    (await db.query("SELECT * FROM campaign_history ORDER BY id")).rows,
    historyBeforeReplay,
  );
  assert.deepEqual(await readCanonicalOwners(), ownersBefore);
  assert.deepEqual(await recipientProbe(), recipientContractAfter);
  checks++;

  // A drifted production prerequisite must abort before installing a trigger.
  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  await db.exec(
    extractFunction(
      admissionInner,
      "admit_bulk_campaign_non_idempotent",
    ).replace("$function$", "$function$\n-- unreviewed drift"),
  );
  await assert.rejects(
    db.exec(circuitMigration),
    /requires the verified 33-argument admission contract/,
  );
  assert.equal((await contract()).message_trigger_enabled, false);
  await db.exec(
    extractFunction(admissionInner, "admit_bulk_campaign_non_idempotent"),
  );
  await db.exec(circuitMigration);
  assert.equal((await contract()).message_trigger_enabled, true);
  checks++;
  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  assert.equal((await contract()).message_trigger_enabled, false);
  await db.exec(
    "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  await db.exec(extractFunction(safety, "update_bulk_campaign_progress"));
  assert.equal((await contract()).lifecycle_preserves_delivery_counts, false);
  await db.exec(
    extractFunction(ledger, "get_bulk_campaign_delivery_counts_batch"),
  );
  assert.equal((await contract()).historical_restrictions_visible, false);
  checks++;

  // Retry-chain regression: local suppression must not hide the original
  // provider restriction, even when SQL admission is called directly.
  await db.exec(circuitMigration);
  const localRetry = await createCampaign(1);
  await seedMessage(localRetry, "failed");
  await db.query(
    "UPDATE campaign_messages SET recipient='fixture-recipient',recipient_hash=$2,snapshot_ordinal=0,failure_reason=$3 WHERE campaign_id=$1",
    [
      localRetry,
      "c".repeat(64),
      JSON.stringify({
        providerCode: "contact_frequency_limit",
        providerScope: "provider",
      }),
    ],
  );
  await db.query(
    "UPDATE campaign_history SET dispatch_status='failed',retry_of_campaign_id=$2 WHERE id=$1",
    [localRetry, admissionSource],
  );
  const ancestryMigration = await readMigration(
    "20260915192220_campaign_retry_ancestor_provider_circuit.sql",
  );
  await db.exec(ancestryMigration);
  const ancestryQuotaChild = await freshId();
  assert.equal(
    (
      await admit(null, {
        ...standalone,
        p_campaign_id: ancestryQuotaChild,
        p_expected_subscription_type: "free",
      })
    ).code,
    "company_plan_changed",
  );
  assert.equal(
    (
      await admit(null, {
        ...standalone,
        p_campaign_id: ancestryQuotaChild,
        p_company_bulk_campaign_limit: 0,
      })
    ).code,
    "company_bulk_campaign_limit_exceeded",
  );
  assert.equal(await readCampaign(ancestryQuotaChild), undefined);
  checks++;
  await assert.rejects(
    admit(null, {
      ...standalone,
      p_campaign_id: collapsedChild,
      p_retry_of_campaign_id: limitedChild,
      p_retry_kind: "failed_only",
      p_audience_source_type: "retry",
    }),
    /retry candidate must exactly match current failed snapshot multiset/,
  );
  assert.equal(await readCampaign(collapsedChild), undefined);
  checks++;
  const nestedChild = await freshId();
  const nestedArgs = {
    p_campaign_id: nestedChild,
    p_retry_of_campaign_id: localRetry,
    p_audience_fingerprint: "b".repeat(64),
  };
  assert.equal(
    (await admit(null, nestedArgs)).code,
    "provider_circuit_acknowledgement_required",
    "SQL admission must preserve inherited Meta restriction",
  );
  checks++;
  assert.equal(await readCampaign(nestedChild), undefined);
  assert.equal((await admit(workspace, nestedArgs)).status, "admitted");
  const nested = await readCampaign(nestedChild);
  assert.equal(nested.provider_circuit_acknowledged_by, workspace);
  assert.ok(nested.provider_circuit_acknowledged_at);
  assert.equal((await admit(null, nestedArgs)).idempotent_replay, true);
  assert.deepEqual(
    (await readCampaign(nestedChild)).provider_circuit_acknowledged_at,
    nested.provider_circuit_acknowledged_at,
  );
  checks++;
  const ancestorCircuit = async (id) =>
    (
      await db.query(
        "SELECT resolve_campaign_retry_ancestor_circuit($1,$2) AS result",
        [workspace, id],
      )
    ).rows[0].result;
  assert.deepEqual(
    await ancestorCircuit(nestedChild),
    { state: "closed" },
    "Persisted acknowledgment stops older inherited warnings",
  );
  const laterLocal = await createCampaign(1);
  await db.query(
    "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
    [laterLocal, nestedChild],
  );
  assert.deepEqual(await ancestorCircuit(laterLocal), { state: "closed" });
  // An acknowledged campaign's own later restriction is still authoritative.
  await db.query(
    "UPDATE campaign_history SET provider_circuit_state='open',provider_circuit_provider='meta',provider_circuit_code='131042',provider_circuit_opened_at=now() WHERE id=$1",
    [nestedChild],
  );
  assert.deepEqual(await ancestorCircuit(laterLocal), {
    state: "open",
    provider: "meta",
    code: "131042",
    failure_count: 0,
  });
  checks++;
  const secondLocal = await createCampaign(1);
  await db.query(
    "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
    [secondLocal, localRetry],
  );
  assert.deepEqual(await ancestorCircuit(secondLocal), {
    state: "open",
    provider: "meta",
    code: "131048",
    failure_count: 1,
  });
  assert.equal(
    (await readCampaign(admissionSource)).provider_circuit_state,
    "closed",
    "Read-time inheritance does not rewrite historical campaigns",
  );
  checks++;
  for (const [label, change, expected] of [
    [
      "cycle",
      async (id) =>
        db.query(
          "UPDATE campaign_history SET retry_of_campaign_id=$1 WHERE id=$1",
          [id],
        ),
      /cyclic/,
    ],
    [
      "missing",
      async (id) =>
        db.query(
          "UPDATE campaign_history SET retry_of_campaign_id=gen_random_uuid() WHERE id=$1",
          [id],
        ),
      /unavailable/,
    ],
    [
      "foreign workspace",
      async (id) => {
        const foreign = await createCampaign();
        await db.query(
          "UPDATE campaign_history SET workspace_id=gen_random_uuid() WHERE id=$1",
          [foreign],
        );
        await db.query(
          "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
          [id, foreign],
        );
      },
      /unavailable/,
    ],
    [
      "different channel",
      async (id) => {
        const foreign = await createCampaign();
        await db.query(
          "UPDATE campaign_history SET channel='email' WHERE id=$1",
          [foreign],
        );
        await db.query(
          "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
          [id, foreign],
        );
      },
      /different channel/,
    ],
    [
      "partial acknowledgment",
      async (id) =>
        db.query(
          "UPDATE campaign_history SET provider_circuit_acknowledged_by=$2 WHERE id=$1",
          [id, workspace],
        ),
      /acknowledgment is malformed/,
    ],
    [
      "infinite acknowledgment",
      async (id) =>
        db.query(
          "UPDATE campaign_history SET provider_circuit_acknowledged_by=$2,provider_circuit_acknowledged_at='infinity' WHERE id=$1",
          [id, workspace],
        ),
      /acknowledgment is malformed/,
    ],
  ]) {
    const invalid = await createCampaign();
    await change(invalid);
    await assert.rejects(ancestorCircuit(invalid), expected, label);
    checks++;
  }
  const boundedSource = await createCampaign();
  let previousAncestor = boundedSource;
  for (let index = 0; index < 20; index++) {
    const ancestor = await createCampaign();
    await db.query(
      "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
      [previousAncestor, ancestor],
    );
    previousAncestor = ancestor;
  }
  assert.deepEqual(await ancestorCircuit(boundedSource), { state: "closed" });
  const tooDeep = await createCampaign();
  await db.query(
    "UPDATE campaign_history SET retry_of_campaign_id=$2 WHERE id=$1",
    [previousAncestor, tooDeep],
  );
  await assert.rejects(ancestorCircuit(boundedSource), /depth limit/);
  checks++;
  assert.deepEqual(await contract(), {
    ...(await contract()),
    retry_ancestry_enforced: true,
  });
  const ancestryRecipientContract = await recipientProbe();
  assert.deepEqual(
    {
      ...ancestryRecipientContract,
      admission_inner_md5: recipientContractAfter.admission_inner_md5,
    },
    recipientContractAfter,
  );
  assert.deepEqual(await readCanonicalOwners(), ownersBefore);
  const ancestryOwners = (
    await db.query(
      "SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon_execute,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated_execute,has_function_privilege('service_role',oid,'EXECUTE') AS service_execute FROM pg_proc WHERE oid=to_regprocedure('public.resolve_campaign_retry_ancestor_circuit(uuid,uuid)')",
    )
  ).rows[0];
  assert.deepEqual(ancestryOwners, {
    prosecdef: false,
    proconfig: ['search_path=""'],
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
  });
  checks++;
  const ancestryHistory = (
    await db.query("SELECT * FROM campaign_history ORDER BY id")
  ).rows;
  await db.exec(ancestryMigration);
  assert.deepEqual(
    (await db.query("SELECT * FROM campaign_history ORDER BY id")).rows,
    ancestryHistory,
  );
  assert.equal((await contract()).retry_ancestry_enforced, true);
  checks++;
  await db.exec(
    "GRANT EXECUTE ON FUNCTION public.resolve_campaign_retry_ancestor_circuit(uuid,uuid) TO anon",
  );
  assert.equal((await contract()).retry_ancestry_enforced, false);
  await db.exec(
    "REVOKE EXECUTE ON FUNCTION public.resolve_campaign_retry_ancestor_circuit(uuid,uuid) FROM anon",
  );
  const helperDefinition = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.resolve_campaign_retry_ancestor_circuit(uuid,uuid)')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(
    helperDefinition.replace(
      "cardinality(v_ids) >= 20",
      "cardinality(v_ids) >= 21",
    ),
  );
  assert.equal((await contract()).retry_ancestry_enforced, false);
  await db.exec(ancestryMigration);
  assert.equal((await contract()).retry_ancestry_enforced, true);
  checks++;

  const senderPolicyMigration = await readMigration(
    "20260918165905_campaign_sender_policy_error_scope.sql",
  );
  const beforeSenderPolicyContract = await contract();
  const beforeSenderPolicyHistory = (
    await db.query("SELECT * FROM campaign_history ORDER BY id")
  ).rows;
  await db.exec(senderPolicyMigration);
  assert.deepEqual(await contract(), {
    ...beforeSenderPolicyContract,
    sender_policy_errors_classified: true,
  });
  assert.deepEqual(await recipientProbe(), ancestryRecipientContract);
  assert.deepEqual(await readCanonicalOwners(), ownersBefore);
  assert.deepEqual(
    (await db.query("SELECT * FROM campaign_history ORDER BY id")).rows,
    beforeSenderPolicyHistory,
  );
  checks++;
  for (const code of [131063, 131064]) {
    assert.equal(
      (
        await db.query(
          "SELECT resolve_bulk_campaign_failure_scope('meta',$1,NULL,NULL) AS scope",
          [code],
        )
      ).rows[0].scope,
      "provider",
    );
    const senderPolicySource = await createCampaign();
    await seedMessage(senderPolicySource);
    await db.query(
      "UPDATE campaign_messages SET recipient='policy-recipient',recipient_hash=$2,snapshot_ordinal=0 WHERE campaign_id=$1",
      [senderPolicySource, "7".repeat(64)],
    );
    await failMessage(senderPolicySource, code);
    assert.equal(
      (await readCampaign(senderPolicySource)).provider_circuit_state,
      "open",
    );
    assert.equal(
      (await readCampaign(senderPolicySource)).provider_circuit_code,
      String(code),
    );
    const policyCounts = (await deliveryCounts(senderPolicySource))[0];
    assert.equal(policyCounts.common_provider_failure_code, String(code));
    assert.equal(policyCounts.retryable_failed_recipient_count, 1);
    await db.query(
      "UPDATE campaign_history SET dispatch_status='completed' WHERE id=$1",
      [senderPolicySource],
    );
    const policyRetry = {
      p_campaign_id: await freshId(),
      p_retry_of_campaign_id: senderPolicySource,
      p_audience_fingerprint: String(code).repeat(11).slice(0, 64),
      p_messages: JSON.stringify([
        {
          recipient: "policy-recipient",
          recipient_hash: "7".repeat(64),
          snapshot_ordinal: 0,
          dispatch_snapshot: {},
        },
      ]),
    };
    assert.equal(
      (await admit(null, policyRetry)).code,
      "provider_circuit_acknowledgement_required",
    );
    assert.equal(await readCampaign(policyRetry.p_campaign_id), undefined);
    assert.equal((await admit(workspace, policyRetry)).status, "admitted");
    checks++;
  }
  const senderPolicyAcl = (
    await db.query(
      "SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon_execute,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated_execute,has_function_privilege('service_role',oid,'EXECUTE') AS service_execute FROM pg_proc WHERE oid=to_regprocedure('public.resolve_bulk_campaign_failure_scope(text,integer,text,text)')",
    )
  ).rows[0];
  assert.deepEqual(senderPolicyAcl, {
    prosecdef: false,
    proconfig: ['search_path=""'],
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
  });
  checks++;
  const beforeSenderPolicyReplay = (
    await db.query("SELECT * FROM campaign_history ORDER BY id")
  ).rows;
  await db.exec(senderPolicyMigration);
  assert.deepEqual(
    (await db.query("SELECT * FROM campaign_history ORDER BY id")).rows,
    beforeSenderPolicyReplay,
  );
  checks++;
  const senderClassifierDefinition = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.resolve_bulk_campaign_failure_scope(text,integer,text,text)')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(senderClassifierDefinition.replace("'131063'", "'991063'"));
  assert.equal((await contract()).sender_policy_errors_classified, false);
  await assert.rejects(
    db.exec(senderPolicyMigration),
    /requires? the verified campaign failure classifier/,
  );
  await db.exec(senderClassifierDefinition);
  assert.equal((await contract()).sender_policy_errors_classified, true);
  checks++;
  const senderContractDefinition = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.get_campaign_provider_circuit_contract()')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(senderContractDefinition.replace("131064", "991064"));
  await assert.rejects(
    db.exec(senderPolicyMigration),
    /requires? the verified retry ancestry contract/,
  );
  await db.exec(senderContractDefinition);
  checks++;

  // recent_contact: the admission ledger accepts, sums and stores the new
  // skip reason, and both contracts re-pin the patched definition.
  const recentContactMigration = await readMigration(
    "20261019092828_campaign_recent_contact_skip_reason.sql",
  );
  const contractAcls = async () =>
    (
      await db.query(
        "SELECT proname, proacl::text, prosecdef, proconfig FROM pg_proc WHERE oid IN (to_regprocedure('public.get_campaign_provider_circuit_contract()'), to_regprocedure('public.get_campaign_recipient_delivery_state_contract()')) ORDER BY proname",
      )
    ).rows;
  const recentContactAdmission = (skippedByReason) => ({
    p_retry_of_campaign_id: null,
    p_retry_kind: null,
    p_audience_source_type: "manual",
    p_audience_fingerprint: "1".repeat(64),
    p_audience_metadata: JSON.stringify({
      policy: { version: 1, excludePriorFailedBulkSends: false },
      authoritativeRecipientLimit: {
        source: "live_meta",
        value: 1000,
        rawLimit: "TIER_1K",
      },
      outcome: {
        evaluatedAt: "2026-10-19T08:00:00.000Z",
        requestedTotal: 3,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 3, accepted: 1 },
        skippedByReason,
        warnings: { missingMarketingConsent: 0 },
      },
      batchPlan: {
        batchSize: 20,
        delayMs: 334,
        ratePerSecond: 60,
        rateSource: "channel_default",
      },
      requestDigest: { version: 1, digest: "9".repeat(64) },
    }),
    p_messages: JSON.stringify([
      {
        recipient: "fixture-recent-contact",
        recipient_hash: "2".repeat(64),
        snapshot_ordinal: 0,
        dispatch_snapshot: {},
      },
    ]),
  });
  const admitRecentContact = async (skippedByReason) => {
    const id = await freshId();
    const args = {
      ...recentContactAdmission(skippedByReason),
      p_campaign_id: id,
    };
    return { id, result: await admit(null, args) };
  };
  const beforeRecentContactContract = await contract();
  const beforeRecentContactRecipientContract = await recipientProbe();
  const beforeRecentContactAcls = await contractAcls();
  assert.equal(beforeRecentContactContract.retry_ancestry_enforced, true);
  assert.equal(
    beforeRecentContactContract.recent_contact_skip_admitted,
    undefined,
  );
  // Before the migration the ledger leaves recent_contact out of the sum.
  await assert.rejects(
    admitRecentContact({ recent_contact: 2 }),
    /outcome aggregates do not match the admitted audience/,
  );
  checks++;
  await db.exec(recentContactMigration);
  assert.deepEqual(await contract(), {
    ...beforeRecentContactContract,
    recent_contact_skip_admitted: true,
  });
  const recentContactRecipientContract = await recipientProbe();
  assert.equal(
    recentContactRecipientContract.admission_metadata_projection_exact,
    true,
  );
  assert.notEqual(
    recentContactRecipientContract.admission_inner_md5,
    beforeRecentContactRecipientContract.admission_inner_md5,
  );
  assert.deepEqual(
    {
      ...recentContactRecipientContract,
      admission_inner_md5:
        beforeRecentContactRecipientContract.admission_inner_md5,
    },
    beforeRecentContactRecipientContract,
    "Every recipient contract field survives except the patched inner body hash",
  );
  assert.deepEqual(await readCanonicalOwners(), ownersBefore);
  assert.deepEqual(await contractAcls(), beforeRecentContactAcls);
  checks++;
  const recentAdmission = await admitRecentContact({ recent_contact: 2 });
  assert.equal(recentAdmission.result.status, "admitted");
  assert.deepEqual(
    (await readCampaign(recentAdmission.id)).audience_metadata.outcome
      .skippedByReason,
    { recent_contact: 2 },
  );
  checks++;
  await assert.rejects(
    admitRecentContact({ recent_contact: 1 }),
    /outcome aggregates do not match the admitted audience/,
  );
  await assert.rejects(
    admitRecentContact({ recent_contact: 2.5 }),
    /skipped counts must be integers between 0 and 50000/,
  );
  checks++;
  // A second run finds the patched definition and refuses to touch it.
  await assert.rejects(
    db.exec(recentContactMigration),
    /recent_contact requires the verified bulk campaign admission definition/,
  );
  assert.equal((await contract()).recent_contact_skip_admitted, true);
  checks++;

  // The production admission, kept for the delivery counts checks below.
  const productionAdmission = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.admit_bulk_campaign_non_idempotent(uuid,uuid,text,text,text,text,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,integer,jsonb,text,timestamptz,uuid,text,jsonb,uuid,text,text,integer,uuid,text,jsonb)')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(
    extractFunction(admissionInner, "admit_bulk_campaign_non_idempotent"),
  );
  await assert.rejects(
    db.exec(ancestryMigration),
    /requires the verified 33-argument admission contract/,
  );
  checks++;

  // Meta 130429: dispatch resends throughput rejections, so a leftover row
  // must not latch the campaign circuit. Every other provider code still does.
  const throughputMigration = await readMigration(
    "20261019182935_campaign_throughput_error_not_latched.sql",
  );
  const readLatchMd5 = async () =>
    (
      await db.query(
        "SELECT md5(regexp_replace(pg_get_functiondef(to_regprocedure('public.latch_campaign_message_provider_circuit()')), '\\s+', ' ', 'g')) AS md5",
      )
    ).rows[0].md5;
  assert.equal(
    await readLatchMd5(),
    "8c60a9b543d81db4207709568d13c29b",
    "The harness latch matches the verified production latch",
  );
  checks++;
  const verifiedLatch = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.latch_campaign_message_provider_circuit()')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(
    verifiedLatch.replace(
      "stop_reason = coalesce(stop_reason, 'provider_circuit_open')",
      "stop_reason = coalesce(stop_reason, 'provider_circuit_opened')",
    ),
  );
  await assert.rejects(
    db.exec(throughputMigration),
    /requires the verified provider circuit latch/,
  );
  await db.exec(verifiedLatch);
  checks++;
  const readCircuitProbe = async () =>
    (
      await db.query(
        "SELECT get_campaign_provider_circuit_contract() AS result",
      )
    ).rows[0].result;
  const readLatchAcl = async () =>
    (
      await db.query(
        "SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute, has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure('public.latch_campaign_message_provider_circuit()')",
      )
    ).rows[0];
  const probeBefore = await readCircuitProbe();
  const aclBefore = await readLatchAcl();
  await db.exec(throughputMigration);
  const throughputLatchMd5 = await readLatchMd5();
  assert.ok(
    throughputMigration.includes(`'${throughputLatchMd5}'`),
    `The migration pins its own latch (${throughputLatchMd5}) so a replay is accepted`,
  );
  await db.exec(throughputMigration);
  assert.equal(await readLatchMd5(), throughputLatchMd5);
  assert.deepEqual(
    await readCircuitProbe(),
    probeBefore,
    "The deployment probe reports the same circuit contract",
  );
  assert.deepEqual(await readLatchAcl(), aclBefore);
  assert.equal(aclBefore.anon_execute, false);
  assert.equal(aclBefore.authenticated_execute, false);
  assert.equal(aclBefore.service_execute, true);
  checks++;
  const throttled = await createCampaign();
  await seedMessage(throttled);
  await failMessage(throttled, 130429);
  const throttledRow = await readCampaign(throttled);
  assert.equal(
    throttledRow.provider_circuit_state,
    "closed",
    "A leftover 130429 must not latch the campaign circuit",
  );
  assert.equal(throttledRow.stop_reason, null);
  const restricted = await createCampaign();
  await seedMessage(restricted);
  await failMessage(restricted, 131048);
  const restrictedRow = await readCampaign(restricted);
  assert.equal(restrictedRow.provider_circuit_state, "open");
  assert.equal(restrictedRow.provider_circuit_code, "131048");
  checks++;

  // A leftover 130429 stays retryable, but the delivery counts must not report
  // it as a Meta restriction: not in the status, not for retry admission and
  // not through retry ancestry. Every other provider code still does.
  const countsMigration = await readMigration(
    "20261020140817_campaign_throughput_error_not_restriction.sql",
  );
  // An earlier guard check replaced admission with an older definition.
  await db.exec(productionAdmission);
  assert.equal(await readLatchMd5(), "eb7c1633a3bfc495ae1c01a182dbc653");
  assert.ok(
    Object.entries(await readCircuitProbe()).every(
      ([key, value]) => key === "version" || value === true,
    ),
    "Every production circuit contract field holds before the change",
  );
  const readCountsMd5 = async () =>
    (
      await db.query(
        "SELECT md5(regexp_replace(pg_get_functiondef(to_regprocedure('public.get_bulk_campaign_delivery_counts_batch(uuid,uuid[])')), '\\s+', ' ', 'g')) AS md5",
      )
    ).rows[0].md5;
  assert.equal(
    await readCountsMd5(),
    "0abfd35faaa71d61cb7e04b85f302b69",
    "The harness delivery counts match the verified production counts",
  );
  checks++;
  const verifiedCounts = (
    await db.query(
      "SELECT pg_get_functiondef(to_regprocedure('public.get_bulk_campaign_delivery_counts_batch(uuid,uuid[])')) AS definition",
    )
  ).rows[0].definition;
  await db.exec(
    verifiedCounts.replace(
      "Reuse the scoped ledger scan",
      "Reuse the scoped ledger read",
    ),
  );
  await assert.rejects(
    db.exec(countsMigration),
    /requires the verified delivery counts/,
  );
  await db.exec(verifiedCounts);
  checks++;

  await db.exec(
    "ALTER TABLE campaign_messages DISABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const throttledSource = await createCampaign();
  await seedMessage(throttledSource);
  await db.query(
    "UPDATE campaign_messages SET recipient='fixture-recipient',recipient_hash=$2,snapshot_ordinal=0,dispatch_snapshot='{}'::jsonb WHERE campaign_id=$1",
    [throttledSource, "c".repeat(64)],
  );
  await failMessage(throttledSource, 130429);
  await seedMessage(throttledSource, "delivered", "-delivered");
  await db.query(
    "UPDATE campaign_history SET dispatch_status='completed' WHERE id=$1",
    [throttledSource],
  );
  const mixedSource = await createCampaign(4);
  await db.query(
    "INSERT INTO campaign_messages(campaign_id,message_id,status,error_code,dispatch_snapshot) SELECT $1,gen_random_uuid()::text,'failed',code,'{}'::jsonb FROM unnest(ARRAY[130429,130429,131048]) AS code",
    [mixedSource],
  );
  await db.exec(
    "ALTER TABLE campaign_messages ENABLE TRIGGER campaign_messages_latch_provider_circuit",
  );
  const throttledRetry = await freshId();
  await db.query(
    "INSERT INTO campaign_history(id,workspace_id,total_recipients,not_attempted_count,retry_of_campaign_id) VALUES($1,$2,1,1,$3)",
    [throttledRetry, workspace, throttledSource],
  );
  const throttledArgs = {
    p_campaign_id: await freshId(),
    p_retry_of_campaign_id: throttledSource,
    p_audience_fingerprint: "e".repeat(64),
  };
  // Before: the leftover 130429 reads as an open Meta restriction.
  assert.equal(
    (await deliveryCounts(throttledSource))[0].common_provider_failure_code,
    "130429",
  );
  assert.equal((await ancestorCircuit(throttledRetry)).state, "open");
  assert.equal(
    (await admit(null, throttledArgs)).code,
    "provider_circuit_acknowledgement_required",
  );
  checks++;

  const probeBeforeCounts = await readCircuitProbe();
  const countsAcl = async () =>
    (
      await db.query(
        "SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute, has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_bulk_campaign_delivery_counts_batch(uuid,uuid[])')",
      )
    ).rows[0];
  await db.exec(countsMigration);
  const countsMd5 = await readCountsMd5();
  assert.ok(
    countsMigration.includes(`'${countsMd5}'`),
    `The migration pins its own delivery counts (${countsMd5}) so a replay is accepted`,
  );
  await db.exec(countsMigration);
  assert.equal(await readCountsMd5(), countsMd5);
  assert.deepEqual(
    await readCircuitProbe(),
    probeBeforeCounts,
    "The deployment probe reports the same circuit contract",
  );
  assert.equal(probeBeforeCounts.historical_restrictions_visible, true);
  // The same service-only ACL and invoker settings production reports.
  assert.deepEqual(await countsAcl(), {
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
    prosecdef: false,
    proconfig: ['search_path=""'],
  });
  checks++;

  // After: no restriction, still one retryable recipient, no acknowledgment.
  const [throttledCounts] = await deliveryCounts(throttledSource);
  assert.equal(throttledCounts.common_provider_failure_provider, null);
  assert.equal(throttledCounts.common_provider_failure_code, null);
  assert.equal(throttledCounts.common_provider_failure_count, 0);
  assert.equal(throttledCounts.retryable_failed_recipient_count, 1);
  assert.equal(throttledCounts.failed, 1);
  assert.deepEqual(await ancestorCircuit(throttledRetry), { state: "closed" });
  const admittedThrottled = await admit(null, throttledArgs);
  assert.equal(admittedThrottled.status, "admitted");
  assert.equal(
    (await readCampaign(throttledArgs.p_campaign_id)).provider_circuit_state,
    "closed",
  );
  checks++;
  // A real restriction is still reported even when 130429 rows outnumber it.
  const [mixedCounts] = await deliveryCounts(mixedSource);
  assert.equal(mixedCounts.common_provider_failure_provider, "meta");
  assert.equal(mixedCounts.common_provider_failure_code, "131048");
  assert.equal(mixedCounts.common_provider_failure_count, 1);
  assert.equal(mixedCounts.retryable_failed_recipient_count, 3);
  checks++;

  // Free plans: 500 bulk recipients in total instead of two campaigns. Usage
  // is one function shared by admission, the scenario run reservation and the
  // app; the allowance migration patches both owners and re-pins the contracts.
  const usageMigration = await readMigration(
    "20261023023011_company_bulk_recipient_usage.sql",
  );
  const allowanceMigration = await readMigration(
    "20261023043335_free_bulk_recipient_allowance.sql",
  );
  const admissionSignature =
    "public.admit_bulk_campaign_non_idempotent(uuid,uuid,text,text,text,text,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text,text,text,integer,jsonb,text,timestamptz,uuid,text,jsonb,uuid,text,text,integer,uuid,text,jsonb)";
  const reserveSignature =
    "public.reserve_scenario_campaign_history(uuid,text,text,text,text,text,integer,uuid,text,text,text,text,text,integer,timestamptz,timestamptz)";
  const readDefinition = async (signature) =>
    (
      await db.query(
        "SELECT pg_get_functiondef(to_regprocedure($1)) AS definition",
        [signature],
      )
    ).rows[0].definition;
  const readFunctionMd5 = async (signature) =>
    (
      await db.query(
        "SELECT md5(regexp_replace(pg_get_functiondef(to_regprocedure($1)), '\\s+', ' ', 'g')) AS md5",
        [signature],
      )
    ).rows[0].md5;
  const readAcl = async (signature) =>
    (
      await db.query(
        "SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute, has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute, has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure($1)",
        [signature],
      )
    ).rows[0];
  const serviceOnly = {
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
    prosecdef: false,
    proconfig: ['search_path=""'],
  };
  // recent_contact ran first, as it did on production.
  assert.equal(
    await readFunctionMd5(admissionSignature),
    "a83e198ac2ca671de16397c7879ff5bf",
    "The harness admission matches the admission since recent_contact",
  );
  checks++;

  // The 16-argument reservation lives only in production before this change.
  // Rebuild it from the migration's own body with the campaign count block
  // put back; the hash proves it is the production definition.
  await db.exec(`
    ALTER TABLE campaign_history ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE campaign_history ADD COLUMN execution_run_key text;
    CREATE UNIQUE INDEX campaign_history_scenario_run_uidx
      ON campaign_history (workspace_id, scenario_id, scenario_node_id, execution_source, execution_run_key)
      WHERE execution_run_key IS NOT NULL;
  `);
  const campaignCountBlock = `  if p_company_bulk_campaign_limit is not null then
    select count(*)::integer
    into v_company_bulk_campaign_count
    from (
      select 1
      from public.campaign_history history
      join public.workspaces history_workspace
        on history_workspace.id = history.workspace_id
      where history_workspace.company_id = v_company_id
        and (
          history.bulk_quota_reserved_at is not null
          or coalesce(history.successful_sends, 0) > 0
          or (
            history.total_recipients > 0
            and coalesce(history.failed_sends, 0) < history.total_recipients
          )
        )
      limit p_company_bulk_campaign_limit
    ) counted_history;

    if v_company_bulk_campaign_count >= p_company_bulk_campaign_limit then
      return jsonb_build_object(
        'status', 'blocked',
        'code', 'company_bulk_campaign_limit_exceeded',
        'retryable', false,
        'company_bulk_campaign_limit', p_company_bulk_campaign_limit,
        'company_bulk_campaign_count', v_company_bulk_campaign_count
      );
    end if;
  end if;
`;
  const allowanceReservation = extractFunction(
    allowanceMigration.replace(/\r\n/g, "\n"),
    "reserve_scenario_campaign_history",
  );
  const allowanceBlockStart = allowanceReservation.indexOf(
    "  -- The plan's bulk recipient allowance.",
  );
  const allowanceBlockEnd =
    allowanceReservation.indexOf(
      "\n  end if;\n",
      allowanceReservation.indexOf(
        "'company_bulk_recipient_count'",
        allowanceBlockStart,
      ),
    ) + "\n  end if;\n".length;
  assert.ok(allowanceBlockStart > 0 && allowanceBlockEnd > allowanceBlockStart);
  const productionReservation =
    allowanceReservation.slice(0, allowanceBlockStart) +
    campaignCountBlock +
    allowanceReservation.slice(allowanceBlockEnd);
  await db.exec(productionReservation);
  await db.exec(
    `REVOKE EXECUTE ON FUNCTION ${reserveSignature} FROM public, anon, authenticated; GRANT EXECUTE ON FUNCTION ${reserveSignature} TO service_role;`,
  );
  assert.equal(
    await readFunctionMd5(reserveSignature),
    "87a72a35d0a23bae4b28bdd52a44da07",
    "The rebuilt reservation is the verified production reservation",
  );
  checks++;

  // The allowance needs the usage function first, and refuses drifted owners.
  await assert.rejects(
    db.exec(allowanceMigration),
    /requires get_company_bulk_recipient_usage/,
  );
  await db.exec(usageMigration);
  await db.exec(usageMigration);
  assert.deepEqual(
    await readAcl("public.get_company_bulk_recipient_usage(uuid[])"),
    serviceOnly,
  );
  checks++;
  await db.exec(
    productionReservation.replace(
      "'company bulk campaign limit must be non-negative or null'",
      "'company bulk campaign limit must not be negative'",
    ),
  );
  await assert.rejects(
    db.exec(allowanceMigration),
    /requires the verified scenario campaign reservation/,
  );
  await db.exec(productionReservation);
  const repositoryAdmission = await readDefinition(admissionSignature);
  await db.exec(
    repositoryAdmission.replace(
      "'company_bulk_campaign_limit_exceeded'",
      "'company_bulk_campaign_quota_exceeded'",
    ),
  );
  await assert.rejects(
    db.exec(allowanceMigration),
    /requires the verified bulk campaign admission definition/,
  );
  await db.exec(repositoryAdmission);
  assert.equal(
    await readFunctionMd5(reserveSignature),
    "87a72a35d0a23bae4b28bdd52a44da07",
  );
  checks++;

  // Usage: in-flight campaigns hold their audience minus failures; finished
  // ones keep what they sent, on every channel. Other companies never count.
  const freeCompany = "22222222-2222-4222-8222-222222222222";
  const freeWorkspace = "22222222-2222-4222-8222-222222222222";
  const emptyCompany = "33333333-3333-4333-8333-333333333333";
  await db.query("INSERT INTO companies VALUES ($1,'free'),($2,'free')", [
    freeCompany,
    emptyCompany,
  ]);
  await db.query("INSERT INTO workspaces VALUES ($1,$2)", [
    freeWorkspace,
    freeCompany,
  ]);
  const readUsage = async (...companies) =>
    (
      await db.query(
        "SELECT company_id, used_recipients FROM get_company_bulk_recipient_usage($1::uuid[]) ORDER BY company_id",
        [companies],
      )
    ).rows;
  const insertHistory = (status, total, failed, notAttempted) =>
    db.query(
      "INSERT INTO campaign_history(id,workspace_id,channel,dispatch_status,total_recipients,failed_sends,not_attempted_count,audience_fingerprint) VALUES(gen_random_uuid(),$1,'email',$2,$3,$4,$5,NULL)",
      [freeWorkspace, status, total, failed, notAttempted],
    );
  assert.deepEqual(await readUsage(freeCompany, emptyCompany, null), [
    { company_id: freeCompany, used_recipients: 0 },
    { company_id: emptyCompany, used_recipients: 0 },
  ]);
  await insertHistory("completed", 10, 3, 2); // sent 5
  await insertHistory("cancelled", 8, 1, 6); // sent 1
  await insertHistory("expired", 4, 0, 4); // sent 0
  await insertHistory("running", 7, 2, 5); // holds 5
  await insertHistory("queued", 6, 0, 6); // holds 6
  await insertHistory("scheduled", 3, 0, 3); // holds 3
  await insertHistory("failed", 9, 9, 0); // sent 0
  assert.deepEqual(await readUsage(freeCompany), [
    { company_id: freeCompany, used_recipients: 20 },
  ]);
  checks++;

  const providerProbeBeforeAllowance = await readCircuitProbe();
  const deliveryProbeBeforeAllowance = await recipientProbe();
  const admissionAclBefore = await readAcl(admissionSignature);
  await db.exec(allowanceMigration);
  const allowanceAdmissionMd5 = await readFunctionMd5(admissionSignature);
  assert.ok(
    allowanceMigration.includes(`'${allowanceAdmissionMd5}'`),
    `The migration pins the patched admission (${allowanceAdmissionMd5})`,
  );
  const allowanceReserveMd5 = await readFunctionMd5(reserveSignature);
  assert.ok(
    allowanceMigration.includes(`'${allowanceReserveMd5}'`),
    `The migration pins its own reservation (${allowanceReserveMd5}) so a replay is accepted`,
  );
  assert.deepEqual(await readCircuitProbe(), providerProbeBeforeAllowance);
  assert.equal(providerProbeBeforeAllowance.retry_ancestry_enforced, true);
  // Only the reported admission body hash moves; every verified field holds.
  const deliveryProbeAfterAllowance = await recipientProbe();
  assert.notEqual(
    deliveryProbeAfterAllowance.admission_inner_md5,
    deliveryProbeBeforeAllowance.admission_inner_md5,
  );
  assert.deepEqual(
    { ...deliveryProbeAfterAllowance, admission_inner_md5: null },
    { ...deliveryProbeBeforeAllowance, admission_inner_md5: null },
  );
  assert.equal(
    deliveryProbeAfterAllowance.admission_metadata_projection_exact,
    true,
  );
  assert.deepEqual(await readAcl(admissionSignature), admissionAclBefore);
  assert.deepEqual(await readAcl(reserveSignature), serviceOnly);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS pins FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND position('a83e198ac2ca671de16397c7879ff5bf' in CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) END) > 0",
      )
    ).rows[0].pins,
    0,
  );
  checks++;
  await db.exec(allowanceMigration);
  assert.equal(
    await readFunctionMd5(admissionSignature),
    allowanceAdmissionMd5,
  );
  assert.equal(await readFunctionMd5(reserveSignature), allowanceReserveMd5);
  assert.deepEqual(await readCircuitProbe(), providerProbeBeforeAllowance);
  checks++;

  // Admission: used + this send's unique recipients must fit the allowance.
  const allowanceMessages = (prefix, hashes) =>
    JSON.stringify(
      hashes.map((hash, snapshot_ordinal) => ({
        recipient: `${prefix}-${hash}`,
        recipient_hash: hash.repeat(64),
        snapshot_ordinal,
        dispatch_snapshot: {},
      })),
    );
  const admitFree = async (limit, fingerprint, hashes) => {
    const id = await freshId();
    const result = await admit(null, {
      p_campaign_id: id,
      p_workspace_id: freeWorkspace,
      p_retry_of_campaign_id: null,
      p_retry_kind: null,
      p_audience_source_type: "manual",
      p_audience_fingerprint: fingerprint.repeat(64),
      p_audience_count: hashes.length,
      p_expected_subscription_type: "free",
      p_company_bulk_campaign_limit: limit,
      p_messages: allowanceMessages(fingerprint, hashes),
    });
    return { id, result };
  };
  // 20 used: 3 unique (4 items) fit an allowance of 23 exactly.
  const fitting = await admitFree(23, "1", ["a", "b", "a", "c"]);
  assert.equal(fitting.result.status, "admitted");
  assert.equal(fitting.result.item_count, 4);
  assert.equal(fitting.result.unique_recipient_count, 3);
  // The queued send now holds its 4 items: 24 used.
  assert.deepEqual(await readUsage(freeCompany), [
    { company_id: freeCompany, used_recipients: 24 },
  ]);
  const over = await admitFree(25, "2", ["d", "e"]);
  assert.deepEqual(
    {
      status: over.result.status,
      code: over.result.code,
      retryable: over.result.retryable,
      limit: over.result.company_bulk_campaign_limit,
      used: over.result.company_bulk_campaign_count,
      requested: over.result.company_bulk_recipient_count,
    },
    {
      status: "blocked",
      code: "company_bulk_campaign_limit_exceeded",
      retryable: false,
      limit: 25,
      used: 24,
      requested: 2,
    },
  );
  assert.equal(await readCampaign(over.id), undefined);
  assert.equal((await admitFree(25, "3", ["d"])).result.status, "admitted");
  checks++;
  // A finished send gives back what failed or was never attempted.
  await db.query(
    "UPDATE campaign_history SET dispatch_status='completed',failed_sends=1,not_attempted_count=2 WHERE id=$1",
    [fitting.id],
  );
  assert.deepEqual(await readUsage(freeCompany), [
    { company_id: freeCompany, used_recipients: 22 },
  ]);
  assert.equal((await admitFree(25, "4", ["e", "f"])).result.status, "admitted");
  assert.equal(
    (await admitFree(24, "5", ["0"])).result.code,
    "company_bulk_campaign_limit_exceeded",
  );
  // Unlimited plans pass no allowance and are never counted against one.
  assert.equal((await admitFree(null, "6", ["7", "8"])).result.status, "admitted");
  checks++;

  // Reservation: a run needs at least one recipient left before it counts its
  // audience; a stated total must fit.
  const reserve = async (limit, runKey, total = 0) =>
    (
      await db.query(
        "SELECT reserve_scenario_campaign_history($1,'Run','whatsapp','fixture','en',NULL,$4,NULL,'scenario','node','scenario_schedule',$2,'free',$3,now(),now()) AS result",
        [freeWorkspace, runKey, limit, total],
      )
    ).rows[0].result;
  const used = (await readUsage(freeCompany))[0].used_recipients;
  const reserved = await reserve(used + 1, "run-1");
  assert.equal(reserved.status, "ready");
  assert.equal(reserved.created, true);
  assert.ok((await readCampaign(reserved.campaign_id)).bulk_quota_reserved_at);
  // The placeholder holds nothing until the run reconciles its total.
  assert.equal((await readUsage(freeCompany))[0].used_recipients, used);
  assert.deepEqual(await reserve(used, "run-2"), {
    status: "blocked",
    code: "company_bulk_campaign_limit_exceeded",
    retryable: false,
    company_bulk_campaign_limit: used,
    company_bulk_campaign_count: used,
    company_bulk_recipient_count: 1,
  });
  assert.equal((await reserve(used + 2, "run-3", 3)).code, "company_bulk_campaign_limit_exceeded");
  assert.equal((await reserve(used + 3, "run-3", 3)).status, "ready");
  // A replayed run keeps its reservation even once the allowance is used up.
  assert.deepEqual(await reserve(0, "run-1"), {
    status: "ready",
    campaign_id: reserved.campaign_id,
    created: false,
  });
  assert.equal((await reserve(null, "run-4")).status, "ready");
  checks++;

  console.log(
    JSON.stringify({
      passed: true,
      checks,
      engine: "ephemeral PostgreSQL",
      productionWrites: 0,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      checks,
      error: error.message,
      detail: error.where,
    }),
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
