import { buildWhatsAppOtpTemplateComponents } from "@icecore/otp-runtime";

describe("buildWhatsAppOtpTemplateComponents", () => {
  it("builds copy-code authentication template parameters", () => {
    const components = buildWhatsAppOtpTemplateComponents("123456");

    expect(components).toEqual([
      {
        type: "body",
        parameters: [{ type: "text", text: "123456" }],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "123456" }],
      },
    ]);
  });
});
