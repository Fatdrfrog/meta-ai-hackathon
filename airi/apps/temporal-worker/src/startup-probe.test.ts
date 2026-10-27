import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import test from "node:test";

import {
  readWorkerStartupProbePort,
  startWorkerStartupProbeListener,
  WORKER_STARTUP_PROBE_PORT_ENV,
} from "./startup-probe";

function tryConnect(port: number): Promise<"accepted" | string> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve("accepted");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code || error.message);
    });
  });
}

test("reads the probe port only when one is configured", () => {
  assert.equal(readWorkerStartupProbePort({}), null);
  assert.equal(
    readWorkerStartupProbePort({ [WORKER_STARTUP_PROBE_PORT_ENV]: " " }),
    null,
  );
  assert.equal(
    readWorkerStartupProbePort({ [WORKER_STARTUP_PROBE_PORT_ENV]: "8080" }),
    8080,
  );
  for (const value of ["0", "70000", "80.5", "http"]) {
    assert.throws(
      () =>
        readWorkerStartupProbePort({ [WORKER_STARTUP_PROBE_PORT_ENV]: value }),
      /must be a TCP port/,
      value,
    );
  }
});

test("accepts TCP connections until stopped", async () => {
  const probe = await startWorkerStartupProbeListener({
    port: 0,
    host: "127.0.0.1",
  });
  assert.ok(probe.port > 0);
  assert.equal(await tryConnect(probe.port), "accepted");
  assert.equal(await tryConnect(probe.port), "accepted");

  const stopped = probe.stop();
  assert.equal(probe.stop(), stopped, "stop is shared");
  await stopped;
  assert.equal(await tryConnect(probe.port), "ECONNREFUSED");
});

test("fails to start when the port is taken", async () => {
  const first = await startWorkerStartupProbeListener({
    port: 0,
    host: "127.0.0.1",
  });
  try {
    await assert.rejects(
      startWorkerStartupProbeListener({ port: first.port, host: "127.0.0.1" }),
      /EADDRINUSE/,
    );
  } finally {
    await first.stop();
  }
});

test("worker opens the probe through the lifecycle readiness hook", () => {
  const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const startupProbePort = readWorkerStartupProbePort\(\);/,
  );
  assert.match(
    source,
    /startReadinessProbe: startupProbePort\s*\?\s*async \(\) => \{\s*const probe = await startWorkerStartupProbeListener\(\{\s*port: startupProbePort,/,
  );
  assert.match(source, /return probe\.stop;/);
});
