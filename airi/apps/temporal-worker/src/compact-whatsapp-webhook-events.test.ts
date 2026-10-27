import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX } from "@icecore/airi-runtime/whatsapp-webhook-event-model";

import {
  formatWhatsAppWebhookCompactionError,
  parseWhatsAppWebhookCompactionArgs,
} from "./compact-whatsapp-webhook-events";

test("operator compaction defaults to dry-run and accepts explicit bounded execution", () => {
  assert.deepEqual(parseWhatsAppWebhookCompactionArgs([]), { dryRun: true });
  assert.deepEqual(
    parseWhatsAppWebhookCompactionArgs([
      "--",
      "--execute",
      "--retention-days=60",
      "--limit=500",
    ]),
    {
      dryRun: false,
      retentionDays: 60,
      limit: 500,
    },
  );
});

test("operator rejects malformed flags instead of accidentally shortening retention", () => {
  for (const arg of [
    "--limit=0",
    "--limit=501",
    "--limit=100garbage",
    "--retention-days=0",
    "--retention-days=1.5",
    "--retention-days=bad",
    "--all",
    "--limit",
  ]) {
    assert.throws(
      () => parseWhatsAppWebhookCompactionArgs([arg]),
      /Unsupported|integer/,
    );
  }
});

test("operator help is available without connecting to Mongo", () => {
  const script = fileURLToPath(
    new URL("./compact-whatsapp-webhook-events.ts", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--help"],
    {
      cwd: process.cwd(),
      env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/unavailable" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run/);
  assert.match(result.stdout, /--execute/);
});

test("compaction CLI does not echo credentials from malformed arguments", () => {
  const script = fileURLToPath(
    new URL("./compact-whatsapp-webhook-events.ts", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      script,
      "--connection=mongodb://fixture-user:fixture-password@127.0.0.1:1/fixture",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported argument/);
  assert.doesNotMatch(
    result.stderr,
    /fixture-user|fixture-password|mongodb:\/\//,
  );
});

test("compaction errors preserve policy guidance and redact arbitrary driver details", () => {
  const error = Object.assign(
    new Error(
      "connection mongodb://fixture-user:fixture-password@127.0.0.1/test failed",
    ),
    { code: 13 },
  );
  const formatted = formatWhatsAppWebhookCompactionError(error);
  assert.match(formatted, /code 13/);
  assert.doesNotMatch(formatted, /fixture-user|fixture-password|mongodb:\/\//);
  assert.equal(
    formatWhatsAppWebhookCompactionError(
      new Error("retentionDays must be an integer between 1 and 3650"),
    ),
    "retentionDays must be an integer between 1 and 3650",
  );
  assert.doesNotMatch(
    formatWhatsAppWebhookCompactionError({
      code: "fixture-password",
      message: "fixture-password",
    }),
    /fixture-password/,
  );
});

test(
  "compaction CLI requires its exact index and never provisions unrelated indexes",
  {
    skip: !process.env.MONGO_COST_TEST_URI,
    timeout: 60_000,
  },
  async (t) => {
    const uri = new URL(process.env.MONGO_COST_TEST_URI!);
    assert.equal(uri.protocol, "mongodb:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname));
    assert.equal(uri.port, "27277");
    assert.equal(uri.username, "");
    assert.equal(uri.password, "");
    assert.equal(uri.pathname, "/airi_mongo_index_cost_tests");
    assert.equal(uri.searchParams.get("replicaSet"), "airiCostTests");
    uri.pathname = `/airi_compaction_cli_${randomUUID().replaceAll("-", "")}`;
    const connection = await mongoose
      .createConnection(uri.toString(), {
        autoCreate: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 5_000,
      })
      .asPromise();
    const collection = connection.collection("whatsappwebhookevents");
    const script = fileURLToPath(
      new URL("./compact-whatsapp-webhook-events.ts", import.meta.url),
    );
    try {
      for (const scenario of ["missing", "drifted", "ready"] as const) {
        await t.test(scenario, async () => {
          await collection.drop().catch((error: { code?: number }) => {
            if (error.code !== 26) throw error;
          });
          await collection.insertOne({
            dedupeKey: scenario,
            status: "completed",
            completedAt: new Date("2020-01-01"),
            payload: { body: "original" },
            payloadCompactedAt: null,
          });
          if (scenario !== "missing") {
            await collection.createIndex(
              WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX.key,
              {
                ...WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX.options,
                ...(scenario === "drifted"
                  ? { partialFilterExpression: { status: "completed" } }
                  : {}),
              },
            );
          }
          const before = await collection.listIndexes().toArray();
          const result = spawnSync(
            process.execPath,
            ["--import", "tsx", script, "--execute"],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                MONGODB_URI: uri.toString(),
                WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS: "30",
                WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT: "100",
              },
              encoding: "utf8",
              timeout: 15_000,
            },
          );
          assert.deepEqual(await collection.listIndexes().toArray(), before);
          const receipt = await collection.findOne({ dedupeKey: scenario });
          if (scenario === "ready") {
            assert.equal(result.status, 0, result.stderr);
            assert.equal(receipt?.payload, undefined);
            assert.ok(receipt?.payloadCompactedAt instanceof Date);
          } else {
            assert.equal(result.status, 1, result.stderr);
            assert.match(
              result.stderr,
              /compaction index.*(?:missing|unexpected)|index.*provisioner/i,
            );
            assert.deepEqual(receipt?.payload, { body: "original" });
            assert.equal(receipt?.payloadCompactedAt, null);
          }
          await collection.drop();
        });
      }
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  },
);
