/** Executes actual migrations in ephemeral PostgreSQL; never connects to a live database.
 * Pass an externally installed @electric-sql/pglite/dist/index.js path as argv[2].
 * --baseline skips the WhatsApp guard migrations to show the checks fail without them.
 */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.argv[2])
  throw new Error(
    "Usage: node .github/scripts/verify-whatsapp-source-guards-sql.mjs /path/to/@electric-sql/pglite/dist/index.js [--baseline]",
  );
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const baseline = process.argv.includes("--baseline");
const root = fileURLToPath(new URL("../..", import.meta.url)).replaceAll(
  "\\",
  "/",
);
const migration = file =>
  readFile(`${root}/supabase/migrations/${file}`, "utf8");

const WORKSPACE = "10000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "10000000-0000-4000-8000-000000000002";
const COMPANY = "20000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "20000000-0000-4000-8000-000000000002";
const MANAGER = "30000000-0000-4000-8000-000000000001";

async function setup() {
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
  CREATE TABLE public.whatsapp_accounts(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id uuid REFERENCES public.sources(id) ON DELETE CASCADE,
    workspace_id uuid,
    company_id uuid,
    account_key text NOT NULL,
    phone_number_id text,
    connection_status text NOT NULL DEFAULT 'active',
    last_observed_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;
  -- Live policies on public.whatsapp_accounts as of 2026-10-16.
  CREATE POLICY "Company members can select WhatsApp account inventory" ON public.whatsapp_accounts FOR SELECT TO authenticated
    USING (((workspace_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = whatsapp_accounts.workspace_id AND cu.user_id = (SELECT auth.uid()))))
      OR ((company_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu JOIN public.workspaces w ON w.id = cu.workspace_id WHERE w.company_id = whatsapp_accounts.company_id AND cu.user_id = (SELECT auth.uid())))));
  CREATE POLICY "Company managers can insert WhatsApp account inventory" ON public.whatsapp_accounts FOR INSERT TO authenticated
    WITH CHECK (((workspace_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = whatsapp_accounts.workspace_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager']))))
      OR ((company_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu JOIN public.workspaces w ON w.id = cu.workspace_id WHERE w.company_id = whatsapp_accounts.company_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager'])))));
  CREATE POLICY "Company managers can update WhatsApp account inventory" ON public.whatsapp_accounts FOR UPDATE TO authenticated
    USING (((workspace_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = whatsapp_accounts.workspace_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager']))))
      OR ((company_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu JOIN public.workspaces w ON w.id = cu.workspace_id WHERE w.company_id = whatsapp_accounts.company_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager'])))))
    WITH CHECK (((workspace_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.workspace_id = whatsapp_accounts.workspace_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager']))))
      OR ((company_id IS NOT NULL) AND (EXISTS (SELECT 1 FROM public.company_users cu JOIN public.workspaces w ON w.id = cu.workspace_id WHERE w.company_id = whatsapp_accounts.company_id AND cu.user_id = (SELECT auth.uid()) AND cu.role = ANY (ARRAY['admin','manager'])))));
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
  GRANT ALL ON public.sources TO anon, authenticated, service_role;
  GRANT SELECT ON public.workspaces, public.company_users TO authenticated;
  GRANT DELETE ON public.workspaces TO authenticated;
  GRANT INSERT, SELECT, UPDATE ON public.whatsapp_accounts TO authenticated;
  GRANT ALL ON public.whatsapp_accounts TO service_role;
  `);
  await db.query("INSERT INTO workspaces VALUES ($1,$2),($3,$4)", [
    WORKSPACE,
    COMPANY,
    OTHER_WORKSPACE,
    OTHER_COMPANY,
  ]);
  await db.query("INSERT INTO company_users VALUES ($1,$2,'admin')", [
    MANAGER,
    WORKSPACE,
  ]);
  await db.exec(
    await migration("20260910181111_protect_source_commerce_credentials.sql"),
  );
  if (!baseline) {
    await db.exec(
      await migration("20261018131759_guard_whatsapp_source_client_writes.sql"),
    );
    await db.exec(
      await migration(
        "20261017135358_revoke_whatsapp_accounts_client_writes.sql",
      ),
    );
  }
  return db;
}

async function verifySourceGuard(db) {
  let checks = 0;
  const denied = async (sql, params = [], pattern = /source_whatsapp_server_managed/) => {
    await assert.rejects(db.query(sql, params), pattern);
    checks++;
  };
  const allowed = async (sql, params = []) => {
    await db.query(sql, params);
    checks++;
  };

  await db.exec("SET ROLE service_role");
  const ownWhatsApp = (
    await db.query(
      "INSERT INTO sources(workspace_id,company_id,type,name,credentials) VALUES ($1,$2,'whatsapp','WhatsApp',$3::jsonb) RETURNING id",
      [
        WORKSPACE,
        COMPANY,
        JSON.stringify({
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          access_token: { ciphertext: "x" },
          coexistence_reonboarding_status: "removed",
          cloud_api_messaging_suspended: true,
        }),
      ],
    )
  ).rows[0].id;
  checks++;
  const ownTelegram = (
    await db.query(
      "INSERT INTO sources(workspace_id,company_id,type,credentials) VALUES ($1,$2,'telegram','{}'::jsonb) RETURNING id",
      [WORKSPACE, COMPANY],
    )
  ).rows[0].id;
  await allowed(
    "UPDATE sources SET credentials=credentials||'{\"phone_number_id\":\"phone-2\"}' WHERE id=$1",
    [ownWhatsApp],
  );

  for (const role of ["authenticated", "anon"]) {
    await db.exec("RESET ROLE");
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
      role === "authenticated" ? MANAGER : "",
    ]);
    await db.exec(`SET ROLE ${role}`);
    // A member cannot create a WhatsApp row claiming another tenant's number.
    // BEFORE triggers run ahead of RLS checks, so anon must hit the trigger
    // too rather than pass only because it has no insert policy.
    await denied(
      "INSERT INTO sources(workspace_id,company_id,type,credentials) VALUES ($1,$2,'whatsapp',$3::jsonb)",
      [
        WORKSPACE,
        OTHER_COMPANY,
        JSON.stringify({ phone_number_id: "victim-phone", waba_id: "victim-waba" }),
      ],
    );
    if (role === "anon") continue;
    for (const patch of [
      { phone_number_id: "victim-phone" },
      { access_token: "plaintext" },
      {
        coexistence_reonboarding_status: null,
        cloud_api_messaging_suspended: false,
        partner_app_installed: true,
      },
      { __airi_whatsapp_flow_source_fence: { token: "forged" } },
    ]) {
      await denied(
        "UPDATE sources SET credentials=credentials||$1::jsonb WHERE id=$2",
        [JSON.stringify(patch), ownWhatsApp],
      );
    }
    await denied("UPDATE sources SET name='renamed' WHERE id=$1", [ownWhatsApp]);
    await denied("UPDATE sources SET type='telegram' WHERE id=$1", [ownWhatsApp]);
    await denied(
      "UPDATE sources SET type='whatsapp',credentials='{\"phone_number_id\":\"victim-phone\"}'::jsonb WHERE id=$1",
      [ownTelegram],
    );
    // Other source types keep their member-editable credentials.
    await allowed(
      "UPDATE sources SET credentials=credentials||'{\"ai_reactions_enabled\":false}' WHERE id=$1",
      [ownTelegram],
    );
    await allowed(
      "INSERT INTO sources(workspace_id,company_id,type,credentials) VALUES ($1,$2,'telegram','{}'::jsonb)",
      [WORKSPACE, COMPANY],
    );
    // The commerce guard still fires first on its keys.
    await denied(
      "UPDATE sources SET credentials=credentials||'{\"sales_webhook_secret\":\"x\"}' WHERE id=$1",
      [ownTelegram],
      /source_commerce_credentials_managed/,
    );
  }

  await db.exec("RESET ROLE");
  assert.equal(
    (
      await db.query(
        "SELECT credentials->>'phone_number_id' AS phone FROM sources WHERE id=$1",
        [ownWhatsApp],
      )
    ).rows[0].phone,
    "phone-2",
  );
  checks++;

  // Workspace deletion cascades as the table owner and is not blocked.
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
    MANAGER,
  ]);
  await db.exec("SET ROLE authenticated");
  await allowed("DELETE FROM workspaces WHERE id=$1", [WORKSPACE]);
  await db.exec("RESET ROLE");
  assert.equal(
    (
      await db.query("SELECT workspace_id FROM sources WHERE id=$1", [
        ownWhatsApp,
      ])
    ).rows[0].workspace_id,
    null,
  );
  checks++;
  return checks;
}

async function verifyAccountsGuard(db) {
  let checks = 0;
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
    MANAGER,
  ]);
  await db.exec("SET ROLE service_role");
  await db.query(
    "INSERT INTO whatsapp_accounts(workspace_id,company_id,account_key,phone_number_id) VALUES ($1,$2,'phone:victim','victim-phone')",
    [OTHER_WORKSPACE, OTHER_COMPANY],
  );
  checks++;
  await db.exec("SET ROLE authenticated");
  // V1: plant a routing row for another tenant's workspace and number by
  // pointing company_id at the attacker's own company.
  await assert.rejects(
    db.query(
      "INSERT INTO whatsapp_accounts(workspace_id,company_id,account_key,phone_number_id,last_observed_at) VALUES ($1,$2,'phone:victim','victim-phone','2999-01-01')",
      [OTHER_WORKSPACE, COMPANY],
    ),
    /permission denied/,
  );
  checks++;
  await assert.rejects(
    db.query(
      "UPDATE whatsapp_accounts SET last_observed_at='2999-01-01' WHERE company_id=$1",
      [COMPANY],
    ),
    /permission denied/,
  );
  checks++;
  // Members keep read access to their company's inventory.
  await db.query("SELECT count(*) FROM whatsapp_accounts");
  checks++;
  await db.exec("RESET ROLE");
  return checks;
}

// Each check group gets its own database: the source checks end by deleting
// the workspace, which also removes the member the account checks rely on.
const sourceDb = await setup();
const sourceChecks = await verifySourceGuard(sourceDb);
await sourceDb.close();
const accountsDb = await setup();
const accountChecks = await verifyAccountsGuard(accountsDb);
await accountsDb.close();
console.log(
  JSON.stringify({
    sourceChecks,
    accountChecks,
    result: "passed",
    database: "ephemeral PostgreSQL only",
  }),
);
