import { redactWhatsAppTemplatePayload } from "./send-payload";

it("masks recipients, nested customer parameters and opaque callbacks in template diagnostics", () => {
  const payload = {
    messaging_product: "whatsapp",
    to: "77001234567",
    type: "template",
    biz_opaque_callback_data: "customer-private-callback",
    template: {
      name: "demo",
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Customer Name customer@company.com" },
          ],
        },
        {
          type: "carousel",
          cards: [
            {
              components: [
                {
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      image: { link: "https://private.example/customer.png" },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "button",
          parameters: [
            {
              type: "action",
              action: {
                flow_token: "private-flow-token",
                flow_action_data: { email: "private@company.com" },
              },
            },
          ],
        },
      ],
    },
  };
  const redacted = redactWhatsAppTemplatePayload(payload);
  const serialized = JSON.stringify(redacted);
  for (const value of [
    "77001234567",
    "Customer Name",
    "customer@company.com",
    "private.example",
    "private-flow-token",
    "private@company.com",
    "customer-private-callback",
  ])
    expect(serialized).not.toContain(value);
  expect(redacted).toMatchObject({
    template: { name: "demo", language: { code: "en" } },
  });
  expect(payload.to).toBe("77001234567");
});
