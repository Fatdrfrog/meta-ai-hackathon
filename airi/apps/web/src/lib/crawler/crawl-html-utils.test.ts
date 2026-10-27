import {
  extractSameOriginLinks,
  extractSitemapLocs,
  isDisallowedCrawlHost,
  isPrivateOrReservedIp,
  normalizeRootUrl,
  rankCrawlUrls,
} from "@/lib/crawler/crawl-html-utils";

describe("normalizeRootUrl", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(normalizeRootUrl("example.com")?.toString()).toBe(
      "https://example.com/"
    );
  });

  it("strips the hash fragment", () => {
    expect(
      normalizeRootUrl("https://example.com/page#section")?.toString()
    ).toBe("https://example.com/page");
  });

  it("preserves an explicit http scheme", () => {
    expect(normalizeRootUrl("http://example.com")?.protocol).toBe("http:");
  });

  it("returns null for blank input", () => {
    expect(normalizeRootUrl("   ")).toBeNull();
    expect(normalizeRootUrl("")).toBeNull();
  });

  it("rejects localhost, .local, and private/reserved IP literals (SSRF)", () => {
    expect(normalizeRootUrl("http://localhost")).toBeNull();
    expect(normalizeRootUrl("http://printer.local")).toBeNull();
    expect(normalizeRootUrl("http://127.0.0.1")).toBeNull();
    expect(
      normalizeRootUrl("http://169.254.169.254/latest/meta-data")
    ).toBeNull();
    expect(normalizeRootUrl("http://10.0.0.5")).toBeNull();
    expect(normalizeRootUrl("http://192.168.1.1")).toBeNull();
    expect(normalizeRootUrl("http://172.16.0.1")).toBeNull();
    expect(normalizeRootUrl("http://[::1]")).toBeNull();
  });
});

describe("isDisallowedCrawlHost", () => {
  it("blocks loopback / link-local / private hosts", () => {
    expect(isDisallowedCrawlHost("localhost")).toBe(true);
    expect(isDisallowedCrawlHost("foo.localhost")).toBe(true);
    expect(isDisallowedCrawlHost("nas.local")).toBe(true);
    expect(isDisallowedCrawlHost("169.254.169.254")).toBe(true);
    expect(isDisallowedCrawlHost("100.64.0.1")).toBe(true);
    expect(isDisallowedCrawlHost("::1")).toBe(true);
    expect(isDisallowedCrawlHost("fd00::1")).toBe(true);
  });

  it("allows ordinary public hostnames", () => {
    expect(isDisallowedCrawlHost("example.com")).toBe(false);
    expect(isDisallowedCrawlHost("www.airi.chat")).toBe(false);
    expect(isDisallowedCrawlHost("8.8.8.8")).toBe(false);
  });
});

describe("isPrivateOrReservedIp", () => {
  it("flags private and reserved IPv4/IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("treats public addresses as allowed", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("extractSameOriginLinks", () => {
  const base = new URL("https://example.com/");

  it("keeps same-origin links and resolves relative paths", () => {
    const html = `
      <a href="/about">About</a>
      <a href="https://example.com/pricing">Pricing</a>
      <a href="contact">Contact</a>
    `;
    const links = extractSameOriginLinks(html, base);
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/pricing");
    expect(links).toContain("https://example.com/contact");
  });

  it("drops cross-origin, asset, and non-navigational links", () => {
    const html = `
      <a href="https://other.com/x">External</a>
      <a href="/logo.png">Logo</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="#top">Top</a>
      <a href="javascript:void(0)">JS</a>
    `;
    const links = extractSameOriginLinks(html, base);
    expect(links).toHaveLength(0);
  });

  it("de-duplicates links that differ only by fragment", () => {
    const html = `
      <a href="/team#a">A</a>
      <a href="/team#b">B</a>
    `;
    const links = extractSameOriginLinks(html, base);
    expect(links).toEqual(["https://example.com/team"]);
  });
});

describe("extractSitemapLocs", () => {
  it("extracts same-origin locations from sitemap xml", () => {
    const xml = `
      <urlset>
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/blog</loc></url>
        <url><loc>https://other.com/x</loc></url>
        <url><loc>https://example.com/file.pdf</loc></url>
      </urlset>
    `;
    const locs = extractSitemapLocs(xml, "https://example.com");
    expect(locs).toEqual(["https://example.com/", "https://example.com/blog"]);
  });
});

describe("rankCrawlUrls", () => {
  it("prioritizes high-signal business pages inside small crawl budgets", () => {
    const root = new URL("https://example.com/");
    const ranked = rankCrawlUrls(
      [
        "https://example.com/blog/company-picnic",
        "https://example.com/products",
        "https://example.com/faq",
        "https://example.com/about",
        "https://example.com/blog/old-news",
      ],
      root
    );

    expect(ranked.slice(0, 3)).toEqual([
      "https://example.com/products",
      "https://example.com/faq",
      "https://example.com/about",
    ]);
  });
});
