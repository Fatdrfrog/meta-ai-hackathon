import {
  buildHiggsfieldWebhookUrl,
  isHiggsfieldWebhookConfigured,
  signHiggsfieldWebhookToken,
  verifyHiggsfieldWebhookToken,
} from "./higgsfield-webhook";

describe("Higgsfield webhook signing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      HIGGSFIELD_WEBHOOK_SECRET: "webhook-secret",
      NEXT_PUBLIC_APP_URL: "https://app.airi.chat/",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("builds a public signed callback URL", () => {
    const url = new URL(buildHiggsfieldWebhookUrl("asset-1"));

    expect(url.origin).toBe("https://app.airi.chat");
    expect(url.pathname).toBe("/api/webhooks/higgsfield");
    expect(url.searchParams.get("assetId")).toBe("asset-1");
    expect(
      verifyHiggsfieldWebhookToken(
        "asset-1",
        url.searchParams.get("token") || ""
      )
    ).toBe(true);
  });

  it("rejects tokens signed for a different asset id", () => {
    const token = signHiggsfieldWebhookToken("asset-1");

    expect(verifyHiggsfieldWebhookToken("asset-2", token)).toBe(false);
  });

  it("treats missing webhook secrets as an invalid token instead of throwing", () => {
    const token = signHiggsfieldWebhookToken("asset-1");
    delete process.env.HIGGSFIELD_WEBHOOK_SECRET;

    expect(verifyHiggsfieldWebhookToken("asset-1", token)).toBe(false);
  });

  it("reports webhook config as missing when callback secret or public app URL is absent", () => {
    expect(isHiggsfieldWebhookConfigured()).toBe(true);

    delete process.env.HIGGSFIELD_WEBHOOK_SECRET;
    expect(isHiggsfieldWebhookConfigured()).toBe(false);

    process.env.HIGGSFIELD_WEBHOOK_SECRET = "webhook-secret";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(isHiggsfieldWebhookConfigured()).toBe(false);
  });
});
