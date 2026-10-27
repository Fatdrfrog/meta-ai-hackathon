import assert from "node:assert/strict";
import test from "node:test";

import {
  configureCreativeAssetReadUrlPort,
  createCreativeAssetReadUrl,
  getCreativeAssetReadUrlPort,
  isCreativeAssetReadUrlPortConfigured,
  resetCreativeAssetReadUrlPortForTests,
  type CreativeAssetReadUrlPort,
} from "./creative-asset-read-url.js";

test("creative asset read-URL port requires composition-root wiring", async () => {
  resetCreativeAssetReadUrlPortForTests();
  assert.equal(isCreativeAssetReadUrlPortConfigured(), false);
  assert.throws(
    () => getCreativeAssetReadUrlPort(),
    /Creative asset read-URL port is not configured/
  );
  await assert.rejects(
    () =>
      createCreativeAssetReadUrl({
        provider: "gcs",
        bucket: "bucket",
        path: "workspaces/w/creative-assets/audio/a/file.ogg",
      }),
    /Creative asset read-URL port is not configured/
  );
});

test("createCreativeAssetReadUrl delegates to the configured port", async () => {
  resetCreativeAssetReadUrlPortForTests();
  const port: CreativeAssetReadUrlPort = {
    async createReadUrl(request) {
      return {
        provider: "gcs",
        bucket: request.bucket,
        path: request.path,
        url: `https://signed.example/${request.path}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  configureCreativeAssetReadUrlPort(port);

  assert.equal(isCreativeAssetReadUrlPortConfigured(), true);
  assert.equal(getCreativeAssetReadUrlPort(), port);
  await assert.deepEqual(
    await createCreativeAssetReadUrl({
      provider: "gcs",
      bucket: "bucket",
      path: "workspaces/w/creative-assets/audio/a/file.ogg",
      workspaceId: "w",
    }),
    {
      provider: "gcs",
      bucket: "bucket",
      path: "workspaces/w/creative-assets/audio/a/file.ogg",
      url: "https://signed.example/workspaces/w/creative-assets/audio/a/file.ogg",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }
  );

  resetCreativeAssetReadUrlPortForTests();
});

test("creative asset read-URL port survives on globalThis across module copies", () => {
  resetCreativeAssetReadUrlPortForTests();
  const port: CreativeAssetReadUrlPort = {
    async createReadUrl(request) {
      return {
        provider: "gcs",
        bucket: request.bucket,
        path: request.path,
        url: "https://signed.example/x",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
  };
  configureCreativeAssetReadUrlPort(port);

  const shared = (
    globalThis as typeof globalThis & {
      __icecoreCreativeAssetReadUrlPort__?: CreativeAssetReadUrlPort | null;
    }
  ).__icecoreCreativeAssetReadUrlPort__;
  assert.equal(shared, port);
  assert.equal(isCreativeAssetReadUrlPortConfigured(), true);

  resetCreativeAssetReadUrlPortForTests();
  assert.equal(
    (
      globalThis as typeof globalThis & {
        __icecoreCreativeAssetReadUrlPort__?: CreativeAssetReadUrlPort | null;
      }
    ).__icecoreCreativeAssetReadUrlPort__,
    null
  );
});
