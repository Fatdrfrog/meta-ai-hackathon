import { normalizeAiriWhatsAppTemplateDraft } from "./whatsapp-template-drafts";

function buttons(value: Record<string, unknown>) {
  return normalizeAiriWhatsAppTemplateDraft({
    name: "shop",
    components: [
      { type: "BODY", text: "Visit our shop" },
      { type: "BUTTONS", buttons: [value] },
    ],
  })?.components.find(component => component.type === "BUTTONS");
}

describe("generated template button types", () => {
  it.each([undefined, "link", "url"])(
    "preserves a URL when the generated type is %s",
    type => {
      expect(
        buttons({ type, text: "Shop", url: "https://example.com/shop" })
      ).toEqual({
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Shop", url: "https://example.com/shop" },
        ],
      });
    }
  );
  it("does not silently turn an unsupported action into a reply", () => {
    expect(
      buttons({ type: "unsupported_action", text: "Open" })
    ).toBeUndefined();
  });
  it("keeps explicit quick replies and plain button drafts", () => {
    for (const type of ["QUICK_REPLY", undefined]) {
      expect(buttons({ type, text: "Back" })).toEqual({
        type: "BUTTONS",
        buttons: [{ type: "QUICK_REPLY", text: "Back" }],
      });
    }
  });
});

describe("generated template variable samples", () => {
  function textComponents(header: string, body: string) {
    return normalizeAiriWhatsAppTemplateDraft({
      name: "order_ready",
      components: [
        { type: "HEADER", format: "TEXT", text: header },
        { type: "BODY", text: body },
      ],
    })?.components;
  }

  it("writes named samples for named variables", () => {
    expect(
      textComponents(
        "Order {{order_id}}",
        "Hi {{first_name}}, order {{order_id}} is ready."
      )
    ).toEqual([
      {
        type: "HEADER",
        format: "TEXT",
        text: "Order {{order_id}}",
        example: {
          header_text_named_params: [
            { param_name: "order_id", example: "order_id_example" },
          ],
        },
      },
      {
        type: "BODY",
        text: "Hi {{first_name}}, order {{order_id}} is ready.",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "first_name_example" },
            { param_name: "order_id", example: "order_id_example" },
          ],
        },
      },
    ]);
  });

  it("keeps positional samples for numbered variables", () => {
    expect(
      textComponents("Order {{1}}", "Hi {{1}}, order {{2}} is ready.")
    ).toEqual([
      {
        type: "HEADER",
        format: "TEXT",
        text: "Order {{1}}",
        example: { header_text: ["1_example"] },
      },
      {
        type: "BODY",
        text: "Hi {{1}}, order {{2}} is ready.",
        example: { body_text: [["1_example", "2_example"]] },
      },
    ]);
  });
});
