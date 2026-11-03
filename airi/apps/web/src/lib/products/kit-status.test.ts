import {
  carouselVerdict,
  kitPartCanRetry,
  productKitStatus,
} from "./kit-status";

// How a kit's parts add up, for the server's status and the page's chips.

describe("carouselVerdict", () => {
  it("reads Meta's template statuses", () => {
    expect(carouselVerdict("PENDING")).toBe("waiting");
    expect(carouselVerdict("IN_APPEAL")).toBe("waiting");
    expect(carouselVerdict(null)).toBe("waiting");
    expect(carouselVerdict("APPROVED")).toBe("approved");
    expect(carouselVerdict("approved")).toBe("approved");
    expect(carouselVerdict("REJECTED")).toBe("rejected");
    expect(carouselVerdict("PAUSED")).toBe("paused");
    expect(carouselVerdict("DISABLED")).toBe("disabled");
    expect(carouselVerdict("LIMIT_EXCEEDED")).toBe("limit");
  });
});

describe("productKitStatus", () => {
  const ready = { state: "ready" };
  const pending = { state: "submitted", metaStatus: "PENDING" };
  const approved = { state: "submitted", metaStatus: "APPROVED" };

  it("is making while either part is", () => {
    expect(
      productKitStatus({ orderForm: { state: "making" }, carousel: approved })
    ).toBe("making");
    expect(
      productKitStatus({ orderForm: ready, carousel: { state: "making" } })
    ).toBe("making");
  });

  it("waits for Meta while it checks the carousel, and is ready once it approves", () => {
    expect(productKitStatus({ orderForm: ready, carousel: pending })).toBe(
      "waiting_for_meta"
    );
    expect(productKitStatus({ orderForm: ready, carousel: approved })).toBe(
      "ready"
    );
    expect(productKitStatus({ orderForm: ready })).toBe("ready");
    expect(productKitStatus({ carousel: approved })).toBe("ready");
  });

  it("needs attention when a part wasn't made, the form is a draft, or Meta turned the carousel down", () => {
    expect(
      productKitStatus({ orderForm: { state: "failed" }, carousel: pending })
    ).toBe("needs_attention");
    expect(
      productKitStatus({ orderForm: { state: "draft" }, carousel: approved })
    ).toBe("needs_attention");
    expect(
      productKitStatus({ orderForm: ready, carousel: { state: "failed" } })
    ).toBe("needs_attention");
    for (const metaStatus of [
      "REJECTED",
      "PAUSED",
      "DISABLED",
      "LIMIT_EXCEEDED",
    ])
      expect(
        productKitStatus({
          orderForm: ready,
          carousel: { state: "submitted", metaStatus },
        })
      ).toBe("needs_attention");
  });

  it("doesn't count a carousel skipped for too few photos", () => {
    expect(
      productKitStatus({ orderForm: ready, carousel: { state: "skipped" } })
    ).toBe("ready");
  });
});

describe("kitPartCanRetry", () => {
  it("makes again a part that wasn't made, or a carousel Meta turned down for good", () => {
    expect(kitPartCanRetry("orderForm", { state: "failed" })).toBe(true);
    expect(kitPartCanRetry("carousel", { state: "failed" })).toBe(true);
    for (const metaStatus of ["REJECTED", "DISABLED", "LIMIT_EXCEEDED"])
      expect(
        kitPartCanRetry("carousel", { state: "submitted", metaStatus })
      ).toBe(true);
  });

  it("leaves alone a part that is made, being made, waiting or paused", () => {
    expect(kitPartCanRetry("orderForm", { state: "ready" })).toBe(false);
    expect(kitPartCanRetry("orderForm", { state: "draft" })).toBe(false);
    expect(kitPartCanRetry("orderForm", { state: "making" })).toBe(false);
    expect(
      kitPartCanRetry("carousel", { state: "submitted", metaStatus: "PENDING" })
    ).toBe(false);
    expect(
      kitPartCanRetry("carousel", { state: "submitted", metaStatus: "PAUSED" })
    ).toBe(false);
    expect(kitPartCanRetry("carousel", { state: "skipped" })).toBe(false);
    expect(kitPartCanRetry("carousel", null)).toBe(false);
  });
});
