/**
 * @jest-environment node
 */

import type { ScenarioActionAttachment } from "@icecore/scenario-contracts";
import {
  configureCreativeAssetReadUrlPort,
  resetCreativeAssetReadUrlPortForTests,
  type CreativeAssetReadUrlPort,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  resolveScenarioActionAttachmentHttpsUrl,
  resolveScenarioAssetHttpsUrl,
} from "./scenario-asset-resolve";

function configureTestPort(port: CreativeAssetReadUrlPort): void {
  configureCreativeAssetReadUrlPort(port);
}

describe("scenario-asset-resolve HTTPS", () => {
  afterEach(() => {
    resetCreativeAssetReadUrlPortForTests();
  });

  it("returns plain https urls without a read-URL port", async () => {
    await expect(
      resolveScenarioAssetHttpsUrl({
        url: "https://cdn.example/file.ogg",
      })
    ).resolves.toBe("https://cdn.example/file.ogg");
  });

  it("resolves GCS refs through the configured creative-asset read-URL port", async () => {
    const createReadUrl = jest.fn(async () => ({
      provider: "gcs" as const,
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      url: "https://signed.example/a.ogg",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    configureTestPort({ createReadUrl });

    await expect(
      resolveScenarioAssetHttpsUrl({
        workspaceId: "ws-1",
        url: "gs://bucket/workspaces/ws-1/creative-assets/audio/a/file.ogg",
        bucket: "bucket",
        path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      })
    ).resolves.toBe("https://signed.example/a.ogg");

    expect(createReadUrl).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      workspaceId: "ws-1",
    });
  });

  it("resolves gs:// urls without explicit bucket/path fields", async () => {
    const createReadUrl = jest.fn(async () => ({
      provider: "gcs" as const,
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      url: "https://signed.example/from-gs.ogg",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    configureTestPort({ createReadUrl });

    await expect(
      resolveScenarioAssetHttpsUrl({
        workspaceId: "ws-1",
        url: "gs://bucket/workspaces/ws-1/creative-assets/audio/a/file.ogg",
      })
    ).resolves.toBe("https://signed.example/from-gs.ogg");

    expect(createReadUrl).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      workspaceId: "ws-1",
    });
  });

  it("throws when the read-URL port is not wired", async () => {
    await expect(
      resolveScenarioAssetHttpsUrl({
        bucket: "bucket",
        path: "workspaces/ws-1/creative-assets/audio/a/file.ogg",
      })
    ).rejects.toThrow(/Creative asset read-URL port is not configured/);
  });

  it("rewrites attachment urls through the read-URL port", async () => {
    configureTestPort({
      async createReadUrl() {
        return {
          provider: "gcs",
          bucket: "bucket",
          path: "workspaces/ws-1/creative-assets/audio/a/voice.ogg",
          url: "https://storage.googleapis.com/signed/voice.ogg",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    });

    const attachment: ScenarioActionAttachment = {
      mediaType: "audio",
      url: "gs://bucket/workspaces/ws-1/creative-assets/audio/a/voice.ogg",
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/voice.ogg",
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    };

    await expect(
      resolveScenarioActionAttachmentHttpsUrl({
        workspaceId: "ws-1",
        attachment,
      })
    ).resolves.toMatchObject({
      mediaType: "audio",
      url: "https://storage.googleapis.com/signed/voice.ogg",
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/audio/a/voice.ogg",
    });
  });
});
