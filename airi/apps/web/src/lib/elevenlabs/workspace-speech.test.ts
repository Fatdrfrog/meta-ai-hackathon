const mockAccess = jest.fn();
const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockSubmit = jest.fn();
const mockVerifyVoice = jest.fn();
jest.mock("./elevenlabs-source", () => ({
  resolveWorkspaceElevenLabsGenerationAccess: (...args: unknown[]) =>
    mockAccess(...args),
}));
jest.mock("./creative-assets", () => ({
  submitElevenLabsTextToSpeech: (...args: unknown[]) => mockSubmit(...args),
  verifyStandardElevenLabsVoice: (...args: unknown[]) =>
    mockVerifyVoice(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@icecore/airi-runtime/workspace-ai-spend", () => ({
  reserveWorkspaceAiSpend: (...args: unknown[]) => mockReserve(...args),
  settleWorkspaceAiSpend: (...args: unknown[]) => mockSettle(...args),
}));
import { generateWorkspaceSpeech } from "./workspace-speech";

const input = {
  workspaceId: "workspace-1",
  actionId: "voice-1",
  text: "Hello",
  voiceId: "voice-1",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyVoice.mockResolvedValue(undefined);
  mockAccess.mockResolvedValue({
    apiKey: "platform-key",
    credentialSource: "platform",
  });
  mockReserve.mockResolvedValue({ operationId: "speech" });
  mockSubmit.mockResolvedValue({
    buffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
  });
});
it("admits platform speech before issuing a paid request", async () => {
  await generateWorkspaceSpeech(input);
  expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(
    mockSubmit.mock.invocationCallOrder[0]
  );
  expect(mockSettle).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ modelId: "eleven_multilingual_v2" })
  );
});
it("blocks provider work when the lifetime allowance is exhausted", async () => {
  mockReserve.mockRejectedValue(new Error("own_ai_source_required"));
  await expect(generateWorkspaceSpeech(input)).rejects.toThrow(
    "own_ai_source_required"
  );
  expect(mockSubmit).not.toHaveBeenCalled();
});
it("uses customer ElevenLabs credentials without a platform reservation", async () => {
  mockAccess.mockResolvedValue({
    apiKey: "customer-key",
    credentialSource: "workspace_source",
  });
  await generateWorkspaceSpeech(input);
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockVerifyVoice).not.toHaveBeenCalled();
  expect(mockSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "customer-key" })
  );
});

it("rejects an unknown voice rate without consuming an allowance", async () => {
  mockVerifyVoice.mockRejectedValue(new Error("Unknown voice rate"));
  await expect(generateWorkspaceSpeech(input)).rejects.toThrow(
    "Unknown voice rate"
  );
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});
it("rejects oversized text before any provider request", async () => {
  await expect(
    generateWorkspaceSpeech({ ...input, text: "x".repeat(2501) })
  ).rejects.toThrow("2500");
  expect(mockSubmit).not.toHaveBeenCalled();
});
it("retains the reservation when the provider outcome is unknown", async () => {
  mockSubmit.mockRejectedValue(new Error("timeout"));
  await expect(generateWorkspaceSpeech(input)).rejects.toThrow("timeout");
  expect(mockSettle).not.toHaveBeenCalled();
});
