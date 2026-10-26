import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { openSpendLedger } from "./budget.ts";
import { createMetaClient } from "./client.ts";
import { ApiError } from "./errors.ts";

const config = {
  apiKey: "test-key",
  baseUrl: "https://api.example.test/v1",
  models: { spark: "muse-spark-1.3", sam: "sam-3.1" },
  budgetUsd: 1,
  ledgerPath: "",
};

function client() {
  const ledger = openSpendLedger(join(mkdtempSync(join(tmpdir(), "spend-")), "spend.json"), 1);
  return createMetaClient(config, ledger);
}

const ok = { id: "r1", status: "completed", output: [], usage: { input_tokens: 1000, output_tokens: 0 } };

afterEach(() => mock.restoreAll());

test("retries a temporary 502 and then succeeds", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    fetchMock.mock.callCount() === 0 ? new Response("<html>Sorry</html>", { status: 502 }) : Response.json(ok),
  );
  const response = await client().createResponse({ model: "muse-spark-1.3", input: "hi" });
  assert.equal(response.id, "r1");
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("does not retry a 400", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("bad request", { status: 400 }));
  await assert.rejects(client().createResponse({ model: "muse-spark-1.3", input: "hi" }), ApiError);
  assert.equal(fetchMock.mock.callCount(), 1);
});
