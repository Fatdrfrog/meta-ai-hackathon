import {
  BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
  resolveBulkDispatchPayloadTtlSeconds,
} from "@icecore/shared/lib/bulk-dispatch-payload-store";

describe("bulk dispatch payload staging TTL", () => {
  it("keeps unscheduled payloads for the base outage window", () => {
    expect(resolveBulkDispatchPayloadTtlSeconds()).toBe(
      BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC
    );
  });

  it("extends TTL past the scheduled dispatch time plus the base outage window", () => {
    expect(
      resolveBulkDispatchPayloadTtlSeconds({
        now: new Date("2099-05-14T10:00:00.000Z"),
        retainUntil: "2099-05-15T10:00:00.000Z",
      })
    ).toBe(BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC + 24 * 60 * 60);
  });

  it("keeps malformed retain dates on the base outage window", () => {
    expect(
      resolveBulkDispatchPayloadTtlSeconds({
        now: new Date("2099-05-14T10:00:00.000Z"),
        retainUntil: "not-a-date",
      })
    ).toBe(BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC);
  });
});
