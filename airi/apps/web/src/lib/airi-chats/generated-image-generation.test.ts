const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockCredentials = jest.fn();
const mockStartWorkflow = jest.fn();
const mockWorkerKey = jest.fn();
jest.mock("@/lib/google/creative-assets", () => ({
  getGoogleImageGenerationModel: () => "gemini-3.1-flash-image",
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/google/creative-credentials", () => ({
  resolveWorkspaceGoogleCreativeCredentials: (...args: unknown[]) =>
    mockCredentials(...args),
  resolveGoogleCreativeWorkerApiKey: (...args: unknown[]) =>
    mockWorkerKey(...args),
}));
jest.mock("@/lib/creative-assets/creative-generation-admission", () => ({
  withWorkspaceCreativeGenerationAdmission: async (
    _workspaceId: string,
    run: () => Promise<unknown>
  ) => run(),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/temporal/creative-image-generation", () => ({
  isTemporalConfigured: () => true,
  startCreativeImageGenerationWorkflow: (...args: unknown[]) =>
    mockStartWorkflow(...args),
}));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    create: (...args: unknown[]) => mockCreate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: jest.fn(),
  },
}));
import {
  createQueuedAiriImageGeneration,
  startQueuedAiriImageGeneration,
} from "./generated-image-generation";
const request = {
  workspaceId: "workspace-1",
  userId: "user-1",
  threadId: "thread-1",
  userMessageId: "message-1",
  title: "Campaign image",
  prompt: "A premium soup campaign image",
  target: { kind: "chat_attachment" as const },
};
describe("customer-funded Airi images", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCredentials.mockResolvedValue({
      sourceId: "source-google",
      apiKey: "private-key",
    });
    mockWorkerKey.mockResolvedValue("private-key");
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    mockCreate.mockImplementation(async value => value);
  });
  it("pins the customer source without persisting its decrypted key", async () => {
    await createQueuedAiriImageGeneration(request);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSourceId: "source-google",
        workspaceId: "workspace-1",
      })
    );
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain("private-key");
  });
  it("rejects a missing source before creating an asset", async () => {
    mockCredentials.mockRejectedValueOnce(
      Object.assign(new Error("Connect Google AI"), {
        code: "own_ai_source_required",
      })
    );
    await expect(
      createQueuedAiriImageGeneration(request)
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
  it("reuses the same persisted request identity", async () => {
    let persisted: unknown = null;
    mockFindOne.mockImplementation(() => ({ lean: async () => persisted }));
    mockCreate.mockImplementation(async value => {
      persisted = value;
      return value;
    });
    const first = await createQueuedAiriImageGeneration(request);
    const replay = await createQueuedAiriImageGeneration(request);
    expect(replay?.assetId).toBe(first?.assetId);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        "providerPayload.airi.generationClaimKey": expect.any(String),
      })
    );
  });
  it("recovers the persisted image after a concurrent duplicate create", async () => {
    const winner = { _id: "winner-asset", providerSourceId: "source-google" };
    mockFindOne
      .mockReturnValueOnce({ lean: async () => null })
      .mockReturnValueOnce({ lean: async () => winner });
    mockCreate.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: 11000 })
    );
    await expect(
      createQueuedAiriImageGeneration(request)
    ).resolves.toMatchObject({ assetId: "winner-asset" });
  });

  it("copies only the stored source ID into the image workflow", async () => {
    mockFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({ providerSourceId: "stored-source" }),
      }),
    });
    await startQueuedAiriImageGeneration({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      prompt: "A mountain",
    });
    expect(mockStartWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ providerSourceId: "stored-source" })
    );
    expect(JSON.stringify(mockStartWorkflow.mock.calls)).not.toContain(
      "private-key"
    );
  });
});
