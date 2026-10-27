import { createPerformanceFormatters } from "./performance-localization";

describe("createPerformanceFormatters", () => {
  it("normalizes negative zero before adding a trend sign", () => {
    const formatters = createPerformanceFormatters("en", key => key);

    expect(formatters.number(-0)).toBe("0");
    expect(formatters.signedNumber(-0)).toBe("0");
  });
});
