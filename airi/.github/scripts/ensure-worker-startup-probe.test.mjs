import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkerPoolCommands,
  buildWorkerStartupProbe,
  ensureWorkerStartupProbe,
  planWorkerStartupProbe,
  toReplaceableWorkerPool,
} from "./ensure-worker-startup-probe.mjs";

const probe = buildWorkerStartupProbe({ port: 8080 });

function describedPool(container = {}) {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "WorkerPool",
    metadata: {
      annotations: {
        "run.googleapis.com/client-name": "gcloud",
        "run.googleapis.com/client-version": "574.0.0",
        "run.googleapis.com/manualInstanceCount": "2",
        "run.googleapis.com/operation-id": "operation-1",
        "run.googleapis.com/scalingMode": "manual",
        "serving.knative.dev/creator": "deployer@example.com",
        "serving.knative.dev/lastModifier": "deployer@example.com",
      },
      creationTimestamp: "2026-01-01T00:00:00Z",
      generation: 578,
      labels: { "cloud.googleapis.com/location": "europe-west1" },
      name: "worker",
      namespace: "123",
      resourceVersion: "version-1",
      selfLink: "/apis/run.googleapis.com/v1/namespaces/123/workerpools/worker",
      uid: "uid-1",
    },
    spec: {
      instanceSplits: [{ latestRevision: true, percent: 100 }],
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/vpc-access-egress": "private-ranges-only",
          },
          labels: { "client.knative.dev/nonce": "nonce-1" },
        },
        spec: {
          containerConcurrency: 0,
          containers: [
            {
              name: "worker-1",
              image: "example/worker:build",
              env: [
                { name: "PLAIN", value: "1" },
                {
                  name: "SECRET",
                  valueFrom: {
                    secretKeyRef: { name: "secret", key: "latest" },
                  },
                },
              ],
              resources: { limits: { cpu: "1", memory: "2Gi" } },
              ...container,
            },
          ],
          serviceAccountName: "worker@example.iam.gserviceaccount.com",
        },
      },
    },
    status: {
      latestReadyRevisionName: "worker-00578",
      observedGeneration: 578,
    },
  };
}

test("builds a TCP startup probe inside Cloud Run's 240 s limit", () => {
  assert.deepEqual(probe, {
    tcpSocket: { port: 8080 },
    initialDelaySeconds: 0,
    timeoutSeconds: 1,
    periodSeconds: 2,
    failureThreshold: 120,
  });
  assert.throws(
    () => buildWorkerStartupProbe({ port: 8080, periodSeconds: 3 }),
    /at most 240 s/,
  );
  assert.throws(
    () =>
      buildWorkerStartupProbe({
        port: 8080,
        periodSeconds: 1,
        timeoutSeconds: 2,
      }),
    /timeout cannot exceed/,
  );
  for (const port of [0, 70_000, "http"]) {
    assert.throws(() => buildWorkerStartupProbe({ port }), /TCP port/);
  }
});

test("turns the described pool into the exported shape replace accepts", () => {
  const described = describedPool();
  const pool = toReplaceableWorkerPool(described);

  assert.equal(pool.status, undefined);
  assert.deepEqual(pool.metadata, {
    annotations: {
      "run.googleapis.com/manualInstanceCount": "2",
      "run.googleapis.com/scalingMode": "manual",
    },
    labels: { "cloud.googleapis.com/location": "europe-west1" },
    name: "worker",
    namespace: "123",
  });
  assert.deepEqual(pool.spec, described.spec);
  assert.equal(described.status.observedGeneration, 578, "input untouched");
});

test("adds the probe to the only container and changes nothing else", () => {
  const pool = toReplaceableWorkerPool(describedPool());
  const plan = planWorkerStartupProbe(pool, { enabled: true, probe });

  assert.equal(plan.action, "added");
  const [container] = plan.pool.spec.template.spec.containers;
  assert.deepEqual(container.startupProbe, probe);
  delete container.startupProbe;
  assert.deepEqual(plan.pool, pool);
  assert.equal(
    pool.spec.template.spec.containers[0].startupProbe,
    undefined,
    "input untouched",
  );
});

test("leaves a matching probe alone even when the API omits default fields", () => {
  const stored = {
    tcpSocket: { port: 8080 },
    periodSeconds: 2,
    failureThreshold: 120,
  };
  const pool = toReplaceableWorkerPool(describedPool({ startupProbe: stored }));

  assert.equal(
    planWorkerStartupProbe(pool, { enabled: true, probe }).action,
    "unchanged",
  );
});

test("updates a probe that drifted and removes it when disabled", () => {
  const drifted = toReplaceableWorkerPool(
    describedPool({ startupProbe: { tcpSocket: { port: 9090 } } }),
  );
  const updated = planWorkerStartupProbe(drifted, { enabled: true, probe });
  assert.equal(updated.action, "updated");
  assert.deepEqual(
    updated.pool.spec.template.spec.containers[0].startupProbe,
    probe,
  );

  const removed = planWorkerStartupProbe(drifted, { enabled: false, probe });
  assert.equal(removed.action, "removed");
  assert.equal(
    "startupProbe" in removed.pool.spec.template.spec.containers[0],
    false,
  );

  const absent = toReplaceableWorkerPool(describedPool());
  assert.equal(
    planWorkerStartupProbe(absent, { enabled: false, probe }).action,
    "unchanged",
  );
});

test("refuses a pool that does not have exactly one container", () => {
  const pool = toReplaceableWorkerPool(describedPool());
  for (const containers of [[], [{}, {}], undefined]) {
    const candidate = structuredClone(pool);
    candidate.spec.template.spec.containers = containers;
    assert.throws(
      () => planWorkerStartupProbe(candidate, { enabled: true, probe }),
      /exactly one worker container/,
    );
  }
});

test("replaces the pool once, and only on drift", () => {
  const input = {
    projectId: "project-1",
    region: "europe-west1",
    workerPool: "worker",
    enabled: true,
    probe,
  };
  const run = (described) => {
    const calls = [];
    const envs = [];
    const action = ensureWorkerStartupProbe(input, {
      log: () => undefined,
      runGcloud: (args, options = {}) => {
        calls.push(args);
        envs.push(options.env);
        if (args[3] === "describe") return JSON.stringify(described);
        const file = args[4];
        assert.ok(existsSync(file));
        const replaced = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(replaced.status, undefined);
        assert.deepEqual(
          replaced.spec.template.spec.containers[0].startupProbe,
          probe,
        );
        return "";
      },
    });
    return { action, calls, envs };
  };

  const added = run(describedPool());
  assert.equal(added.action, "added");
  assert.deepEqual(
    added.calls.map((args) => args.slice(3)),
    [
      [
        "describe",
        "worker",
        "--project=project-1",
        "--region=europe-west1",
        "--format=json",
      ],
      ["replace", added.calls[1][4], "--project=project-1"],
    ],
  );
  // `replace` has no --region flag; the region comes from run/region, and
  // gcloud must not write the spec into its debug log.
  assert.deepEqual(added.envs.slice(1), [
    {
      CLOUDSDK_RUN_REGION: "europe-west1",
      CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "True",
    },
  ]);
  assert.equal(existsSync(added.calls[1][4]), false, "spec file cleaned up");

  const unchanged = run(describedPool({ startupProbe: probe }));
  assert.equal(unchanged.action, "unchanged");
  assert.equal(unchanged.calls.length, 1);
});

test("keeps a failed replace from leaving the spec file behind", () => {
  let file;
  assert.throws(
    () =>
      ensureWorkerStartupProbe(
        {
          projectId: "project-1",
          region: "europe-west1",
          workerPool: "worker",
          enabled: true,
          probe,
        },
        {
          log: () => undefined,
          runGcloud: (args) => {
            if (args[3] === "describe") return JSON.stringify(describedPool());
            file = args[4];
            throw new Error("gcloud beta run worker-pools replace failed");
          },
        },
      ),
    /replace failed/,
  );
  assert.equal(existsSync(file), false);
});

test("deploy sets the probe only after the build is current in Temporal", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-temporal-worker.yml", import.meta.url),
    "utf8",
  );
  // A failing probe step must never leave the running instances on a build
  // Temporal does not route to (2026-10-19: ~2.5 min of stalled workflows).
  const deploy = workflow.indexOf("      - name: Deploy Cloud Run worker pool");
  const current = workflow.indexOf(
    "      - name: Mark build current in Temporal",
  );
  const ensure = workflow.indexOf("      - name: Ensure worker startup probe");
  const verify = workflow.indexOf(
    "      - name: Verify live Temporal history health after rollout",
  );
  assert.ok(
    deploy !== -1 && deploy < current && current < ensure && ensure < verify,
  );

  const step = workflow.slice(
    ensure,
    workflow.indexOf("\n      - name: ", ensure + 1),
  );
  assert.match(
    step,
    /node \.github\/scripts\/ensure-worker-startup-probe\.mjs/,
  );
  assert.match(
    step,
    /--worker-pool "\$\{\{ steps\.deploy-meta\.outputs\.worker_pool_name \}\}"/,
  );
  assert.match(step, /--enabled "\$\{GCP_WORKER_STARTUP_PROBE_ENABLED\}"/);
  assert.match(step, /--port "\$\{GCP_WORKER_STARTUP_PROBE_PORT\}"/);
  assert.doesNotMatch(step, /^\s+if:/m);

  assert.match(
    workflow,
    /GCP_WORKER_STARTUP_PROBE_ENABLED: \$\{\{ vars\.GCP_WORKER_STARTUP_PROBE_ENABLED \|\| 'false' \}\}/,
  );
  assert.match(workflow, /GCP_WORKER_STARTUP_PROBE_PORT: "8080"/);
  // The worker always listens, so a spec that still has the probe never
  // meets a revision that cannot pass it.
  assert.match(
    workflow,
    /AIRI_WORKER_STARTUP_PROBE_PORT: \$\{\{ env\.GCP_WORKER_STARTUP_PROBE_PORT \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /AIRI_WORKER_STARTUP_PROBE_PORT: \$\{\{ vars\./,
  );
  assert.match(
    workflow,
    /- "\.github\/scripts\/ensure-worker-startup-probe\.mjs"/,
  );
});

test("worker pool commands stay scoped to the given project and region", () => {
  const commands = buildWorkerPoolCommands({
    projectId: "project-1",
    region: "europe-west1",
    workerPool: "worker",
  });
  assert.ok(commands.describe.includes("--project=project-1"));
  assert.ok(commands.describe.includes("--region=europe-west1"));
  assert.deepEqual(commands.replace("/tmp/pool.json"), [
    "beta",
    "run",
    "worker-pools",
    "replace",
    "/tmp/pool.json",
    "--project=project-1",
  ]);
  assert.deepEqual(commands.replaceEnv, {
    CLOUDSDK_RUN_REGION: "europe-west1",
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "True",
  });
});

test("replace only uses flags gcloud accepts and never waits on a dry run", () => {
  // gcloud beta run worker-pools replace FILE [--async] [--dry-run]
  // [--endpoint-mode] plus global flags such as --project (574.0.0). A dry
  // run polls a nonexistent operation forever, so it must not be used.
  const accepted = new Set(["--async", "--endpoint-mode", "--project"]);
  const commands = buildWorkerPoolCommands({
    projectId: "project-1",
    region: "europe-west1",
    workerPool: "worker",
  });
  for (const arg of commands.replace("/tmp/pool.json").slice(5)) {
    assert.ok(accepted.has(arg.split("=")[0]), arg);
  }
});

test("refuses to replace a pool described from another region", () => {
  const described = describedPool();
  described.metadata.labels["cloud.googleapis.com/location"] = "us-central1";
  assert.throws(
    () =>
      ensureWorkerStartupProbe(
        {
          projectId: "project-1",
          region: "europe-west1",
          workerPool: "worker",
          enabled: true,
          probe,
        },
        {
          log: () => undefined,
          runGcloud: (args) => {
            assert.equal(args[3], "describe", "no replace");
            return JSON.stringify(described);
          },
        },
      ),
    /is in us-central1, not europe-west1/,
  );
});
