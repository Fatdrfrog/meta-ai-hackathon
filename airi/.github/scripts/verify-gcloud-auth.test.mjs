import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableGcloudAuthError,
  verifyGcloudAuth,
} from "./verify-gcloud-auth.mjs";

test("classifies transient workload identity transport failures", () => {
  assert.equal(
    isRetryableGcloudAuthError(
      "Unable to retrieve Identity Pool subject token: upstream connect error or disconnect/reset before headers. reset reason: overflow",
    ),
    true,
  );
  assert.equal(
    isRetryableGcloudAuthError("PERMISSION_DENIED: caller lacks permission"),
    false,
  );
});

test("retries transient gcloud authentication failures with bounded backoff", async () => {
  const attempts = [];
  const waits = [];
  const results = [
    {
      status: 1,
      stderr:
        "Unable to retrieve Identity Pool subject token: connection reset by peer",
    },
    {
      status: 1,
      stderr: "UNAVAILABLE: upstream connect error",
    },
    { status: 0, stderr: "" },
  ];

  const result = await verifyGcloudAuth({
    attempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 150,
    run: () => {
      attempts.push(Date.now());
      return results.shift();
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
    log: () => undefined,
  });

  assert.equal(result.attemptsUsed, 3);
  assert.equal(attempts.length, 3);
  assert.deepEqual(waits, [100, 150]);
});

test("fails immediately for permanent gcloud authentication errors", async () => {
  let attempts = 0;

  await assert.rejects(
    verifyGcloudAuth({
      attempts: 5,
      run: () => {
        attempts += 1;
        return {
          status: 1,
          stderr: "PERMISSION_DENIED: invalid workload identity principal",
        };
      },
      wait: async () => undefined,
      log: () => undefined,
    }),
    /PERMISSION_DENIED/,
  );

  assert.equal(attempts, 1);
});

test("fails after the configured transient retry budget", async () => {
  let attempts = 0;

  await assert.rejects(
    verifyGcloudAuth({
      attempts: 3,
      baseDelayMs: 1,
      run: () => {
        attempts += 1;
        return {
          status: 1,
          stderr: "UNAVAILABLE: upstream connection reset",
        };
      },
      wait: async () => undefined,
      log: () => undefined,
    }),
    /after 3 attempts/,
  );

  assert.equal(attempts, 3);
});
