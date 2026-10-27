import { referenceVideoPlanInputSchema } from "./contracts";
import { decodeTikTokMarketingTemplatesResponse } from "../tiktok-marketing-templates";

const input = () => ({
  recipeId: "product-reveal",
  title: "Our new collection",
  scenes: Array.from({ length: 3 }, (_, index) => ({
    assetId: "64c13ab08edf48a008793cab",
    caption: `Scene ${index + 1}`,
    sourceStart: 0,
  })),
});

describe("reference video input contract", () => {
  it("requires the exact reviewed scene count and a supported recipe", () => {
    expect(
      referenceVideoPlanInputSchema.safeParse({ ...input(), scenes: [] })
        .success
    ).toBe(false);
    expect(
      referenceVideoPlanInputSchema.safeParse({
        ...input(),
        recipeId: "unknown",
      }).success
    ).toBe(false);
    expect(
      referenceVideoPlanInputSchema.safeParse({
        ...input(),
        scenes: [...input().scenes, input().scenes[0]],
      }).success
    ).toBe(false);
  });

  it("rejects invalid IDs, control characters, excessive captions, and unbounded source offsets", () => {
    for (const change of [
      { assetId: "bad" },
      { caption: "a".repeat(121) },
      { caption: "bad\u0000text" },
      { sourceStart: Infinity },
      { sourceStart: 7201 },
    ]) {
      const value = input();
      Object.assign(value.scenes[0], change);
      expect(referenceVideoPlanInputSchema.safeParse(value).success).toBe(
        false
      );
    }
  });

  it("accepts a canonical TikTok reference while rejecting malformed paths and external URLs", () => {
    const reference = {
      providerVideoId: "1234567890123456789",
      shareUrl: "https://www.tiktok.com/@business/video/1234567890123456789",
      title: "Reference",
    };
    expect(
      referenceVideoPlanInputSchema.safeParse({ ...input(), reference }).success
    ).toBe(true);
    for (const shareUrl of [
      "not a URL",
      "/video/1234567890123456789",
      "https://example.com/video/1234567890123456789",
      "https://user:pass@www.tiktok.com/@business/video/1234567890123456789",
      "https://www.tiktok.com/junk/video/1234567890123456789",
      "https://www.tiktok.com/video/1234567890123456789",
      "https://www.tiktok.com/prefix/@business/video/1234567890123456789",
      "https://www.tiktok.com/@/video/1234567890123456789",
      "https://www.tiktok.com/@business/video/video.1",
      `https://www.tiktok.com/@business/video/${"a".repeat(129)}`,
    ]) {
      expect(
        referenceVideoPlanInputSchema.safeParse({
          ...input(),
          reference: { ...reference, shareUrl },
        }).success
      ).toBe(false);
    }
  });

  it.each([
    ["video-1", "1"],
    ["1234567890123456789", "999"],
    ["VIDEO_2", "VIDEO_2"],
    ["a".repeat(128), "a".repeat(128)],
    ["1".repeat(31), "1".repeat(31)],
  ])(
    "accepts discovery identifier %s with public video path %s through the catalog-to-plan boundary",
    (providerVideoId, pathVideoId) => {
      const catalog = decodeTikTokMarketingTemplatesResponse(
        {
          status: "ok",
          items: [
            {
              id: `tiktok:${providerVideoId}`,
              source: "tiktok_discovery",
              title: "Reference",
              preset: null,
              reference: {
                providerVideoId,
                shareUrl: `https://www.tiktok.com/@creator/video/${pathVideoId}`,
                thumbnailUrl: null,
                creatorName: null,
                creatorUrl: null,
                hashtag: "business",
                hashtagRank: 1,
                videoRank: 1,
                market: "KZ",
                category: "ALL",
                windowDays: 7,
              },
            },
          ],
          market: "KZ",
          category: "ALL",
          windowDays: 7,
          updatedAt: "2026-09-05T12:00:00.000Z",
          stale: false,
        },
        { market: "KZ", category: "ALL" }
      );
      expect(catalog?.status).toBe("ok");
      if (catalog?.status !== "ok") throw new Error("Invalid catalog fixture");
      const item = catalog.items[0];
      const reference = {
        providerVideoId: item.reference.providerVideoId,
        shareUrl: item.reference.shareUrl,
        title: item.title,
      };
      expect(
        referenceVideoPlanInputSchema.parse({ ...input(), reference }).reference
      ).toEqual(reference);
    }
  );

  it.each(["", "a".repeat(129), "video/1", "video.1", "video 1"])(
    "rejects unsupported discovery identifier %s",
    providerVideoId => {
      expect(
        referenceVideoPlanInputSchema.safeParse({
          ...input(),
          reference: {
            providerVideoId,
            shareUrl: "https://www.tiktok.com/@business/video/1",
            title: "Reference",
          },
        }).success
      ).toBe(false);
    }
  );
});
