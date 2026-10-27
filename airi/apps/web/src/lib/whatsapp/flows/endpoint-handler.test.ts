import { handleDecryptedFlowPayload } from "./endpoint-handler";
import { encodeFlowEndpointToken } from "./endpoint-token";

const LINEAR_FLOW_TOKEN = encodeFlowEndpointToken({
  v: 1,
  screens: ["CONTACT", "PREFERENCES", "CONFIRM"],
  routing: {
    CONTACT: ["PREFERENCES"],
    PREFERENCES: ["CONFIRM"],
    CONFIRM: [],
  },
});

describe("handleDecryptedFlowPayload", () => {
  it("carries accumulated prior answers to the next screen", () => {
    expect(
      handleDecryptedFlowPayload({
        version: "4.0",
        action: "data_exchange",
        screen: "PREFERENCES",
        data: {
          full_name: "Ada Lovelace",
          contact: {
            email: "ada@example.com",
            phone: "+441234567890",
          },
          preferred_channel: "whatsapp",
        },
        flow_token: LINEAR_FLOW_TOKEN,
      })
    ).toEqual({
      screen: "CONFIRM",
      data: {
        full_name: "Ada Lovelace",
        contact: {
          email: "ada@example.com",
          phone: "+441234567890",
        },
        preferred_channel: "whatsapp",
      },
    });
  });

  it("uses the current form value over carried state when branching", () => {
    const branchingFlowToken = encodeFlowEndpointToken({
      v: 1,
      screens: ["CONTACT", "ACCOUNT", "BUSINESS", "PERSONAL", "CONFIRM"],
      routing: {
        CONTACT: ["ACCOUNT"],
        ACCOUNT: ["BUSINESS", "PERSONAL"],
        BUSINESS: ["CONFIRM"],
        PERSONAL: ["CONFIRM"],
        CONFIRM: [],
      },
      branches: {
        ACCOUNT: {
          account_type: {
            business: "BUSINESS",
            personal: "PERSONAL",
          },
        },
      },
    });
    const contactResponse = handleDecryptedFlowPayload({
      version: "4.0",
      action: "data_exchange",
      screen: "CONTACT",
      data: {
        account_type: "personal",
        company_name: "Old Company",
        locale: "en",
      },
      flow_token: branchingFlowToken,
    }) as { data: Record<string, unknown> };

    expect(
      handleDecryptedFlowPayload({
        version: "4.0",
        action: "data_exchange",
        screen: "ACCOUNT",
        data: {
          ...contactResponse.data,
          account_type: "business",
          company_name: "Airi Labs",
        },
        flow_token: branchingFlowToken,
      })
    ).toEqual({
      screen: "BUSINESS",
      data: {
        account_type: "business",
        company_name: "Airi Labs",
        locale: "en",
      },
    });
  });

  it("returns the accumulated terminal submission without dropping arrays or objects", () => {
    expect(
      handleDecryptedFlowPayload({
        version: "4.0",
        action: "data_exchange",
        screen: "CONFIRM",
        data: {
          full_name: "Ada Lovelace",
          preferred_channels: ["whatsapp", "email"],
          address: {
            city: "London",
            coordinates: {
              latitude: 51.5072,
              longitude: -0.1276,
            },
          },
          consent: true,
          dependants: 2,
          flow_token: "stale-client-token",
        },
        flow_token: LINEAR_FLOW_TOKEN,
      })
    ).toEqual({
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: {
            flow_token: LINEAR_FLOW_TOKEN,
            full_name: "Ada Lovelace",
            preferred_channels: ["whatsapp", "email"],
            address: {
              city: "London",
              coordinates: {
                latitude: 51.5072,
                longitude: -0.1276,
              },
            },
            consent: true,
            dependants: 2,
          },
        },
      },
    });
  });

  it("preserves state on BACK and rejects unknown screens", () => {
    expect(
      handleDecryptedFlowPayload({
        version: "4.0",
        action: "BACK",
        screen: "PREFERENCES",
        data: { full_name: "Ada Lovelace", selected: ["email"] },
        flow_token: LINEAR_FLOW_TOKEN,
      })
    ).toEqual({
      screen: "PREFERENCES",
      data: { full_name: "Ada Lovelace", selected: ["email"] },
    });

    expect(
      handleDecryptedFlowPayload({
        version: "4.0",
        action: "data_exchange",
        screen: "NOT_A_SCREEN",
        data: { full_name: "Ada" },
        flow_token: LINEAR_FLOW_TOKEN,
      })
    ).toEqual({
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: {
            flow_token: LINEAR_FLOW_TOKEN,
            error: "unsupported_flow_screen",
          },
        },
      },
    });
  });
});
