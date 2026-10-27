export type WhatsAppOtpTemplateSendComponent = {
  type: "body" | "button";
  sub_type?: "url";
  index?: string;
  parameters: Array<{ type: "text"; text: string }>;
};

export function buildWhatsAppOtpTemplateComponents(
  code: string,
  buttonIndex = 0
): WhatsAppOtpTemplateSendComponent[] {
  return [
    {
      type: "body",
      parameters: [{ type: "text", text: code }],
    },
    {
      type: "button",
      sub_type: "url",
      index: String(buttonIndex),
      parameters: [{ type: "text", text: code }],
    },
  ];
}
