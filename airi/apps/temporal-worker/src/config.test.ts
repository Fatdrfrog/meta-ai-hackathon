import assert from "node:assert/strict";
import test from "node:test";

import { getTemporalWorkerConfig } from "./config";

const IDENTITY_ENV_KEYS = [
  "TEMPORAL_WORKER_IDENTITY",
  "TEMPORAL_WORKER_DEPLOYMENT_NAME",
  "TEMPORAL_WORKER_BUILD_ID",
  "K_REVISION",
  "K_SERVICE",
  "HOSTNAME",
] as const;

const REQUESTS_PROJECTION_ENV_KEYS = [
  "REQUESTS_PROJECTION_WRITER_ENABLED",
  "REQUESTS_PROJECTION_REALTIME_ENABLED",
  "MONGODB_MAX_POOL_SIZE",
  "MONGODB_APP_NAME",
] as const;

type IdentityEnvKey = (typeof IDENTITY_ENV_KEYS)[number];

function snapshotIdentityEnv(): Record<IdentityEnvKey, string | undefined> {
  return Object.fromEntries(
    IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<IdentityEnvKey, string | undefined>;
}

function restoreIdentityEnv(
  snapshot: Record<IdentityEnvKey, string | undefined>,
) {
  for (const key of IDENTITY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configureGeneratedIdentity() {
  delete process.env.TEMPORAL_WORKER_IDENTITY;
  process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME = "test-worker";
  process.env.TEMPORAL_WORKER_BUILD_ID = "test-build";
  process.env.K_REVISION = "test-revision";
  delete process.env.K_SERVICE;
  delete process.env.HOSTNAME;
}

function withRequestsProjectionEnv(
  values: Partial<
    Record<(typeof REQUESTS_PROJECTION_ENV_KEYS)[number], string>
  >,
  operation: () => void,
) {
  const snapshot = Object.fromEntries(
    REQUESTS_PROJECTION_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<
    (typeof REQUESTS_PROJECTION_ENV_KEYS)[number],
    string | undefined
  >;

  for (const key of REQUESTS_PROJECTION_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    operation();
  } finally {
    for (const key of REQUESTS_PROJECTION_ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("uses a process-specific UUID when the identity is not configured", () => {
  const env = snapshotIdentityEnv();
  configureGeneratedIdentity();

  try {
    assert.match(
      getTemporalWorkerConfig().identity,
      /^test-worker:test-revision:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  } finally {
    restoreIdentityEnv(env);
  }
});

test("keeps the generated worker identity stable for the process lifetime", () => {
  const env = snapshotIdentityEnv();
  configureGeneratedIdentity();

  try {
    const firstIdentity = getTemporalWorkerConfig().identity;
    const secondIdentity = getTemporalWorkerConfig().identity;

    assert.equal(secondIdentity, firstIdentity);
  } finally {
    restoreIdentityEnv(env);
  }
});

test("preserves an explicitly configured worker identity", () => {
  const env = snapshotIdentityEnv();
  process.env.TEMPORAL_WORKER_IDENTITY = "operator-managed-worker";
  process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME = "test-worker";
  process.env.TEMPORAL_WORKER_BUILD_ID = "test-build";

  try {
    assert.equal(getTemporalWorkerConfig().identity, "operator-managed-worker");
  } finally {
    restoreIdentityEnv(env);
  }
});

test("keeps both request projection infrastructure flags false by default", () => {
  withRequestsProjectionEnv({}, () => {
    const config = getTemporalWorkerConfig();

    assert.equal(config.requestsProjectionWriterEnabled, false);
    assert.equal(config.requestsProjectionRealtimeEnabled, false);
  });
});

test("accepts only canonical request projection Boolean spellings", () => {
  withRequestsProjectionEnv(
    {
      REQUESTS_PROJECTION_WRITER_ENABLED: "true",
      REQUESTS_PROJECTION_REALTIME_ENABLED: "false",
      MONGODB_MAX_POOL_SIZE: "12",
      MONGODB_APP_NAME: "airi-requests-projection-worker",
    },
    () => {
      const config = getTemporalWorkerConfig();
      assert.equal(config.requestsProjectionWriterEnabled, true);
      assert.equal(config.requestsProjectionRealtimeEnabled, false);
    },
  );

  for (const value of ["", "1", "yes", "on", "TRUE", " false "]) {
    withRequestsProjectionEnv(
      { REQUESTS_PROJECTION_WRITER_ENABLED: value },
      () => {
        assert.throws(
          () => getTemporalWorkerConfig(),
          /REQUESTS_PROJECTION_WRITER_ENABLED.*true.*false/i,
        );
      },
    );
  }
});

test("rejects realtime request projection publishing without the writer", () => {
  withRequestsProjectionEnv(
    { REQUESTS_PROJECTION_REALTIME_ENABLED: "true" },
    () => {
      assert.throws(
        () => getTemporalWorkerConfig(),
        /REQUESTS_PROJECTION_REALTIME_ENABLED.*writer/i,
      );
    },
  );
});

test("requires an explicit projection worker Mongo pool and app name", () => {
  const invalid = [
    {
      env: { REQUESTS_PROJECTION_WRITER_ENABLED: "true" },
      pattern: /MONGODB_MAX_POOL_SIZE.*12/i,
    },
    {
      env: {
        REQUESTS_PROJECTION_WRITER_ENABLED: "true",
        MONGODB_MAX_POOL_SIZE: "11",
        MONGODB_APP_NAME: "airi-requests-projection-worker",
      },
      pattern: /MONGODB_MAX_POOL_SIZE.*12/i,
    },
    {
      env: {
        REQUESTS_PROJECTION_WRITER_ENABLED: "true",
        MONGODB_MAX_POOL_SIZE: "12.5",
        MONGODB_APP_NAME: "airi-requests-projection-worker",
      },
      pattern: /MONGODB_MAX_POOL_SIZE.*integer/i,
    },
    {
      env: {
        REQUESTS_PROJECTION_WRITER_ENABLED: "true",
        MONGODB_MAX_POOL_SIZE: "12",
      },
      pattern: /MONGODB_APP_NAME/i,
    },
    {
      env: {
        REQUESTS_PROJECTION_WRITER_ENABLED: "true",
        MONGODB_MAX_POOL_SIZE: "12",
        MONGODB_APP_NAME: "icecore-web",
      },
      pattern: /MONGODB_APP_NAME.*worker/i,
    },
  ] as const;

  for (const fixture of invalid) {
    withRequestsProjectionEnv(fixture.env, () => {
      assert.throws(() => getTemporalWorkerConfig(), fixture.pattern);
    });
  }
});
