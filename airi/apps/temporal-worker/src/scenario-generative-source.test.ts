import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGcsUri } from "@icecore/airi-runtime/media-api";

import {
  buildScenarioGenerativeSourceIdentity,
  importScenarioGenerativeWhatsAppSource,
  type ScenarioGenerativeSourceDependencies,
} from "./activities/scenario-generative-source.js";

const input = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  inputMessageId: "message-1",
  whatsappMediaId: "media-1",
  declaredMimeType: "image/jpeg",
  fileName: "camera.jpg",
};

function createDependencies(
  overrides: Partial<ScenarioGenerativeSourceDependencies> = {},
) {
  const identity = buildScenarioGenerativeSourceIdentity(input);
  const path = `workspaces/workspace-1/creative-assets/image/${identity.assetId}/${identity.assetId}.jpg`;
  // What uploadGcsCreativeAssetBuffer returns: the canonical gcs:// URI.
  const stored = {
    storageProvider: "gcs" as const,
    url: canonicalGcsUri("creative-assets", path),
    bucket: "creative-assets",
    path,
    mimeType: "image/jpeg",
    fileName: `${identity.assetId}.jpg`,
    fileSize: 11,
  };
  const object = {
    exists: true,
    fileSize: 11,
    mimeType: "image/jpeg",
    customMetadata: {
      workspaceId: input.workspaceId,
      assetId: identity.assetId,
      kind: "image",
      scenarioGenerativeSourceVersion: "1",
      scenarioGenerativeSourceDigest: identity.provenanceDigest,
      scenarioGenerativeSourceWorkspaceId: input.workspaceId,
      scenarioGenerativeSourceConversationId: input.conversationId,
      scenarioGenerativeSourceInputMessageId: input.inputMessageId,
      scenarioGenerativeSourceWhatsAppMediaId: input.whatsappMediaId,
      scenarioGenerativeSourceDeclaredMimeType: "image/jpeg",
      scenarioGenerativeContentSha256: "c".repeat(64),
    },
  };
  const updates: unknown[] = [];
  let claimedAsset: Record<string, unknown> | null = null;
  const deps: ScenarioGenerativeSourceDependencies = {
    allowedImageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    maxImageBytes: 5 * 1024 * 1024,
    bucket: "creative-assets",
    createPath: ({ workspaceId, assetId, fileName }) =>
      `workspaces/${workspaceId}/creative-assets/image/${assetId}/${fileName}`,
    findAsset: async () => claimedAsset,
    upsertPendingAsset: async (asset) => {
      if (!claimedAsset) claimedAsset = asset;
    },
    completeAsset: async (_id: string, update: Record<string, unknown>) => {
      updates.push(update);
      claimedAsset = { ...(claimedAsset || {}), ...update };
    },
    downloadOwnedWhatsAppMedia: async () => ({
      buffer: Buffer.from("owned-image"),
      contentType: "image/jpeg",
      sizeBytes: 11,
      sha256: "c".repeat(64),
    }),
    upload: async () => stored,
    stat: async ({ path }) =>
      path.endsWith(".jpg") ? object : { exists: false },
    ...overrides,
  };
  return {
    identity,
    stored,
    object,
    updates,
    deps,
  };
}

type Fixture = ReturnType<typeof createDependencies>;

function sourceMedia(
  fixture: Fixture,
  {
    declaredMimeType = "image/jpeg" as string | null,
    contentSha256 = null as string | null,
  } = {},
) {
  return {
    version: 1,
    provenanceDigest: fixture.identity.provenanceDigest,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    inputMessageId: input.inputMessageId,
    whatsappMediaId: input.whatsappMediaId,
    declaredMimeType,
    contentSha256,
  };
}

/** The claimed in-progress source document, before the object is verified. */
function pendingSourceAsset(
  fixture: Fixture,
  media: Parameters<typeof sourceMedia>[1] = {},
) {
  return {
    _id: fixture.identity.assetId,
    workspaceId: input.workspaceId,
    kind: "image",
    source: "uploaded",
    status: "in_progress",
    sourceMedia: sourceMedia(fixture, media),
  };
}

/** A stat seam that misses the first lookup and then finds the object. */
function objectAfterFirstStat(fixture: Fixture) {
  let statCalls = 0;
  return async () => {
    statCalls += 1;
    return statCalls === 1 ? { exists: false } : fixture.object;
  };
}

/** An upload seam that stores at the configured bucket's canonical path. */
function uploadToCanonicalPath(
  fixture: Fixture,
): ScenarioGenerativeSourceDependencies["upload"] {
  return async (upload) => {
    const path = fixture.deps.createPath({
      workspaceId: upload.workspaceId,
      assetId: upload.assetId,
      kind: "image",
      fileName: upload.fileName,
    });
    return {
      ...fixture.stored,
      bucket: upload.bucket,
      path,
      url: canonicalGcsUri(upload.bucket, path),
    };
  };
}

test("converges an object-only source import by verifying then creating its document", async () => {
  const fixture = createDependencies();

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(fixture.updates.length, 1);
  assert.deepEqual(
    {
      workspaceId: (fixture.updates[0] as Record<string, unknown>).workspaceId,
      kind: (fixture.updates[0] as Record<string, unknown>).kind,
      source: (fixture.updates[0] as Record<string, unknown>).source,
      status: (fixture.updates[0] as Record<string, unknown>).status,
      storageProvider: (fixture.updates[0] as Record<string, unknown>)
        .storageProvider,
    },
    {
      workspaceId: input.workspaceId,
      kind: "image",
      source: "uploaded",
      status: "complete",
      storageProvider: "gcs",
    },
  );
});

test("uses the fixed domain-separated source identity vector", () => {
  assert.deepEqual(buildScenarioGenerativeSourceIdentity(input), {
    assetId: "7867a9bc8e60be9dba031f8e",
    provenanceDigest:
      "7867a9bc8e60be9dba031f8ec9ddd1353c0352270aee5480251c5278bce083e0",
  });
});

test("repairs an in-progress nullable-MIME row from its verified object without re-downloading", async () => {
  const fixture = createDependencies();
  fixture.deps.findAsset = async () =>
    pendingSourceAsset(fixture, { declaredMimeType: null });
  let downloaded = false;
  fixture.deps.downloadOwnedWhatsAppMedia = async () => {
    downloaded = true;
    throw new Error("must not re-download");
  };

  const result = await importScenarioGenerativeWhatsAppSource(
    { ...input, declaredMimeType: null },
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(downloaded, false);
  assert.equal(fixture.updates.length, 1);
});

test("rejects an oversized existing object before document repair", async () => {
  const fixture = createDependencies({ maxImageBytes: 10 });
  fixture.object.fileSize = 11;

  await assert.rejects(
    importScenarioGenerativeWhatsAppSource(input, fixture.deps),
    /size limit/i,
  );
});

test("repairs a pending source document by downloading, create-only uploading, and completing it", async () => {
  const fixture = createDependencies();
  fixture.deps.findAsset = async () => pendingSourceAsset(fixture);
  fixture.deps.stat = objectAfterFirstStat(fixture);
  let uploaded = false;
  fixture.deps.upload = async () => {
    uploaded = true;
    return fixture.stored;
  };

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(uploaded, true);
  assert.equal(fixture.updates.length, 1);
});

test("returns the same asset when matching document and object already exist", async () => {
  const fixture = createDependencies();
  fixture.deps.findAsset = async () =>
    completedSourceAsset(fixture, fixture.stored.url);
  let downloaded = false;
  fixture.deps.downloadOwnedWhatsAppMedia = async () => {
    downloaded = true;
    throw new Error("should not download");
  };

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(downloaded, false);
  assert.equal(fixture.updates.length, 0);
});

test("fails closed when an existing object carries conflicting provenance", async () => {
  const fixture = createDependencies();
  fixture.object.customMetadata.scenarioGenerativeSourceWhatsAppMediaId =
    "other-media";

  await assert.rejects(
    importScenarioGenerativeWhatsAppSource(input, fixture.deps),
    /provenance/i,
  );
});

test("rejects an object found through a non-canonical candidate path seam", async () => {
  const fixture = createDependencies();
  let pathCalls = 0;
  fixture.deps.createPath = ({ workspaceId, assetId, fileName }) => {
    pathCalls += 1;
    const suffix = pathCalls === 1 ? "wrong-path.jpg" : fileName;
    return `workspaces/${workspaceId}/creative-assets/image/${assetId}/${suffix}`;
  };

  await assert.rejects(
    importScenarioGenerativeWhatsAppSource(input, fixture.deps),
    /canonical path conflict/i,
  );
});

test("fails closed when a completion-CAS loser rereads a divergent completed winner", async () => {
  const fixture = createDependencies();
  const pending = pendingSourceAsset(fixture);
  let readCount = 0;
  fixture.deps.findAsset = async () => {
    readCount += 1;
    return readCount === 1
      ? pending
      : { ...pending, status: "complete", bucket: "other" };
  };
  fixture.deps.stat = objectAfterFirstStat(fixture);
  fixture.deps.completeAsset = async () => ({ matched: false });

  await assert.rejects(
    importScenarioGenerativeWhatsAppSource(input, fixture.deps),
    /completion claim was lost/i,
  );
});

test("treats a create-only AlreadyExists response as a verification path", async () => {
  const fixture = createDependencies({ stat: async () => ({ exists: false }) });
  let statCalls = 0;
  fixture.deps.upload = async () => {
    const error = Object.assign(new Error("already exists"), { code: 412 });
    throw error;
  };
  fixture.deps.stat = async () => {
    statCalls += 1;
    return statCalls === 1 ? { exists: false } : fixture.object;
  };

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(statCalls >= 2, true);
});

test("converges a fresh import through pending persistence, upload, verification, and completion", async () => {
  const fixture = createDependencies({ stat: async () => ({ exists: false }) });
  let pending = 0;
  const claimPendingAsset = fixture.deps.upsertPendingAsset;
  fixture.deps.upsertPendingAsset = async (asset) => {
    pending += 1;
    await claimPendingAsset(asset);
  };
  fixture.deps.stat = objectAfterFirstStat(fixture);

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(pending, 1);
  assert.equal(fixture.updates.length, 1);
});

test("converges two concurrent fresh imports through one create-only object", async () => {
  const fixture = createDependencies();
  let sharedAsset: Record<string, unknown> | null = null;
  let sharedObject = false;
  let uploads = 0;
  let materializations = 0;
  let createOnlyLosers = 0;
  const uploadInputs: Array<Record<string, unknown>> = [];
  const makeDeps = (): ScenarioGenerativeSourceDependencies => ({
    ...fixture.deps,
    findAsset: async () => sharedAsset,
    upsertPendingAsset: async (asset) => {
      if (!sharedAsset) sharedAsset = asset;
    },
    stat: async ({ path }) =>
      sharedObject && path.endsWith(".jpg")
        ? fixture.object
        : { exists: false },
    upload: async (upload) => {
      uploads += 1;
      uploadInputs.push(upload);
      if (sharedObject) {
        createOnlyLosers += 1;
        throw Object.assign(new Error("exists"), { code: 412 });
      }
      sharedObject = true;
      materializations += 1;
      const path = fixture.deps.createPath({
        workspaceId: upload.workspaceId,
        assetId: upload.assetId,
        kind: "image",
        fileName: upload.fileName,
      });
      return {
        ...fixture.stored,
        bucket: upload.bucket,
        path,
        url: canonicalGcsUri(upload.bucket, path),
      };
    },
    completeAsset: async (_id, update) => {
      if (sharedAsset?.status === "complete") return { matched: false };
      sharedAsset = { ...(sharedAsset || {}), ...update };
      return { matched: true };
    },
  });

  const [first, second] = await Promise.all([
    importScenarioGenerativeWhatsAppSource(input, makeDeps()),
    importScenarioGenerativeWhatsAppSource(input, makeDeps()),
  ]);

  assert.equal(first.assetId, fixture.identity.assetId);
  assert.equal(second.assetId, fixture.identity.assetId);
  assert.equal(uploads, 2);
  assert.equal(materializations, 1);
  assert.equal(createOnlyLosers, 1);
  assert.equal(uploadInputs[0]?.bucket, fixture.deps.bucket);
  assert.deepEqual(uploadInputs[0]?.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(
    (uploadInputs[0]?.customMetadata as Record<string, string>)
      .scenarioGenerativeSourceDigest,
    fixture.identity.provenanceDigest,
  );
  const completedAsset = sharedAsset as Record<string, unknown> | null;
  assert.equal(completedAsset?.status, "complete");
  assert.equal(
    (completedAsset?.sourceMedia as Record<string, unknown>).provenanceDigest,
    fixture.identity.provenanceDigest,
  );
});

test("derives nullable accepted MIME from owned Meta media and uses the configured bucket path", async () => {
  const fixture = createDependencies({ bucket: "configured-creative-assets" });
  const nullableInput = { ...input, declaredMimeType: null };
  const paths: Array<{ bucket: string; path: string }> = [];
  let statCalls = 0;
  fixture.deps.stat = async ({ bucket, path }) => {
    paths.push({ bucket, path });
    statCalls += 1;
    return statCalls <= 3 ? { exists: false } : fixture.object;
  };

  fixture.deps.upload = uploadToCanonicalPath(fixture);

  const result = await importScenarioGenerativeWhatsAppSource(
    nullableInput,
    fixture.deps,
  );

  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(
    paths.every((item) => item.bucket === "configured-creative-assets"),
    true,
  );
});

test("fails closed when a completed document disagrees with verified GCS storage", async () => {
  const fixture = createDependencies();
  fixture.deps.findAsset = async () => ({
    _id: fixture.identity.assetId,
    workspaceId: input.workspaceId,
    kind: "image",
    source: "uploaded",
    status: "complete",
    storageProvider: "gcs",
    bucket: "other-bucket",
    path: fixture.stored.path,
    mimeType: "image/jpeg",
    fileSize: 11,
    sourceMedia: sourceMedia(fixture, { contentSha256: "c".repeat(64) }),
  });

  await assert.rejects(
    importScenarioGenerativeWhatsAppSource(input, fixture.deps),
    /storage metadata conflict/i,
  );
});

function completedSourceAsset(
  fixture: ReturnType<typeof createDependencies>,
  url: string,
) {
  return {
    _id: fixture.identity.assetId,
    workspaceId: input.workspaceId,
    kind: "image",
    source: "uploaded",
    status: "complete",
    storageProvider: "gcs",
    url,
    bucket: fixture.stored.bucket,
    path: fixture.stored.path,
    mimeType: "image/jpeg",
    fileName: fixture.stored.fileName,
    fileSize: 11,
    sourceMedia: sourceMedia(fixture, { contentSha256: "c".repeat(64) }),
  };
}

test("completes a fresh upload with the canonical gcs:// URI the upload helper returns", async () => {
  const fixture = createDependencies();
  fixture.deps.stat = objectAfterFirstStat(fixture);

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(fixture.updates.length, 1);
  assert.equal(
    (fixture.updates[0] as Record<string, unknown>).url,
    `gcs://creative-assets/${fixture.stored.path}`,
  );
});

test("completes an object-only import with the canonical gcs:// URI", async () => {
  const fixture = createDependencies();

  await importScenarioGenerativeWhatsAppSource(input, fixture.deps);

  assert.equal(
    (fixture.updates[0] as Record<string, unknown>).url,
    `gcs://creative-assets/${fixture.stored.path}`,
  );
});

test("still accepts a completed source recorded with the legacy gs:// scheme", async () => {
  const fixture = createDependencies();
  fixture.deps.findAsset = async () =>
    completedSourceAsset(
      fixture,
      `gs://creative-assets/${fixture.stored.path}`,
    );

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
  assert.equal(fixture.updates.length, 0);
});

test("accepts a legacy gs:// completion-CAS winner for the same object", async () => {
  const fixture = createDependencies();
  const completed = completedSourceAsset(
    fixture,
    `gs://creative-assets/${fixture.stored.path}`,
  );
  const pending = {
    ...completed,
    status: "in_progress",
    sourceMedia: { ...completed.sourceMedia, contentSha256: null },
  };
  let readCount = 0;
  fixture.deps.findAsset = async () => {
    readCount += 1;
    return readCount === 1 ? pending : completed;
  };
  fixture.deps.stat = objectAfterFirstStat(fixture);
  fixture.deps.completeAsset = async () => ({ matched: false });

  const result = await importScenarioGenerativeWhatsAppSource(
    input,
    fixture.deps,
  );

  assert.equal(result.assetId, fixture.identity.assetId);
});
