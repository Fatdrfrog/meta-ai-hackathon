import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { readWhatsAppTemplateExampleValues } from "./parameter-format";

describe("readWhatsAppTemplateExampleValues", () => {
  it("reads positional body and header samples in variable order", () => {
    const components = [
      {
        type: "HEADER",
        format: "TEXT",
        text: "Order {{1}}",
        example: { header_text: ["#1024"] },
      },
      {
        type: "BODY",
        text: "Hi {{1}}, {{2}} is ready. {{1}}, see you soon.",
        example: { body_text: [["Alex", "your order"]] },
      },
    ] as WhatsAppComponent[];

    // The body's {{1}} wins: both fill the same send value.
    expect(readWhatsAppTemplateExampleValues(components)).toEqual({
      "1": "Alex",
      "2": "your order",
    });
  });

  it("reads named samples", () => {
    const components = [
      {
        type: "BODY",
        text: "Hi {{first_name}}, use {{code}}",
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Alex" },
            { param_name: "code", example: "SPRING10" },
          ],
        },
      },
    ] as WhatsAppComponent[];

    expect(readWhatsAppTemplateExampleValues(components)).toEqual({
      first_name: "Alex",
      code: "SPRING10",
    });
  });

  it("skips blank samples and media headers", () => {
    const components = [
      {
        type: "HEADER",
        format: "IMAGE",
        example: { header_handle: ["https://example.com/a.png"] },
      },
      {
        type: "BODY",
        text: "Hi {{1}} {{2}}",
        example: { body_text: [["  ", "there"]] },
      },
    ] as WhatsAppComponent[];

    expect(readWhatsAppTemplateExampleValues(components)).toEqual({
      "2": "there",
    });
    expect(readWhatsAppTemplateExampleValues(undefined)).toEqual({});
  });
});
