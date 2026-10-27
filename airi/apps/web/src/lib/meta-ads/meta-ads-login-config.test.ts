import {
  resolveMetaAdsLoginConfigId,
  resolveMetaAdsMcpLoginConfigId,
} from "@/lib/meta-ads/meta-ads-login-config";

describe("meta-ads-login-config", () => {
  const originalMcp = process.env.META_ADS_MCP_LOGIN_CONFIG_ID;
  const originalAds = process.env.META_ADS_LOGIN_CONFIG_ID;

  afterEach(() => {
    if (originalMcp === undefined) {
      delete process.env.META_ADS_MCP_LOGIN_CONFIG_ID;
    } else {
      process.env.META_ADS_MCP_LOGIN_CONFIG_ID = originalMcp;
    }
    if (originalAds === undefined) {
      delete process.env.META_ADS_LOGIN_CONFIG_ID;
    } else {
      process.env.META_ADS_LOGIN_CONFIG_ID = originalAds;
    }
  });

  it("prefers dedicated MCP login config id", () => {
    process.env.META_ADS_MCP_LOGIN_CONFIG_ID = "mcp-config";
    process.env.META_ADS_LOGIN_CONFIG_ID = "ads-config";
    expect(resolveMetaAdsMcpLoginConfigId()).toBe("mcp-config");
  });

  it("falls back to Meta Ads login config id", () => {
    delete process.env.META_ADS_MCP_LOGIN_CONFIG_ID;
    process.env.META_ADS_LOGIN_CONFIG_ID = "ads-config";
    expect(resolveMetaAdsMcpLoginConfigId()).toBe("ads-config");
    expect(resolveMetaAdsLoginConfigId()).toBe("ads-config");
  });
});
