import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";

import {
  GREEN_SCREEN_PROCESSOR_LIMITS,
  buildGreenScreenProcessorPaths,
  downloadSourceVideo,
  resolveGreenScreenProcessingDimensions,
  resolveGreenScreenProcessingPlan,
  resolveGreenScreenMattingCommand,
} from "./green-screen-processor";

test("keeps downloaded source and final output paths separate even when the source is named green-screen.mp4", () => {
  const workDir = path.join("tmp", "airi-green-screen-test");
  const paths = buildGreenScreenProcessorPaths({
    workDir,
    sourceFileName: "green-screen.mp4",
  });

  assert.notEqual(paths.inputPath, paths.outputPath);
  assert.equal(
    paths.inputPath,
    path.join(workDir, "input", "green-screen.mp4"),
  );
  assert.equal(
    paths.outputPath,
    path.join(workDir, "output", "green-screen.mp4"),
  );
  assert.equal(paths.framePattern, path.join(workDir, "frames", "%06d.jpg"));
  assert.equal(
    paths.mattedFramePattern,
    path.join(workDir, "matted", "%06d.png"),
  );
});

test("uses the bundled MediaPipe runner and fixed green-screen processing limits", () => {
  const original = {
    command: process.env.AIRI_GREEN_SCREEN_MATTING_COMMAND,
    maxFps: process.env.AIRI_GREEN_SCREEN_MAX_FPS,
    timeout: process.env.AIRI_GREEN_SCREEN_PROCESS_TIMEOUT_MS,
  };

  process.env.AIRI_GREEN_SCREEN_MATTING_COMMAND = "python bad.py";
  process.env.AIRI_GREEN_SCREEN_MAX_FPS = "1";
  process.env.AIRI_GREEN_SCREEN_PROCESS_TIMEOUT_MS = "1";

  try {
    const command = resolveGreenScreenMattingCommand();

    assert.equal(command.command, "python3");
    assert.equal(command.args.length, 1);
    assert.equal(existsSync(command.args[0]), true);
    assert.match(
      command.args[0],
      /media-runners[\\/]mediapipe_green_screen\.py$/,
    );
    assert.equal(
      GREEN_SCREEN_PROCESSOR_LIMITS.maxSourceBytes,
      256 * 1024 * 1024,
    );
    assert.equal(
      GREEN_SCREEN_PROCESSOR_LIMITS.maxOutputBytes,
      256 * 1024 * 1024,
    );
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.maxDurationSeconds, 90);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.maxPixels, 4_000_000);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.maxLongEdge, 960);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.maxFrames, 360);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.maxFps, 12);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.processTimeoutMs, 15 * 60_000);
    assert.equal(GREEN_SCREEN_PROCESSOR_LIMITS.totalTimeoutMs, 25 * 60_000);
  } finally {
    if (original.command === undefined) {
      delete process.env.AIRI_GREEN_SCREEN_MATTING_COMMAND;
    } else {
      process.env.AIRI_GREEN_SCREEN_MATTING_COMMAND = original.command;
    }
    if (original.maxFps === undefined) {
      delete process.env.AIRI_GREEN_SCREEN_MAX_FPS;
    } else {
      process.env.AIRI_GREEN_SCREEN_MAX_FPS = original.maxFps;
    }
    if (original.timeout === undefined) {
      delete process.env.AIRI_GREEN_SCREEN_PROCESS_TIMEOUT_MS;
    } else {
      process.env.AIRI_GREEN_SCREEN_PROCESS_TIMEOUT_MS = original.timeout;
    }
  }
});

test("streams source video downloads larger than the old 50MB cap", async () => {
  const originalFetch = globalThis.fetch;
  const workDir = await mkdtemp(path.join(tmpdir(), "airi-green-source-test-"));
  const outputPath = path.join(workDir, "source.mov");
  const chunkBytes = 1024 * 1024;
  const chunkCount = 60;
  const totalBytes = chunkBytes * chunkCount;
  const progress: Array<{
    phase: string;
    bytes?: number;
    totalBytes?: number;
  }> = [];

  globalThis.fetch = (async () => {
    let sentChunks = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sentChunks >= chunkCount) {
            controller.close();
            return;
          }
          sentChunks += 1;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
      }),
      {
        headers: {
          "content-length": String(totalBytes),
          "content-type": "video/quicktime",
        },
      },
    );
  }) as typeof fetch;

  try {
    const downloadedBytes = await downloadSourceVideo(
      "https://storage.example.com/source.mov",
      outputPath,
      {
        onProgress: (details) =>
          progress.push({
            phase: details.phase,
            bytes: details.bytes,
            totalBytes: details.totalBytes,
          }),
      },
    );

    assert.equal(downloadedBytes, totalBytes);
    assert.equal((await stat(outputPath)).size, totalBytes);
    assert.equal(progress.length > 1, true);
    assert.equal(progress.at(-1)?.phase, "download");
    assert.equal(progress.at(-1)?.bytes, totalBytes);
    assert.equal(progress.at(-1)?.totalBytes, totalBytes);
    assert.equal(
      progress.some(
        (item) =>
          item.phase === "download" &&
          typeof item.bytes === "number" &&
          item.bytes >= 8 * 1024 * 1024,
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workDir, { recursive: true, force: true });
  }
});

test("scales green-screen processing dimensions to a bounded long edge", () => {
  assert.deepEqual(
    resolveGreenScreenProcessingDimensions({ width: 1080, height: 1920 }),
    { width: 540, height: 960 },
  );
  assert.deepEqual(
    resolveGreenScreenProcessingDimensions({ width: 1920, height: 1080 }),
    { width: 960, height: 540 },
  );
  assert.deepEqual(
    resolveGreenScreenProcessingDimensions({ width: 540, height: 960 }),
    { width: 540, height: 960 },
  );
});

test("reduces green-screen processing fps to keep supported videos within the frame budget", () => {
  assert.deepEqual(
    resolveGreenScreenProcessingPlan({
      durationSeconds: 90,
      sourceFps: 30,
    }),
    {
      processingFps: 4,
      estimatedFrames: 360,
    },
  );

  assert.deepEqual(
    resolveGreenScreenProcessingPlan({
      durationSeconds: 30,
      sourceFps: 30,
    }),
    {
      processingFps: 12,
      estimatedFrames: 360,
    },
  );
});
