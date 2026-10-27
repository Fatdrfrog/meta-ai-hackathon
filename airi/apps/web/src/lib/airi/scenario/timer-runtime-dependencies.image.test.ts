const mockFindAsset = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/scenario", () => ({ Scenario: {} }));
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: { findOne: (...args: unknown[]) => mockFindAsset(...args) },
}));
// The reply-language module's translation and detection are never reached.
jest.mock("@/lib/ai", () => ({}));
jest.mock("@/lib/airi/language-detector-server", () => ({}));
jest.mock("@/lib/cache", () => ({}));

import { airiScenarioTimerDependencies } from "./timer-runtime-dependencies";

const asset = {
  _id: "asset-1",
  workspaceId: "workspace-1",
  kind: "image",
  status: "complete",
  storageProvider: "gcs",
  bucket: "media",
  path: "workspaces/workspace-1/image/output.png",
  mimeType: "image/png",
  fileName: "output.png",
  fileSize: 1024,
  providerPayload: {
    scenario: {
      workflowId: "creative-image-generation:asset-1",
      attemptToken: "attempt-1",
      completionTarget: {
        workflowId: "scenario-generation:execution-1",
        signalName: "airi.scenarioGenerativeAI.videoCompletion",
        correlationId: "execution-1",
      },
    },
  },
};

describe("scenario generated image asset loading", () => {
  beforeEach(() => jest.resetAllMocks());

  it("loads only the workspace-owned image and its pinned completion identity", async () => {
    mockFindAsset.mockReturnValue({ lean: jest.fn().mockResolvedValue(asset) });
    const result =
      await airiScenarioTimerDependencies.generativeAIResult.loadAsset({
        workspaceId: "workspace-1",
        assetId: "asset-1",
      });
    expect(mockFindAsset).toHaveBeenCalledWith({
      _id: "asset-1",
      workspaceId: "workspace-1",
    });
    expect(result).toMatchObject({
      kind: "image",
      videoWorkflowId: "creative-image-generation:asset-1",
      attemptToken: "attempt-1",
      completionTarget: asset.providerPayload.scenario.completionTarget,
    });
  });

  it("rejects malformed image completion provenance", async () => {
    mockFindAsset.mockReturnValue({
      lean: jest
        .fn()
        .mockResolvedValue({
          ...asset,
          providerPayload: {
            scenario: {
              ...asset.providerPayload.scenario,
              completionTarget: { workflowId: "wrong" },
            },
          },
        }),
    });
    await expect(
      airiScenarioTimerDependencies.generativeAIResult.loadAsset({
        workspaceId: "workspace-1",
        assetId: "asset-1",
      })
    ).resolves.toBeNull();
  });
});

describe("scenario generated result language", () => {
  const resolve = (body: Record<string, unknown>) =>
    airiScenarioTimerDependencies.generativeAIResult.resolveCustomerLanguage!(
      body
    );

  it("answers Cyrillic words in Russian or Kazakh despite a stored English default", async () => {
    const conversation = { preferred_language: "en" };
    await expect(
      resolve({ conversation, newMessage: { text: "Айсулу, спорт: танцы" } })
    ).resolves.toBe("ru");
    await expect(
      resolve({ conversation, newMessage: { text: "Әлия, күрес" } })
    ).resolves.toBe("kz");
  });

  it("reads the customer's recent language when the reply was a tap", async () => {
    await expect(
      resolve({
        conversation: {
          preferred_language: "en",
          airi_last_customer_language: "kz",
        },
        newMessage: { text: "cta1" },
      })
    ).resolves.toBe("kz");
  });
});
