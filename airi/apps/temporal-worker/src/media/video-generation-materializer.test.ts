import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeVideoGenerationResult,
  writeBase64VideoToFile,
  type VideoGenerationMaterializerDependencies,
  type VideoGenerationMaterializerInput,
} from "./video-generation-materializer";
import { VideoGenerationFinalizationError } from "../video-generation-finalization-failure";

test("rejects oversized base64 before or during bounded chunk decoding", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "airi-base64-video-test-"),
  );
  try {
    await assert.rejects(
      writeBase64VideoToFile(
        Buffer.alloc(17).toString("base64"),
        path.join(directory, "decoded.mp4"),
        16,
      ),
      /size limit/i,
    );
    await assert.rejects(
      writeBase64VideoToFile(
        `${" ".repeat(5_000)}YQ==`,
        path.join(directory, "whitespace.mp4"),
        16,
      ),
      /encoded size limit/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries short file writes until every decoded byte is persisted", async () => {
  const source = Buffer.from("a complete generated video payload");
  const persisted: Buffer[] = [];
  let closed = false;
  const result = await writeBase64VideoToFile(
    source.toString("base64"),
    "unused-by-injected-writer.mp4",
    source.byteLength,
    {
      openFile: async () => ({
        write: async (
          buffer: Uint8Array,
          offset = 0,
          length = buffer.byteLength - offset,
        ) => {
          const bytesWritten = Math.min(3, length);
          persisted.push(
            Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
          );
          return { bytesWritten };
        },
        close: async () => {
          closed = true;
        },
      }),
    },
  );

  assert.deepEqual(Buffer.concat(persisted), source);
  assert.equal(result.fileSize, source.byteLength);
  assert.equal(
    result.sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(closed, true);
});

test("fails safely when a file write makes no progress", async () => {
  let closed = false;
  await assert.rejects(
    writeBase64VideoToFile("YQ==", "unused-by-injected-writer.mp4", 1, {
      openFile: async () => ({
        write: async () => ({ bytesWritten: 0 }),
        close: async () => {
          closed = true;
        },
      }),
    }),
    /write.*progress/i,
  );
  assert.equal(closed, true);
});

const input: VideoGenerationMaterializerInput = {
  workspaceId: "workspace-1",
  assetId: "asset-1",
  attemptToken: "attempt-1",
  providerRequestId: "request-1",
  recipeFingerprint: "recipe-1",
  provider: "happyhorse",
  requestedDurationSeconds: 6,
};

function missingObject() {
  return {
    exists: false,
    fileSize: null,
    mimeType: null,
    updatedAt: null,
    customMetadata: {},
    generation: null,
    metageneration: null,
  };
}

function baseDependencies(
  overrides: Partial<VideoGenerationMaterializerDependencies> = {},
) {
  const calls = {
    provider: 0,
    copies: [] as unknown[],
    completes: [] as unknown[],
    clears: [] as unknown[],
    deletes: [] as unknown[],
    stages: [] as unknown[],
    uploads: [] as unknown[],
    tempPaths: [] as string[],
  };
  const deps: VideoGenerationMaterializerDependencies = {
    bucketName: "creative-assets",
    getAsset: async () => ({ status: "in_progress", generationResult: null }),
    statObject: async () => missingObject(),
    loadProviderResult: async () => {
      calls.provider += 1;
      return {
        kind: "url",
        url: "https://cdn.example/video.mp4",
        policy: { kind: "dynamic" },
        mimeType: "video/mp4",
      };
    },
    writeProviderResult: async ({ destinationPath, result }) => {
      calls.tempPaths.push(destinationPath);
      await writeFile(destinationPath, "valid-video");
      return {
        fileSize: 11,
        sha256: "a".repeat(64),
        mimeType: result.mimeType || "video/mp4",
      };
    },
    probeVideoFile: async () => ({
      durationSeconds: 6,
      width: 1080,
      height: 1920,
      mimeType: "video/mp4",
    }),
    uploadFile: async (params) => {
      calls.uploads.push(params);
      return {
        storageProvider: "gcs",
        url: "gs://creative-assets/workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
        bucket: "creative-assets",
        path: params.path,
        mimeType: params.mimeType,
        fileName: "generated-video.mp4",
        fileSize: 11,
        generation: "7",
        metageneration: "2",
      };
    },
    copyObject: async (params) => {
      calls.copies.push(params);
      return { generation: "8", metageneration: "1" };
    },
    deleteObject: async (params) => {
      calls.deletes.push(params);
      return { deleted: true };
    },
    stageAsset: async (params) => {
      calls.stages.push(params);
      return { matched: true };
    },
    clearStagedAsset: async (params) => {
      calls.clears.push(params);
      return { matched: true };
    },
    completeAsset: async (params) => {
      calls.completes.push(params);
      return { matched: true };
    },
    ...overrides,
  };
  return { deps, calls };
}

test("reuses a matching deterministic object before touching the provider", async () => {
  const stored = storedObjectWithMatchingIdentity({});
  const { deps, calls } = baseDependencies({
    statObject: async () => ({
      ...stored,
      customMetadata: {
        ...stored.customMetadata,
        resultProviderUsage: JSON.stringify({ billedSeconds: 6 }),
        resultWarnings: JSON.stringify([
          {
            code: "duration_mismatch",
            message: "Generated video duration differs from the request",
          },
        ]),
      },
    }),
  });
  const result = await materializeVideoGenerationResult(input, deps);
  assert.equal(calls.provider, 0);
  assert.equal(calls.stages.length, 1);
  assert.equal(calls.completes.length, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.result.sha256, "a".repeat(64));
  assert.deepEqual(result.result.providerUsage, { billedSeconds: 6 });
  assert.deepEqual(result.result.warnings, [
    {
      code: "duration_mismatch",
      message: "Generated video duration differs from the request",
    },
  ]);
});

function storedObjectWithMatchingIdentity(overrides: {
  fileSize?: number | null;
  mimeType?: string | null;
  metadataFileSize?: string;
  metadataMimeType?: string;
}) {
  return {
    exists: true,
    fileSize: overrides.fileSize ?? 11,
    mimeType: overrides.mimeType ?? "video/mp4",
    updatedAt: "2026-07-23T00:00:00.000Z",
    generation: "7",
    metageneration: "2",
    customMetadata: {
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      recipeFingerprint: input.recipeFingerprint,
      provider: input.provider,
      attemptTokenHash:
        "3dafcfaa6218343276ff42263fe100bab5e2b0475a8d98b96abc88c57bfd9992",
      providerRequestIdHash:
        "19f1064b619d49d35392eac7261cd7266c720671fc594f4b226f32bf0bee74ba",
      sha256: "a".repeat(64),
      width: "1080",
      height: "1920",
      durationSeconds: "6",
      mimeType: overrides.metadataMimeType ?? "video/mp4",
      fileSize: overrides.metadataFileSize ?? "11",
    },
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function storedObjectFor(
  identity: VideoGenerationMaterializerInput,
  metadataOverrides: Record<string, string> = {},
): {
  exists: true;
  fileSize: number;
  mimeType: string;
  updatedAt: string;
  generation: string;
  metageneration: string;
  customMetadata: Record<string, string>;
} {
  return {
    exists: true,
    fileSize: 11,
    mimeType: "video/mp4",
    updatedAt: "2026-07-23T00:00:00.000Z",
    generation: "17",
    metageneration: "3",
    customMetadata: {
      workspaceId: identity.workspaceId,
      assetId: identity.assetId,
      recipeFingerprint: identity.recipeFingerprint,
      provider: identity.provider,
      attemptTokenHash: sha(identity.attemptToken),
      providerRequestIdHash: sha(identity.providerRequestId),
      sha256: "b".repeat(64),
      width: "1080",
      height: "1920",
      durationSeconds: "6",
      mimeType: "video/mp4",
      fileSize: "11",
      completedAt: "2026-07-23T00:00:00.000Z",
      ...metadataOverrides,
    },
  };
}

/** A child asset recovering asset-1's stored result. */
const recoveryInput: VideoGenerationMaterializerInput = {
  ...input,
  assetId: "child-asset",
  attemptToken: "child-attempt",
  recipeFingerprint: "c".repeat(64),
  recoverySource: {
    assetId: input.assetId,
    attemptToken: input.attemptToken,
    providerRequestId: input.providerRequestId,
    recipeFingerprint: "d".repeat(64),
    provider: input.provider,
  },
};

/** The identity asset-1's stored object was written under. */
const recoverySourceIdentity: VideoGenerationMaterializerInput = {
  ...recoveryInput,
  assetId: input.assetId,
  attemptToken: input.attemptToken,
  recipeFingerprint: "d".repeat(64),
  recoverySource: null,
};

/**
 * Storage where asset-1's object exists until deleteObject removes it and
 * copyObject creates the child's copy.
 */
function recoveryDependencies(
  deleteObject: (
    params: Parameters<
      VideoGenerationMaterializerDependencies["deleteObject"]
    >[0],
    removeSource: () => void,
  ) => { deleted: boolean },
) {
  let copiedObject: ReturnType<typeof storedObjectFor> | null = null;
  let sourceExists = true;
  const harness = baseDependencies({
    statObject: async ({ path: objectPath }) => {
      if (objectPath.includes("/asset-1/")) {
        return sourceExists
          ? storedObjectFor(recoverySourceIdentity)
          : missingObject();
      }
      return copiedObject ?? missingObject();
    },
    copyObject: async (params) => {
      harness.calls.copies.push(params);
      copiedObject = {
        ...storedObjectFor(recoveryInput),
        generation: "18",
        metageneration: "1",
        customMetadata: { ...params.customMetadata },
      };
      return { generation: "18", metageneration: "1" };
    },
    deleteObject: async (params) => {
      harness.calls.deletes.push(params);
      return deleteObject(params, () => {
        sourceExists = false;
      });
    },
  });
  return harness;
}

test("copies a matching stored parent version before provider refetch and removes the source", async () => {
  const { deps, calls } = recoveryDependencies((params, removeSource) => {
    if (params.path.includes("/asset-1/")) removeSource();
    return { deleted: true };
  });

  const result = await materializeVideoGenerationResult(recoveryInput, deps);

  assert.equal(result.status, "complete");
  assert.equal(result.result.sha256, "b".repeat(64));
  assert.equal(calls.provider, 0);
  assert.equal(calls.copies.length, 1);
  assert.deepEqual(calls.deletes, [
    {
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
      workspaceId: "workspace-1",
      ifGenerationMatch: "17",
      ifMetagenerationMatch: "3",
    },
  ]);
  assert.deepEqual(calls.clears, [
    {
      expected: {
        workspaceId: "workspace-1",
        assetId: "asset-1",
        attemptToken: "attempt-1",
        providerRequestId: "request-1",
      },
      storage: {
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
      },
    },
  ]);
});

test("retries source cleanup from the matching child copy without recopying or refetching", async () => {
  let deleteAttempts = 0;
  const { deps, calls } = recoveryDependencies((_params, removeSource) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("temporary cleanup outage");
    removeSource();
    return { deleted: true };
  });

  await assert.rejects(
    materializeVideoGenerationResult(recoveryInput, deps),
    (error: unknown) =>
      error instanceof VideoGenerationFinalizationError &&
      error.failure.code === "result_store_cleanup_failed",
  );
  const result = await materializeVideoGenerationResult(recoveryInput, deps);

  assert.equal(result.status, "complete");
  assert.equal(calls.copies.length, 1);
  assert.equal(calls.provider, 0);
  assert.equal(calls.completes.length, 1);
  assert.equal(calls.deletes.length, 2);
  assert.equal(calls.clears.length, 1);
});

const storedResultIdentityMismatches: Array<{
  name: string;
  metadata: Record<string, string>;
}> = [
  {
    name: "workspace",
    metadata: { workspaceId: "another-workspace" },
  },
  {
    name: "attempt",
    metadata: { attemptTokenHash: sha("another-attempt") },
  },
  {
    name: "provider",
    metadata: { provider: "google" },
  },
];

for (const mismatch of storedResultIdentityMismatches) {
  test(`does not reuse a stored parent with a ${mismatch.name} mismatch`, async () => {
    const { deps, calls } = baseDependencies({
      statObject: async ({ path: objectPath }) =>
        objectPath.includes("/asset-1/")
          ? storedObjectFor(recoverySourceIdentity, mismatch.metadata)
          : missingObject(),
    });

    await materializeVideoGenerationResult(recoveryInput, deps);

    assert.equal(calls.copies.length, 0);
    assert.equal(calls.provider, 1);
    assert.equal(calls.deletes.length, 0);
  });
}

test("deletes a recovered matching object version when NSFW wins completion", async () => {
  let reads = 0;
  const { deps, calls } = baseDependencies({
    bucketName: "creative-assets",
    getAsset: async () => {
      reads += 1;
      return {
        status: reads === 1 ? "in_progress" : "nsfw",
        generationResult: null,
      };
    },
    statObject: async () => storedObjectWithMatchingIdentity({}),
    completeAsset: async () => ({ matched: false }),
  });

  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    /completion race/i,
  );
  assert.equal(calls.provider, 0);
  assert.deepEqual(calls.deletes, [
    {
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
      workspaceId: "workspace-1",
      ifGenerationMatch: "7",
      ifMetagenerationMatch: "2",
    },
  ]);
});

test("deletes a matching deterministic object when the asset is already NSFW", async () => {
  const { deps, calls } = baseDependencies({
    bucketName: "creative-assets",
    getAsset: async () => ({
      status: "nsfw",
      generationResult: null,
    }),
    statObject: async () => storedObjectWithMatchingIdentity({}),
  });

  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    /already terminal: nsfw/i,
  );
  assert.equal(calls.provider, 0);
  assert.deepEqual(calls.deletes, [
    {
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
      workspaceId: "workspace-1",
      ifGenerationMatch: "7",
      ifMetagenerationMatch: "2",
    },
  ]);
});

test("does not recover metadata whose file size disagrees with GCS", async () => {
  const { deps, calls } = baseDependencies({
    statObject: async () =>
      storedObjectWithMatchingIdentity({
        fileSize: 11,
        metadataFileSize: "11.5",
      }),
  });

  await materializeVideoGenerationResult(input, deps);
  assert.equal(calls.provider, 1);
  assert.equal(calls.deletes.length, 1);
});

test("does not recover metadata whose MIME type disagrees with GCS", async () => {
  const { deps, calls } = baseDependencies({
    statObject: async () =>
      storedObjectWithMatchingIdentity({
        mimeType: "video/webm",
        metadataMimeType: "video/mp4",
      }),
  });

  await materializeVideoGenerationResult(input, deps);
  assert.equal(calls.provider, 1);
  assert.equal(calls.deletes.length, 1);
});

test("streams, probes, uploads with recoverable metadata, completes, and cleans temp files", async () => {
  const { deps, calls } = baseDependencies();
  const result = await materializeVideoGenerationResult(input, deps);
  assert.equal(result.status, "complete");
  assert.equal(calls.stages.length, 1);
  assert.equal(calls.completes.length, 1);
  const complete = calls.completes[0] as {
    expected: unknown;
    result: { width: number };
  };
  assert.deepEqual(complete.expected, {
    workspaceId: "workspace-1",
    assetId: "asset-1",
    attemptToken: "attempt-1",
    providerRequestId: "request-1",
    allowedStatuses: ["queued", "in_progress"],
  });
  assert.equal(complete.result.width, 1080);
  const stage = calls.stages[0] as {
    storage: { storageProvider: string; path: string; fileSize: number };
  };
  assert.deepEqual(stage.storage, {
    storageProvider: "gcs",
    url: "gs://creative-assets/workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
    bucket: "creative-assets",
    path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
    mimeType: "video/mp4",
    fileName: "generated-video.mp4",
    fileSize: 11,
  });
  await assert.rejects(access(calls.tempPaths[0]!), /ENOENT/);
});

test("fails before completion when the staged storage reference cannot be persisted", async () => {
  const { deps, calls } = baseDependencies({
    stageAsset: async () => ({ matched: false }),
  });

  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    (error: unknown) =>
      error instanceof VideoGenerationFinalizationError &&
      error.failure.code === "result_stage_conflict",
  );
  assert.equal(calls.completes.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test("rejects provider and platform duration ceilings before upload", async () => {
  let uploads = 0;
  const { deps } = baseDependencies({
    probeVideoFile: async () => ({
      durationSeconds: 16,
      width: 1080,
      height: 1920,
      mimeType: "video/mp4",
    }),
    uploadFile: async () => {
      uploads += 1;
      throw new Error("should not upload");
    },
  });
  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    (error: unknown) =>
      error instanceof VideoGenerationFinalizationError &&
      error.failure.code === "result_duration_invalid" &&
      error.failure.retryable === false,
  );
  assert.equal(uploads, 0);
});

test("records bounded duration and MIME normalization warnings", async () => {
  const { deps, calls } = baseDependencies({
    loadProviderResult: async () => ({
      kind: "url",
      url: "https://cdn.example/video",
      policy: { kind: "dynamic" },
      mimeType: "application/octet-stream",
      providerUsage: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `key-${index}`,
          "x".repeat(300),
        ]),
      ),
    }),
    probeVideoFile: async () => ({
      durationSeconds: 8,
      width: 1080,
      height: 1920,
      mimeType: "video/mp4",
    }),
  });
  await materializeVideoGenerationResult(input, deps);
  const complete = calls.completes[0] as {
    result: {
      warnings: Array<{ code: string }>;
      providerUsage: Record<string, string>;
    };
  };
  assert.deepEqual(
    complete.result.warnings.map((item) => item.code),
    ["duration_mismatch", "mime_type_normalized"],
  );
  assert.equal(Object.keys(complete.result.providerUsage).length, 16);
  assert.equal(Object.values(complete.result.providerUsage)[0]?.length, 256);
  const upload = calls.uploads[0] as {
    customMetadata: Record<string, string>;
  };
  assert.deepEqual(JSON.parse(upload.customMetadata.resultWarnings!), [
    {
      code: "duration_mismatch",
      message: "Generated video duration differs from the requested duration",
    },
    {
      code: "mime_type_normalized",
      message: "Generated video MIME type was normalized from probed media",
    },
  ]);
  assert.equal(
    Object.keys(JSON.parse(upload.customMetadata.resultProviderUsage!)).length,
    16,
  );
});

for (const [kind, value] of [
  ["multibyte", "界".repeat(256)],
  ["JSON-escaped control", "\u0001".repeat(256)],
] as const) {
  test(`keeps the whole GCS metadata map byte-safe for ${kind} provider usage`, async () => {
    const { deps, calls } = baseDependencies({
      loadProviderResult: async () => ({
        kind: "url",
        url: "https://cdn.example/video",
        policy: { kind: "dynamic" },
        providerUsage: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [`usage-${index}`, value]),
        ),
      }),
    });

    await materializeVideoGenerationResult(input, deps);

    const upload = calls.uploads[0] as {
      customMetadata: Record<string, string>;
    };
    const metadataBytes = Object.entries(upload.customMetadata).reduce(
      (total, [key, metadataValue]) =>
        total +
        Buffer.byteLength(`x-goog-meta-${key}: ${metadataValue}\r\n`, "utf8"),
      0,
    );
    assert.ok(metadataBytes <= 6 * 1024);

    const storedUsage = JSON.parse(
      upload.customMetadata.resultProviderUsage ?? "{}",
    ) as Record<string, string>;
    const complete = calls.completes[0] as {
      result: { providerUsage: Record<string, string> | null };
    };
    assert.deepEqual(complete.result.providerUsage, storedUsage);
    assert.ok(Object.keys(storedUsage).length > 0);
    assert.ok(Object.keys(storedUsage).length < 16);
  });
}

test("retains the just-written object for lossless recovery when a failed status wins completion", async () => {
  let reads = 0;
  const { deps, calls } = baseDependencies({
    getAsset: async () => {
      reads += 1;
      return {
        status: reads === 1 ? "in_progress" : "failed",
        generationResult: null,
      };
    },
    completeAsset: async () => ({ matched: false }),
  });
  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    /completion race/i,
  );
  assert.equal(calls.deletes.length, 0);
});

test("never deletes an object owned by another attempt", async () => {
  const { deps, calls } = baseDependencies({
    statObject: async () => ({
      exists: true,
      fileSize: 11,
      mimeType: "video/mp4",
      updatedAt: null,
      generation: "9",
      metageneration: "1",
      customMetadata: {
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        recipeFingerprint: input.recipeFingerprint,
        attemptTokenHash: "different",
        providerRequestIdHash: "different",
      },
    }),
  });
  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    /storage_object_conflict/,
  );
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.provider, 0);
});

function readFailure(error: unknown) {
  return (
    error as {
      failure?: {
        phase?: string;
        code?: string;
        retryable?: boolean;
        message?: string;
      };
    }
  ).failure;
}

for (const scenario of [
  {
    name: "download",
    overrides: {
      writeProviderResult: async () => {
        throw new Error(
          "download exposed https://signed.example/video?token=secret",
        );
      },
    },
    expected: {
      phase: "download",
      code: "result_download_failed",
      retryable: true,
    },
  },
  {
    name: "probe",
    overrides: {
      probeVideoFile: async () => {
        throw new Error("ffprobe exposed C:\\secret\\video.mp4");
      },
    },
    expected: {
      phase: "probe",
      code: "result_probe_failed",
      retryable: true,
    },
  },
  {
    name: "store",
    overrides: {
      uploadFile: async () => {
        throw new Error("upload exposed gs://secret-bucket/video");
      },
    },
    expected: {
      phase: "store",
      code: "result_store_failed",
      retryable: true,
    },
  },
] as const) {
  test(`classifies and redacts ${scenario.name} failures at their materialization stage`, async () => {
    const { deps } = baseDependencies(
      scenario.overrides as Partial<VideoGenerationMaterializerDependencies>,
    );
    await assert.rejects(
      materializeVideoGenerationResult(input, deps),
      (error: unknown) => {
        const failure = readFailure(error);
        assert.equal(failure?.phase, scenario.expected.phase);
        assert.equal(failure?.code, scenario.expected.code);
        assert.equal(failure?.retryable, scenario.expected.retryable);
        assert.doesNotMatch(
          failure?.message || "",
          /https?:|gs:|token=|secret/i,
        );
        return true;
      },
    );
  });
}

test("classifies Mongo completion failures as retryable store failures", async () => {
  const { deps } = baseDependencies({
    completeAsset: async () => {
      throw new Error(
        "Mongo connection included mongodb://user:secret@host/db",
      );
    },
  });

  await assert.rejects(
    materializeVideoGenerationResult(input, deps),
    (error: unknown) => {
      const failure = readFailure(error);
      assert.deepEqual(
        {
          phase: failure?.phase,
          code: failure?.code,
          retryable: failure?.retryable,
        },
        {
          phase: "store",
          code: "result_store_failed",
          retryable: true,
        },
      );
      assert.doesNotMatch(failure?.message || "", /mongodb:|user:|secret/i);
      return true;
    },
  );
});
