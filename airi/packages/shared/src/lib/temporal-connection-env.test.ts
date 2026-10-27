import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPORAL_TLS_API_KEY_REQUIRED_MESSAGE,
  assertTemporalTlsApiKey,
  hasTemporalConnectionEnv,
  resolveTemporalConnectionEnv,
} from "./temporal-connection-env";

const KEYS = [
  "TEMPORAL_ADDRESS",
  "TEMPORAL_CLOUD_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_CLOUD_NAMESPACE",
  "TEMPORAL_API_KEY",
  "TEMPORAL_CLOUD_API_KEY",
] as const;

type TemporalEnv = Partial<Record<(typeof KEYS)[number], string>>;

function withTemporalEnv(values: TemporalEnv, run: () => void) {
  const previous = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolveTemporalConnectionEnv falls back to a plain local connection", () => {
  withTemporalEnv({}, () => {
    assert.deepEqual(resolveTemporalConnectionEnv(), {
      address: "localhost:7233",
      namespace: "default",
      apiKey: null,
      tls: false,
    });
    assert.equal(hasTemporalConnectionEnv(), false);
  });
});

test("resolveTemporalConnectionEnv prefers TEMPORAL_* over TEMPORAL_CLOUD_*", () => {
  withTemporalEnv(
    {
      TEMPORAL_ADDRESS: " temporal.internal:7233 ",
      TEMPORAL_CLOUD_ADDRESS: "cloud.example:7233",
      TEMPORAL_NAMESPACE: "primary",
      TEMPORAL_CLOUD_NAMESPACE: "cloud-ns",
      TEMPORAL_API_KEY: "primary-key",
      TEMPORAL_CLOUD_API_KEY: "cloud-key",
    },
    () => {
      assert.deepEqual(resolveTemporalConnectionEnv(), {
        address: "temporal.internal:7233",
        namespace: "primary",
        apiKey: "primary-key",
        tls: true,
      });
      assert.equal(hasTemporalConnectionEnv(), true);
    },
  );
});

test("resolveTemporalConnectionEnv uses TEMPORAL_CLOUD_* when TEMPORAL_* is blank", () => {
  withTemporalEnv(
    {
      TEMPORAL_ADDRESS: "  ",
      TEMPORAL_CLOUD_ADDRESS: "ns.acct.tmprl.cloud:7233",
      TEMPORAL_NAMESPACE: "",
      TEMPORAL_CLOUD_NAMESPACE: "ns.acct",
      TEMPORAL_CLOUD_API_KEY: " cloud-key ",
    },
    () => {
      assert.deepEqual(resolveTemporalConnectionEnv(), {
        address: "ns.acct.tmprl.cloud:7233",
        namespace: "ns.acct",
        apiKey: "cloud-key",
        tls: true,
      });
    },
  );
});

test("hasTemporalConnectionEnv requires both an address and a namespace", () => {
  withTemporalEnv({ TEMPORAL_ADDRESS: "temporal:7233" }, () => {
    assert.equal(hasTemporalConnectionEnv(), false);
  });
  withTemporalEnv(
    { TEMPORAL_CLOUD_ADDRESS: "temporal:7233", TEMPORAL_CLOUD_NAMESPACE: "ns" },
    () => {
      assert.equal(hasTemporalConnectionEnv(), true);
    },
  );
});

test("TLS turns on for *.api.temporal.io addresses even without a key", () => {
  for (const [address, tls] of [
    ["us-east-1.aws.api.temporal.io:7233", true],
    ["us-east-1.aws.API.TEMPORAL.IO", true],
    ["api.temporal.io.example.com:7233", false],
    ["temporal.internal:7233", false],
  ] as const) {
    withTemporalEnv(
      { TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: "ns" },
      () => {
        const connection = resolveTemporalConnectionEnv();
        assert.equal(connection.tls, tls, address);
        assert.equal(connection.apiKey, null);
      },
    );
  }
});

test("assertTemporalTlsApiKey throws the per-runtime message only for keyless TLS", () => {
  const keylessTls = {
    address: "x.api.temporal.io:7233",
    namespace: "ns",
    apiKey: null,
    tls: true,
  };
  assert.throws(
    () => assertTemporalTlsApiKey(keylessTls),
    (error: unknown) =>
      error instanceof Error &&
      error.message === TEMPORAL_TLS_API_KEY_REQUIRED_MESSAGE,
  );
  assert.equal(
    TEMPORAL_TLS_API_KEY_REQUIRED_MESSAGE,
    "TEMPORAL_API_KEY or TEMPORAL_CLOUD_API_KEY is required when using Temporal Cloud or a TLS Temporal endpoint",
  );
  assert.throws(() => assertTemporalTlsApiKey(keylessTls, "worker text"), {
    message: "worker text",
  });
  assert.doesNotThrow(() =>
    assertTemporalTlsApiKey({ ...keylessTls, apiKey: "key" }),
  );
  assert.doesNotThrow(() =>
    assertTemporalTlsApiKey({ ...keylessTls, tls: false }),
  );
});
