/** Executes the Telegram bot-token migration in ephemeral PostgreSQL; never connects to a live database.
 * Pass an externally installed @electric-sql/pglite/dist/index.js path as argv[2].
 */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!process.argv[2])
  throw new Error("Usage: node .github/scripts/verify-telegram-source-credentials-sql.mjs /path/to/@electric-sql/pglite/dist/index.js");
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL("../..", import.meta.url)).replaceAll("\\", "/");
const migration = await readFile(`${root}/supabase/migrations/20261026190000_telegram_bot_token_encrypted.sql`, "utf8");

const envelope = { iv: "aXYtMTItYnl0ZXM=", tag: "dGFnLTE2LWJ5dGVzLWxvbmc=", ciphertext: "Y2lwaGVydGV4dA==" };

async function setup(rows = []) {
  const db = new PGlite();
  await db.exec(`
  CREATE TABLE public.sources(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid,
    type text CHECK (type = ANY (ARRAY['telegram','whatsapp','email','instagram','web_widget','teams','intercom','canva','higgsfield','elevenlabs','google_calendar','meta_ads','google_ai'])),
    name text,
    credentials jsonb
  );`);
  for (const [type, credentials] of rows)
    await db.query("INSERT INTO sources(type, credentials) VALUES ($1, $2)", [type, credentials === undefined ? null : JSON.stringify(credentials)]);
  return db;
}

const results = {};

// Validation refuses to start while a plain-text token is still stored.
{
  const db = await setup([["telegram", { bot_token: "123:plain", bot_username: "airi_bot" }]]);
  await assert.rejects(db.exec(migration), /sources_telegram_bot_token_check/);
  results.refusesBeforeBackfill = true;
}

// After the backfill: encrypted rows, placeholders and other source types all validate.
{
  const db = await setup([
    ["telegram", { bot_token: envelope, bot_username: "airi_bot", webhook_secret_token: "secret" }],
    ["telegram", undefined],
    ["telegram", {}],
    ["telegram", { bot_username: "no_token_yet" }],
    ["higgsfield", { bot_token: "not-a-telegram-row" }],
  ]);
  await db.exec(migration);
  const { rows } = await db.query("SELECT convalidated FROM pg_constraint WHERE conname = 'sources_telegram_bot_token_check'");
  assert.deepEqual(rows, [{ convalidated: true }]);

  let checks = 0;
  const insert = credentials => db.query("INSERT INTO sources(type, credentials) VALUES ('telegram', $1)", [credentials === null ? null : JSON.stringify(credentials)]);
  const denied = async promise => { await assert.rejects(promise, /sources_telegram_bot_token_check/); checks++; };
  const allowed = async promise => { await promise; checks++; };

  await allowed(insert(null));
  await allowed(insert({}));
  await allowed(insert({ ai_reactions_enabled: true }));
  await allowed(insert({ bot_token: envelope }));
  await denied(insert({ bot_token: "123:plain" }));
  await denied(insert({ bot_token: "" }));
  await denied(insert({ bot_token: null }));
  await denied(insert({ bot_token: ["123:plain"] }));
  await denied(insert({ bot_token: JSON.stringify(envelope) }));
  await denied(insert({ bot_token: { ...envelope, tag: undefined } }));
  await denied(insert({ bot_token: { ...envelope, iv: "" } }));
  await denied(insert({ bot_token: { ...envelope, ciphertext: 7 } }));

  const encryptedId = (await db.query("SELECT id FROM sources WHERE credentials->>'bot_username' = 'airi_bot'")).rows[0].id;
  await denied(db.query("UPDATE sources SET credentials = jsonb_set(credentials, '{bot_token}', '\"123:plain\"') WHERE id = $1", [encryptedId]));
  await allowed(db.query("UPDATE sources SET credentials = credentials || '{\"ai_reactions_enabled\": true}' WHERE id = $1", [encryptedId]));
  await allowed(db.query("UPDATE sources SET name = '@airi_bot' WHERE id = $1", [encryptedId]));

  const otherId = (await db.query("SELECT id FROM sources WHERE type = 'higgsfield'")).rows[0].id;
  await denied(db.query("UPDATE sources SET type = 'telegram' WHERE id = $1", [otherId]));
  results.constraintChecks = checks;
}

console.log(JSON.stringify(results));
