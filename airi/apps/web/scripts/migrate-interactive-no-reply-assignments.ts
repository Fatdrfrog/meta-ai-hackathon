import fs from "node:fs";

import mongoose from "mongoose";

import {
  buildInteractiveNoReplyMigrationErrorEvent,
  parseInteractiveNoReplyMigrationArgs,
  runInteractiveNoReplyMigrationOperator,
  type InteractiveNoReplyMigrationPreimage,
} from "../src/lib/scenarios/interactive-no-reply-migration";
import { loadWebOperatorEnv } from "./load-web-operator-env";

async function writePreimage(
  outputPath: string,
  preimage: InteractiveNoReplyMigrationPreimage
): Promise<void> {
  await fs.promises.writeFile(
    outputPath,
    `${JSON.stringify(preimage, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

async function main(): Promise<void> {
  loadWebOperatorEnv();
  const args = parseInteractiveNoReplyMigrationArgs(process.argv.slice(2));
  const [
    mongooseRuntime,
    conversionService,
    preimageLoader,
    timerReplanIngress,
  ] = await Promise.all([
    import("../src/lib/mongoose"),
    import("../src/lib/scenarios/legacy-routing-conversion-service"),
    import("../src/lib/scenarios/legacy-routing-migration-preimage"),
    import("../src/lib/airi/scenario/timer-recovery/ingress"),
  ]);
  await mongooseRuntime.connectDB();

  await runInteractiveNoReplyMigrationOperator(args, {
    assertTimerReplanIngressReady:
      timerReplanIngress.assertTimerReplanIngressIndexes,
    loadState: preimageLoader.loadLegacyRoutingMigrationState,
    applyMigration: conversionService.convertLegacyRoutingInTransaction,
    writePreimage,
    emit: event => {
      // eslint-disable-next-line no-console -- JSONL is the operator contract.
      console.log(JSON.stringify(event));
    },
  });
}

main()
  .catch(error => {
    // eslint-disable-next-line no-console -- failures are emitted as JSONL.
    console.error(
      JSON.stringify(buildInteractiveNoReplyMigrationErrorEvent(error))
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
