import "server-only";

import {
  configureCreativeAssetReadUrlPort,
  isCreativeAssetReadUrlPortConfigured,
  type CreativeAssetReadUrlPort,
  type CreativeAssetReadUrlRequest,
  type CreativeAssetReadUrlResponse,
} from "@icecore/airi-runtime/creative-asset-read-url";
import {
  isCreativeAssetDisplayReadUrlCacheEnabled,
  readCreativeAssetReadUrlThroughCache,
} from "@/lib/google/creative-asset-read-url-cache";
import {
  canCallGcpMediaApi,
  createRemoteCreativeAssetReadUrl,
  getGcpMediaApiBaseUrl,
} from "@/lib/google/gcp-media-api";

async function signWithMediaApi(
  request: CreativeAssetReadUrlRequest
): Promise<CreativeAssetReadUrlResponse> {
  const result = await createRemoteCreativeAssetReadUrl({
    provider: "gcs",
    bucket: request.bucket,
    path: request.path,
    workspaceId: request.workspaceId,
    expiresInSeconds: request.expiresInSeconds,
  });

  return {
    provider: "gcs",
    bucket: result.bucket,
    path: result.path,
    url: result.url,
    expiresAt: result.expiresAt,
  };
}

export function createMediaApiCreativeAssetReadUrlPort(): CreativeAssetReadUrlPort {
  return {
    async createReadUrl(
      request: CreativeAssetReadUrlRequest
    ): Promise<CreativeAssetReadUrlResponse> {
      if (!canCallGcpMediaApi()) {
        throw new Error(
          "GCP media API is not configured. Set GCP_MEDIA_API_URL to a local media API (http://127.0.0.1:8080) or set VERCEL_OIDC_TOKEN for the remote media API."
        );
      }

      // Only the scenario editor's display path reuses cached URLs.
      return isCreativeAssetDisplayReadUrlCacheEnabled()
        ? readCreativeAssetReadUrlThroughCache(request, signWithMediaApi, {
            signer: getGcpMediaApiBaseUrl() ?? "",
          })
        : signWithMediaApi(request);
    },
  };
}

export function configureMediaApiCreativeAssetReadUrlPort(): void {
  configureCreativeAssetReadUrlPort(createMediaApiCreativeAssetReadUrlPort());
}

/**
 * Idempotent composition-root wiring for route handlers / serializers.
 * Instrumentation also calls configure; this covers Turbopack/dev cases where
 * the instrumentation module graph does not share the port singleton.
 *
 * Never call this from Temporal worker delivery paths — worker wires the GCS
 * signer at composition root. Media API + VERCEL_OIDC is Vercel/web only.
 */
export function ensureMediaApiCreativeAssetReadUrlPort(): void {
  if (isCreativeAssetReadUrlPortConfigured()) return;
  // Cloud Run Temporal worker (and any non-Vercel runtime) must not fall back
  // to Media API auth. Without VERCEL/OIDC, canCallGcpMediaApi() is false and
  // carousel/media sends explode with a misleading config error.
  const runtimeMode = String(process.env.AIRI_RUNTIME_MODE || "")
    .trim()
    .toLowerCase();
  if (
    runtimeMode === "worker" ||
    runtimeMode === "otp-worker" ||
    runtimeMode === "realtime-dispatcher"
  ) {
    return;
  }
  configureMediaApiCreativeAssetReadUrlPort();
}
