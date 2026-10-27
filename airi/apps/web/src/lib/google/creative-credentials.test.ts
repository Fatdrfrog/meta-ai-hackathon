/** @jest-environment node */
const mockResolve = jest.fn();
const mockPlatformKey = jest.fn(() => "platform-key");
jest.mock("@/lib/google/google-ai-source", () => ({
  resolveGoogleAiCredentialsForWorkspace: (...args: unknown[]) =>
    mockResolve(...args),
}));
jest.mock("@/lib/google/creative-assets", () => ({
  getGoogleGenerativeApiKey: () => mockPlatformKey(),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
const mockElevenLabsAccess = jest.fn();
jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  resolveWorkspaceElevenLabsGenerationAccess: (...args: unknown[]) =>
    mockElevenLabsAccess(...args),
}));
import {
  isCreativeAiSourceLookupUnavailable,
  resolveElevenLabsCreativeWorkerApiKey,
  resolveGoogleCreativeWorkerApiKey,
  resolveWorkspaceGoogleCreativeCredentials,
} from "./creative-credentials";

describe("Google creative customer credentials", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue({
      sourceId: "source-1",
      apiKey: "customer-key",
    });
  });
  it("requires a pinned source for worker submission", async () => {
    await expect(
      resolveGoogleCreativeWorkerApiKey({
        workspaceId: "workspace-1",
        providerSourceId: null,
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(mockPlatformKey).not.toHaveBeenCalled();
  });
  it("resolves the exact worker workspace and source on every execution", async () => {
    await expect(
      resolveGoogleCreativeWorkerApiKey({
        workspaceId: "workspace-1",
        providerSourceId: "source-1",
      })
    ).resolves.toBe("customer-key");
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    );
    expect(mockPlatformKey).not.toHaveBeenCalled();
  });
  it("never falls back when a pinned source is deleted, including polling", async () => {
    mockResolve.mockRejectedValue(new Error("deleted source"));
    await expect(
      resolveGoogleCreativeWorkerApiKey({
        workspaceId: "workspace-1",
        providerSourceId: "source-1",
        allowLegacyPlatform: true,
      })
    ).rejects.toThrow();
    expect(mockPlatformKey).not.toHaveBeenCalled();
  });
  it("can finish a previously submitted platform operation", async () => {
    await expect(
      resolveGoogleCreativeWorkerApiKey({
        workspaceId: "workspace-1",
        providerSourceId: null,
        allowLegacyPlatform: true,
      })
    ).resolves.toBe("platform-key");
    expect(mockResolve).not.toHaveBeenCalled();
  });
  it("returns a safe required-source error for invalid selected credentials", async () => {
    mockResolve.mockRejectedValue(new Error("invalid secret key"));
    await expect(
      resolveWorkspaceGoogleCreativeCredentials({
        supabase: {} as never,
        workspaceId: "workspace-1",
        sourceId: "source-1",
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(mockPlatformKey).not.toHaveBeenCalled();
  });
  it("tells a source that could not be read apart from an invalid one", async () => {
    const resolve = () =>
      resolveGoogleCreativeWorkerApiKey({
        workspaceId: "workspace-1",
        providerSourceId: "source-1",
      }).catch((error: unknown) => error);

    mockResolve.mockRejectedValue(
      Object.assign(new Error("Google AI is unavailable"), {
        code: "GOOGLE_AI_UNAVAILABLE",
      })
    );
    const unavailable = await resolve();
    expect(unavailable).toMatchObject({ code: "own_ai_source_required" });
    expect(isCreativeAiSourceLookupUnavailable(unavailable)).toBe(true);

    mockResolve.mockRejectedValue(
      Object.assign(new Error("invalid secret key"), {
        code: "INVALID_API_KEY",
      })
    );
    const invalid = await resolve();
    expect(invalid).toMatchObject({ code: "own_ai_source_required" });
    expect(isCreativeAiSourceLookupUnavailable(invalid)).toBe(false);
    // The cause stays out of serialized errors.
    expect(JSON.stringify(invalid)).not.toContain("secret");
  });
});

describe("ElevenLabs creative customer credentials", () => {
  const resolve = (providerSourceId: string | null = "source-1") =>
    resolveElevenLabsCreativeWorkerApiKey({
      workspaceId: "workspace-1",
      providerSourceId,
    });
  beforeEach(() => {
    jest.clearAllMocks();
    mockElevenLabsAccess.mockResolvedValue({
      available: true,
      credentialSource: "workspace_source",
      sourceId: "source-1",
      apiKey: "customer-key",
    });
  });

  it("reads only the pinned workspace source, never the platform key", async () => {
    await expect(resolve()).resolves.toBe("customer-key");
    expect(mockElevenLabsAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        allowPlatform: false,
      })
    );
  });

  it.each([
    ["no pinned source", null, undefined],
    ["another source", "source-1", { sourceId: "source-2" }],
    ["the platform key", "source-1", { credentialSource: "platform" }],
    ["a source without a key", "source-1", { available: false, apiKey: null }],
  ])("requires the workspace's own key: %s", async (_name, source, access) => {
    if (access) {
      mockElevenLabsAccess.mockResolvedValue({
        available: true,
        credentialSource: "workspace_source",
        sourceId: "source-1",
        apiKey: "customer-key",
        ...access,
      });
    }
    const error = await resolve(source).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "own_ai_source_required" });
    expect(isCreativeAiSourceLookupUnavailable(error)).toBe(false);
  });

  it("marks a source that could not be read as temporarily unavailable", async () => {
    mockElevenLabsAccess.mockRejectedValue(
      new Error("ElevenLabs source could not be loaded.")
    );
    const error = await resolve().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "own_ai_source_required" });
    expect(isCreativeAiSourceLookupUnavailable(error)).toBe(true);
  });
});
