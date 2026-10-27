import { formatMessagingLimitTier } from "./messaging-limit";

describe("formatMessagingLimitTier", () => {
  it.each([
    ["TIER_250", "250 / 24h"],
    ["TIER_2K", "2,000 / 24h"],
    ["TIER_10K", "10,000 / 24h"],
    ["TIER_100K", "100,000 / 24h"],
    ["TIER_UNLIMITED", "Unlimited"],
    ["UNLIMITED", "Unlimited"],
    ["10000", "10,000 / 24h"],
    [undefined, "Unknown"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatMessagingLimitTier(input)).toBe(expected);
  });
});
