const mockGetPlatformUsage = jest.fn();
const mockWithPlatformAdmission = jest.fn();
const mockIsGoogleCreativeGenerationConfigured = jest.fn();
const mockIsPlatformElevenLabsConfigured = jest.fn();
let mockFreeGenerationLimit = 10;

jest.mock("@/lib/google/creative-assets", () => ({
  getGoogleFreeGenerationLimit: () => mockFreeGenerationLimit,
  isGoogleCreativeGenerationConfigured: () =>
    mockIsGoogleCreativeGenerationConfigured(),
}));

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  isPlatformElevenLabsConfigured: () => mockIsPlatformElevenLabsConfigured(),
}));

jest.mock(
  "@/lib/creative-assets/platform-creative-generation-quota-ledger",
  () => ({
    getWorkspacePlatformCreativeGenerationUsage: (...args: unknown[]) =>
      mockGetPlatformUsage(...args),
    withWorkspacePlatformCreativeGenerationQuotaAdmission: (
      ...args: unknown[]
    ) => mockWithPlatformAdmission(...args),
  })
);

import {
  getWorkspaceCreativeGenerationQuotas,
  getWorkspacePlatformCreativeGenerationQuota,
} from "./creative-asset-quota";

describe("creative asset platform quota", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFreeGenerationLimit = 10;
    mockGetPlatformUsage.mockResolvedValue(3);
    mockWithPlatformAdmission.mockResolvedValue({
      accepted: true,
      replay: false,
      value: "generated",
      quota: { limit: 10, used: 4, remaining: 6 },
    });
    mockIsGoogleCreativeGenerationConfigured.mockReturnValue(false);
    mockIsPlatformElevenLabsConfigured.mockReturnValue(true);
  });

  it("counts Google and ElevenLabs platform-funded generations together", async () => {
    const quota = await getWorkspacePlatformCreativeGenerationQuota("ws-1");

    expect(mockGetPlatformUsage).toHaveBeenCalledWith("ws-1", 10);
    expect(quota).toEqual({
      configured: true,
      limit: 10,
      used: 3,
      remaining: 7,
    });
  });

  it("derives Google and platform quotas from one ledger usage snapshot", async () => {
    const quotas = await getWorkspaceCreativeGenerationQuotas("ws-1");

    expect(mockGetPlatformUsage).toHaveBeenCalledTimes(1);
    expect(quotas).toEqual({
      google: {
        configured: false,
        limit: 10,
        used: 3,
        remaining: 7,
      },
      platform: {
        configured: true,
        limit: 10,
        used: 3,
        remaining: 7,
      },
    });
  });

  it("caps admission reads at the workspace quota limit", async () => {
    mockGetPlatformUsage.mockResolvedValue(10);

    await expect(
      getWorkspacePlatformCreativeGenerationQuota("ws-large")
    ).resolves.toMatchObject({ used: 10, remaining: 0 });

    expect(mockGetPlatformUsage).toHaveBeenCalledWith("ws-large", 10);
  });

  it("does not issue an invalid Mongo limit when generation is disabled", async () => {
    mockFreeGenerationLimit = 0;
    mockGetPlatformUsage.mockResolvedValue(0);

    await expect(
      getWorkspaceCreativeGenerationQuotas("ws-disabled")
    ).resolves.toMatchObject({ google: { limit: 0, used: 0, remaining: 0 } });

    expect(mockGetPlatformUsage).toHaveBeenCalledWith("ws-disabled", 0);
  });
});
