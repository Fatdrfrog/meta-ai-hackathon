import {
  normalizeBusinessConnectionId,
  resolveBusinessConnectionId,
} from "./telegram-business-connection";

describe("Telegram business connection utilities", () => {
  it("normalizes optional business connection IDs", () => {
    expect(normalizeBusinessConnectionId(undefined)).toBeUndefined();
    expect(normalizeBusinessConnectionId(null)).toBeUndefined();
    expect(normalizeBusinessConnectionId("   ")).toBeUndefined();
    expect(normalizeBusinessConnectionId("  biz_1  ")).toBe("biz_1");
  });

  it("resolves the first non-empty business connection ID", () => {
    expect(resolveBusinessConnectionId(undefined, " ", " biz_2 ")).toBe(
      "biz_2"
    );
    expect(resolveBusinessConnectionId("biz_1", "biz_2")).toBe("biz_1");
  });
});
