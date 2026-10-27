const mockAccess = jest.fn();
const mockSpeech = jest.fn();
const mockStore = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/elevenlabs/workspace-speech", () => ({
  generateWorkspaceSpeech: (...args: unknown[]) => mockSpeech(...args),
}));
jest.mock("@/lib/scenarios/scenario-asset-storage", () => ({
  storeScenarioAssetBuffer: (...args: unknown[]) => mockStore(...args),
}));
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import { POST } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-1" });
function request(text = "Hello voice") {
  return new Request(
    "https://airi.chat/api/workspaces/workspace-1/scenarios/generate-voice",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }
  ) as never;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ ok: true });
  mockSpeech.mockResolvedValue({
    buffer: Buffer.from("ogg-bytes"),
    mimeType: "audio/ogg",
  });
  mockStore.mockResolvedValue({
    url: "gcs://bucket/voice.ogg",
    displayUrl: "https://cdn.example.com/voice.ogg",
    bucket: "bucket",
    path: "voice.ogg",
  });
});
it("uses the shared lifetime speech owner and canonical playable/durable storage URLs", async () => {
  const response = await POST(request(), { params });
  expect(response.status).toBe(200);
  expect(mockSpeech).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    actionId: expect.stringMatching(/^scenario-voice:/),
    text: "Hello voice",
    voiceId: undefined,
    outputFormat: "opus_48000_64",
  });
  expect(mockStore).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      buffer: expect.any(Buffer),
      mimeType: "audio/ogg",
    })
  );
  expect(await response.json()).toMatchObject({
    success: true,
    attachment: {
      url: "https://cdn.example.com/voice.ogg",
      durableUrl: "gcs://bucket/voice.ogg",
      mediaType: "audio",
    },
  });
});
it("authenticates before generating", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: Response.json({}, { status: 403 }),
  });
  expect((await POST(request(), { params })).status).toBe(403);
  expect(mockSpeech).not.toHaveBeenCalled();
});
it("validates input before generating", async () => {
  expect((await POST(request("x".repeat(2501)), { params })).status).toBe(400);
  expect(mockSpeech).not.toHaveBeenCalled();
});
it.each([
  ["workspace_ai_spend_limit", 402],
  ["workspace_ai_policy_unavailable", 503],
] as const)("returns actionable admission failure %s", async (code, status) => {
  mockSpeech.mockRejectedValue(new WorkspaceAiSpendError(code));
  expect((await POST(request(), { params })).status).toBe(status);
  expect(mockStore).not.toHaveBeenCalled();
});
it("does not publish a non-OPUS result as a WhatsApp voice note", async () => {
  mockSpeech.mockResolvedValue({
    buffer: Buffer.from("mp3"),
    mimeType: "audio/mpeg",
  });
  expect((await POST(request(), { params })).status).toBe(502);
  expect(mockStore).not.toHaveBeenCalled();
});
