import { asNullableWhatsAppRecord as asRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { resolveWhatsAppFlowNextScreenId } from "@icecore/scenario-contracts";
import { decodeFlowEndpointToken } from "./endpoint-token";

function isErrorNotificationPayload(data: Record<string, unknown>): boolean {
  return (
    typeof data.error === "string" || typeof data.error_message === "string"
  );
}

function unsupportedScreenResponse(
  flowToken: string,
  error = "unsupported_flow_screen"
): {
  screen: "SUCCESS";
  data: { extension_message_response: { params: Record<string, string> } };
} {
  return {
    screen: "SUCCESS",
    data: {
      extension_message_response: {
        params: {
          flow_token: flowToken || "unknown",
          error,
        },
      },
    },
  };
}

/**
 * Turn decrypted Flow Endpoint JSON into the **plaintext** response object
 * (encrypt with encryptFlowEndpointResponse before returning to Meta).
 */
export function handleDecryptedFlowPayload(decrypted: unknown): unknown {
  const p = asRecord(decrypted);
  if (!p) {
    return { data: { status: "active" } };
  }

  const action = typeof p.action === "string" ? p.action : "";
  const flowToken = typeof p.flow_token === "string" ? p.flow_token.trim() : "";

  if (action === "ping") {
    return { data: { status: "active" } };
  }

  const dataObj = asRecord(p.data);
  if (dataObj && isErrorNotificationPayload(dataObj)) {
    return { data: { acknowledged: true } };
  }

  const token = decodeFlowEndpointToken(flowToken);
  if (!token || token.screens.length === 0) {
    return unsupportedScreenResponse(
      flowToken || "unknown",
      "unsupported_flow_token"
    );
  }

  const firstScreen = token.screens[0]!;

  if (action === "INIT" || action === "") {
    return { screen: firstScreen, data: {} };
  }

  if (action === "BACK") {
    const screen =
      typeof p.screen === "string" && p.screen.trim().length > 0
        ? p.screen.trim()
        : firstScreen;
    if (!token.screens.includes(screen)) {
      return unsupportedScreenResponse(flowToken);
    }
    return { screen, data: dataObj ?? {} };
  }

  if (action === "data_exchange") {
    const currentScreen =
      typeof p.screen === "string" && p.screen.trim().length > 0
        ? p.screen.trim()
        : firstScreen;
    const formData = dataObj ?? {};

    if (!token.screens.includes(currentScreen)) {
      return unsupportedScreenResponse(flowToken);
    }

    const allowed = token.routing[currentScreen] || [];
    if (allowed.length === 0) {
      return {
        screen: "SUCCESS",
        data: {
          extension_message_response: {
            params: {
              ...formData,
              flow_token: flowToken,
            },
          },
        },
      };
    }

    const nextId = resolveWhatsAppFlowNextScreenId(
      currentScreen,
      formData,
      token
    );
    return { screen: nextId, data: formData };
  }

  return { screen: firstScreen, data: {} };
}
