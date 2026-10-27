jest.mock("server-only", () => ({}));

import { resolveCrawlBudget } from "@/lib/crawler/crawl-limits";

import {
  buildCrawlWebsiteExecutionFingerprint,
  buildCrawlWebsiteExecutionId,
} from "./crawl-website-execution";

describe("crawl website execution identity", () => {
  const firstFourWebsites = [
    "https://a.example",
    "https://b.example",
    "https://c.example",
    "https://d.example",
  ];

  it("canonicalizes equivalent websites and effective crawl defaults", () => {
    const executionId = buildCrawlWebsiteExecutionId({
      websites: ["https://b.example", "https://a.example/#fragment"],
      includeInstagram: true,
    });

    expect(executionId).toBe(
      buildCrawlWebsiteExecutionId({
        websites: [
          "https://a.example/",
          "https://b.example/",
          "https://a.example",
        ],
        includeInstagram: true,
        ...resolveCrawlBudget({}),
      })
    );
    expect(executionId).toMatch(/^manual-[a-f0-9]{64}$/);
    expect(
      buildCrawlWebsiteExecutionFingerprint({
        websites: ["https://a.example"],
      })
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes identity for material crawl input differences", () => {
    const baseline = buildCrawlWebsiteExecutionId({
      websites: ["https://a.example"],
    });

    expect(
      buildCrawlWebsiteExecutionId({
        websites: ["https://a.example"],
        includeInstagram: true,
      })
    ).not.toBe(baseline);
    expect(
      buildCrawlWebsiteExecutionId({
        websites: ["https://b.example"],
      })
    ).not.toBe(baseline);
    expect(
      buildCrawlWebsiteExecutionId({
        websites: ["https://a.example"],
        maxPagesPerSite: 4,
      })
    ).not.toBe(baseline);
  });

  it("changes identity when the fifth website changes without Instagram", () => {
    expect(
      buildCrawlWebsiteExecutionId({
        websites: [...firstFourWebsites, "https://e.example"],
        includeInstagram: false,
      })
    ).not.toBe(
      buildCrawlWebsiteExecutionId({
        websites: [...firstFourWebsites, "https://f.example"],
        includeInstagram: false,
      })
    );
  });

  it("ignores fifth-website differences when Instagram reserves that slot", () => {
    expect(
      buildCrawlWebsiteExecutionId({
        websites: [...firstFourWebsites, "https://e.example"],
        includeInstagram: true,
      })
    ).toBe(
      buildCrawlWebsiteExecutionId({
        websites: [...firstFourWebsites, "https://f.example"],
        includeInstagram: true,
      })
    );
  });
});
