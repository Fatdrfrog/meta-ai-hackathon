import {
  configureCreativeAssetReadUrlPort,
  type CreativeAssetReadUrlPort,
  type CreativeAssetReadUrlRequest,
  type CreativeAssetReadUrlResponse,
} from "@icecore/airi-runtime/creative-asset-read-url";

import { createGcsCreativeAssetReadUrl } from "./gcs-creative-assets.js";

export function createGcsCreativeAssetReadUrlPort(): CreativeAssetReadUrlPort {
  return {
    async createReadUrl(
      request: CreativeAssetReadUrlRequest
    ): Promise<CreativeAssetReadUrlResponse> {
      const result = await createGcsCreativeAssetReadUrl({
        bucket: request.bucket,
        path: request.path,
        workspaceId: request.workspaceId,
        expiresInSeconds: request.expiresInSeconds,
      });

      return {
        provider: "gcs",
        bucket: request.bucket,
        path: request.path,
        url: result.url,
        expiresAt: result.expiresAt,
      };
    },
  };
}

export function configureGcsCreativeAssetReadUrlPort(): void {
  configureCreativeAssetReadUrlPort(createGcsCreativeAssetReadUrlPort());
}

configureGcsCreativeAssetReadUrlPort();
