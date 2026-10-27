import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalGcsUri,
  createCreativeAssetObjectPath,
  isCreativeAssetObjectPathForWorkspace,
  matchesGcsObjectUri,
  parseCanonicalGcsUri,
  resolveCreativeAssetGcsObjectRef,
  sanitizeCreativeAssetObjectFileName,
} from "./media-api.js";

test("canonical GCS URIs use gcs:// and stored gs:// URIs still match", () => {
  const path = "workspaces/w/creative-assets/image/a/file.jpg";
  assert.equal(canonicalGcsUri("bucket", `/${path}`), `gcs://bucket/${path}`);
  assert.equal(
    matchesGcsObjectUri(`gcs://bucket/${path}`, "bucket", path),
    true,
  );
  assert.equal(
    matchesGcsObjectUri(`gs://bucket/${path}`, "bucket", path),
    true,
  );
  for (const other of [
    `gcs://other/${path}`,
    `gs://bucket/${path}.png`,
    `https://storage.googleapis.com/bucket/${path}`,
    ` gcs://bucket/${path}`,
    null,
    undefined,
  ]) {
    assert.equal(matchesGcsObjectUri(other, "bucket", path), false);
  }
});

test("creative asset filenames cannot introduce rejected dot runs into object paths", () => {
  for (const [input, expected] of [
    ["Friday.. lunch.mp4", "Friday.-lunch.mp4"],
    ["Launch....v2.mp4", "Launch.v2.mp4"],
    ["../folder/Launch...mp4", "folder-Launch.mp4"],
    ["...", "creative-asset"],
    ["launch.v2.mp4", "launch.v2.mp4"],
  ]) {
    assert.equal(sanitizeCreativeAssetObjectFileName(input!), expected);
    const objectPath = createCreativeAssetObjectPath({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      kind: "video",
      fileName: input!,
    });
    assert.ok(
      isCreativeAssetObjectPathForWorkspace({
        workspaceId: "workspace-1",
        path: objectPath,
      }),
    );
  }
});

test("parseCanonicalGcsUri accepts gcs:// and gs://", () => {
  assert.deepEqual(
    parseCanonicalGcsUri(
      "gcs://bucket/workspaces/w/creative-assets/audio/a/file.ogg"
    ),
    {
      bucket: "bucket",
      path: "workspaces/w/creative-assets/audio/a/file.ogg",
    }
  );
  assert.deepEqual(
    parseCanonicalGcsUri(
      "gs://bucket/workspaces/w/creative-assets/audio/a/file.ogg"
    ),
    {
      bucket: "bucket",
      path: "workspaces/w/creative-assets/audio/a/file.ogg",
    }
  );
  assert.equal(parseCanonicalGcsUri("https://cdn.example/file.ogg"), null);
});

test("resolveCreativeAssetGcsObjectRef prefers explicit bucket/path", () => {
  assert.deepEqual(
    resolveCreativeAssetGcsObjectRef({
      url: "gs://other/ignored",
      bucket: "bucket",
      path: "workspaces/w/file.ogg",
    }),
    { bucket: "bucket", path: "workspaces/w/file.ogg" }
  );
  assert.deepEqual(
    resolveCreativeAssetGcsObjectRef({
      url: "gs://bucket/workspaces/w/file.ogg",
    }),
    { bucket: "bucket", path: "workspaces/w/file.ogg" }
  );
});
