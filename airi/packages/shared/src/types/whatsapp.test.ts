import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTemplatePreview, type WhatsAppTemplate } from "./whatsapp";

function template(
  components: WhatsAppTemplate["components"]
): WhatsAppTemplate {
  return {
    name: "promo_carousel",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    components,
  };
}

describe("getTemplatePreview", () => {
  it("includes carousel card body text when the template has no BODY", () => {
    assert.equal(
      getTemplatePreview(
        template([
          {
            type: "CAROUSEL",
            cards: [
              {
                components: [
                  { type: "HEADER", format: "IMAGE" },
                  { type: "BODY", text: "First card" },
                ],
              },
              {
                components: [
                  { type: "HEADER", format: "IMAGE" },
                  { type: "BODY", text: "Second card" },
                ],
              },
            ],
          },
        ])
      ),
      "First card Second card"
    );
  });

  it("joins the BODY copy with carousel card bodies", () => {
    assert.equal(
      getTemplatePreview(
        template([
          { type: "BODY", text: "Pick a card" },
          {
            type: "CAROUSEL",
            cards: [
              {
                components: [{ type: "BODY", text: "Red" }],
              },
            ],
          },
        ])
      ),
      "Pick a card Red"
    );
  });
});
