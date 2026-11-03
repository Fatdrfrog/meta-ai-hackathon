/** @jest-environment jsdom */

import {
  adFileName,
  clockTime,
  fileSize,
  productWord,
  tookTime,
} from "./product-ad-parts";

// The studio's small words: the making clock, how long something took, a
// file's size, what "Still your …" calls a product, and download names.

describe("the studio's numbers and names", () => {
  it("writes the making clock as minutes and seconds", () => {
    expect(clockTime(0)).toBe("0:00");
    expect(clockTime(38_400)).toBe("0:38");
    expect(clockTime(725_000)).toBe("12:05");
    expect(clockTime(-5)).toBe("0:00");
  });

  it("says how long something took", () => {
    expect(tookTime(7_400)).toBe("7 s");
    expect(tookTime(64_000)).toBe("1 min 4 s");
    expect(tookTime(120_000)).toBe("2 min");
  });

  it("sizes files in the units WhatsApp's 16 MB is counted in", () => {
    expect(fileSize(3_355_443)).toBe("3.2 MB");
    expect(fileSize(16 * 1024 * 1024)).toBe("16.0 MB");
    expect(fileSize(880_640)).toBe("860 KB");
    expect(fileSize(10)).toBe("1 KB");
  });

  it("calls a product by its English name, keeping a brand's capitals", () => {
    expect(productWord({ englishName: "Blue doll" })).toBe("blue doll");
    expect(productWord({ englishName: "Doll" })).toBe("doll");
    expect(productWord({ englishName: "LOL doll" })).toBe("LOL doll");
    expect(productWord({ englishName: "Web UMN mug" })).toBe("Web UMN mug");
    expect(productWord({ englishName: "  " })).toBe("product");
    expect(productWord({ englishName: null })).toBe("product");
  });

  it("names downloads by the day the ad was made", () => {
    const ad = {
      createdAt: "2026-11-02T09:14:00.000Z",
      readyAt: "2026-11-03T08:00:00.000Z",
    };
    expect(adFileName(ad, "video")).toBe("video-ad-2026-11-03.mp4");
    expect(adFileName(ad, "status")).toBe("status-picture-2026-11-03.jpg");
    expect(adFileName({ ...ad, readyAt: null }, "feed")).toBe(
      "ad-picture-4x5-2026-11-02.jpg"
    );
  });
});
