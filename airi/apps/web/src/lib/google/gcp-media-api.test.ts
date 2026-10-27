jest.mock("@/lib/google/gcp-auth", () => ({
  compactEnv: () => null,
  getVercelOidcTokenOrEnv: async () => null,
}));
const mockSettle = jest.fn();
const mockReadWorkspaceObject = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => ({
  ...jest.requireActual("@icecore/airi-runtime/storage-quota"),
  readWorkspaceStorageObject: (...args: unknown[]) =>
    mockReadWorkspaceObject(...args),
  readStorageObject: async () => ({ status: "reserved" }),
  settleStorageObject: (...args: unknown[]) => mockSettle(...args),
  storageObjectId: () => "reservation",
}));
import {
  createRemoteCreativeAssetUpload,
  storeRemoteCreativeAssetBuffer,
} from "./gcp-media-api";

const input = {
  workspaceId: "workspace",
  assetId: "asset",
  kind: "image" as const,
  fileName: "image.png",
  mimeType: "image/png",
  fileSize: 4,
};
const originalFetch = global.fetch;
const priorUrl = process.env.GCP_MEDIA_API_URL;
beforeEach(() => {
  process.env.GCP_MEDIA_API_URL = "http://127.0.0.1:8080";
  jest.clearAllMocks();
  mockReadWorkspaceObject.mockResolvedValue(null);
});

it("reuses a settled generated object without issuing another upload grant", async () => {
  mockReadWorkspaceObject.mockResolvedValue({
    status: "stored",
    bytes: 4,
    bucket: "remote-bucket",
    path: "existing-path",
  });
  global.fetch = jest.fn();
  await expect(
    storeRemoteCreativeAssetBuffer({ ...input, buffer: Buffer.from("test") })
  ).resolves.toMatchObject({
    bucket: "remote-bucket",
    path: "existing-path",
    fileSize: 4,
  });
  expect(global.fetch).not.toHaveBeenCalled();
});

it("never recreates a deleted generated identity", async () => {
  mockReadWorkspaceObject.mockResolvedValue({ status: "tombstoned", bytes: 4 });
  global.fetch = jest.fn();
  await expect(
    storeRemoteCreativeAssetBuffer({ ...input, buffer: Buffer.from("test") })
  ).rejects.toThrow(/deleted/i);
  expect(global.fetch).not.toHaveBeenCalled();
});
afterEach(() => {
  global.fetch = originalFetch;
  if (priorUrl === undefined) delete process.env.GCP_MEDIA_API_URL;
  else process.env.GCP_MEDIA_API_URL = priorUrl;
});

it("preserves a non-JSON media HTTP failure", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue(new Response("service unavailable", { status: 503 }));
  await expect(createRemoteCreativeAssetUpload(input)).rejects.toThrow(
    "HTTP 503: service unavailable"
  );
});

it("recovers an ambiguous signed PUT by settling the authoritative physical object", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        provider: "gcs",
        method: "PUT",
        bucket: "bucket",
        path: "path",
        uploadUrl: "https://storage.test/object",
        mode: "single",
        headers: { "x-goog-content-length-range": "4,4" },
      })
    )
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(
      Response.json({
        provider: "gcs",
        bucket: "bucket",
        path: "path",
        exists: true,
        fileSize: 4,
      })
    );
  await expect(
    storeRemoteCreativeAssetBuffer({ ...input, buffer: Buffer.from("test") })
  ).resolves.toMatchObject({ fileSize: 4 });
  expect(mockSettle).toHaveBeenCalledWith("reservation", 4);
  expect(
    (global.fetch as jest.Mock).mock.calls[1][1].headers[
      "x-goog-content-length-range"
    ]
  ).toBe("4,4");
});
