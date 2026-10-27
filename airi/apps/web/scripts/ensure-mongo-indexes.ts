import mongoose from "mongoose";
import { loadWebOperatorEnv } from "./load-web-operator-env";

/** all = every managed index; the narrow modes repair one area only. */
export type MongoIndexMode = "all" | "query-cost" | "airi-chat";

const MODE_FLAGS: ReadonlyMap<string, MongoIndexMode> = new Map([
  ["--query-cost-only", "query-cost"],
  ["--airi-chat-only", "airi-chat"],
]);

async function ensureDatabaseIndexes(mode: MongoIndexMode): Promise<void> {
  loadWebOperatorEnv();
  const { ensureAiriChatIndexes, ensureIndexes, ensureMongoQueryIndexes } =
    await import("../src/lib/mongo");
  if (mode === "query-cost") await ensureMongoQueryIndexes();
  else if (mode === "airi-chat") await ensureAiriChatIndexes();
  else await ensureIndexes();
}

export async function runEnsureMongoIndexes(
  argv: string[],
  dependencies: {
    ensure?: (mode: MongoIndexMode) => Promise<void>;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const stdout =
    dependencies.stdout ?? (value => process.stdout.write(`${value}\n`));
  const stderr =
    dependencies.stderr ?? (value => process.stderr.write(`${value}\n`));
  const usage =
    "Usage: ensure-mongo-indexes.ts [--query-cost-only | --airi-chat-only]";
  let ownsConnection = false;
  const flagMode = MODE_FLAGS.get(argv[0] ?? "");
  const mode: MongoIndexMode = flagMode ?? "all";
  const queryCostOnly = mode === "query-cost";
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      stdout(usage);
      return 0;
    }
    if (argv.length > 1 || (argv.length === 1 && !flagMode)) {
      stderr(usage);
      return 1;
    }
    ownsConnection = !dependencies.ensure;
    await (dependencies.ensure ?? ensureDatabaseIndexes)(mode);
    stdout(
      queryCostOnly
        ? "Mongo query cost indexes verified (delivery key, user pages, chat pages)."
        : mode === "airi-chat"
          ? "Airi chat indexes ensured (airichatthreads, airichatmessages, airichatruns)."
          : "Mongo indexes ensured."
    );
    return 0;
  } catch (error) {
    stderr(formatMongoIndexError(error, queryCostOnly));
    return 1;
  } finally {
    if (ownsConnection) await mongoose.disconnect().catch(() => undefined);
  }
}

export function formatMongoQueryIndexError(error: unknown): string {
  return formatMongoIndexError(error, true);
}

function formatMongoIndexError(error: unknown, queryCostOnly: boolean): string {
  const prefix = queryCostOnly
    ? "Mongo query index repair"
    : "Mongo index repair";
  const metadata =
    error && typeof error === "object"
      ? (error as { code?: unknown; codeName?: unknown })
      : {};
  if (metadata.code === 11000) {
    return queryCostOnly
      ? `${prefix} failed: duplicate keys. Resolve duplicate string delivery keys, then rerun with --query-cost-only.`
      : `${prefix} failed: duplicate keys. Inspect duplicate groups before retrying.`;
  }
  if (metadata.code === 13 || metadata.codeName === "Unauthorized") {
    return `${prefix} failed: permission denied. Use the privileged index provisioner credentials.`;
  }
  if (
    metadata.code === 85 ||
    metadata.code === 86 ||
    metadata.codeName === "IndexOptionsConflict" ||
    metadata.codeName === "IndexKeySpecsConflict"
  ) {
    return `${prefix} failed: conflicting index definition. Inspect stored index definitions before retrying.`;
  }

  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith(
      "Temporal delivery-key unique index preflight found duplicate rows;"
    )
  ) {
    return "Temporal delivery-key index preflight found duplicate string keys; no rows were modified. Resolve the duplicate groups manually, then rerun with --query-cost-only.";
  }
  for (const label of ["Temporal delivery-key", "Requests dependency fanout"]) {
    if (
      message.startsWith(
        `${label} index verification failed after reconciliation:`
      )
    ) {
      return `${label} index verification failed after reconciliation. Inspect stored index definitions before retrying with --query-cost-only.`;
    }
  }
  const code =
    typeof metadata.code === "number" && Number.isSafeInteger(metadata.code)
      ? ` (code ${metadata.code})`
      : "";
  return `${prefix} failed${code}.`;
}

if (/ensure-mongo-indexes\.(?:ts|js|mjs)$/.test(process.argv[1] || "")) {
  void runEnsureMongoIndexes(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
