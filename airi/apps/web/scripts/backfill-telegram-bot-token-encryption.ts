import { loadWebOperatorEnv } from "./load-web-operator-env";

/**
 * Encrypts the Telegram bot tokens and webhook secrets that were saved in
 * plain text before they were encrypted at rest. Only those two credentials
 * change, and only while the row still holds them as it was read.
 *
 * Order: the release that reads encrypted credentials is live on web and the
 * worker, then this backfill, then the sources_telegram_bot_token_check and
 * sources_telegram_webhook_secret_check migrations, then
 * --rotate-webhook-secrets. Any Telegram settings save on that release
 * already encrypts its row, and older builds read an encrypted bot token or
 * webhook secret as missing: before rolling web or the worker back past it,
 * drop the guard trigger and both constraints and run --decrypt --apply.
 *
 * Every mode first proves ENCRYPTION_SECRET decrypts existing credentials in
 * this database. Dry run by default. Output is counts and ids, never secrets.
 *   pnpm backfill:telegram-bot-token-encryption [--apply]
 *   pnpm backfill:telegram-bot-token-encryption --decrypt [--apply]
 *   pnpm backfill:telegram-bot-token-encryption --rotate-webhook-secrets [--apply]
 *   pnpm backfill:telegram-bot-token-encryption --scrub-turn-checkpoints [--apply]
 *
 * --rotate-webhook-secrets gives every connected bot a new webhook secret and
 * registers it with Telegram: members could read, and set, the old ones until
 * the guard trigger. Run it once the trigger is applied, with
 * NEXT_PUBLIC_APP_URL set to the production app URL.
 * --scrub-turn-checkpoints removes the plain-text bot token that turns
 * prepared before this release copied into Mongo turn checkpoints.
 */

type Mode =
  | "encrypt"
  | "decrypt"
  | "rotateWebhookSecrets"
  | "scrubTurnCheckpoints";
type Outcome =
  | "encrypted"
  | "decrypted"
  | "rotated"
  | "rotationFailed"
  | "unchanged"
  | "noSecrets"
  | "undecryptable"
  | "invalidShape"
  | "changedConcurrently";

/** The PostgREST filters this script uses, without the client's deep types. */
type ConditionalUpdate = {
  is(column: string, value: null): ConditionalUpdate;
  not(column: string, operator: "is", value: null): ConditionalUpdate;
  eq(column: string, value: string): ConditionalUpdate;
  select(columns: "id"): PromiseLike<{
    data: { id: string }[] | null;
    error: { message: string } | null;
  }>;
};

const PAGE_SIZE = 500;
const SEALED_KEYS = ["bot_token", "webhook_secret_token"] as const;
const TURN_CHECKPOINT_TOKEN_PATH =
  "turnPreparation.result.pendingDelivery.context.botToken";

function parseArgs(argv: string[]): { dryRun: boolean; mode: Mode } {
  let dryRun = true;
  let mode: Mode = "encrypt";
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--apply") dryRun = false;
    else if (arg === "--decrypt") mode = "decrypt";
    else if (arg === "--rotate-webhook-secrets") mode = "rotateWebhookSecrets";
    else if (arg === "--scrub-turn-checkpoints") mode = "scrubTurnCheckpoints";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, mode };
}

function isEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return ["iv", "tag", "ciphertext"].every(
    key => typeof envelope[key] === "string" && Boolean(envelope[key])
  );
}

async function main() {
  loadWebOperatorEnv();
  const { dryRun, mode } = parseArgs(process.argv.slice(2));

  const [{ supabaseAdmin }, { decryptMaybeString, encryptString }] =
    await Promise.all([
      import("../src/lib/supabase/admin"),
      import("../src/lib/crypto"),
    ]);

  // A local key would encrypt (and round-trip) fine, then leave every bot
  // undecryptable in production. Prove the key on credentials already here.
  const { data: probes, error: probeError } = await supabaseAdmin
    .from("sources")
    .select("credentials")
    .eq("type", "whatsapp")
    .not("credentials->access_token->ciphertext", "is", null)
    .limit(5);
  if (probeError) {
    throw new Error(`Failed to read key probes: ${probeError.message}`);
  }
  const keyVerified = (probes ?? []).some(probe =>
    Boolean(
      decryptMaybeString(
        (probe.credentials as Record<string, unknown> | null)?.access_token
      )
    )
  );
  if (!keyVerified) {
    throw new Error(
      "ENCRYPTION_SECRET does not decrypt this database's encrypted WhatsApp tokens; use the production key"
    );
  }

  if (mode === "scrubTurnCheckpoints") {
    const [{ default: connectDB }, { default: AiriTurnContext }] =
      await Promise.all([
        import("../src/lib/mongoose"),
        import("../src/models/airi-turn-context"),
      ]);
    const mongoose = await import("mongoose");
    await connectDB();
    try {
      const filter = {
        channel: "telegram",
        [TURN_CHECKPOINT_TOKEN_PATH]: { $exists: true },
      };
      const matched = await AiriTurnContext.countDocuments(filter);
      const modified = dryRun
        ? 0
        : (
            await AiriTurnContext.updateMany(filter, {
              $unset: { [TURN_CHECKPOINT_TOKEN_PATH]: "" },
            })
          ).modifiedCount;
      console.log(JSON.stringify({ dryRun, mode, matched, modified }, null, 2));
    } finally {
      await mongoose.default.disconnect();
    }
    return;
  }

  const counts: Partial<Record<Outcome, number>> = {};
  const sourceIds: Partial<Record<Outcome, string[]>> = {};
  const record = (outcome: Outcome, sourceId: string) => {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    (sourceIds[outcome] ??= []).push(sourceId);
  };

  // Keyset pages: a row deleted mid-run cannot shift the next page.
  async function* telegramRows() {
    for (let afterId = "00000000-0000-0000-0000-000000000000"; ; ) {
      const { data: rows, error } = await supabaseAdmin
        .from("sources")
        .select("id, credentials, updated_at")
        .eq("type", "telegram")
        .gt("id", afterId)
        .order("id")
        .limit(PAGE_SIZE);
      if (error) {
        throw new Error(`Failed to read Telegram sources: ${error.message}`);
      }
      yield* rows ?? [];
      if (!rows || rows.length < PAGE_SIZE) return;
      afterId = String(rows[rows.length - 1].id);
    }
  }

  if (mode === "rotateWebhookSecrets") {
    // Every bot's webhook is registered again at this base URL.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    if (!/^https:\/\//.test(appUrl) || /localhost|127\.0\.0\.1/.test(appUrl)) {
      throw new Error(
        "NEXT_PUBLIC_APP_URL must be the production https app URL"
      );
    }
    const [{ registerTelegramWebhook }, { readTelegramBotToken }] =
      await Promise.all([
        import("../src/lib/telegram/register-webhook"),
        import("../src/lib/telegram/telegram-source"),
      ]);
    for await (const row of telegramRows()) {
      const sourceId = String(row.id);
      const botToken = readTelegramBotToken(row.credentials);
      if (!botToken) {
        record("noSecrets", sourceId);
        continue;
      }
      if (dryRun) {
        record("rotated", sourceId);
        continue;
      }
      const result = await registerTelegramWebhook(botToken, sourceId, {
        rotateSecret: true,
      });
      record(result.success ? "rotated" : "rotationFailed", sourceId);
    }
    console.log(
      JSON.stringify({ dryRun, mode, appUrl, counts, sourceIds }, null, 2)
    );
    return;
  }

  rows: for await (const row of telegramRows()) {
    const sourceId = String(row.id);
    const credentials =
      row.credentials && typeof row.credentials === "object"
        ? (row.credentials as Record<string, unknown>)
        : null;
    if (!credentials || SEALED_KEYS.every(key => !(key in credentials))) {
      record("noSecrets", sourceId);
      continue;
    }

    const next: Record<string, unknown> = { ...credentials };
    let changed = false;
    for (const key of SEALED_KEYS) {
      if (!(key in credentials)) continue;
      const stored = credentials[key];
      const value = decryptMaybeString(stored);
      if (typeof stored === "string") {
        if (!value) {
          record("invalidShape", sourceId);
          continue rows;
        }
        if (mode === "encrypt") {
          const sealed = encryptString(value);
          if (decryptMaybeString(sealed) !== value) {
            record("undecryptable", sourceId);
            continue rows;
          }
          next[key] = sealed;
          changed = true;
        }
      } else if (isEnvelope(stored)) {
        if (!value) {
          record("undecryptable", sourceId);
          continue rows;
        }
        if (mode === "decrypt") {
          next[key] = value;
          changed = true;
        }
      } else {
        record("invalidShape", sourceId);
        continue rows;
      }
    }

    if (!changed) {
      record("unchanged", sourceId);
      continue;
    }
    if (dryRun) {
      record(mode === "decrypt" ? "decrypted" : "encrypted", sourceId);
      continue;
    }

    // Each credential must still be as it was read. Filters name only its
    // shape or the random, non-secret IV: values in a PostgREST filter end
    // up in the request URL, and so in the API logs.
    let update = supabaseAdmin
      .from("sources")
      .update({ credentials: next })
      .eq("id", sourceId)
      .eq("type", "telegram") as unknown as ConditionalUpdate;
    // A settings save since the read changed updated_at, not the secrets.
    update = row.updated_at
      ? update.eq("updated_at", String(row.updated_at))
      : update.is("updated_at", null);
    for (const key of SEALED_KEYS) {
      const stored = credentials[key];
      if (stored === undefined) {
        update = update.is(`credentials->${key}`, null);
      } else if (typeof stored === "string") {
        update = update
          .not(`credentials->${key}`, "is", null)
          .is(`credentials->${key}->iv`, null);
      } else {
        update = update.eq(
          `credentials->${key}->>iv`,
          String((stored as Record<string, unknown>).iv)
        );
      }
    }
    const { data: updated, error: updateError } = await update.select("id");
    if (updateError) {
      throw new Error(
        `Failed to update Telegram source ${sourceId}: ${updateError.message}`
      );
    }
    record(
      updated?.length
        ? mode === "decrypt"
          ? "decrypted"
          : "encrypted"
        : "changedConcurrently",
      sourceId
    );
  }

  console.log(JSON.stringify({ dryRun, mode, counts, sourceIds }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
