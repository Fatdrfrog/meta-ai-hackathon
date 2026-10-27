import fs from "node:fs";

import mongoose, { type Model } from "mongoose";

import {
  buildLegacyRoutingRedrawMigrationErrorEvent,
  parseLegacyRoutingRedrawMigrationArgs,
  runLegacyRoutingRedrawMigrationOperator,
  type LegacyRoutingRedrawInventory,
  type LegacyRoutingRedrawMigrationArgs,
  type LegacyRoutingRedrawScenarioSnapshot,
} from "../src/lib/scenarios/legacy-routing-redraw-migration";
import { loadWebOperatorEnv } from "./load-web-operator-env";

const SCENARIO_LIST_BATCH_SIZE = 50;

async function writePreimage(
  outputPath: string,
  inventory: LegacyRoutingRedrawInventory
): Promise<void> {
  await fs.promises.writeFile(
    outputPath,
    `${JSON.stringify(inventory, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

async function* listScenarios(
  listArgs: LegacyRoutingRedrawMigrationArgs,
  Scenario: Model<unknown>
): AsyncIterable<LegacyRoutingRedrawScenarioSnapshot> {
  const query: Record<string, unknown> = { deletedAt: null };
  if (listArgs.workspaceId) query.workspaceId = listArgs.workspaceId;
  if (listArgs.scenarioId) query._id = listArgs.scenarioId;
  let lastId: unknown;
  for (;;) {
    const batchQuery =
      lastId === undefined ? query : { ...query, _id: { $gt: lastId } };
    const batch = await Scenario.find(batchQuery)
      .sort({ _id: 1 })
      .limit(SCENARIO_LIST_BATCH_SIZE)
      .select({
        _id: 1,
        workspaceId: 1,
        name: 1,
        status: 1,
        updatedAt: 1,
        nodes: 1,
        edges: 1,
      })
      .lean<LegacyRoutingRedrawScenarioSnapshot[]>();
    if (!batch.length) return;
    lastId = batch[batch.length - 1]._id;
    yield* batch;
  }
}

async function main(): Promise<void> {
  loadWebOperatorEnv();
  const args = parseLegacyRoutingRedrawMigrationArgs(process.argv.slice(2));
  const [mongooseRuntime, conversionService, scenarioModel] = await Promise.all(
    [
      import("../src/lib/mongoose"),
      import("../src/lib/scenarios/legacy-routing-conversion-service"),
      import("../src/models/scenario"),
    ]
  );
  await mongooseRuntime.connectDB();

  await runLegacyRoutingRedrawMigrationOperator(args, {
    listScenarios: listArgs =>
      listScenarios(listArgs, scenarioModel.Scenario as Model<unknown>),
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
      JSON.stringify(buildLegacyRoutingRedrawMigrationErrorEvent(error))
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
