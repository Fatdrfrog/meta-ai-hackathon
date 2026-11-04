/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoggerError = jest.fn();
const mockAudio = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock("@/lib/products/voices", () => ({
  productVoiceSampleAudio: (...args: unknown[]) => mockAudio(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const voiceId = "cgSgspJ2msm6clMCkdW9";
const get = (query = "?language=ru", id = voiceId) =>
  GET(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/voice/samples/${id}${query}`
    ),
    { params: Promise.resolve({ workspaceId, voiceId: id }) }
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "admin" },
  });
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockAudio.mockResolvedValue({
    audio: Buffer.from("ID3 sample"),
    mimeType: "audio/mpeg",
  });
});

it("plays the sample as audio, kept for a day", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/mpeg");
  expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
    "ID3 sample"
  );
  expect(mockAudio).toHaveBeenCalledWith(workspaceId, voiceId, "ru");
});

it("is 403 ai_disabled, without an error logged, when the company turned AI off", async () => {
  mockAudio.mockRejectedValue(
    Object.assign(new Error("AI is disabled for this company."), {
      code: "workspace_ai_disabled",
    })
  );
  const response = await get();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "AI is disabled for this company",
    code: "ai_disabled",
  });
  expect(mockLoggerError).not.toHaveBeenCalled();
});

it("is 404 for a voice that isn't airi's, 400 for another language", async () => {
  mockAudio.mockResolvedValue(null);
  expect((await get("?language=ru", "someone")).status).toBe(404);
  expect((await get("?language=uz")).status).toBe(400);
});

it("answers 503 and logs when the sample can't be made", async () => {
  mockAudio.mockRejectedValue(new Error("ElevenLabs down"));
  const response = await get();
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("voice_unavailable");
  expect(mockLoggerError).toHaveBeenCalled();
});
