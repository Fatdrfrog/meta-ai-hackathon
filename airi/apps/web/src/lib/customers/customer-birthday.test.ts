import {
  buildCustomerBirthdayValue,
  isCustomerBirthdayFieldName,
  parseCustomerBirthday,
} from "./customer-birthday";

describe("customer birthday normalization", () => {
  it.each([
    ["1992-04-17", { month: 4, day: 17, year: 1992 }],
    ["17.04.1992", { month: 4, day: 17, year: 1992 }],
    ["17/04/1992", { month: 4, day: 17, year: 1992 }],
    ["04-17", { month: 4, day: 17 }],
    ["17.04", { month: 4, day: 17 }],
    ["29.02", { month: 2, day: 29 }],
  ])("accepts %s", (value, expected) => {
    expect(parseCustomerBirthday(value)).toEqual({
      ok: true,
      birthday: {
        ...expected,
        raw: value,
      },
    });
  });

  it.each(["04/17", "31.04.1992", "1992-02-30", "29.02.2023", "13-40"])(
    "rejects ambiguous or invalid value %s",
    value => {
      expect(parseCustomerBirthday(value)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
    }
  );

  it("builds the persisted value with source metadata", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");

    expect(
      buildCustomerBirthdayValue({
        value: "1992-04-17",
        source: "csv",
        now,
      })
    ).toEqual({
      month: 4,
      day: 17,
      year: 1992,
      raw: "1992-04-17",
      source: "csv",
      updatedAt: now,
    });
  });

  it("detects birthday column aliases", () => {
    expect(isCustomerBirthdayFieldName("birth date")).toBe(true);
    expect(isCustomerBirthdayFieldName("dob")).toBe(true);
    expect(isCustomerBirthdayFieldName("phone")).toBe(false);
  });
});
