import { ltvConfigPayloadSchema } from "./ltv-config";

it.each([NaN, Infinity, -Infinity, 0, -1, "100", null])(
  "rejects invalid customer value %s",
  baseValue => {
    expect(
      ltvConfigPayloadSchema.safeParse({ baseValue, currency: "USD" }).success
    ).toBe(false);
  }
);
it.each(["123", "US", "USDD", "", null])(
  "rejects invalid currency %s",
  currency => {
    expect(
      ltvConfigPayloadSchema.safeParse({ baseValue: 100, currency }).success
    ).toBe(false);
  }
);
it("keeps a finite decimal value and canonical currency", () => {
  expect(
    ltvConfigPayloadSchema.parse({ baseValue: 10.25, currency: "kzt" })
  ).toEqual({ baseValue: 10.25, currency: "KZT" });
});
