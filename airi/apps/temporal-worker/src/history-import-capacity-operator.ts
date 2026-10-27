import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemporalWorkerEnv } from "./load-env.js";

export function parseHistoryImportCapacityArgs(argv: string[]) {
  const result = {
    companyId: "",
    maxMessages: NaN,
    maxBytes: NaN,
    execute: false,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--execute") result.execute = true;
    else if (arg.startsWith("--company-id="))
      result.companyId = arg.slice("--company-id=".length).trim();
    else if (arg.startsWith("--max-messages="))
      result.maxMessages = Number(arg.slice("--max-messages=".length));
    else if (arg.startsWith("--max-bytes="))
      result.maxBytes = Number(arg.slice("--max-bytes=".length));
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  if (!result.companyId)
    throw new Error("A company ID and both limits are required");
  if (
    ![result.maxMessages, result.maxBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("Both limits must be finite nonnegative integers");
  return result;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Preview company history import limits: pnpm exec tsx src/history-import-capacity-operator.ts --company-id=<id> --max-messages=75000 --max-bytes=536870912 [--execute]. Execute wakes preserved paused imports; counters are never reset.",
    );
    return;
  }
  const { execute, ...limits } = parseHistoryImportCapacityArgs(
    process.argv.slice(2),
  );
  loadTemporalWorkerEnv();
  const [{ default: connectDB }, store] = await Promise.all([
    import("@icecore/airi-runtime/mongoose"),
    import("@icecore/airi-runtime/whatsapp-history-import-store"),
  ]);
  await connectDB();
  try {
    if (execute) {
      const { ensureWhatsAppWebhookEventIndexes } = await import(
        "@icecore/airi-runtime/whatsapp-webhook-event-indexes"
      );
      await ensureWhatsAppWebhookEventIndexes();
    }
    const before = await store.readWhatsAppHistoryImportCapacity(
      limits.companyId,
    );
    if (execute) await store.setWhatsAppHistoryImportCapacity(limits);
    console.log(
      JSON.stringify(
        {
          execute,
          proposed: limits,
          before,
          ...(execute
            ? {
                after: await store.readWhatsAppHistoryImportCapacity(
                  limits.companyId,
                ),
              }
            : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
