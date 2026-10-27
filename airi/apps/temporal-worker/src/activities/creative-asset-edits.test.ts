import assert from "node:assert/strict";
import test from "node:test";
import {
  configureCreativeAssetReadUrlPort,
  getCreativeAssetReadUrlPort,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  createCreativeAssetObjectPath,
  isCreativeAssetObjectPathForWorkspace,
} from "@icecore/airi-runtime/media-api";

import "../creative-asset-read-url-gcs-adapter.js";
import {
  CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
  type CreativeAssetEditActivityInput,
} from "@icecore/temporal";
import {
  failCreativeAssetEditActivity,
  processCreativeAssetEditActivity,
  type ProcessCreativeAssetEditActivityDeps,
} from "./creative-asset-edits";

function createLeanChain<T>(value: T) {
  return {
    lean: async () => value,
  };
}

const baseInput: CreativeAssetEditActivityInput = {
  contractVersion: CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
  workspaceId: "workspace-1",
  sourceAssetId: "source-video",
  outputAssetId: "output-video",
  operation: "green_screen",
};

test("green-screen retries use separately charged temporary objects after failed-attempt cleanup", async (t) => {
  const priorReadPort = getCreativeAssetReadUrlPort();
  t.after(() => configureCreativeAssetReadUrlPort(priorReadPort));
  configureCreativeAssetReadUrlPort({
    createReadUrl: async (input) => ({
      ...input,
      url: `https://storage.test/${input.path}`,
      expiresAt: "2030-01-01T00:00:00Z",
    }),
  });
  const objects = new Map<string, { bytes: number; tombstoned: boolean }>();
  let chargedBytes = 0;
  const storeBuffer: ProcessCreativeAssetEditActivityDeps["storeBuffer"] =
    async (params) => {
      const path = createCreativeAssetObjectPath(params);
      const prior = objects.get(path);
      if (prior?.tombstoned) throw new Error("Storage object was deleted");
      if (!prior) {
        chargedBytes += params.buffer.byteLength;
        objects.set(path, {
          bytes: params.buffer.byteLength,
          tombstoned: false,
        });
      }
      return {
        storageProvider: "gcs",
        bucket: "creative-assets",
        path,
        url: `gcs://creative-assets/${path}`,
        mimeType: params.mimeType,
        fileName: params.fileName,
        fileSize: params.buffer.byteLength,
      };
    };
  const runAttempt = (attempt: number) =>
    processCreativeAssetEditActivity({
      input: baseInput,
      temporaryUploadId: `workflow-run-activity-${attempt}`,
      assetModel: {
        findOne: (query) =>
          createLeanChain(
            query._id === "source-video"
              ? {
                  kind: "video",
                  status: "complete",
                  url: "https://storage.test/source.mp4",
                }
              : {
                  kind: "video",
                  source: "edited",
                  provider: "airi",
                  status: "queued",
                  sourceAssetId: "source-video",
                },
          ),
        findOneAndUpdate: async () => null,
      },
      storageClient: null,
      storeBuffer,
      deleteStoredObject: async ({ path }) => {
        const object = objects.get(path);
        assert.ok(object);
        object.tombstoned = true;
        return { deleted: true };
      },
      runGreenScreenProcessor: async (processor) => {
        const chunk = await processor.uploadChunkSource!({
          buffer: Buffer.from("part"),
          mimeType: "video/mp4",
          fileName: "chunk-001.mp4",
          chunkIndex: 1,
          chunkCount: 1,
        });
        try {
          if (attempt === 1) throw new Error("temporary provider outage");
          return {
            buffer: Buffer.from("output"),
            mimeType: "video/mp4",
            fileName: "finished.mp4",
            providerPayload: {},
          };
        } finally {
          await processor.deleteChunkSource!(chunk);
        }
      },
    });
  await assert.rejects(runAttempt(1), /temporary provider outage/);
  assert.equal(chargedBytes, 4);
  assert.equal((await runAttempt(2)).status, "complete");
  const temporary = [...objects.entries()].filter(([path]) =>
    path.includes("/tmp-"),
  );
  assert.equal(temporary.length, 2);
  assert.ok(temporary.every(([, object]) => object.tombstoned));
  assert.equal(chargedBytes, 4 + 4 + 6);
});

for (const scenario of [
  {
    name: "complete workspace photo",
    primary: "photo",
    kind: "image",
    status: "complete",
    owned: true,
    expected: "complete",
  },
  {
    name: "complete workspace photo with consecutive dots in its approved title",
    primary: "photo",
    kind: "image",
    status: "complete",
    owned: true,
    expected: "complete",
    fileName: "Friday.. lunch.mp4",
  },
  {
    name: "foreign workspace photo",
    primary: "photo",
    kind: "image",
    status: "complete",
    owned: false,
    expected: "failed",
  },
  {
    name: "foreign workspace storyboard scene",
    primary: "source-video",
    kind: "image",
    status: "complete",
    owned: false,
    expected: "failed",
  },
  {
    name: "incomplete photo",
    primary: "photo",
    kind: "image",
    status: "queued",
    owned: true,
    expected: "failed",
  },
  {
    name: "audio source",
    primary: "photo",
    kind: "audio",
    status: "complete",
    owned: true,
    expected: "failed",
  },
] as const) {
  test(`timeline validates ${scenario.name} before rendering`, async () => {
    const fileName =
      "fileName" in scenario ? scenario.fileName : "Friday lunch.mp4";
    const queries: Array<{ _id: string; workspaceId?: string }> = [];
    const updates: Record<string, unknown>[] = [];
    let renders = 0;
    const result = await processCreativeAssetEditActivity({
      input: {
        ...baseInput,
        operation: "timeline_render",
        sourceAssetId: scenario.primary,
        timeline: {
          canvas: "9:16",
          duration: 3,
          clips: [
            {
              id: "scene",
              assetId: "photo",
              trackId: "V1",
              sourceStart: 0,
              timelineStart: 0,
              duration: 3,
              caption: "Our business",
            },
          ],
        },
      },
      assetModel: {
        findOne: (query) => {
          queries.push(query);
          return createLeanChain(
            query._id === baseInput.outputAssetId
              ? {
                  kind: "video",
                  source: "edited",
                  provider: "airi",
                  status: "queued",
                  sourceAssetId: scenario.primary,
                  fileName,
                }
              : query._id === "source-video"
                ? {
                    kind: "video",
                    status: "complete",
                    url: "https://storage.example.com/source.mp4",
                  }
                : scenario.owned
                  ? {
                      kind: scenario.kind,
                      status: scenario.status,
                      url: "https://storage.example.com/photo.png",
                    }
                  : null,
          );
        },
        findOneAndUpdate: async (_query, update) => {
          updates.push(update);
          return null;
        },
      },
      storageClient: null,
      runGreenScreenProcessor: async () => {
        throw new Error("Unexpected green screen");
      },
      storeBuffer: async () => {
        throw new Error("Unexpected buffer upload");
      },
      runTimelineRenderProcessor: async (params) => {
        renders += 1;
        assert.equal(params.sources[0]?.kind, "image");
        return {
          outputPath: "output.mp4",
          mimeType: "video/mp4",
          fileName: "output.mp4",
          fileSize: 100,
          providerPayload: {},
          cleanup: async () => undefined,
        };
      },
      storeFile: async (params) => {
        assert.equal(
          params.fileName,
          fileName,
          "Preserve the reviewed business title when storing the completed render",
        );
        const objectPath = createCreativeAssetObjectPath(params);
        assert.ok(
          isCreativeAssetObjectPathForWorkspace({
            workspaceId: params.workspaceId,
            path: objectPath,
          }),
          "The approved filename must produce a valid GCS object path",
        );
        return {
          storageProvider: "gcs",
          bucket: "assets",
          path: "out.mp4",
          url: "gcs://assets/out.mp4",
          mimeType: "video/mp4",
          fileName: params.fileName,
          fileSize: 100,
        };
      },
    });
    assert.equal(result.status, scenario.expected);
    if (scenario.expected === "complete") {
      assert.equal(
        updates.find((update) => update.status === "complete")?.fileName,
        fileName,
      );
    }
    assert.equal(renders, scenario.expected === "complete" ? 1 : 0);
    assert.ok(
      queries.every((query) => query.workspaceId === baseInput.workspaceId),
    );
  });
}

test("renders a multi-source timeline and streams the output file to storage", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const rendered: unknown[] = [];
  const stored: unknown[] = [];
  let cleanupCalls = 0;
  const timeline = {
    duration: 8,
    clips: [
      {
        id: "clip-1",
        assetId: "source-video",
        trackId: "V1" as const,
        timelineStart: 0,
        sourceStart: 3,
        duration: 4,
      },
      {
        id: "clip-2",
        assetId: "source-two",
        trackId: "V2" as const,
        timelineStart: 4,
        sourceStart: 0,
        duration: 4,
      },
    ],
  };
  const input: CreativeAssetEditActivityInput = {
    ...baseInput,
    operation: "timeline_render",
    timeline,
  };
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "output-video"
          ? {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
              providerPayload: { operation: "timeline_render", timeline },
            }
          : {
              _id: query._id,
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: `https://storage.example.com/${query._id}.mp4`,
              fileName: `${query._id}.mp4`,
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return update;
    },
  };

  const result = await processCreativeAssetEditActivity({
    input,
    assetModel,
    storageClient: null,
    runGreenScreenProcessor: async () => {
      throw new Error("green-screen processor must not run");
    },
    storeBuffer: async () => {
      throw new Error("buffer upload must not run");
    },
    runTimelineRenderProcessor: async (params) => {
      rendered.push(params);
      return {
        outputPath: "C:/tmp/timeline.mp4",
        mimeType: "video/mp4",
        fileName: "timeline.mp4",
        fileSize: 25,
        providerPayload: {
          operation: "timeline_render",
          processor: "ffmpeg-timeline-renderer",
          clipCount: 2,
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
      };
    },
    storeFile: async (params) => {
      stored.push(params);
      return {
        storageProvider: "gcs",
        url: "gcs://creative-assets/timeline.mp4",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/output-video/timeline.mp4",
        mimeType: "video/mp4",
        fileName: "timeline.mp4",
        fileSize: 25,
      };
    },
    now: () => new Date("2026-07-10T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outputAssetId: "output-video",
    status: "complete",
    terminal: true,
  });
  assert.equal(rendered.length, 1);
  assert.deepEqual((rendered[0] as { sources: unknown }).sources, [
    {
      assetId: "source-video",
      kind: "video",
      url: "https://storage.example.com/source-video.mp4",
      fileName: "source-video.mp4",
    },
    {
      assetId: "source-two",
      kind: "video",
      url: "https://storage.example.com/source-two.mp4",
      fileName: "source-two.mp4",
    },
  ]);
  assert.equal(stored.length, 1);
  assert.equal((stored[0] as Record<string, unknown>).fileName, "timeline.mp4");
  assert.equal(
    (stored[0] as Record<string, unknown>).localPath,
    "C:/tmp/timeline.mp4",
  );
  assert.equal(cleanupCalls, 1);
  assert.ok(
    updates.some(
      (entry) =>
        (entry.update as Record<string, unknown>).status === "complete" &&
        (entry.update as Record<string, unknown>).url ===
          "gcs://creative-assets/timeline.mp4",
    ),
  );
});

test("loads mixed-case Mongo timeline sources once without changing the approved payload", async () => {
  const assetId = "abcdef123456abcdef123456";
  const timeline = {
    duration: 2,
    clips: [assetId.toUpperCase(), assetId].map((id, index) => ({
      id: `scene-${index}`,
      assetId: id,
      trackId: "V1" as const,
      timelineStart: index,
      sourceStart: 0,
      duration: 1,
    })),
  };
  const snapshot = JSON.stringify(timeline);
  const queries: Array<{ _id: string; workspaceId?: string }> = [];
  const result = await processCreativeAssetEditActivity({
    input: {
      ...baseInput,
      sourceAssetId: assetId.toUpperCase(),
      operation: "timeline_render",
      timeline,
    },
    assetModel: {
      findOne: (query) => {
        queries.push(query);
        return createLeanChain(
          query._id === baseInput.outputAssetId
            ? {
                kind: "video",
                source: "edited",
                provider: "airi",
                status: "queued",
                sourceAssetId: assetId,
              }
            : {
                kind: "video",
                status: "complete",
                url: "https://storage.example.com/source.mp4",
              },
        );
      },
      findOneAndUpdate: async () => null,
    },
    storageClient: null,
    runGreenScreenProcessor: async () => {
      throw new Error("Unexpected green screen");
    },
    storeBuffer: async () => {
      throw new Error("Unexpected buffer upload");
    },
    runTimelineRenderProcessor: async (params) => {
      assert.equal(params.sources.length, 1);
      assert.equal(params.sources[0]?.assetId, assetId);
      assert.equal(JSON.stringify(params.timeline), snapshot);
      return {
        outputPath: "output.mp4",
        mimeType: "video/mp4",
        fileName: "output.mp4",
        fileSize: 1,
        providerPayload: {},
        cleanup: async () => undefined,
      };
    },
    storeFile: async (params) => ({
      storageProvider: "gcs",
      bucket: "assets",
      path: "out.mp4",
      url: "gcs://assets/out.mp4",
      mimeType: params.mimeType,
      fileName: params.fileName,
      fileSize: 1,
    }),
  });
  assert.equal(result.status, "complete");
  assert.equal(
    queries.filter((query) => query._id.toLowerCase() === assetId).length,
    1,
  );
  assert.ok(
    queries.every((query) => query.workspaceId === baseInput.workspaceId),
  );
  assert.equal(JSON.stringify(timeline), snapshot);
});

test("processes a green-screen edit and stores the derivative video", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const processed: unknown[] = [];
  const stored: unknown[] = [];
  const storageClient = { storage: { from: () => ({}) } };
  const abortController = new AbortController();
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
              fileName: "talking-head.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return {
        ...(query as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    },
  };

  const result = await processCreativeAssetEditActivity({
    input: baseInput,
    assetModel,
    storageClient,
    runGreenScreenProcessor: async (params) => {
      processed.push(params);
      await params.onProviderSubmitted?.({
        requestId: "bria-request-1",
        statusUrl: "https://engine.prod.bria-api.com/v2/status/bria-request-1",
        raw: {
          request_id: "bria-request-1",
          status_url:
            "https://engine.prod.bria-api.com/v2/status/bria-request-1",
        },
      });
      return {
        buffer: Buffer.from("green-screen-video"),
        mimeType: "video/mp4",
        fileName: "talking-head-green-screen.mp4",
        providerPayload: {
          durationSeconds: 3.5,
          processor: "bria-video-green-screen-api",
          requestId: "bria-request-1",
          statusUrl:
            "https://engine.prod.bria-api.com/v2/status/bria-request-1",
        },
      };
    },
    storeBuffer: async (params) => {
      stored.push(params);
      return {
        storageProvider: "gcs",
        url: "https://storage.example.com/output.mp4",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/output-video/output.mp4",
        mimeType: "video/mp4",
        fileName: "talking-head-green-screen.mp4",
        fileSize: 18,
      };
    },
    abortSignal: abortController.signal,
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outputAssetId: "output-video",
    status: "complete",
    terminal: true,
  });
  assert.equal(processed.length, 1);
  assert.equal(
    (processed[0] as Record<string, unknown>).workspaceId,
    "workspace-1",
  );
  assert.equal(
    (processed[0] as Record<string, unknown>).sourceAssetId,
    "source-video",
  );
  assert.equal(
    (processed[0] as Record<string, unknown>).outputAssetId,
    "output-video",
  );
  assert.equal(
    (processed[0] as Record<string, unknown>).sourceUrl,
    "https://storage.example.com/source.mp4",
  );
  assert.equal(
    (processed[0] as Record<string, unknown>).sourceFileName,
    "talking-head.mp4",
  );
  assert.equal(
    (processed[0] as Record<string, unknown>).abortSignal,
    abortController.signal,
  );
  assert.equal(
    typeof (processed[0] as Record<string, unknown>).onProviderSubmitted,
    "function",
  );
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], {
    storageClient,
    workspaceId: "workspace-1",
    assetId: "output-video",
    kind: "video",
    buffer: Buffer.from("green-screen-video"),
    mimeType: "video/mp4",
    fileName: "talking-head-green-screen.mp4",
  });
  assert.deepEqual(updates[0], {
    query: {
      _id: "output-video",
      workspaceId: "workspace-1",
      status: { $in: ["queued", "in_progress"] },
    },
    update: {
      status: "in_progress",
      error: null,
      updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    },
  });
  assert.deepEqual(updates[1], {
    query: {
      _id: "output-video",
      workspaceId: "workspace-1",
      status: { $in: ["queued", "in_progress"] },
    },
    update: {
      providerRequestId: "bria-request-1",
      providerStatusUrl:
        "https://engine.prod.bria-api.com/v2/status/bria-request-1",
      providerPayload: {
        operation: "green_screen",
        provider: "bria",
        processor: "bria-video-green-screen-api",
        modelId: "airi-green-screen-bria-v1",
        requestId: "bria-request-1",
        statusUrl: "https://engine.prod.bria-api.com/v2/status/bria-request-1",
        greenShade: "chroma_green",
        backgroundColor: "#00ff00",
        outputContainerAndCodec: "mp4_h264",
        preserveAudio: true,
        rawSubmitResponse: {
          request_id: "bria-request-1",
          status_url:
            "https://engine.prod.bria-api.com/v2/status/bria-request-1",
        },
      },
      updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    },
  });
  assert.deepEqual(updates.at(-1), {
    query: {
      _id: "output-video",
      workspaceId: "workspace-1",
      status: { $in: ["queued", "in_progress"] },
    },
    update: {
      status: "complete",
      url: "https://storage.example.com/output.mp4",
      storageProvider: "gcs",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/output-video/output.mp4",
      mimeType: "video/mp4",
      fileName: "talking-head-green-screen.mp4",
      fileSize: 18,
      providerPayload: {
        durationSeconds: 3.5,
        processor: "bria-video-green-screen-api",
        requestId: "bria-request-1",
        statusUrl: "https://engine.prod.bria-api.com/v2/status/bria-request-1",
      },
      providerRequestId: "bria-request-1",
      providerStatusUrl:
        "https://engine.prod.bria-api.com/v2/status/bria-request-1",
      error: null,
      completedAt: new Date("2026-06-28T00:00:00.000Z"),
      updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    },
  });
});

test("forwards processor progress to Temporal heartbeats", async () => {
  const heartbeats: Record<string, unknown>[] = [];
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
              fileName: "talking-head.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => ({
      ...(query as Record<string, unknown>),
      ...(update as Record<string, unknown>),
    }),
  };

  await processCreativeAssetEditActivity({
    input: baseInput,
    assetModel,
    storageClient: null,
    runGreenScreenProcessor: async (params) => {
      params.onProgress?.({
        phase: "matting",
        frames: 120,
        totalElapsedMs: 45_000,
      });
      return {
        buffer: Buffer.from("green-screen-video"),
        mimeType: "video/mp4",
        fileName: "talking-head-green-screen.mp4",
        providerPayload: {
          processor: "ffmpeg-mediapipe",
        },
      };
    },
    storeBuffer: async () => ({
      storageProvider: "gcs",
      url: "https://storage.example.com/output.mp4",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/output-video/output.mp4",
      mimeType: "video/mp4",
      fileName: "talking-head-green-screen.mp4",
      fileSize: 18,
    }),
    heartbeat: (details) => heartbeats.push(details),
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });

  assert.deepEqual(heartbeats, [
    {
      workspaceId: "workspace-1",
      sourceAssetId: "source-video",
      outputAssetId: "output-video",
      operation: "green_screen",
      phase: "matting",
      frames: 120,
      totalElapsedMs: 45_000,
    },
    {
      workspaceId: "workspace-1",
      sourceAssetId: "source-video",
      outputAssetId: "output-video",
      operation: "green_screen",
      phase: "upload",
    },
    {
      workspaceId: "workspace-1",
      sourceAssetId: "source-video",
      outputAssetId: "output-video",
      operation: "green_screen",
      phase: "uploaded",
    },
  ]);
});

test("marks the output asset failed when media processing fails", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
              fileName: "talking-head.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return {
        ...(query as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    },
  };

  const result = await processCreativeAssetEditActivity({
    input: baseInput,
    assetModel,
    storageClient: { storage: { from: () => ({}) } },
    runGreenScreenProcessor: async () => {
      throw new Error("FFprobe did not return a usable video duration");
    },
    storeBuffer: async () => {
      throw new Error("store should not be called");
    },
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outputAssetId: "output-video",
    status: "failed",
    terminal: true,
  });
  assert.deepEqual(updates.at(-1), {
    query: {
      _id: "output-video",
      workspaceId: "workspace-1",
      status: { $in: ["queued", "in_progress"] },
    },
    update: {
      status: "failed",
      error: "FFprobe did not return a usable video duration",
      updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    },
  });
});

test("does not reprocess or clobber an output asset that is no longer queued", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
              fileName: "talking-head.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "complete",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return {
        ...(query as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    },
  };

  const result = await processCreativeAssetEditActivity({
    input: baseInput,
    assetModel,
    storageClient: { storage: { from: () => ({}) } },
    runGreenScreenProcessor: async () => {
      throw new Error("processor should not be called");
    },
    storeBuffer: async () => {
      throw new Error("store should not be called");
    },
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outputAssetId: "output-video",
    status: "failed",
    terminal: true,
  });
  assert.deepEqual(updates, []);
});

test("throws retryable processing errors so Temporal can retry", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
              fileName: "talking-head.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return {
        ...(query as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    },
  };

  await assert.rejects(
    () =>
      processCreativeAssetEditActivity({
        input: baseInput,
        assetModel,
        storageClient: { storage: { from: () => ({}) } },
        runGreenScreenProcessor: async () => ({
          buffer: Buffer.from("green-screen-video"),
          mimeType: "video/mp4",
          fileName: "talking-head-green-screen.mp4",
          providerPayload: {
            processor: "ffmpeg-mediapipe",
          },
        }),
        storeBuffer: async () => {
          throw new Error("temporary storage outage");
        },
        now: () => new Date("2026-06-28T00:00:00.000Z"),
      }),
    /temporary storage outage/,
  );

  assert.equal(
    updates.some(
      ({ update }) => (update as Record<string, unknown>).status === "failed",
    ),
    false,
  );
});

test("retries FFmpeg failures that may come from transient source transport", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const assetModel = {
    findOne: (query: { _id: string }) =>
      createLeanChain(
        query._id === "source-video"
          ? {
              _id: "source-video",
              workspaceId: "workspace-1",
              kind: "video",
              status: "complete",
              url: "https://storage.example.com/source.mp4",
            }
          : {
              _id: "output-video",
              workspaceId: "workspace-1",
              kind: "video",
              source: "edited",
              provider: "airi",
              status: "queued",
              sourceAssetId: "source-video",
            },
      ),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return update;
    },
  };

  await assert.rejects(
    processCreativeAssetEditActivity({
      input: baseInput,
      assetModel,
      storageClient: null,
      runGreenScreenProcessor: async () => {
        throw new Error("ffmpeg exited with code 1: HTTP error 503");
      },
      storeBuffer: async () => {
        throw new Error("must not store");
      },
    }),
    /HTTP error 503/,
  );
  assert.equal(
    updates.some(
      (entry) => (entry.update as Record<string, unknown>).status === "failed",
    ),
    false,
  );
});

test("final failure updates the output asset with workspace and mutable-status scoping", async () => {
  const updates: Array<{ query: unknown; update: unknown }> = [];
  const assetModel = {
    findOne: () => createLeanChain(null),
    findOneAndUpdate: async (query: unknown, update: unknown) => {
      updates.push({ query, update });
      return {
        ...(query as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    },
  };

  const result = await failCreativeAssetEditActivity({
    input: {
      contractVersion: CREATIVE_ASSET_EDIT_ACTIVITY_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      outputAssetId: "output-video",
      error: "temporary storage outage",
    },
    assetModel,
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outputAssetId: "output-video",
    status: "failed",
    terminal: true,
  });
  assert.deepEqual(updates, [
    {
      query: {
        _id: "output-video",
        workspaceId: "workspace-1",
        status: { $in: ["queued", "in_progress"] },
      },
      update: {
        status: "failed",
        error: "temporary storage outage",
        updatedAt: new Date("2026-06-28T00:00:00.000Z"),
      },
    },
  ]);
});
