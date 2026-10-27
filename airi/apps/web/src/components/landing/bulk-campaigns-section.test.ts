import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";
import kz from "../../../messages/kz.json";

function leaves(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (!value || typeof value !== "object") return {};
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      leaves(child, prefix ? prefix + "." + key : key)
    )
  );
}
const namespaces = [
  "sources",
  "revenueWorkflows",
  "revenueReport",
  "faq",
  "cta",
  "footer",
] as const;
describe.each(Object.entries({ en, ru, kz }))(
  "Lower landing copy (%s)",
  (_locale, messages) => {
    it("keeps complete, nonempty translations for every section and control", () => {
      for (const namespace of namespaces) {
        const expected = leaves(en.LandingDemo[namespace]);
        const actual = leaves(messages.LandingDemo[namespace]);
        expect(Object.keys(actual).sort()).toEqual(
          Object.keys(expected).sort()
        );
        for (const value of Object.values(actual)) {
          expect(value.trim()).not.toBe("");
          expect(value).not.toMatch(/undefined|\[object Object\]/);
        }
      }
    });
    it("keeps the revenue report free of retired table rows", () => {
      expect(messages.LandingDemo.revenueReport).not.toHaveProperty("rows");
      expect(messages.LandingDemo.revenueReport).not.toHaveProperty(
        "breakdown"
      );
    });
    it("explains WhatsApp setup and separate message charges without performance guarantees", () => {
      const d = messages.LandingDemo;
      expect(d.faq.items.number.answer).toContain("Meta");
      expect(d.faq.items.cost.answer).toContain("Meta");
      expect(d.faq.items.cost.answer).toContain("airi.chat");
      expect(d.faq.items.crm.answer).toContain("CRM");
      for (const [key, value] of namespaces.flatMap(namespace =>
        Object.entries(leaves(d[namespace], namespace))
      )) {
        expect(value).not.toMatch(
          /10x|guarantee|zero bans|safe delivery|no grey schemes/i
        );
        // P90 defines the percentile of measured replies, not a promised improvement.
        if (key === "revenueReport.details.response.p90") {
          expect(value).toMatch(/90\s*%/);
        } else {
          expect(value).not.toMatch(/\d\s*%/);
        }
      }
    });
  }
);
