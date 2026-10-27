import {
  normalizeInternalLabelOptions,
  normalizeSelectStringOptions,
} from "./dialog-list-filter-options";

describe("dialog list filter options", () => {
  it("removes blank internal labels before rendering select items", () => {
    expect(
      normalizeInternalLabelOptions([
        { id: "empty", name: "" },
        { id: "blank", name: "   " },
        { id: "support", name: " Support " },
        { id: "support-duplicate", name: "support" },
        { id: "billing", name: "Billing" },
        { id: "missing", name: null },
      ])
    ).toEqual([
      { id: "support", name: "Support" },
      { id: "billing", name: "Billing" },
    ]);
  });

  it("removes blank and reserved dynamic select options", () => {
    expect(
      normalizeSelectStringOptions([
        "",
        "   ",
        " whatsapp ",
        "whatsapp",
        "all",
        null,
        "instagram",
      ])
    ).toEqual(["whatsapp", "instagram"]);
  });
});
