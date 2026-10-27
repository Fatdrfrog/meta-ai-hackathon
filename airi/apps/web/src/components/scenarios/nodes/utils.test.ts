import {
  filterScenarioAudienceCustomers,
  filterScenarioContextItems,
  getAudienceModeLabel,
  NONE_OPTION_VALUE,
  resolveSafeScenarioOptionValue,
  resolveScenarioSingleSelectValue,
} from "./utils";

describe("scenario node utils", () => {
  const t = (key: string) => key;

  it("maps audience modes to labels", () => {
    expect(getAudienceModeLabel("classification", t)).toBe("byClassification");
    expect(getAudienceModeLabel("funnel_stage", t)).toBe("byFunnelStage");
    expect(getAudienceModeLabel("all", t)).toBe("allCustomers");
  });

  it("filters context items by label and meta", () => {
    const items = [
      { id: "1", label: "Refund policy", meta: "billing" },
      { id: "2", label: "Shipping", description: "Delivery times" },
    ];

    expect(filterScenarioContextItems(items, "bill")).toEqual([items[0]]);
    expect(filterScenarioContextItems(items, "delivery")).toEqual([items[1]]);
  });

  it("filters audience customers and caps the result size", () => {
    const customers = Array.from({ length: 140 }, (_, index) => ({
      id: String(index),
      label: `Customer ${index}`,
      channel: index % 2 === 0 ? "telegram" : "whatsapp",
      internalLabels: index % 3 === 0 ? ["vip"] : [],
    }));

    expect(filterScenarioAudienceCustomers(customers, "")).toHaveLength(120);
    expect(
      filterScenarioAudienceCustomers(customers, "vip").length
    ).toBeLessThanOrEqual(120);
    expect(
      filterScenarioAudienceCustomers(customers, "telegram").every(
        customer => customer.channel === "telegram"
      )
    ).toBe(true);
  });

  it("returns a safe select fallback when the stored option is missing", () => {
    expect(resolveSafeScenarioOptionValue("draft", ["active", "paused"])).toBe(
      NONE_OPTION_VALUE
    );
    expect(resolveSafeScenarioOptionValue("active", ["active", "paused"])).toBe(
      "active"
    );
  });

  it("maps single-select sentinel values to array and scalar payloads", () => {
    expect(resolveScenarioSingleSelectValue(NONE_OPTION_VALUE)).toBeUndefined();
    expect(resolveScenarioSingleSelectValue("vip")).toBe("vip");
  });
});
