import {
  normalizeTikTokShareUrl,
  normalizeTikTokThumbnailUrl,
} from "./url-policy";

describe("TikTok URL policy", () => {
  it("normalizes approved URLs and rejects deceptive share hosts", () => {
    expect(
      normalizeTikTokShareUrl(
        "https://www.tiktok.com/@creator/video/123#tracking"
      )
    ).toBe("https://www.tiktok.com/@creator/video/123");
    expect(
      normalizeTikTokThumbnailUrl("https://p16.muscdn.com/object/preview")
    ).toBe("https://p16.muscdn.com/object/preview");
    for (const value of [
      "http://www.tiktok.com/@creator/video/123",
      "https://tiktok.com.evil.test/x",
      "https://eviltiktok.com/x",
      "https://user:pass@www.tiktok.com/x",
      "https://www.tiktok.com:8443/x",
    ])
      expect(normalizeTikTokShareUrl(value)).toBeNull();
  });

  it.each([
    "https://muscdn.com.evil.test/preview",
    "https://evilmuscdn.com/preview",
    "https://user:pass@p16.muscdn.com/preview",
    "https://p16.muscdn.com:8443/preview",
  ])("rejects a deceptive thumbnail URL %s", value => {
    expect(normalizeTikTokThumbnailUrl(value)).toBeNull();
  });
});
