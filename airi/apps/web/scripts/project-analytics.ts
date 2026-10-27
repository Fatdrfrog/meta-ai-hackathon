import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import mongoose from "mongoose";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

async function main() {
  if (existsSync(".env.local")) loadEnvFile(".env.local");
  const args = process.argv.slice(2);
  const workspaceId = args[args.indexOf("--workspace") + 1];
  const [{ isAnalyticsWorkspaceId }, { startAnalyticsProjectionRuntime }] =
    await Promise.all([
      import("../src/lib/analytics/service-lifecycle-consumer"),
      import("../src/lib/analytics/analytics-projection-runtime"),
    ]);
  if (!args.includes("--workspace") || !isAnalyticsWorkspaceId(workspaceId)) {
    throw new Error(
      "Usage: pnpm analytics:project --workspace <UUID> [--watch] [--replay]"
    );
  }
  const abort = new AbortController();
  const stopFromSignal = () => abort.abort();
  process.on("SIGINT", stopFromSignal);
  process.on("SIGTERM", stopFromSignal);
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await startAnalyticsProjectionRuntime({
      workspaceId,
      signal: abort.signal,
      once: !args.includes("--watch"),
      replay: args.includes("--replay"),
    });
    if (args.includes("--watch") && !abort.signal.aborted) {
      await new Promise<void>(resolve =>
        abort.signal.addEventListener("abort", () => resolve(), { once: true })
      );
    }
  } finally {
    abort.abort();
    await stop?.();
    process.off("SIGINT", stopFromSignal);
    process.off("SIGTERM", stopFromSignal);
    await mongoose.disconnect();
  }
}
main().catch(error => {
  airiWorkerLogger.error(
    "analytics.operator_failed",
    error instanceof Error ? error : new Error("Analytics operator failed")
  );
  process.exitCode = 1;
  void mongoose.disconnect();
});
