import type {
  MediaApiObjectReadUrlRequest,
  MediaApiObjectReadUrlResponse,
} from "./media-api.js";

/**
 * Same contract as Media API `/v1/creative-assets/objects/read-url`.
 * Web adapter calls Media API; worker adapter signs GCS directly.
 */
export type CreativeAssetReadUrlRequest = MediaApiObjectReadUrlRequest;
export type CreativeAssetReadUrlResponse = MediaApiObjectReadUrlResponse;

/**
 * Runtime port for turning GCS creative-asset object refs into short-lived HTTPS
 * read URLs. Wire once at composition root — never branch on env inside callers.
 */
export type CreativeAssetReadUrlPort = {
  createReadUrl(
    request: CreativeAssetReadUrlRequest
  ): Promise<CreativeAssetReadUrlResponse>;
};

const GLOBAL_PORT_KEY = "__icecoreCreativeAssetReadUrlPort__" as const;

type CreativeAssetReadUrlGlobal = typeof globalThis & {
  [GLOBAL_PORT_KEY]?: CreativeAssetReadUrlPort | null;
};

function readConfiguredPort(): CreativeAssetReadUrlPort | null {
  return (globalThis as CreativeAssetReadUrlGlobal)[GLOBAL_PORT_KEY] ?? null;
}

function writeConfiguredPort(port: CreativeAssetReadUrlPort | null): void {
  (globalThis as CreativeAssetReadUrlGlobal)[GLOBAL_PORT_KEY] = port;
}

export function configureCreativeAssetReadUrlPort(
  port: CreativeAssetReadUrlPort
): void {
  // globalThis survives duplicate module graphs (worker composition root vs
  // apps/web delivery imports of the same package entry).
  writeConfiguredPort(port);
}

/** Test-only. Production code must wire an adapter at composition root. */
export function resetCreativeAssetReadUrlPortForTests(): void {
  writeConfiguredPort(null);
}

export function getCreativeAssetReadUrlPort(): CreativeAssetReadUrlPort {
  const configuredPort = readConfiguredPort();
  if (!configuredPort) {
    throw new Error(
      "Creative asset read-URL port is not configured. Wire the Media API adapter (web) or GCS adapter (worker) at composition root."
    );
  }
  return configuredPort;
}

export function isCreativeAssetReadUrlPortConfigured(): boolean {
  return readConfiguredPort() !== null;
}

export async function createCreativeAssetReadUrl(
  request: CreativeAssetReadUrlRequest
): Promise<CreativeAssetReadUrlResponse> {
  return getCreativeAssetReadUrlPort().createReadUrl(request);
}
