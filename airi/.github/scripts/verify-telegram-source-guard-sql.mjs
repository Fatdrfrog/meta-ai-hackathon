/** Executes the Telegram source guard migration in ephemeral PostgreSQL; never connects to a live database.
 * Pass an externally installed @electric-sql/pglite/dist/index.js path as argv[2].
 * --baseline skips the Telegram guard migration to show the checks fail without it.
 */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.argv[2])
  throw new Error("Usage: node .github/scripts/verify-telegram-source-guard-sql.mjs /path/to/@electric-sql/pglite/dist/index.js [--baseline]");
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const baseline = process.argv.includes("--baseline");
const root = fileURLToPath(new URL("../..", import.meta.url)).replaceAll("\\", "/");
const migration = file => readFile(`${root}/supabase/migrations/${file}`, "utf8");
const GUARD = "20261026210000_telegram_sources_server_managed.sql";

const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const COMPANY = "20000000-0000-4000-8000-000000000001";
const MEMBER = "30000000-0000-4000-8000-000000000001";
const envelope = { iv: "aXYtMTItYnl0ZXM=", tag: "dGFnLTE2LWJ5dGVzLWxvbmc=", ciphertext: "Y2lwaGVydGV4dA==" };

async function setup(seedPlainSecret = false) {
  const db = new PGlite();
  await db.exec(`
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.workspaces(id uuid PRIMARY KEY, company_id uuid);
  CREATE TABLE public.company_users(user_id uuid, workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE, role text);
  CREATE TABLE public.sources(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
    company_id uuid,
    type text CHECK (type = ANY (ARRAY['telegram','whatsapp','email','instagram','web_widget','teams','intercom','canva','higgsfield','elevenlabs','google_calendar','meta_ads','google_ai'])),
    name text,
    credentials jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz
  );
  ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
  -- Live policies on public.sources as of 2026-10-16.
  CREATE POLICY sources_insert_for_workspace_members ON public.sources FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = sources.workspace_id AND cu.user_id = (SELECT auth.uid())));
  CREATE POLICY sources_select_for_workspace_members ON public.sources FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = sources.workspace_id AND cu.user_id = (SELECT auth.uid())));
  CREATE POLICY sources_update_for_workspace_members ON public.sources FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = sources.workspace_id AND cu.user_id = (SELECT auth.uid())))
    WITH CHECK (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = sources.workspace_id AND cu.user_id = (SELECT auth.uid())));
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
  GRANT ALL ON public.sources TO anon, authenticated, service_role;
  GRANT SELECT ON public.workspaces, public.company_users TO authenticated;
  GRANT DELETE ON public.workspaces TO authenticated;
  `);
  await db.query("INSERT INTO workspaces VALUES ($1,$2)", [WORKSPACE, COMPANY]);
  await db.query("INSERT INTO company_users VALUES ($1,$2,'manager')", [MEMBER, WORKSPACE]);
  await db.query(
    "INSERT INTO sources(workspace_id,company_id,type,name,credentials) VALUES ($1,$2,'telegram','@airi_bot',$3::jsonb)",
    [WORKSPACE, COMPANY, JSON.stringify({ bot_token: envelope, bot_username: "airi_bot", webhook_secret_token: seedPlainSecret ? "plain-secret" : envelope })],
  );
  await db.query(
    "INSERT INTO sources(workspace_id,company_id,type,name,credentials) VALUES ($1,$2,'canva','Canva','{}'::jsonb)",
    [WORKSPACE, COMPANY],
  );
  for (const file of [
    "20260910181111_protect_source_commerce_credentials.sql",
    "20261018131759_guard_whatsapp_source_client_writes.sql",
    "20261026190000_telegram_bot_token_encrypted.sql",
  ])
    await db.exec(await migration(file));
  return db;
}

const results = {};

// VALIDATE refuses while a webhook secret is still plain text.
{
  const db = await setup(true);
  if (!baseline) await assert.rejects(db.exec(await migration(GUARD)), /sources_telegram_webhook_secret_check/);
  await db.close();
  results.refusesPlainWebhookSecret = true;
}

const db = await setup();
if (!baseline) await db.exec(await migration(GUARD));
const telegramId = (await db.query("SELECT id FROM sources WHERE type='telegram'")).rows[0].id;
const canvaId = (await db.query("SELECT id FROM sources WHERE type='canva'")).rows[0].id;
let checks = 0;
const denied = async (sql, params = [], pattern = /source_telegram_server_managed/) => {
  await assert.rejects(db.query(sql, params), pattern);
  checks++;
};
const allowed = async (sql, params = []) => {
  await db.query(sql, params);
  checks++;
};

for (const role of ["authenticated", "anon"]) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [role === "authenticated" ? MEMBER : ""]);
  await db.exec(`SET ROLE ${role}`);
  // BEFORE triggers run ahead of RLS checks, so anon hits the trigger too.
  await denied(
    "INSERT INTO sources(workspace_id,company_id,type,credentials) VALUES ($1,$2,'telegram',$3::jsonb)",
    [WORKSPACE, COMPANY, JSON.stringify({ bot_token: envelope })],
  );
  if (role === "anon") continue;
  for (const patch of [
    { webhook_secret_token: envelope },
    { bot_token: envelope },
    { ai_reactions_enabled: true },
  ]) {
    await denied("UPDATE sources SET credentials=credentials||$1::jsonb WHERE id=$2", [JSON.stringify(patch), telegramId]);
  }
  await denied("UPDATE sources SET credentials=credentials-'webhook_secret_token' WHERE id=$1", [telegramId]);
  await denied("UPDATE sources SET name='renamed' WHERE id=$1", [telegramId]);
  await denied("UPDATE sources SET type='web_widget' WHERE id=$1", [telegramId]);
  await denied("UPDATE sources SET type='telegram',credentials=$1::jsonb WHERE id=$2", [JSON.stringify({ bot_token: envelope }), canvaId]);
  // Live RLS has no member DELETE policy, so the row is filtered out first.
  assert.equal((await db.query("DELETE FROM sources WHERE id=$1", [telegramId])).affectedRows, 0);
  checks++;
  // Other source types keep their member-editable rows.
  await allowed("UPDATE sources SET name='Canva team' WHERE id=$1", [canvaId]);
  await allowed("INSERT INTO sources(workspace_id,company_id,type,credentials) VALUES ($1,$2,'web_widget','{}'::jsonb)", [WORKSPACE, COMPANY]);
  // Upserting onto a Telegram row hits the UPDATE branch.
  await denied(
    "INSERT INTO sources(id,workspace_id,company_id,type,credentials) VALUES ($1,$2,$3,'telegram',$4::jsonb) ON CONFLICT (id) DO UPDATE SET credentials=EXCLUDED.credentials",
    [telegramId, WORKSPACE, COMPANY, JSON.stringify({ bot_token: envelope })],
  );
}

// If a member DELETE policy is ever added, the trigger still blocks Telegram rows.
await db.exec("RESET ROLE");
await db.exec("CREATE POLICY sources_delete_for_workspace_members ON public.sources FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = sources.workspace_id AND cu.user_id = (SELECT auth.uid())))");
await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [MEMBER]);
await db.exec("SET ROLE authenticated");
await denied("DELETE FROM sources WHERE id=$1", [telegramId]);

// Server code writes as the service role, still held to the encrypted shape.
await db.exec("RESET ROLE");
await db.exec("SET ROLE service_role");
await allowed("UPDATE sources SET credentials=credentials||'{\"ai_reactions_enabled\":true}' WHERE id=$1", [telegramId]);
await denied("UPDATE sources SET credentials=credentials||'{\"webhook_secret_token\":\"plain\"}' WHERE id=$1", [telegramId], /sources_telegram_webhook_secret_check/);
await denied("UPDATE sources SET credentials=credentials||'{\"bot_token\":\"123:plain\"}' WHERE id=$1", [telegramId], /sources_telegram_bot_token_check/);
await allowed("INSERT INTO sources(workspace_id,company_id,type,name) VALUES ($1,$2,'telegram','placeholder')", [WORKSPACE, COMPANY]);
await allowed("DELETE FROM sources WHERE type='telegram' AND name='placeholder'");

// Workspace deletion cascades as the table owner and is not blocked.
await db.exec("RESET ROLE");
await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [MEMBER]);
await db.exec("SET ROLE authenticated");
await allowed("DELETE FROM workspaces WHERE id=$1", [WORKSPACE]);
await db.exec("RESET ROLE");
assert.equal((await db.query("SELECT workspace_id FROM sources WHERE id=$1", [telegramId])).rows[0].workspace_id, null);
checks++;
await db.close();

results.guardChecks = checks;
console.log(JSON.stringify({ ...results, result: "passed", database: "ephemeral PostgreSQL only" }));
