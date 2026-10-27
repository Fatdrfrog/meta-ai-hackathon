const mockCredentials = jest.fn();
const mockStatus = jest.fn();
const mockDownload = jest.fn();
const mockStore = jest.fn();
const mockUpdate = jest.fn();
jest.mock("./elevenlabs-source", () => ({
  resolveElevenLabsCredentialsForWorkspace: (...args: unknown[]) =>
    mockCredentials(...args),
  getPlatformElevenLabsApiKey: () => "platform-key",
}));
jest.mock("./creative-assets", () => ({
  getElevenLabsDubbingStatus: (...args: unknown[]) => mockStatus(...args),
  downloadElevenLabsDubbingResult: (...args: unknown[]) =>
    mockDownload(...args),
}));
jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  storeCreativeAssetBuffer: (...args: unknown[]) => mockStore(...args),
}));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findByIdAndUpdate: (...args: unknown[]) => mockUpdate(...args),
  },
}));
import { syncElevenLabsCreativeAsset } from "./creative-asset-sync";
beforeEach(() => {
  jest.clearAllMocks();
  mockCredentials.mockResolvedValue({
    apiKey: "customer-key",
    sourceId: "source-new",
  });
  mockStatus.mockResolvedValue({ status: "in_progress", raw: {} });
});
it.each([null, "source-original"])(
  "polls an already-paid result with its original payer %s",
  async providerSourceId => {
    await syncElevenLabsCreativeAsset({
      supabase: {} as never,
      storageClient: {} as never,
      asset: {
        _id: "asset-1",
        workspaceId: "workspace-1",
        provider: "elevenlabs",
        status: "in_progress",
        providerRequestId: "request-1",
        providerSourceId,
        providerPayload: { mode: "dub", targetLanguage: "en" },
      },
    });
    expect(mockStatus).toHaveBeenCalledWith({
      apiKey: providerSourceId ? "customer-key" : "platform-key",
      dubbingId: "request-1",
    });
    if (providerSourceId)
      expect(mockCredentials).toHaveBeenCalledWith({
        supabase: {},
        workspaceId: "workspace-1",
        sourceId: providerSourceId,
      });
    else expect(mockCredentials).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  }
);
