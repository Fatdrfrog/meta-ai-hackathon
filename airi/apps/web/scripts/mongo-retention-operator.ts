import mongoose from "mongoose";
import { loadWebOperatorEnv } from "./load-web-operator-env";

export async function runMongoRetentionOperator(
  argv: string[],
  dependencies: {
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const stdout =
    dependencies.stdout ?? (value => process.stdout.write(`${value}\n`));
  const stderr =
    dependencies.stderr ?? (value => process.stderr.write(`${value}\n`));
  const usage =
    "Usage: mongo-retention-operator.ts [--dry-run (default) | --apply]";
  let ownsConnection = false;
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      stdout(usage);
      return 0;
    }
    if (
      argv.length > 1 ||
      argv.some(arg => !["--apply", "--dry-run"].includes(arg))
    ) {
      stderr(usage);
      return 1;
    }
    loadWebOperatorEnv();
    ownsConnection = true;
    const { default: connectDB } = await import("../src/lib/mongoose");
    await connectDB();
    const { ensureScenarioObservabilityIndexes } = await import(
      "../src/lib/scenarios/ensure-observability-indexes"
    );
    const result = await ensureScenarioObservabilityIndexes({
      dryRun: argv[0] !== "--apply",
    });
    stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch {
    stderr(
      "Mongo retention operator failed; no success claimed. Check permissions and index definitions."
    );
    return 1;
  } finally {
    if (ownsConnection) await mongoose.disconnect().catch(() => undefined);
  }
}

if (/mongo-retention-operator\.(?:ts|js|mjs)$/.test(process.argv[1] || "")) {
  void runMongoRetentionOperator(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
