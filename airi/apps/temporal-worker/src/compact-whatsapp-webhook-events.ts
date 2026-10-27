import {
  compactCompletedWhatsAppWebhookEventPayloads,
  resolveWhatsAppWebhookPayloadRetentionPolicy,
} from "@icecore/airi-runtime/whatsapp-webhook-event-retention";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { loadTemporalWorkerEnv } from "./load-env.js";

const COMPACTION_INDEX_REQUIRED_MESSAGE =
  "WhatsApp webhook compaction index is missing or has unexpected options. Use the existing ensureWhatsAppWebhookEventIndexes provisioner to install the canonical definition before retrying; this command never creates indexes.";

export function formatWhatsAppWebhookCompactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Unsupported argument:")) {
    return "Unsupported argument. Use --help for supported flags.";
  }
  if (
    [
      COMPACTION_INDEX_REQUIRED_MESSAGE,
      "retentionDays must be an integer between 1 and 3650",
      "limit must be an integer between 1 and 500",
      "MONGODB_URI environment variable is required",
    ].includes(message)
  )
    return message;
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  const suffix =
    typeof code === "number" && Number.isSafeInteger(code)
      ? ` (code ${code})`
      : "";
  return `WhatsApp webhook compaction failed${suffix}. Check MongoDB connectivity, permissions and the compaction index.`;
}

export function parseWhatsAppWebhookCompactionArgs(argv: string[]): {
  dryRun: boolean;
  retentionDays?: number;
  limit?: number;
} {
  const options: { dryRun: boolean; retentionDays?: number; limit?: number } = {
    dryRun: true,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--execute") options.dryRun = false;
    else if (arg.startsWith("--retention-days=")) {
      options.retentionDays = Number(arg.slice("--retention-days=".length));
    } else if (arg.startsWith("--limit=")) {
      options.limit = Number(arg.slice("--limit=".length));
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  resolveWhatsAppWebhookPayloadRetentionPolicy(options);
  return options;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Preview one bounded batch of completed WhatsApp webhook payloads (default: dry-run, 30 days, 100 receipts).",
        "pnpm --filter @icecore/temporal-worker compact:whatsapp-webhook-events -- --limit=100 --retention-days=30 [--execute]",
        "--execute removes completed raw payloads and processing cursors; durable dedupe receipts remain.",
        "Failed, dead, queued and processing payloads are preserved. Compacted receipts cannot be replayed.",
        "WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS and WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT supply defaults.",
        "The existing webhook index provisioner must install the compaction index first; this command never creates indexes.",
      ].join("\n"),
    );
    return;
  }
  const options = parseWhatsAppWebhookCompactionArgs(argv);
  loadTemporalWorkerEnv();
  const policy = resolveWhatsAppWebhookPayloadRetentionPolicy({
    ...options,
    env: process.env,
  });
  const { default: connectDB } = await import("@icecore/airi-runtime/mongoose");
  await connectDB();
  try {
    const {
      default: WhatsAppWebhookEvent,
      WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX: expectedIndex,
    } = await import("@icecore/airi-runtime/whatsapp-webhook-event-model");
    const indexes = await WhatsAppWebhookEvent.collection
      .listIndexes({ maxTimeMS: 10_000 })
      .toArray()
      .catch((error: { code?: number }) => {
        if (error.code === 26) return [];
        throw error;
      });
    const index = indexes.find(
      (item) => item.name === expectedIndex.options.name,
    );
    if (
      !index ||
      !isDeepStrictEqual(
        Object.entries(index.key),
        Object.entries(expectedIndex.key),
      ) ||
      !isDeepStrictEqual(
        index.partialFilterExpression,
        expectedIndex.options.partialFilterExpression,
      ) ||
      Object.keys(index).some(
        (key) =>
          ![
            "v",
            "ns",
            "key",
            "name",
            "background",
            "partialFilterExpression",
          ].includes(key),
      )
    ) {
      throw new Error(COMPACTION_INDEX_REQUIRED_MESSAGE);
    }
    const result = await compactCompletedWhatsAppWebhookEventPayloads({
      model: WhatsAppWebhookEvent,
      ...policy,
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(formatWhatsAppWebhookCompactionError(error));
    process.exitCode = 1;
  });
}
