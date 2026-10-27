import crypto from "crypto";
import {
  enforceTelegramSourceWebhookSecret,
  verifyMetaSignature,
  verifyPostmarkWebhookToken,
} from "./webhook-auth";

function makeTelegramRequest(secret?: string): Request {
  return new Request("http://localhost/api/telegram/webhook/source-1", {
    method: "POST",
    headers: secret
      ? {
          "x-telegram-bot-api-secret-token": secret,
        }
      : undefined,
    body: JSON.stringify({ update_id: 1 }),
  });
}

describe("Telegram source webhook security", () => {
  it("enforces a configured per-source Telegram secret token", () => {
    expect(
      enforceTelegramSourceWebhookSecret({
        request: makeTelegramRequest("wrong-secret"),
        expectedSecret: "source-secret",
        mode: "optional",
      })
    ).toEqual({
      allowed: false,
      reasonCode: "invalid_source_secret",
    });
  });
});

describe("Postmark webhook security", () => {
  it("accepts a matching token from either the Postmark header or query string", () => {
    const headerRequest = new Request("http://localhost/api/email/inbound", {
      headers: {
        "x-postmark-token": "postmark-secret",
      },
    });
    const queryRequest = new Request(
      "http://localhost/api/email/inbound?token=postmark-secret"
    );

    expect(verifyPostmarkWebhookToken(headerRequest, "postmark-secret")).toBe(
      true
    );
    expect(verifyPostmarkWebhookToken(queryRequest, "postmark-secret")).toBe(
      true
    );
    expect(verifyPostmarkWebhookToken(headerRequest, "wrong-secret")).toBe(
      false
    );
  });
});

describe("Meta webhook security", () => {
  it("verifies the existing string body contract", () => {
    const rawBody = '{"event":"message"}';
    const digest = crypto
      .createHmac("sha256", "meta-secret")
      .update(rawBody)
      .digest("hex");

    expect(
      verifyMetaSignature(rawBody, `sha256=${digest}`, "meta-secret")
    ).toBe(true);
  });

  it("hashes exact Uint8Array bytes without a text conversion", () => {
    const rawBody = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);
    const digest = crypto
      .createHmac("sha256", "meta-secret")
      .update(rawBody)
      .digest("hex");

    expect(
      verifyMetaSignature(rawBody, `sha256=${digest}`, "meta-secret")
    ).toBe(true);
  });
});
