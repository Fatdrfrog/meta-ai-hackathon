import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppMessage } from "./webhook-payload";
import { normalizeWhatsAppFlowReply } from "./flow-reply";

function buildFlowReply(
  responseJson: string,
): Pick<WhatsAppMessage, "type" | "interactive"> {
  return {
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: responseJson,
      },
    },
  };
}

test("preserves malformed and non-object Flow response JSON without throwing", () => {
  for (const responseJson of ["{", "null", "[]", '"value"']) {
    let normalized: ReturnType<typeof normalizeWhatsAppFlowReply>;

    assert.doesNotThrow(() => {
      normalized = normalizeWhatsAppFlowReply(buildFlowReply(responseJson));
    });
    assert.deepEqual(normalized!, {
      flowName: "flow",
      flowToken: null,
      body: "Sent",
      responseJson,
    });
  }
});
