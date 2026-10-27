/** @jest-environment node */
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import { submitWanS2V, submitWanFirstLastI2V } from "@/lib/wan/wan-s2v-client";
import { submitHappyHorseT2V } from "@/lib/happyhorse/happyhorse-client";
import { PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER } from "@/lib/creative-assets/platform-creative-generation-quota-ledger";

describe("customer-funded creative policy", () => {
  afterEach(() => jest.restoreAllMocks());
  it("blocks Alibaba and HappyHorse submissions while customer sources are unsupported", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("Unexpected provider call"));
    await expect(
      submitHappyHorseT2V({
        prompt: "A mountain",
        resolution: "720P",
        ratio: "9:16",
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    await expect(
      submitWanS2V({
        imageUrl: "https://example.com/image.png",
        audioUrl: "https://example.com/audio.mp3",
        resolution: "720P",
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    await expect(
      submitWanFirstLastI2V({
        prompt: "A mountain",
        firstFrameUrl: "https://example.com/image.png",
        lastFrameUrl: "https://example.com/end.png",
        resolution: "720P",
      })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("excludes Google customer sources from platform audio allowance reconciliation", () => {
    const google = PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER.$or[0];
    expect(google).toEqual({
      provider: "google",
      $or: [
        { providerSourceId: null },
        { providerSourceId: "" },
        { providerSourceId: { $exists: false } },
      ],
    });
  });
});
