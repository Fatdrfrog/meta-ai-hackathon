import type { WhatsAppMessage } from "./webhook-payload";
import { asNullableWhatsAppRecord, compactWhatsAppString } from "./value-utils";

export type NormalizedWhatsAppFlowReply = {
  flowName: string;
  flowToken: string | null;
  body: string | null;
  responseJson: string | null;
};

export function normalizeWhatsAppFlowReply(
  message: Pick<WhatsAppMessage, "type" | "interactive">,
): NormalizedWhatsAppFlowReply | null {
  if (
    message.type !== "interactive" ||
    message.interactive?.type !== "nfm_reply" ||
    !message.interactive.nfm_reply
  ) {
    return null;
  }

  const reply = message.interactive.nfm_reply;
  const responseJson =
    typeof reply.response_json === "string" ? reply.response_json : null;
  let response = null;
  if (responseJson !== null) {
    try {
      response = asNullableWhatsAppRecord(JSON.parse(responseJson) as unknown);
    } catch {
      response = null;
    }
  }

  return {
    flowName: reply.name || "flow",
    flowToken: compactWhatsAppString(response?.flow_token),
    body: reply.body || null,
    responseJson,
  };
}
