import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

import {
  BRIA_GREEN_SCREEN_LIMITS,
  createBriaProgressPulse,
  runBriaGreenScreenProcessor,
} from "./bria-green-screen-processor";

const execFileAsync = promisify(execFile);

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const mediaToolsAvailable =
  (await commandAvailable("ffmpeg")) && (await commandAvailable("ffprobe"));

const assetIds = {
  workspaceId: "workspace-1",
  sourceAssetId: "source-video",
  outputAssetId: "output-video",
};

function responseJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function videoResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.byteLength),
    },
  });
}

const rejectFetch = (() => {
  throw new Error("fetch should not be called");
}) as typeof fetch;

/**
 * Runs `run` with BRIA_API_TOKEN set to `token` (unset when undefined) and,
 * when given, global.fetch replaced; both are restored afterwards.
 */
async function withBriaEnvironment(
  token: string | undefined,
  fetchImpl: typeof fetch | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = global.fetch;
  const originalToken = process.env.BRIA_API_TOKEN;
  if (token === undefined) {
    delete process.env.BRIA_API_TOKEN;
  } else {
    process.env.BRIA_API_TOKEN = token;
  }
  if (fetchImpl) global.fetch = fetchImpl;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.BRIA_API_TOKEN;
    } else {
      process.env.BRIA_API_TOKEN = originalToken;
    }
  }
}

async function createTestVideo(
  filePath: string,
  durationSeconds: number,
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:r=30",
    "-t",
    String(durationSeconds),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    filePath,
  ]);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return (address as AddressInfo).port;
}

/** Serves a generated source video over local HTTP for the duration of `run`. */
async function withSourceVideo(
  workDirPrefix: string,
  durationSeconds: number,
  run: (sourceUrl: string) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), workDirPrefix));
  const sourcePath = path.join(workDir, "source.mp4");
  await createTestVideo(sourcePath, durationSeconds);
  const server = createServer((request, response) => {
    if (request.url !== "/source.mp4") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "video/mp4" });
    createReadStream(sourcePath).pipe(response);
  });
  const port = await listen(server);
  try {
    await run(`http://127.0.0.1:${port}/source.mp4`);
  } finally {
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

test("requires BRIA_API_TOKEN before submitting green-screen jobs", async () => {
  await withBriaEnvironment(undefined, undefined, async () => {
    await assert.rejects(
      () =>
        runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl: "https://storage.example.com/source.mp4",
        }),
      /BRIA_API_TOKEN is required/,
    );
  });
});

test("rejects sources above the Bria green-screen size limit before API calls", async () => {
  await withBriaEnvironment("token", rejectFetch, async () => {
    await assert.rejects(
      () =>
        runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl: "https://storage.example.com/source.mp4",
          sourceFileSize: BRIA_GREEN_SCREEN_LIMITS.maxSourceBytes + 1,
        }),
      /Source video exceeds Bria green-screen processing size limit/,
    );
  });
});

test("rejects aborted Bria processing before starting media work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by Temporal"));

  await withBriaEnvironment("token", rejectFetch, async () => {
    await assert.rejects(
      () =>
        runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl: "https://storage.example.com/source.mp4",
          abortSignal: controller.signal,
        }),
      /cancelled by Temporal/,
    );
  });
});

test("emits repeated progress pulses during long local Bria processing", async () => {
  const progress: Array<Record<string, unknown>> = [];
  const stopPulse = createBriaProgressPulse({
    phase: "split_chunk",
    details: {
      chunkIndex: 1,
      chunkCount: 2,
    },
    intervalMs: 5,
    onProgress: (details) => progress.push(details),
  });

  await delay(18);
  stopPulse();

  assert.ok(progress.length >= 3);
  assert.ok(
    progress.every(
      (event) =>
        event.phase === "split_chunk" &&
        event.chunkIndex === 1 &&
        event.chunkCount === 2 &&
        typeof event.phaseElapsedMs === "number",
    ),
  );
});

test(
  "submits, polls, and downloads a Bria green-screen MP4",
  { skip: !mediaToolsAvailable },
  async () => {
    await withSourceVideo("bria-test-", 1, async (sourceUrl) => {
      const outputBytes = new Uint8Array(Buffer.from("green-screen-output"));
      const submissions: Array<Record<string, unknown>> = [];
      const fetches: Array<{ url: string; headers: Headers; body?: unknown }> =
        [];
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        fetches.push({ url, headers, body: init?.body });

        if (url.endsWith("/video/edit/green_screen")) {
          submissions.push(JSON.parse(String(init?.body || "{}")));
          return responseJson(
            {
              request_id: "request-1",
              status_url:
                "https://engine.prod.bria-api.com/v2/status/request-1",
            },
            202,
          );
        }

        if (url.endsWith("/status/request-1")) {
          return responseJson({
            status: "COMPLETED",
            result: {
              video_url: "https://cdn.example.com/output.mp4",
            },
          });
        }

        if (url === "https://cdn.example.com/output.mp4") {
          return videoResponse(outputBytes);
        }

        return responseJson({ message: "unexpected URL" }, 404);
      }) as typeof fetch;

      await withBriaEnvironment("bria-token", fetchImpl, async () => {
        const providerSubmissions: unknown[] = [];
        const result = await runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl,
          sourceFileName: "talking-head.mov",
          onProviderSubmitted: (submission) => {
            providerSubmissions.push(submission);
          },
        });

        assert.deepEqual(Buffer.from(result.buffer), Buffer.from(outputBytes));
        assert.equal(result.mimeType, "video/mp4");
        assert.equal(result.fileName, "talking-head-green-screen.mp4");
        assert.deepEqual(submissions, [
          {
            video: sourceUrl,
            green_shade: "chroma_green",
            output_container_and_codec: "mp4_h264",
            preserve_audio: true,
          },
        ]);
        assert.equal(providerSubmissions.length, 1);
        assert.equal(result.providerPayload.provider, "bria");
        assert.equal(
          result.providerPayload.processor,
          "bria-video-green-screen-api",
        );
        assert.equal(
          result.providerPayload.modelId,
          "airi-green-screen-bria-v1",
        );
        assert.equal(result.providerPayload.requestId, "request-1");
        assert.equal(
          result.providerPayload.outputBytes,
          outputBytes.byteLength,
        );
        assert.equal(fetches[0]?.headers.get("api_token"), "bria-token");
        assert.equal(
          fetches[0]?.headers.get("user-agent"),
          "BriaPlatform/APIdocs/LLMsAgent",
        );
      });
    });
  },
);

test(
  "resumes a Bria job from request id without re-submitting when status URL is missing",
  { skip: !mediaToolsAvailable },
  async () => {
    await withSourceVideo("bria-resume-test-", 1, async (sourceUrl) => {
      const outputBytes = new Uint8Array(Buffer.from("resumed-output"));
      const submittedUrls: string[] = [];
      const statusUrls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith("/video/edit/green_screen")) {
          submittedUrls.push(url);
          return responseJson({ message: "should not submit" }, 500);
        }

        if (url === "https://engine.prod.bria-api.com/v2/status/request-1") {
          statusUrls.push(url);
          return responseJson({
            status: "COMPLETED",
            result: {
              video_url: "https://cdn.example.com/resumed-output.mp4",
            },
          });
        }

        if (url === "https://cdn.example.com/resumed-output.mp4") {
          return videoResponse(outputBytes);
        }

        return responseJson({ message: "unexpected URL" }, 404);
      }) as typeof fetch;

      await withBriaEnvironment("bria-token", fetchImpl, async () => {
        const providerSubmissions: unknown[] = [];
        const result = await runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl,
          sourceFileName: "talking-head.mov",
          providerRequestId: "request-1",
          providerStatusUrl: null,
          onProviderSubmitted: (submission) => {
            providerSubmissions.push(submission);
          },
        });

        assert.deepEqual(submittedUrls, []);
        assert.deepEqual(statusUrls, [
          "https://engine.prod.bria-api.com/v2/status/request-1",
        ]);
        assert.equal(providerSubmissions.length, 0);
        assert.deepEqual(Buffer.from(result.buffer), Buffer.from(outputBytes));
        assert.equal(result.providerPayload.requestId, "request-1");
        assert.equal(
          result.providerPayload.statusUrl,
          "https://engine.prod.bria-api.com/v2/status/request-1",
        );
        assert.equal(result.providerPayload.submitResponse, undefined);
      });
    });
  },
);

test(
  "splits long sources into Bria chunks and stitches one output",
  { skip: !mediaToolsAvailable },
  async () => {
    await withSourceVideo("bria-chunk-test-", 61, async (sourceUrl) => {
      const originalFetch = global.fetch;
      const uploads: Array<{ url: string; buffer: Buffer }> = [];
      const submissions: Array<Record<string, unknown>> = [];
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);

        if (url === sourceUrl) {
          return originalFetch(input, init);
        }

        if (url.endsWith("/video/edit/green_screen")) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            video?: string;
          };
          submissions.push(body);
          const chunkNumber = submissions.length;
          return responseJson(
            {
              request_id: `request-${chunkNumber}`,
              status_url: `https://engine.prod.bria-api.com/v2/status/request-${chunkNumber}`,
            },
            202,
          );
        }

        const statusMatch = url.match(/\/status\/request-(\d+)$/);
        if (statusMatch) {
          const chunkNumber = Number(statusMatch[1]);
          return responseJson({
            status: "COMPLETED",
            result: {
              video_url: `https://cdn.example.com/output-${chunkNumber}.mp4`,
            },
          });
        }

        const outputMatch = url.match(/\/output-(\d+)\.mp4$/);
        if (outputMatch) {
          const upload = uploads[Number(outputMatch[1]) - 1];
          assert.ok(upload);
          return videoResponse(new Uint8Array(upload.buffer));
        }

        return responseJson({ message: "unexpected URL" }, 404);
      }) as typeof fetch;

      await withBriaEnvironment("bria-token", fetchImpl, async () => {
        const result = await runBriaGreenScreenProcessor({
          ...assetIds,
          sourceUrl,
          sourceFileName: "talking-head.mov",
          uploadChunkSource: async (chunk) => {
            const url = `https://chunks.example.com/${chunk.fileName}`;
            uploads.push({ url, buffer: chunk.buffer });
            return { url };
          },
        });

        assert.equal(uploads.length, 2);
        assert.equal(submissions.length, 2);
        assert.deepEqual(
          submissions.map((submission) => submission.video),
          uploads.map((upload) => upload.url),
        );
        assert.equal(result.mimeType, "video/mp4");
        assert.equal(result.providerPayload.chunked, true);
        assert.equal(result.providerPayload.chunkCount, 2);
        assert.equal(result.providerPayload.usageMultiplier, 2);
        assert.ok(result.buffer.byteLength > 0);
      });
    });
  },
);
