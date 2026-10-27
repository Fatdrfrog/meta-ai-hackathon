import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runProcess } from "./process-runner";

test("runs a process and bounds captured output", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('0123456789'); process.stderr.write('abcdefghij')",
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 5,
  });
  assert.equal(result.stdout, "56789");
  assert.equal(result.stderr, "fghij");
});

test("pulses while a long process is running", async () => {
  let pulses = 0;
  await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 90)"],
    timeoutMs: 2_000,
    pulseIntervalMs: 20,
    onPulse: () => {
      pulses += 1;
    },
  });
  assert.ok(pulses >= 2);
});

test("kills and rejects a process after its deadline", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 25,
    }),
    /timed out/i,
  );
});

test("kills and rejects when aborted", async () => {
  const controller = new AbortController();
  const pending = runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10_000)"],
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("kills the child and contains an initial pulse exception", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-process-runner-test-"));
  const marker = path.join(dir, "child-survived.txt");
  try {
    await assert.rejects(
      runProcess({
        command: process.execPath,
        args: [
          "-e",
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
            marker,
          )}, "alive"), 150); setTimeout(() => {}, 10_000)`,
        ],
        timeoutMs: 5_000,
        onPulse: () => {
          throw new Error("initial pulse failed");
        },
      }),
      /initial pulse failed/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await pathExists(marker), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kills the child and contains an interval pulse exception", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "airi-process-runner-test-"));
  const marker = path.join(dir, "child-survived.txt");
  let pulses = 0;
  try {
    await assert.rejects(
      runProcess({
        command: process.execPath,
        args: [
          "-e",
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
            marker,
          )}, "alive"), 250); setTimeout(() => {}, 10_000)`,
        ],
        timeoutMs: 5_000,
        pulseIntervalMs: 25,
        onPulse: () => {
          pulses += 1;
          if (pulses > 1) throw new Error("interval pulse failed");
        },
      }),
      /interval pulse failed/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await pathExists(marker), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contains a final pulse exception after the child closes", async () => {
  let pulses = 0;
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5_000,
      onPulse: () => {
        pulses += 1;
        if (pulses > 1) throw new Error("final pulse failed");
      },
    }),
    /final pulse failed/i,
  );
  assert.equal(pulses, 2);
});

function delayedCloseProcess(delayMs: number): {
  spawn: typeof import("node:child_process").spawn;
  didClose: () => boolean;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  let closed = false;
  Object.defineProperties(child, {
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
  child.kill = () => {
    setTimeout(() => {
      stdout.end();
      stderr.end();
      closed = true;
      child.emit("close", null, "SIGKILL");
    }, delayMs);
    return true;
  };
  return {
    spawn: (() =>
      child) as unknown as typeof import("node:child_process").spawn,
    didClose: () => closed,
  };
}

function synchronousCloseProcess(): {
  spawn: typeof import("node:child_process").spawn;
} {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  });
  child.kill = () => {
    child.emit("close", null, "SIGKILL");
    return true;
  };
  return {
    spawn: (() =>
      child) as unknown as typeof import("node:child_process").spawn,
  };
}

test("settles when an initial pulse kill closes synchronously", async () => {
  const fake = synchronousCloseProcess();
  await assert.rejects(
    Promise.race([
      runProcess(
        {
          command: "fake-process",
          args: [],
          timeoutMs: 5_000,
          onPulse: () => {
            throw new Error("initial pulse failed");
          },
        },
        { spawn: fake.spawn },
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runner did not settle")), 100),
      ),
    ]),
    /initial pulse failed/i,
  );
});

test("does not reject a timeout until the killed child's pipes close", async () => {
  const fake = delayedCloseProcess(40);
  await assert.rejects(
    runProcess(
      {
        command: "fake-process",
        args: [],
        timeoutMs: 5,
      },
      { spawn: fake.spawn },
    ),
    /timed out/i,
  );
  assert.equal(fake.didClose(), true);
});

test("does not reject an abort until the killed child's pipes close", async () => {
  const controller = new AbortController();
  const fake = delayedCloseProcess(40);
  const pending = runProcess(
    {
      command: "fake-process",
      args: [],
      timeoutMs: 5_000,
      signal: controller.signal,
    },
    { spawn: fake.spawn },
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(fake.didClose(), true);
});
