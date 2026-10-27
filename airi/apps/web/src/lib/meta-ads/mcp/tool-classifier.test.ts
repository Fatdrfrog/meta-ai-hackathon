import {
  classifyMetaAdsMcpToolSideEffect,
  isMetaAdsMcpWriteTool,
} from "./tool-classifier";

describe("classifyMetaAdsMcpToolSideEffect", () => {
  it("marks known reporting tools as read", () => {
    expect(classifyMetaAdsMcpToolSideEffect("ads_get_ad_entities")).toBe(
      "read"
    );
    expect(
      classifyMetaAdsMcpToolSideEffect("ads_insights_performance_trend")
    ).toBe("read");
    expect(classifyMetaAdsMcpToolSideEffect("ads_get_ad_accounts")).toBe(
      "read"
    );
    expect(classifyMetaAdsMcpToolSideEffect("ads_get_field_context")).toBe(
      "read"
    );
  });

  it("marks create/update tools as write", () => {
    expect(classifyMetaAdsMcpToolSideEffect("ads_create_campaign")).toBe(
      "write"
    );
    expect(classifyMetaAdsMcpToolSideEffect("ads_update_adset")).toBe("write");
    expect(isMetaAdsMcpWriteTool("catalog_create_product")).toBe(true);
  });

  it("defaults unknown tools to write/confirm", () => {
    expect(classifyMetaAdsMcpToolSideEffect("mystery_tool")).toBe("write");
    expect(classifyMetaAdsMcpToolSideEffect("")).toBe("write");
    expect(classifyMetaAdsMcpToolSideEffect("ADS_GET_AD_ACCOUNTS")).toBe(
      "write"
    );
    expect(classifyMetaAdsMcpToolSideEffect(" ads_get_ad_accounts ")).toBe(
      "write"
    );
  });
});
