import { createHmac } from "node:crypto";

import { verifyPaddleWebhookSignature } from "./paddle-client";

describe("Paddle webhook signature verification", () => {
  it("accepts the HMAC SHA-256 signature for the timestamped raw payload", () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "test" });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "pdl_ntfset_secret";
    const h1 = createHmac("sha256", secret)
      .update(`${timestamp}:${body}`)
      .digest("hex");

    expect(
      verifyPaddleWebhookSignature({
        rawBody: body,
        signatureHeader: `ts=${timestamp};h1=${h1}`,
        secret,
      })
    ).toBe(true);
  });

  it("rejects mismatched signatures", () => {
    expect(
      verifyPaddleWebhookSignature({
        rawBody: "{}",
        signatureHeader: "ts=1700000000;h1=bad",
        secret: "pdl_ntfset_secret",
      })
    ).toBe(false);
  });
});
