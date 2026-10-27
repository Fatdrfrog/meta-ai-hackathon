/**
 * @jest-environment node
 */

const mockCanCallGcpMediaApi = jest.fn();
const mockCreateRemoteCreativeAssetReadUrl = jest.fn();
const mockGetGcpMediaApiBaseUrl = jest.fn();
const mockReadWithStatus = jest.fn();
const mockWriteWithStatus = jest.fn();

jest.mock("next/server", () => ({ after: jest.fn() }));
jest.mock("@/lib/google/gcp-media-api", () => ({
  canCallGcpMediaApi: () => mockCanCallGcpMediaApi(),
  createRemoteCreativeAssetReadUrl: (...args: unknown[]) =>
    mockCreateRemoteCreativeAssetReadUrl(...args),
  getGcpMediaApiBaseUrl: () => mockGetGcpMediaApiBaseUrl(),
}));
jest.mock("@icecore/shared/lib/cache", () => ({
  ...jest.requireActual("@icecore/shared/lib/cache"),
  cache: {
    readWithStatus: (...args: unknown[]) => mockReadWithStatus(...args),
    writeWithStatus: (...args: unknown[]) => mockWriteWithStatus(...args),
  },
}));

import { resetCreativeAssetReadUrlPortForTests } from "@icecore/airi-runtime/creative-asset-read-url";
import { withCreativeAssetDisplayReadUrlCache } from "./creative-asset-read-url-cache";
import { createMediaApiCreativeAssetReadUrlPort } from "./creative-asset-read-url-media-api-adapter";

const readRequest = {
  provider: "gcs" as const,
  bucket: "media",
  path: "workspaces/ws-1/creative-assets/image/a/card.png",
  workspaceId: "ws-1",
};

describe("createMediaApiCreativeAssetReadUrlPort", () => {
  const store = new Map<string, unknown>();
  let signatures = 0;

  afterEach(() => {
    resetCreativeAssetReadUrlPortForTests();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    signatures = 0;
    mockCanCallGcpMediaApi.mockReturnValue(true);
    mockGetGcpMediaApiBaseUrl.mockReturnValue("https://media-api.example");
    mockReadWithStatus.mockImplementation(async (key: string) =>
      store.has(key)
        ? { status: "hit", value: store.get(key) }
        : { status: "miss" }
    );
    mockWriteWithStatus.mockImplementation(
      async (key: string, value: unknown) => {
        store.set(key, value);
        return "stored";
      }
    );
    mockCreateRemoteCreativeAssetReadUrl.mockImplementation(async () => {
      signatures += 1;
      return {
        provider: "gcs",
        bucket: readRequest.bucket,
        path: readRequest.path,
        url: `https://signed.example/card.png?signature=${signatures}`,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
    });
  });

  it("reuses a signed URL on the scenario editor's display path", async () => {
    const port = createMediaApiCreativeAssetReadUrlPort();

    const [first, second] = await withCreativeAssetDisplayReadUrlCache(
      async () => [
        await port.createReadUrl(readRequest),
        await port.createReadUrl(readRequest),
      ]
    );

    expect(second).toEqual(first);
    expect(first.url).toBe("https://signed.example/card.png?signature=1");
    expect(mockCreateRemoteCreativeAssetReadUrl).toHaveBeenCalledTimes(1);
    expect(mockCreateRemoteCreativeAssetReadUrl).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: readRequest.bucket,
      path: readRequest.path,
      workspaceId: "ws-1",
      expiresInSeconds: undefined,
    });
  });

  it("signs a fresh URL for every other caller, who may hand it to a third party", async () => {
    const port = createMediaApiCreativeAssetReadUrlPort();
    await withCreativeAssetDisplayReadUrlCache(() =>
      port.createReadUrl(readRequest)
    );

    const first = await port.createReadUrl(readRequest);
    const second = await port.createReadUrl(readRequest);

    expect(first.url).toBe("https://signed.example/card.png?signature=2");
    expect(second.url).toBe("https://signed.example/card.png?signature=3");
    expect(mockReadWithStatus).toHaveBeenCalledTimes(1);
    expect(mockWriteWithStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps URLs from different Media APIs apart", async () => {
    const port = createMediaApiCreativeAssetReadUrlPort();

    await withCreativeAssetDisplayReadUrlCache(async () => {
      await port.createReadUrl(readRequest);
      mockGetGcpMediaApiBaseUrl.mockReturnValue("http://127.0.0.1:8080");
      await port.createReadUrl(readRequest);
    });

    expect(mockCreateRemoteCreativeAssetReadUrl).toHaveBeenCalledTimes(2);
  });

  it("reuses a signed URL when instrumentation wired the port from another module graph", async () => {
    // Instrumentation is bundled apart from pages and routes, so it
    // configures the shared port with its own copy of these modules.
    await jest.isolateModulesAsync(async () => {
      const adapter = await import(
        "./creative-asset-read-url-media-api-adapter"
      );
      adapter.configureMediaApiCreativeAssetReadUrlPort();
    });
    let urls: unknown[] = [];
    await jest.isolateModulesAsync(async () => {
      const [adapter, scope, port] = await Promise.all([
        import("./creative-asset-read-url-media-api-adapter"),
        import("./creative-asset-read-url-cache"),
        import("@icecore/airi-runtime/creative-asset-read-url"),
      ]);
      adapter.ensureMediaApiCreativeAssetReadUrlPort();
      urls = await scope.withCreativeAssetDisplayReadUrlCache(async () => [
        await port.createCreativeAssetReadUrl(readRequest),
        await port.createCreativeAssetReadUrl(readRequest),
      ]);
    });

    expect(urls).toHaveLength(2);
    expect(urls[1]).toEqual(urls[0]);
    expect(mockCreateRemoteCreativeAssetReadUrl).toHaveBeenCalledTimes(1);
    expect(mockReadWithStatus).toHaveBeenCalledTimes(2);
    expect(mockWriteWithStatus).toHaveBeenCalledTimes(1);
  });

  it("still refuses before the cache when the Media API is not configured", async () => {
    mockCanCallGcpMediaApi.mockReturnValue(false);
    const port = createMediaApiCreativeAssetReadUrlPort();

    await expect(
      withCreativeAssetDisplayReadUrlCache(() =>
        port.createReadUrl(readRequest)
      )
    ).rejects.toThrow("GCP media API is not configured");
    expect(mockReadWithStatus).not.toHaveBeenCalled();
    expect(mockCreateRemoteCreativeAssetReadUrl).not.toHaveBeenCalled();
  });
});
