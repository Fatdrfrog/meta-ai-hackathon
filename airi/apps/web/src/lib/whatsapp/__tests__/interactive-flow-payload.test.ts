import {
  DEFAULT_FLOW_BODY_TEXT,
  DEFAULT_FLOW_CTA_TEXT,
} from "@/lib/scenarios/normalization";
import {
  buildWhatsAppInteractiveFlowPayload,
  normalizeWhatsAppFlowActionPayload,
} from "../interactive-flow-payload";

jest.mock("@/lib/whatsapp-format", () => ({
  htmlToWhatsAppFormat: (value: string) => value,
}));

describe("normalizeWhatsAppFlowActionPayload", () => {
  it("omits empty navigate payloads", () => {
    expect(normalizeWhatsAppFlowActionPayload("navigate", {})).toBeUndefined();
  });

  it("keeps navigate payload screen and non-empty data", () => {
    expect(
      normalizeWhatsAppFlowActionPayload("navigate", {
        screen: "FIRST_ENTRY_SCREEN",
        data: { product_name: "name" },
      })
    ).toEqual({
      screen: "FIRST_ENTRY_SCREEN",
      data: { product_name: "name" },
    });
  });

  it("omits payloads for data_exchange", () => {
    expect(
      normalizeWhatsAppFlowActionPayload("data_exchange", {
        screen: "FIRST_ENTRY_SCREEN",
        data: { product_name: "name" },
      })
    ).toBeUndefined();
  });
});

describe("buildWhatsAppInteractiveFlowPayload", () => {
  it("does not send flow_action_payload for default navigate messages", () => {
    const payload = buildWhatsAppInteractiveFlowPayload({
      flowId: "1721813952122675",
      flowToken: "flow_token",
    });

    expect(payload).toEqual({
      type: "flow",
      body: { text: DEFAULT_FLOW_BODY_TEXT },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: "flow_token",
          flow_id: "1721813952122675",
          flow_cta: DEFAULT_FLOW_CTA_TEXT,
          flow_action: "navigate",
        },
      },
    });
  });

  it("includes flow_action_payload only when navigate payload is meaningful", () => {
    const payload = buildWhatsAppInteractiveFlowPayload({
      flowId: "1721813952122675",
      flowToken: "flow_token",
      flowActionType: "navigate",
      flowActionPayload: {
        screen: "FIRST_ENTRY_SCREEN",
        data: { product_name: "name" },
      },
      flowCta: "Choose product",
      bodyText: "Please choose",
    });

    expect(payload).toEqual({
      type: "flow",
      body: { text: "Please choose" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: "flow_token",
          flow_id: "1721813952122675",
          flow_cta: "Choose product",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "FIRST_ENTRY_SCREEN",
            data: { product_name: "name" },
          },
        },
      },
    });
  });

  it("sends flow_name when no flow_id is provided", () => {
    const payload = buildWhatsAppInteractiveFlowPayload({
      flowName: "appointment_booking_v1",
      flowToken: "flow_token",
    });

    expect(payload).toMatchObject({
      action: {
        parameters: {
          flow_message_version: "3",
          flow_name: "appointment_booking_v1",
        },
      },
    });
    expect(
      (payload as { action: { parameters: Record<string, unknown> } }).action
        .parameters.flow_id
    ).toBeUndefined();
  });

  it("includes draft mode only when requested", () => {
    const payload = buildWhatsAppInteractiveFlowPayload({
      flowId: "1721813952122675",
      flowToken: "flow_token",
      mode: "draft",
    });

    expect(payload).toMatchObject({
      action: {
        parameters: {
          mode: "draft",
        },
      },
    });
  });
});
