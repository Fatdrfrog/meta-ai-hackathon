import {
  listMarketingTemplates,
  MARKETING_TEMPLATES,
} from "./marketing-templates";

describe("marketing templates catalog", () => {
  it("lists templates and filters by category", () => {
    expect(MARKETING_TEMPLATES.length).toBeGreaterThan(3);
    expect(listMarketingTemplates("all").length).toBe(
      MARKETING_TEMPLATES.length
    );
    expect(
      listMarketingTemplates("ugc").every(item => item.category === "ugc")
    ).toBe(true);
  });
});
