import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(
  ".github/scripts/prepare-cloud-run-runtime.mjs",
);
const realManifestPath = path.resolve(
  ".github/cloud-run/runtime-manifest.json",
);
const deployWorkflowPath = path.resolve(
  ".github/workflows/deploy-temporal-worker.yml",
);
const dockerIgnorePath = path.resolve(".dockerignore");

test("standalone dispatcher retirement requires an explicitly enabled embedded owner", async () => {
  const { resolveRealtimeDispatcherInstanceCount } = await import(
    "./prepare-cloud-run-runtime.mjs"
  );
  assert.equal(resolveRealtimeDispatcherInstanceCount({}), 1);
  assert.equal(
    resolveRealtimeDispatcherInstanceCount({
      GCP_REALTIME_DISPATCHER_INSTANCES: "2",
    }),
    2,
  );
  assert.equal(
    resolveRealtimeDispatcherInstanceCount({
      GCP_REALTIME_DISPATCHER_INSTANCES: "0",
      REALTIME_DISPATCHER_ENABLED: "true",
    }),
    0,
  );
  for (const value of ["0", "-1", "1.5", "unsafe", "9007199254740992"]) {
    assert.throws(() =>
      resolveRealtimeDispatcherInstanceCount({
        GCP_REALTIME_DISPATCHER_INSTANCES: value,
      }),
    );
  }
  assert.throws(() =>
    resolveRealtimeDispatcherInstanceCount({
      GCP_REALTIME_DISPATCHER_INSTANCES: "0",
      REALTIME_DISPATCHER_ENABLED: "false",
    }),
  );
});

function createManifest(dir) {
  const manifestPath = path.join(dir, "runtime-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        worker: {
          fixedVars: { AIRI_RUNTIME_MODE: "worker" },
          vars: ["WORKER_REQUIRED"],
          secrets: [],
        },
        gateway: {
          fixedVars: { AIRI_RUNTIME_MODE: "ai-gateway" },
          vars: ["GATEWAY_REQUIRED"],
          secrets: [],
        },
        otpWorker: {
          fixedVars: { AIRI_RUNTIME_MODE: "otp-worker" },
          vars: ["OTP_WORKER_REQUIRED"],
          secrets: [],
        },
        otpApi: {
          fixedVars: { AIRI_RUNTIME_MODE: "otp-api" },
          vars: ["MEMORYSTORE_VALKEY_HOST"],
          secrets: [],
        },
        realtimeGateway: {
          fixedVars: { AIRI_RUNTIME_MODE: "realtime-gateway" },
          vars: ["MEMORYSTORE_VALKEY_HOST"],
          secrets: ["REALTIME_TOKEN_SECRET"],
        },
        realtimeDispatcher: {
          fixedVars: { AIRI_RUNTIME_MODE: "realtime-dispatcher" },
          vars: ["MEMORYSTORE_VALKEY_HOST"],
          secrets: ["MONGODB_URI"],
        },
      },
      null,
      2,
    ),
  );
  return manifestPath;
}

function runPrepare(args, env = {}) {
  return spawnSync("node", [scriptPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GCP_PROJECT_ID: "project-1",
      WORKER_REQUIRED: "worker-value",
      GATEWAY_REQUIRED: "gateway-value",
      OTP_WORKER_REQUIRED: "otp-worker-value",
      ...env,
    },
  });
}

test("worker preparation requires the shared capacity store and keeps its token secret", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airi-capacity-runtime-"));
  const manifestPath = createManifest(dir);
  const fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const configuration = {
    vars: "UPSTASH_REDIS_REST_URL",
    secrets: "UPSTASH_REDIS_REST_TOKEN",
  };
  for (const [kind, name] of Object.entries(configuration)) {
    const entry = manifest.worker[kind].find(
      (value) => (typeof value === "string" ? value : value.name) === name,
    );
    assert.ok(entry, `worker must declare ${name}`);
    assert.notEqual(entry.optional, true, `${name} must be required`);
    fixture.worker[kind].push(entry);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(fixture));
  const outDir = path.join(dir, "out");
  const args = [
    "--manifest",
    manifestPath,
    "--runtime",
    "worker",
    "--out-dir",
    outDir,
  ];
  const env = {
    CLOUD_RUN_SKIP_SECRET_SYNC: "0",
    UPSTASH_REDIS_REST_URL: "https://capacity.example",
    UPSTASH_REDIS_REST_TOKEN: "contract-capacity-token",
  };
  for (const name of Object.values(configuration)) {
    const missing = runPrepare(args, { ...env, [name]: "" });
    assert.notEqual(missing.status, 0);
    assert.match(
      missing.stderr,
      new RegExp(`Missing required runtime value for ${name}`),
    );
  }

  const configured = runPrepare([...args, "--skip-secret-sync"], env);
  assert.equal(configured.status, 0, configured.stderr);
  const workerEnv = fs.readFileSync(path.join(outDir, "worker.env"), "utf8");
  const workerSecrets = fs.readFileSync(
    path.join(outDir, "worker.secrets"),
    "utf8",
  );
  const metadata = fs.readFileSync(path.join(outDir, "metadata.json"), "utf8");
  assert.match(workerEnv, /^UPSTASH_REDIS_REST_URL=https:\/\/capacity\.example$/m);
  assert.doesNotMatch(workerEnv, /UPSTASH_REDIS_REST_TOKEN/);
  assert.match(
    workerSecrets,
    /^UPSTASH_REDIS_REST_TOKEN\|UPSTASH_REDIS_REST_TOKEN\|UPSTASH_REDIS_REST_TOKEN$/m,
  );
  assert.match(
    JSON.parse(metadata).worker.setSecretsArg,
    /UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest/,
  );
  for (const output of [workerEnv, workerSecrets, metadata]) {
    assert.ok(!output.includes(env.UPSTASH_REDIS_REST_TOKEN));
  }

  const existingSecret = runPrepare([...args, "--skip-secret-sync"], {
    ...env,
    UPSTASH_REDIS_REST_TOKEN: "",
  });
  assert.equal(existingSecret.status, 0, existingSecret.stderr);
  const existingMetadata = JSON.parse(
    fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"),
  );
  assert.match(
    existingMetadata.worker.setSecretsArg,
    /UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest/,
  );
});

test("cost rollout choices reach only their selected runtime without enabling them by default", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airi-cost-runtime-"));
  const manifestPath = createManifest(dir);
  const fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expected = {
    worker: [
      "REALTIME_DISPATCHER_ENABLED",
      "VERTEX_GEMINI_HEAVY_MODEL",
      "GCP_LLM_ANALYTICS_MAX_BYTES_BILLED",
    ],
    gateway: ["GCP_LLM_ANALYTICS_MAX_BYTES_BILLED"],
  };
  for (const [runtime, names] of Object.entries(expected)) {
    for (const name of names) {
      const entry = manifest[runtime].vars.find((value) => value.name === name);
      assert.ok(entry?.optional, `${runtime}.${name} must be optional`);
      assert.equal(manifest[runtime].fixedVars[name], undefined);
      fixture[runtime].vars.push(entry);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(fixture));
  const outDir = path.join(dir, "out");
  const args = [
    "--manifest",
    manifestPath,
    "--runtime",
    "worker,gateway,realtimeGateway",
    "--out-dir",
    outDir,
    "--skip-secret-sync",
  ];
  const baseEnv = { MEMORYSTORE_VALKEY_HOST: "127.0.0.1" };
  const baseline = runPrepare(args, baseEnv);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.doesNotMatch(
    fs.readFileSync(path.join(outDir, "worker.env"), "utf8"),
    /REALTIME_DISPATCHER_ENABLED/,
  );
  const configured = runPrepare(args, {
    ...baseEnv,
    REALTIME_DISPATCHER_ENABLED: "true",
    VERTEX_GEMINI_HEAVY_MODEL: "gemini-3.5-flash",
    GCP_LLM_ANALYTICS_MAX_BYTES_BILLED: "1073741824",
  });
  assert.equal(configured.status, 0, configured.stderr);
  const worker = fs.readFileSync(path.join(outDir, "worker.env"), "utf8");
  const gateway = fs.readFileSync(path.join(outDir, "gateway.env"), "utf8");
  const realtime = fs.readFileSync(
    path.join(outDir, "realtimeGateway.env"),
    "utf8",
  );
  assert.match(worker, /REALTIME_DISPATCHER_ENABLED.*true/);
  assert.match(worker, /VERTEX_GEMINI_HEAVY_MODEL.*gemini-3\.5-flash/);
  assert.match(gateway, /GCP_LLM_ANALYTICS_MAX_BYTES_BILLED.*1073741824/);
  assert.doesNotMatch(
    gateway,
    /REALTIME_DISPATCHER_ENABLED|VERTEX_GEMINI_HEAVY_MODEL/,
  );
  assert.doesNotMatch(
    realtime,
    /REALTIME_DISPATCHER_ENABLED|GCP_LLM_ANALYTICS_MAX_BYTES_BILLED/,
  );
});

test("Claude text settings reach the worker as optional env and the API key only as a secret reference", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airi-claude-runtime-"));
  const manifestPath = createManifest(dir);
  const fixture = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const optionalVars = {
    AI_CHAT_PROVIDER_ORDER: "anthropic,vertex",
    ANTHROPIC_AI_ENABLED: "true",
    ANTHROPIC_LIGHT_MODEL: "claude-haiku-4-5",
    ANTHROPIC_HEAVY_MODEL: "claude-sonnet-5-5",
    ANTHROPIC_REASONING_MODEL: "claude-opus-5-5",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_contract",
  };
  for (const name of Object.keys(optionalVars)) {
    const entry = manifest.worker.vars.find((value) => value.name === name);
    assert.ok(entry?.optional, `worker.${name} must be optional`);
    fixture.worker.vars.push(entry);
  }
  const secretEntry = manifest.worker.secrets.find(
    (value) => value.name === "ANTHROPIC_API_KEY",
  );
  assert.ok(secretEntry?.optional, "worker ANTHROPIC_API_KEY must be optional");
  fixture.worker.secrets.push(secretEntry);
  fs.writeFileSync(manifestPath, JSON.stringify(fixture));

  const outDir = path.join(dir, "out");
  const args = [
    "--manifest",
    manifestPath,
    "--runtime",
    "worker,gateway",
    "--out-dir",
    outDir,
    "--skip-secret-sync",
  ];
  const unsetEnv = Object.fromEntries(
    ["ANTHROPIC_API_KEY", ...Object.keys(optionalVars)].map((name) => [
      name,
      "",
    ]),
  );
  const readOutputs = () => ({
    workerEnv: fs.readFileSync(path.join(outDir, "worker.env"), "utf8"),
    workerSecrets: fs.readFileSync(path.join(outDir, "worker.secrets"), "utf8"),
    gatewayEnv: fs.readFileSync(path.join(outDir, "gateway.env"), "utf8"),
    metadata: JSON.parse(
      fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"),
    ),
  });

  const baseline = runPrepare(args, unsetEnv);
  assert.equal(baseline.status, 0, baseline.stderr);
  const unset = readOutputs();
  assert.doesNotMatch(unset.workerEnv, /ANTHROPIC_|AI_CHAT_PROVIDER_ORDER/);
  assert.doesNotMatch(unset.workerSecrets, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(unset.metadata.worker.setSecretsArg, /ANTHROPIC_API_KEY/);

  const configured = runPrepare(args, {
    ...optionalVars,
    ANTHROPIC_API_KEY: "contract-anthropic-key",
  });
  assert.equal(configured.status, 0, configured.stderr);
  const outputs = readOutputs();
  for (const [name, value] of Object.entries(optionalVars)) {
    assert.ok(
      outputs.workerEnv.split("\n").includes(`${name}=${value}`),
      `${name} must reach the worker env`,
    );
    assert.doesNotMatch(outputs.gatewayEnv, new RegExp(name));
  }
  assert.doesNotMatch(outputs.workerEnv, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(
    JSON.stringify(outputs),
    /contract-anthropic-key/,
    "the API key value must never be written to runtime config files",
  );
  assert.ok(
    outputs.workerSecrets
      .split("\n")
      .includes("ANTHROPIC_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_API_KEY"),
  );
  assert.match(
    outputs.metadata.worker.setSecretsArg,
    /(?:^|,)ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest(?:,|$)/,
  );
  assert.doesNotMatch(outputs.metadata.gateway.setSecretsArg, /ANTHROPIC/);
});

test("selected runtimes do not require disabled runtime values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifest = createManifest(dir);
  const outDir = path.join(dir, "out");

  const result = runPrepare([
    "--manifest",
    manifest,
    "--out-dir",
    outDir,
    "--skip-secret-sync",
    "--runtime",
    "worker",
    "--runtime",
    "gateway",
    "--runtime",
    "otpWorker",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outDir, "worker.env")), true);
  assert.equal(fs.existsSync(path.join(outDir, "gateway.env")), true);
  assert.equal(fs.existsSync(path.join(outDir, "otpWorker.env")), true);
  assert.equal(fs.existsSync(path.join(outDir, "otpApi.env")), false);
});

test("ElevenLabs async STT requires webhook id and HMAC secret together", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifest = createManifest(dir);
  const outDir = path.join(dir, "out");
  const args = [
    "--manifest",
    manifest,
    "--out-dir",
    outDir,
    "--skip-secret-sync",
    "--runtime",
    "worker",
  ];

  const missingSecret = runPrepare(args, {
    ELEVENLABS_STT_WEBHOOK_ID: "webhook-1",
    ELEVENLABS_STT_WEBHOOK_SECRET: "",
  });
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /must be configured together/);

  const configured = runPrepare(args, {
    ELEVENLABS_STT_WEBHOOK_ID: "webhook-1",
    ELEVENLABS_STT_WEBHOOK_SECRET: "secret-1",
  });
  assert.equal(configured.status, 0, configured.stderr);
});

test("selected otpApi runtime still requires a Valkey endpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifest = createManifest(dir);
  const outDir = path.join(dir, "out");

  const result = runPrepare([
    "--manifest",
    manifest,
    "--out-dir",
    outDir,
    "--skip-secret-sync",
    "--runtime",
    "otpApi",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Missing required runtime value for MEMORYSTORE_VALKEY_HOST/,
  );
});

test("skip secret sync references required precreated secrets without local values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifestPath = path.join(dir, "runtime-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        worker: {
          fixedVars: { AIRI_RUNTIME_MODE: "worker" },
          vars: ["WORKER_REQUIRED"],
          secrets: ["WORKER_SECRET"],
        },
      },
      null,
      2,
    ),
  );
  const outDir = path.join(dir, "out");

  const result = runPrepare([
    "--manifest",
    manifestPath,
    "--out-dir",
    outDir,
    "--skip-secret-sync",
    "--runtime",
    "worker",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"),
  );
  assert.equal(
    metadata.worker.setSecretsArg,
    "WORKER_SECRET=WORKER_SECRET:latest",
  );
});

test("skip secret sync references only opted-in optional precreated secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifestPath = path.join(dir, "runtime-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        worker: {
          fixedVars: { AIRI_RUNTIME_MODE: "worker" },
          vars: ["WORKER_REQUIRED"],
          secrets: [
            { name: "OMITTED_OPTIONAL_SECRET", optional: true },
            {
              name: "PRECREATED_OPTIONAL_SECRET",
              optional: true,
              referenceWhenSkippingSync: true,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  const outDir = path.join(dir, "out");

  const result = runPrepare([
    "--manifest",
    manifestPath,
    "--out-dir",
    outDir,
    "--skip-secret-sync",
    "--runtime",
    "worker",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"),
  );
  assert.equal(
    metadata.worker.setSecretsArg,
    "PRECREATED_OPTIONAL_SECRET=PRECREATED_OPTIONAL_SECRET:latest",
  );
});

test("Docker context declares nested environment files private", () => {
  const patterns = fs
    .readFileSync(dockerIgnorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert.equal(patterns.includes("**/.env*"), true);
});

test("selected realtime runtimes require Valkey and token secret config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-runtime-"));
  const manifest = createManifest(dir);
  const outDir = path.join(dir, "out");

  const missingSecret = runPrepare(
    [
      "--manifest",
      manifest,
      "--out-dir",
      outDir,
      "--runtime",
      "realtimeGateway",
    ],
    { MEMORYSTORE_VALKEY_HOST: "10.0.0.2" },
  );

  assert.notEqual(missingSecret.status, 0);
  assert.match(
    missingSecret.stderr,
    /Missing required runtime value for REALTIME_TOKEN_SECRET/,
  );

  const ready = runPrepare(
    [
      "--manifest",
      manifest,
      "--out-dir",
      outDir,
      "--skip-secret-sync",
      "--runtime",
      "realtimeGateway",
      "--runtime",
      "realtimeDispatcher",
    ],
    {
      MEMORYSTORE_VALKEY_HOST: "10.0.0.2",
      REALTIME_TOKEN_SECRET: "token-secret",
      MONGODB_URI: "mongodb://example",
    },
  );

  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(fs.existsSync(path.join(outDir, "realtimeGateway.env")), true);
  assert.equal(
    fs.existsSync(path.join(outDir, "realtimeDispatcher.env")),
    true,
  );
});

test("real worker manifest exposes WhatsApp call media and Pub/Sub runtime values", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const worker = manifest.worker;
  const varNames = new Set(
    (worker.vars || []).map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
  );
  const secretNames = new Set(
    (worker.secrets || []).map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
  );

  for (const name of [
    "WHATSAPP_CALL_PUBSUB_ENABLED",
    "WHATSAPP_CALL_PUBSUB_PROJECT_ID",
    "WHATSAPP_CALL_PUBSUB_TOPIC",
    "WHATSAPP_CALL_PUBSUB_SUBSCRIPTION",
    "WHATSAPP_CALL_PUBSUB_MAX_MESSAGES",
    "WHATSAPP_CALL_COMMAND_TIMEOUT_SECONDS",
    "WHATSAPP_CALL_RECORDING_BUCKET",
    "WHATSAPP_CALL_RECORDING_EGRESS_ENABLED",
    "WHATSAPP_CALL_RECORDING_FILE_TYPE",
    "WHATSAPP_CALL_RECORDING_RETENTION_DAYS",
    "WHATSAPP_CALL_RECORDING_PIPELINE_ENABLED",
    "WHATSAPP_CALL_RECORDING_PIPELINE_URL",
    "WHATSAPP_CALL_RECORDING_WEBHOOK_URL",
    "WHATSAPP_CALL_TRANSCRIPTION_ENABLED",
    "WHATSAPP_CALL_TRANSCRIPTION_PROJECT_ID",
    "WHATSAPP_CALL_TRANSCRIPTION_LOCATION",
    "WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES",
    "WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE",
    "WHATSAPP_CALL_TRANSCRIPTION_MODEL",
    "WHATSAPP_CALL_TRANSCRIPTION_RECOGNIZER",
    "WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ENABLED",
    "WHATSAPP_CALL_TRANSCRIPTION_DRAIN_LIMIT",
    "WHATSAPP_CALL_ANALYTICS_ENABLED",
    "WHATSAPP_CALL_ANALYTICS_PROJECT_ID",
    "WHATSAPP_CALL_ANALYTICS_TOPIC",
    "AIRI_MEDIA_TASK_QUEUE",
    "AIRI_MEDIA_WORKER_ENABLED",
    "AIRI_MEDIA_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS",
    "AIRI_MEDIA_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_POLLS",
    "AIRI_MEDIA_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS",
    "AIRI_MEDIA_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_POLLS",
    "ELEVENLABS_STT_ENABLED",
    "ELEVENLABS_STT_MODEL",
    "ELEVENLABS_STT_WEBHOOK_ID",
    "ELEVENLABS_TIMEOUT_MS",
    "LIVEKIT_URL",
    "LIVEKIT_WHATSAPP_CLOUD_API_VERSION",
    "LIVEKIT_MEDIA_TOKEN_TTL_SECONDS",
    "LIVEKIT_EGRESS_TOKEN_TTL_SECONDS",
  ]) {
    assert.equal(varNames.has(name), true, `missing worker var ${name}`);
  }

  assert.equal(secretNames.has("LIVEKIT_API_KEY"), true);
  assert.equal(secretNames.has("LIVEKIT_API_SECRET"), true);
  assert.equal(secretNames.has("LIVEKIT_EGRESS_GCP_CREDENTIALS_JSON"), true);
  assert.equal(secretNames.has("BRIA_API_TOKEN"), true);
  assert.equal(secretNames.has("ELEVENLABS_API_KEY"), true);
  assert.equal(
    secretNames.has("WHATSAPP_CALL_TRANSCRIPTION_SERVICE_ACCOUNT_JSON"),
    true,
  );

  for (const name of [
    "AIRI_GREEN_SCREEN_MATTING_COMMAND",
    "AIRI_GREEN_SCREEN_MAX_SOURCE_BYTES",
    "AIRI_GREEN_SCREEN_MAX_OUTPUT_BYTES",
    "AIRI_GREEN_SCREEN_MAX_DURATION_SECONDS",
    "AIRI_GREEN_SCREEN_MAX_FRAMES",
    "AIRI_GREEN_SCREEN_MAX_FPS",
    "AIRI_GREEN_SCREEN_PROCESS_TIMEOUT_MS",
  ]) {
    assert.equal(varNames.has(name), false, `unexpected worker var ${name}`);
  }
});

test("real media API manifest owns signed ElevenLabs webhook ingress and Temporal signaling", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const mediaApi = manifest.mediaApi;
  const varNames = new Set(
    (mediaApi.vars || []).map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
  );
  const secretNames = new Set(
    (mediaApi.secrets || []).map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
  );

  assert.equal(varNames.has("TEMPORAL_ADDRESS"), true);
  assert.equal(varNames.has("TEMPORAL_NAMESPACE"), true);
  assert.equal(secretNames.has("TEMPORAL_API_KEY"), true);
  assert.equal(secretNames.has("ELEVENLABS_STT_WEBHOOK_SECRET"), true);
  const webhookSecret = (mediaApi.secrets || []).find(
    (entry) =>
      typeof entry === "object" &&
      entry?.name === "ELEVENLABS_STT_WEBHOOK_SECRET",
  );
  assert.equal(webhookSecret?.optional, true);
});

test("media API generation supplies storage admission configuration and secret references", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airi-media-admission-"));
  try {
    const result = runPrepare([
      "--manifest", realManifestPath,
      "--out-dir", dir,
      "--runtime", "mediaApi",
      "--skip-secret-sync",
    ], {
      GCP_PROJECT_ID: "project-1",
      GOOGLE_CLOUD_PROJECT: "project-1",
      AI_GATEWAY_VERCEL_OIDC_ISSUER_URL: "https://issuer.example",
      AI_GATEWAY_VERCEL_OIDC_AUDIENCE: "audience",
      AI_GATEWAY_VERCEL_OIDC_SUBJECTS: "subject",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      TEMPORAL_CLOUD_ADDRESS: "temporal.example:7233",
      TEMPORAL_CLOUD_NAMESPACE: "test.namespace",
      STORAGE_QUOTA_ROLLOUT_MODE: "record",
    });
    assert.equal(result.status, 0, result.stderr);
    const envFile = fs.readFileSync(path.join(dir, "mediaApi.env"), "utf8");
    assert.match(envFile, /STORAGE_QUOTA_ROLLOUT_MODE.*record/);
    assert.match(envFile, /NEXT_PUBLIC_SUPABASE_URL.*example.supabase.co/);
    const secrets = fs.readFileSync(path.join(dir, "mediaApi.secrets"), "utf8");
    assert.match(secrets, /^MONGODB_URI\|MONGODB_URI\|MONGODB_URI$/m);
    assert.match(secrets, /^SUPABASE_SERVICE_ROLE_KEY\|SUPABASE_SERVICE_ROLE_KEY\|SUPABASE_SERVICE_ROLE_KEY$/m);
    assert.doesNotMatch(envFile, /SUPABASE_SERVICE_ROLE_KEY|MONGODB_URI/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real worker manifest owns the customer WhatsApp priority subscriber", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));

  assert.equal(manifest.whatsappFastWebhookConsumer, undefined);
  const workerVars = new Set(
    manifest.worker.vars.map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
  );
  assert.equal(workerVars.has("WHATSAPP_FAST_WEBHOOK_PUBSUB_ENABLED"), true);
  assert.equal(
    workerVars.has("WHATSAPP_FAST_WEBHOOK_PUBSUB_SUBSCRIPTION"),
    true,
  );
  for (const name of [
    "WHATSAPP_FAST_LANE_PUBSUB_ENABLED",
    "WHATSAPP_FAST_LANE_PUBSUB_SUBSCRIPTION",
    "WHATSAPP_FAST_LANE_PUBSUB_MAX_MESSAGES",
  ]) {
    assert.equal(workerVars.has(name), true, name);
  }
});

test("retired telemetry is absent from all Cloud Run runtime configurations", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  for (const runtime of Object.values(manifest)) {
    assert.equal(
      Object.keys(runtime.fixedVars || {}).some((key) => key.startsWith("DD_")),
      false,
    );
    assert.equal(
      (runtime.secrets || []).some((entry) =>
        (typeof entry === "string" ? entry : entry.name).startsWith("DD_"),
      ),
      false,
    );
  }
  assert.doesNotMatch(
    fs.readFileSync(deployWorkflowPath, "utf8"),
    /DD_API_KEY|DD_APP_KEY|sync-datadog/,
  );
});

test("real worker manifest owns the complete paused classification rollout values", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  const classificationVars = (manifest.worker.vars || [])
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .filter((name) => name.startsWith("CONVERSATION_CLASSIFICATION_"));

  assert.deepEqual(classificationVars, [
    "CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED",
    "CONVERSATION_CLASSIFICATION_PUBSUB_ENABLED",
    "CONVERSATION_CLASSIFICATION_WORKSPACE_ALLOWLIST",
    "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
    "CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC",
    "CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION",
    "CONVERSATION_CLASSIFICATION_PUBSUB_MAX_MESSAGES",
  ]);
  assert.equal(manifest.conversationClassificationConsumer, undefined);
});

test("deploy workflow provisions isolated WhatsApp call Pub/Sub resources", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");

  for (const name of [
    "WHATSAPP_CALL_PUBSUB_SKIP_SETUP",
    "WHATSAPP_CALL_PUBSUB_TOPIC",
    "WHATSAPP_CALL_PUBSUB_SUBSCRIPTION",
    "WHATSAPP_CALL_PUBSUB_DLQ_TOPIC",
    "WHATSAPP_CALL_PUBSUB_DLQ_SUBSCRIPTION",
    "WHATSAPP_CALL_PUBSUB_SKIP_IAM_BINDINGS",
  ]) {
    assert.match(workflow, new RegExp(name));
  }

  assert.match(workflow, /icecore-whatsapp-call-events/);
  assert.match(workflow, /icecore-whatsapp-call-events-worker/);
  assert.match(workflow, /icecore-whatsapp-call-events-dlq/);
});

test("deploy workflow provisions the dedicated fast inbound Pub/Sub lane", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");

  for (const name of [
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_SKIP_SETUP",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_SUBSCRIPTION",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_DLQ_TOPIC",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_DLQ_SUBSCRIPTION",
    "WHATSAPP_FAST_WEBHOOK_PUBSUB_SKIP_IAM_BINDINGS",
  ]) {
    assert.match(workflow, new RegExp(name));
  }

  assert.match(workflow, /icecore-whatsapp-fast-events/);
  assert.match(workflow, /icecore-whatsapp-fast-events-worker/);
  assert.match(workflow, /icecore-whatsapp-fast-events-dlq/);
  assert.match(workflow, /WHATSAPP_FAST_WEBHOOK_PUBSUB_TOPIC/);
});

test("deploy workflow reuses the existing worker pool for fast WhatsApp inbounds", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");

  for (const value of [
    "GCP_WHATSAPP_FAST_WEBHOOK_CONSUMER_POOL_NAME",
    "whatsappFastWebhookConsumer",
    "Deploy Cloud Run WhatsApp fast webhook consumer worker pool",
    "Wait for WhatsApp fast webhook consumer worker pool rollout",
  ]) {
    assert.doesNotMatch(workflow, new RegExp(value));
  }
});

test("deploy workflow prepares realtime Cloud Run runtime config", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");
  const deployStart = workflow.indexOf("Deploy Cloud Run realtime gateway");
  const deployEnd = workflow.indexOf(
    "Verify realtime gateway health",
    deployStart,
  );
  const realtimeDeployBlock = workflow.slice(deployStart, deployEnd);

  assert.match(workflow, /--runtime realtimeGateway/);
  assert.match(workflow, /--runtime realtimeDispatcher/);
  assert.match(workflow, /realtimeGateway\.env/);
  assert.match(workflow, /realtimeDispatcher\.env/);
  assert.match(workflow, /\$\{realtime_gateway_url\}\/readyz/);
  assert.doesNotMatch(workflow, /\$\{realtime_gateway_url\}\/healthz/);
  assert.match(workflow, /Sync Vercel runtime env/);
  assert.match(workflow, /sync-vercel-runtime-env\.mjs/);
  assert.match(workflow, /REALTIME_GATEWAY_URL/);
  assert.match(realtimeDeployBlock, /--no-invoker-iam-check/);
  assert.doesNotMatch(realtimeDeployBlock, /--allow-unauthenticated/);
});

test("deploy workflow requires a new Vercel production deployment after env sync", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");

  assert.match(
    workflow,
    /::warning title=Vercel production redeploy required::/,
  );
  assert.match(workflow, /Mandatory next step: redeploy Vercel production/);
});

test("deploy workflow gives main worker private Valkey network access", () => {
  const workflow = fs.readFileSync(deployWorkflowPath, "utf8");
  const deployStart = workflow.indexOf("Deploy Cloud Run worker pool");
  const deployEnd = workflow.indexOf(
    "Wait for Cloud Run worker pool rollout",
    deployStart,
  );
  const workerDeployBlock = workflow.slice(deployStart, deployEnd);

  assert.match(workerDeployBlock, /GCP_WORKER_VPC_NETWORK/);
  assert.match(workerDeployBlock, /GCP_REALTIME_VPC_NETWORK/);
  assert.match(workerDeployBlock, /--network="\$\{WORKER_NETWORK\}"/);
  assert.match(workerDeployBlock, /--vpc-egress=private-ranges-only/);
  assert.match(workerDeployBlock, /--subnet="\$\{WORKER_SUBNET\}"/);
});

test("secret sync helpers skip unchanged values and keep only latest version", async () => {
  const { secretValuesEqual, selectSecretVersionsToDestroy } = await import(
    "./prepare-cloud-run-runtime.mjs"
  );

  assert.equal(secretValuesEqual("abc", "abc"), true);
  assert.equal(secretValuesEqual("abc", "abc\n"), false);
  assert.equal(secretValuesEqual(null, ""), true);

  assert.deepEqual(selectSecretVersionsToDestroy(["3", "1", "2"]), ["2", "1"]);
  assert.deepEqual(selectSecretVersionsToDestroy(["10"]), []);
  assert.deepEqual(selectSecretVersionsToDestroy(["7", "latest", "6"]), ["6"]);
});

test("analytics projection is activated only in the existing main worker", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
  for (const [runtimeName, runtime] of Object.entries(manifest)) {
    assert.equal(
      runtime.fixedVars?.ANALYTICS_PROJECTION_ENABLED,
      runtimeName === "worker" ? "true" : undefined,
      `unexpected analytics activation for ${runtimeName}`,
    );
  }
});

test("Requests projection manifest activates the checkpoint-gated runtime", () => {
  const manifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));

  assert.deepEqual(manifest.worker.requestsReadModelMetadata, {
    state: "live",
  });
  assert.equal(
    manifest.worker.fixedVars.REQUESTS_PROJECTION_WRITER_ENABLED,
    "true",
  );
  assert.equal(
    manifest.worker.fixedVars.REQUESTS_PROJECTION_REALTIME_ENABLED,
    "true",
  );
  assert.ok(Number(manifest.worker.fixedVars.MONGODB_MAX_POOL_SIZE) >= 12);
  assert.equal(
    manifest.realtimeDispatcher.fixedVars.MONGODB_APP_NAME,
    "icecore-realtime-dispatcher",
  );
  assert.ok(
    Number(manifest.realtimeDispatcher.fixedVars.MONGODB_MAX_POOL_SIZE) >= 12,
  );
  assert.equal(manifest.realtimeDispatcher.manualInstanceCount, 1);
  assert.deepEqual(manifest.realtimeDispatcher.instanceSplit, { LATEST: 100 });
});

test("runtime generation derives Requests flags only from source-controlled state", async () => {
  const { deriveRequestsProjectionRuntime } = await import(
    "./prepare-cloud-run-runtime.mjs"
  );
  assert.deepEqual(deriveRequestsProjectionRuntime({ state: "disabled" }), {
    writerEnabled: false,
    realtimeEnabled: false,
  });
  assert.deepEqual(deriveRequestsProjectionRuntime({ state: "shadow" }), {
    writerEnabled: true,
    realtimeEnabled: false,
  });
  assert.deepEqual(deriveRequestsProjectionRuntime({ state: "live" }), {
    writerEnabled: true,
    realtimeEnabled: true,
  });
});
