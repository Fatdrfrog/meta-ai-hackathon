import {
  coerceCompactString,
  coerceBoolean,
  coerceBooleanField,
  coerceNonEmptyString,
  coerceStringArray,
  booleanField,
  normalizeUrlBase,
} from "@icecore/shared/lib/value-utils";

describe("@icecore/shared/lib/value-utils", () => {
  it("coerces non-nullish values to trimmed non-empty strings", () => {
    expect(coerceNonEmptyString(123)).toBe("123");
    expect(coerceNonEmptyString("  abc  ")).toBe("abc");
    expect(coerceNonEmptyString(null)).toBeNull();
    expect(coerceNonEmptyString(undefined)).toBeNull();
  });

  it("rejects plain object stringification while accepting ObjectId-like values", () => {
    expect(coerceNonEmptyString({ id: "abc" })).toBeNull();
    expect(
      coerceNonEmptyString({
        toString: () => "507f1f77bcf86cd799439011",
      })
    ).toBe("507f1f77bcf86cd799439011");
  });

  it("coerces and compacts internal whitespace when requested", () => {
    expect(coerceCompactString("  hello \n\t world  ")).toBe("hello world");
  });

  it("coerces array items to non-empty strings", () => {
    expect(coerceStringArray([" abc ", 123, null, ""])).toEqual(["abc", "123"]);
  });

  it("extracts strict and coerced boolean fields", () => {
    expect(booleanField({ enabled: true }, "enabled")).toBe(true);
    expect(booleanField({ enabled: "true" }, "enabled")).toBeNull();
    expect(coerceBoolean("yes")).toBe(true);
    expect(coerceBoolean("off")).toBe(false);
    expect(coerceBoolean("maybe")).toBeNull();
    expect(coerceBooleanField({ enabled: "1" }, "enabled")).toBe(true);
  });

  it("normalizes URL base values", () => {
    expect(normalizeUrlBase(" https://example.com/// ")).toBe(
      "https://example.com"
    );
    expect(normalizeUrlBase("   ")).toBeUndefined();
  });
});
