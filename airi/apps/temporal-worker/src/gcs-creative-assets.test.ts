import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { Storage } from "@google-cloud/storage";

import { CREATIVE_ASSET_CACHE_CONTROL } from "@icecore/airi-runtime/media-api";

import {
  createGcsCreativeAssetUpload,
  copyGcsCreativeAssetObject,
  deleteGcsCreativeAssetObject,
  statGcsCreativeAssetObject,
  uploadGcsCreativeAssetFile,
  uploadGcsCreativeAssetBuffer,
} from "./gcs-creative-assets";

const admittedStorage = {
  reserve: async () => ({
    _id: "test-reservation",
    status: "reserved" as const,
  }),
  settle: async () => {},
};

test("reserves bytes before issuing a create-only exact-size signed PUT", async (t) => {
  t.mock.method(Storage.prototype, "bucket", () => ({
    file: () => ({ createResumableUpload: async () => ["legacy"] }),
  }));
  const operations: string[] = [];
  let signedOptions: unknown;
  const result = await createGcsCreativeAssetUpload({
    workspaceId: "workspace-1",
    assetId: "asset-1",
    kind: "image",
    fileName: "image.png",
    mimeType: "image/png",
    fileSize: 17,
    storageClient: {
      bucket: () => ({
        file: () => ({
          getMetadata: async () => [],
          getSignedUrl: async (options: unknown) => {
            operations.push("sign");
            signedOptions = options;
            return ["https://storage.googleapis.com/signed"];
          },
        }),
      }),
    },
    storageQuota: {
      reserve: async () => {
        operations.push("reserve");
        return { _id: "reservation", status: "reserved" };
      },
      settle: async () => {},
    },
  });
  assert.deepEqual(operations, ["reserve", "sign"]);
  assert.equal(result.mode, "single");
  assert.equal(result.headers["x-goog-content-length-range"], "17,17");
  assert.equal(result.headers["x-goog-if-generation-match"], "0");
  assert.deepEqual(
    (signedOptions as { extensionHeaders: unknown }).extensionHeaders,
    result.headers,
  );
});

test("storage quota rejection does not issue a provider capability", async (t) => {
  t.mock.method(Storage.prototype, "bucket", () => ({
    file: () => ({ createResumableUpload: async () => ["legacy"] }),
  }));
  let signed = false;
  await assert.rejects(
    createGcsCreativeAssetUpload({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      kind: "image",
      fileName: "image.png",
      mimeType: "image/png",
      fileSize: 17,
      storageClient: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => [],
            getSignedUrl: async () => {
              signed = true;
              return ["url"];
            },
          }),
        }),
      },
      storageQuota: {
        reserve: async () => {
          throw new Error("Storage limit exceeded");
        },
        settle: async () => {},
      },
    }),
    /Storage limit/,
  );
  assert.equal(signed, false);
});

test("settled identities never receive another signed write grant", async () => {
  let signed = false;
  await assert.rejects(
    createGcsCreativeAssetUpload({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      kind: "image",
      fileName: "image.png",
      mimeType: "image/png",
      fileSize: 17,
      storageClient: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => [],
            getSignedUrl: async () => {
              signed = true;
              return ["url"];
            },
          }),
        }),
      },
      storageQuota: {
        ...admittedStorage,
        reserve: async () => ({ _id: "existing", status: "stored" }),
      },
    }),
    /already stored/i,
  );
  assert.equal(signed, false);
});

test("an ambiguous buffer write is recovered from its physical object without a second charge", async () => {
  const settled: number[] = [];
  const result = await uploadGcsCreativeAssetBuffer({
    workspaceId: "workspace-1",
    assetId: "asset-1",
    kind: "image",
    fileName: "image.png",
    buffer: Buffer.from("image"),
    mimeType: "image/png",
    storageClient: {
      bucket: () => ({
        file: () => ({
          save: async () => {
            throw new Error("response lost");
          },
          getMetadata: async () => [{ size: 5 }],
        }),
      }),
    },
    storageQuota: {
      reserve: admittedStorage.reserve,
      settle: async (_id, bytes) => {
        settled.push(bytes);
      },
    },
  });
  assert.equal(result.fileSize, 5);
  assert.deepEqual(settled, [5]);
});

test("a file growing after reservation cannot send bytes beyond the reservation", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "airi-gcs-file-bound-"));
  const localPath = path.join(workDir, "output.mp4");
  await writeFile(localPath, "small");
  const chunks: Buffer[] = [];
  try {
    await uploadGcsCreativeAssetFile({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      kind: "video",
      fileName: "output.mp4",
      localPath,
      mimeType: "video/mp4",
      storageQuota: {
        reserve: async () => {
          await writeFile(localPath, "small and unexpected extra bytes");
          return { _id: "one", status: "reserved" };
        },
        settle: async () => {},
      },
      storageClient: {
        bucket: () => ({
          file: () => ({
            createWriteStream: () =>
              new Writable({
                write(chunk, _encoding, done) {
                  chunks.push(Buffer.from(chunk));
                  done();
                },
              }),
            getMetadata: async () => [
              { size: Buffer.concat(chunks).byteLength },
            ],
          }),
        }),
      },
    });
    assert.equal(Buffer.concat(chunks).toString(), "small");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("uploads source media create-only with immutable provenance and content metadata", async () => {
  const saves: unknown[] = [];
  const storageClient = {
    bucket: () => ({
      file: () => ({
        save: async (_buffer: Buffer, options: unknown) => {
          saves.push(options);
        },
      }),
    }),
  };

  await uploadGcsCreativeAssetBuffer({
    storageClient,
    storageQuota: admittedStorage,
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    assetId: "0123456789abcdef01234567",
    kind: "image",
    buffer: Buffer.from("owned-image"),
    mimeType: "image/jpeg",
    fileName: "0123456789abcdef01234567.jpg",
    customMetadata: {
      scenarioGenerativeSourceDigest: "a".repeat(64),
      scenarioGenerativeContentSha256: "b".repeat(64),
    },
    preconditionOpts: { ifGenerationMatch: 0 },
  });

  assert.deepEqual(saves, [
    {
      resumable: false,
      contentType: "image/jpeg",
      metadata: {
        cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
        metadata: {
          workspaceId: "workspace-1",
          assetId: "0123456789abcdef01234567",
          kind: "image",
          scenarioGenerativeSourceDigest: "a".repeat(64),
          scenarioGenerativeContentSha256: "b".repeat(64),
        },
      },
      preconditionOpts: { ifGenerationMatch: 0 },
    },
  ]);
});

test("copies an exact source generation server-side into a create-only destination", async () => {
  const fileCalls: unknown[] = [];
  const copyCalls: unknown[] = [];
  const destination = {
    getMetadata: async () => [
      { generation: "22", metageneration: "1", size: 8 },
    ],
  };
  const storageClient = {
    bucket: (bucket: string) => ({
      file: (objectPath: string, options?: unknown) => {
        fileCalls.push({ bucket, objectPath, options });
        if (objectPath.includes("/parent-asset/")) {
          return {
            getMetadata: async () => [{ size: 8 }],
            copy: async (copyDestination: unknown, copyOptions: unknown) => {
              copyCalls.push({
                destination: copyDestination,
                options: copyOptions,
              });
              return [destination] as [typeof destination];
            },
          };
        }
        return destination;
      },
    }),
  };

  const result = await copyGcsCreativeAssetObject({
    storageClient,
    storageQuota: admittedStorage,
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    sourcePath:
      "workspaces/workspace-1/creative-assets/video/parent-asset/generated-video.mp4",
    sourceGeneration: "17",
    sourceMetageneration: "3",
    destinationPath:
      "workspaces/workspace-1/creative-assets/video/child-asset/generated-video.mp4",
    mimeType: "video/mp4",
    customMetadata: { sha256: "abc123", assetId: "child-asset" },
  });

  assert.deepEqual(result, { generation: "22", metageneration: "1" });
  assert.deepEqual(fileCalls[0], {
    bucket: "creative-assets",
    objectPath:
      "workspaces/workspace-1/creative-assets/video/parent-asset/generated-video.mp4",
    options: { generation: "17" },
  });
  assert.deepEqual(copyCalls, [
    {
      destination,
      options: {
        cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
        contentType: "video/mp4",
        metadata: {
          sha256: "abc123",
          assetId: "child-asset",
          workspaceId: "workspace-1",
          kind: "video",
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      },
    },
  ]);
});

test("uploads a rendered file through a bounded create-only stream", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "airi-gcs-file-test-"));
  const localPath = path.join(workDir, "timeline.mp4");
  await writeFile(localPath, Buffer.from("rendered-video"));
  const uploads: Array<{
    bucket: string;
    path: string;
    options: Record<string, unknown>;
  }> = [];
  const storageClient = {
    bucket: (bucket: string) => ({
      file: (objectPath: string) => ({
        createWriteStream: (options: Record<string, unknown>) => {
          uploads.push({ bucket, path: objectPath, options });
          return new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          });
        },
        getMetadata: async () => [
          { generation: "17", metageneration: "3", size: 14 },
        ],
      }),
    }),
  };

  try {
    const result = await uploadGcsCreativeAssetFile({
      storageClient,
      storageQuota: admittedStorage,
      bucket: "creative-assets",
      workspaceId: "workspace-1",
      assetId: "asset-1",
      kind: "video",
      localPath,
      mimeType: "video/mp4",
      fileName: "timeline.mp4",
      customMetadata: { sha256: "abc123", attemptTokenHash: "attempt-hash" },
      preconditionOpts: { ifGenerationMatch: 0 },
    });

    assert.equal(result.storageProvider, "gcs");
    assert.equal(result.fileSize, 14);
    assert.equal(result.bucket, "creative-assets");
    assert.equal(
      result.path,
      "workspaces/workspace-1/creative-assets/video/asset-1/timeline.mp4",
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.path, result.path);
    assert.deepEqual(uploads[0]?.options, {
      resumable: true,
      metadata: {
        contentType: "video/mp4",
        cacheControl: CREATIVE_ASSET_CACHE_CONTROL,
        metadata: {
          workspaceId: "workspace-1",
          assetId: "asset-1",
          kind: "video",
          sha256: "abc123",
          attemptTokenHash: "attempt-hash",
        },
      },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    assert.equal(result.generation, "17");
    assert.equal(result.metageneration, "3");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("deletion leaves an empty generation-fenced tombstone blocking old create-only grants", async () => {
  const writes: unknown[] = [];
  const operations: string[] = [];
  const storageClient = {
    bucket: () => ({
      file: () => ({
        exists: async () => [true] as [boolean],
        getMetadata: async () => [
          {
            size: "42",
            contentType: "video/mp4",
            updated: "2026-07-23T00:00:00.000Z",
            metadata: { sha256: "hash", assetId: "asset-1" },
            generation: "9",
            metageneration: "2",
          },
        ],
        save: async (buffer: Buffer, options: unknown) => {
          operations.push("save");
          writes.push({ bytes: buffer.byteLength, options });
        },
      }),
    }),
  };

  const stat = await statGcsCreativeAssetObject({
    storageClient,
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
  });
  assert.deepEqual(stat, {
    exists: true,
    fileSize: 42,
    mimeType: "video/mp4",
    updatedAt: "2026-07-23T00:00:00.000Z",
    customMetadata: { sha256: "hash", assetId: "asset-1" },
    generation: "9",
    metageneration: "2",
  });

  await deleteGcsCreativeAssetObject({
    storageClient,
    tombstone: async (_id, observation) => {
      assert.deepEqual(observation, { generation: "9", bytes: 42 });
      operations.push("tombstone");
    },
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    path: "workspaces/workspace-1/creative-assets/video/asset-1/generated-video.mp4",
    ifGenerationMatch: "9",
    ifMetagenerationMatch: "2",
  });
  assert.deepEqual(operations, ["tombstone", "save"]);
  assert.deepEqual(writes, [
    {
      bytes: 0,
      options: {
        resumable: false,
        contentType: "application/octet-stream",
        metadata: {
          cacheControl: "no-store",
          metadata: { airiDeleted: "true" },
        },
        preconditionOpts: {
          ifGenerationMatch: "9",
          ifMetagenerationMatch: "2",
        },
      },
    },
  ]);
});

test("replayed deletion and old grants cannot accumulate retained generations", async () => {
  const observations: unknown[] = [];
  let current = {
    size: 42,
    generation: "9",
    metadata: {} as Record<string, string>,
  };
  let writes = 0;
  const save = async (
    buffer: Buffer,
    options: { preconditionOpts?: { ifGenerationMatch: string | 0 } },
  ) => {
    if (
      String(options.preconditionOpts?.ifGenerationMatch) !== current.generation
    )
      throw Object.assign(new Error("precondition failed"), { code: 412 });
    writes++;
    current = {
      size: buffer.byteLength,
      generation: "10",
      metadata: { airiDeleted: "true" },
    };
  };
  const input = {
    storageClient: {
      bucket: () => ({
        file: () => ({ getMetadata: async () => [current], save }),
      }),
    },
    tombstone: async (
      _id: string,
      observed?: { generation: string; bytes: number },
    ) => {
      observations.push(observed);
    },
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    path: "workspaces/workspace-1/creative-assets/image/asset-1/image.png",
  };
  await deleteGcsCreativeAssetObject(input);
  await assert.rejects(
    save(Buffer.alloc(42), { preconditionOpts: { ifGenerationMatch: 0 } }),
    /precondition/,
  );
  await deleteGcsCreativeAssetObject(input);
  assert.equal(writes, 1);
  assert.equal(current.size, 0);
  assert.deepEqual(observations, [{ generation: "9", bytes: 42 }, undefined]);
});

test("a rejected provider tombstone write preserves the claimed retained generation", async () => {
  let observed: unknown;
  await assert.rejects(
    deleteGcsCreativeAssetObject({
      storageClient: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => [{ size: 8, generation: "9" }],
            save: async () => {
              throw Object.assign(new Error("generation precondition failed"), {
                code: 412,
              });
            },
          }),
        }),
      },
      tombstone: async (_id, value) => {
        observed = value;
      },
      bucket: "creative-assets",
      workspaceId: "workspace-1",
      path: "workspaces/workspace-1/creative-assets/image/asset-1/held.png",
    }),
    /precondition/,
  );
  assert.deepEqual(observed, { generation: "9", bytes: 8 });
});

test("a missing object receives a create-only tombstone and rejects stale cleanup versions", async () => {
  const writes: unknown[] = [];
  const input = {
    storageClient: {
      bucket: () => ({
        file: () => ({
          getMetadata: async () => {
            throw Object.assign(new Error("missing"), { code: 404 });
          },
          save: async (_buffer: Buffer, options: unknown) => {
            writes.push(options);
          },
        }),
      }),
    },
    tombstone: async () => {},
    bucket: "creative-assets",
    workspaceId: "workspace-1",
    path: "workspaces/workspace-1/creative-assets/image/asset-1/missing.png",
  };
  await deleteGcsCreativeAssetObject(input);
  assert.deepEqual(
    (writes[0] as { preconditionOpts: unknown }).preconditionOpts,
    { ifGenerationMatch: 0 },
  );
  let tombstoned = false;
  await assert.rejects(
    deleteGcsCreativeAssetObject({
      ...input,
      ifGenerationMatch: "2",
      tombstone: async () => {
        tombstoned = true;
      },
      storageClient: {
        bucket: () => ({
          file: () => ({
            getMetadata: async () => [{ size: 42, generation: "3" }],
            save: async () => {
              throw new Error("must not write");
            },
          }),
        }),
      },
    }),
    /version changed/,
  );
  assert.equal(tombstoned, false);
});
