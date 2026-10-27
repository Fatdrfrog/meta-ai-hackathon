const mockSpeech = jest.fn();
const mockStore = jest.fn();
const mockAccess = jest.fn();
const mockFeature = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/elevenlabs/workspace-speech", () => ({
  generateWorkspaceSpeech: (...args: unknown[]) => mockSpeech(...args),
}));
jest.mock("@/lib/scenarios/scenario-asset-storage", () => ({
  storeScenarioAssetBuffer: (...args: unknown[]) => mockStore(...args),
}));
jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) => mockFeature(...args),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: { id: "source-1" } }),
            }),
          }),
        }),
      }),
    }),
  }),
}));
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import { POST } from "./route";
function send(body: unknown) {
  return POST(
    new Request(
      "https://airi.chat/api/workspaces/workspace-1/studio/instagram/voice",
      { method: "POST", body: JSON.stringify(body) }
    ) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mockAccess.mockResolvedValue(true);
  mockFeature.mockResolvedValue(true);
  mockSpeech.mockResolvedValue({
    buffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
  });
  mockStore.mockResolvedValue({
    displayUrl: "https://storage.example/signed",
    url: "gs://bucket/durable",
  });
});
it("uses admitted speech and canonical storage, preserving a playable URL", async () => {
  const response = await send({ text: "Hello", language: "kz" });
  expect(response.status).toBe(200);
  expect(mockSpeech).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      language: "kk",
      actionId: expect.stringMatching(/^instagram-voice:/),
    })
  );
  expect(mockStore).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      buffer: Buffer.from("audio"),
    })
  );
  expect(await response.json()).toMatchObject({
    url: "https://storage.example/signed",
    durableUrl: "gs://bucket/durable",
  });
});
it.each([{ text: 42 }, { text: "x".repeat(2501) }])(
  "rejects invalid or oversized text before paid work",
  async body => {
    expect((await send(body)).status).toBe(400);
    expect(mockSpeech).not.toHaveBeenCalled();
  }
);
it("rejects a foreign workspace before paid work", async () => {
  mockAccess.mockResolvedValue(false);
  expect((await send({ text: "Hello" })).status).toBe(403);
  expect(mockSpeech).not.toHaveBeenCalled();
});
it("surfaces exhausted allowance without uploading an asset", async () => {
  mockSpeech.mockRejectedValue(
    new WorkspaceAiSpendError("workspace_ai_spend_limit")
  );
  expect((await send({ text: "Hello" })).status).toBe(402);
  expect(mockStore).not.toHaveBeenCalled();
});
