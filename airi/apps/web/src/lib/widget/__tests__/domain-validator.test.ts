import {
  getRequestOrigin,
  normalizeAllowedDomains,
  validateDomain,
} from "@/lib/widget/domain-validator";

describe("widget domain validator", () => {
  it("rejects origins when no allowed domains are configured", () => {
    expect(validateDomain("https://preview.example.com", [])).toBe(false);
  });

  it("matches exact domains stored as hostnames or full URLs", () => {
    expect(
      validateDomain("https://nest-ai-front-8mgk9cz1l.vercel.app", [
        "https://nest-ai-front-8mgk9cz1l.vercel.app",
      ])
    ).toBe(true);
  });

  it("matches wildcard subdomains", () => {
    expect(
      validateDomain("https://preview.example.com", ["*.example.com"])
    ).toBe(true);
  });

  it("supports localhost wildcard ports documented in the UI", () => {
    expect(validateDomain("http://localhost:3000", ["localhost:*"])).toBe(true);
    expect(validateDomain("http://localhost:3001", ["localhost:3000"])).toBe(
      false
    );
  });

  it("normalizes stored domains before persistence", () => {
    expect(
      normalizeAllowedDomains([
        " https://Example.com/path ",
        "example.com",
        "LOCALHOST:*",
      ])
    ).toEqual(["example.com", "localhost:*"]);
  });

  it("falls back to the referer header when origin is missing", () => {
    const request = new Request("https://api.example.com/widget", {
      headers: {
        referer: "https://preview.example.com/products/1",
      },
    });

    expect(getRequestOrigin(request)).toBe("https://preview.example.com");
  });
});
