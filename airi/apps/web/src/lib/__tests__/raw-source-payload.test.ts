import {
  RAW_SOURCE_REDACTED_VALUE,
  buildRawSourcePayload,
} from "@icecore/shared/lib/raw-source-payload";

describe("buildRawSourcePayload", () => {
  it("wraps provider payloads with recovery metadata", () => {
    const capturedAt = new Date("2026-04-29T08:13:28.000Z");

    const rawSourcePayload = buildRawSourcePayload({
      provider: "whatsapp",
      eventType: "message",
      capturedAt,
      payload: {
        messages: [
          {
            id: "wamid.1",
            type: "unsupported",
            referral: { source_id: "ad_123" },
          },
        ],
      },
    });

    expect(rawSourcePayload).toEqual({
      provider: "whatsapp",
      eventType: "message",
      capturedAt,
      payload: {
        messages: [
          {
            id: "wamid.1",
            type: "unsupported",
            referral: { source_id: "ad_123" },
          },
        ],
      },
    });
  });

  it("redacts credential-like fields recursively", () => {
    const rawSourcePayload = buildRawSourcePayload({
      provider: "web_widget",
      eventType: "message",
      payload: {
        clientKey: "public-but-secret-client-key",
        metadata: {
          pageUrl: "https://example.com/pricing",
          authorization: "Bearer secret",
        },
        nested: [{ access_token: "meta-token" }],
      },
    });

    expect(rawSourcePayload.payload).toEqual({
      clientKey: RAW_SOURCE_REDACTED_VALUE,
      metadata: {
        pageUrl: "https://example.com/pricing",
        authorization: RAW_SOURCE_REDACTED_VALUE,
      },
      nested: [{ access_token: RAW_SOURCE_REDACTED_VALUE }],
    });
  });

  it("allows source-specific extra redaction keys", () => {
    const rawSourcePayload = buildRawSourcePayload({
      provider: "email",
      eventType: "inbound",
      payload: {
        MessageID: "email-1",
        Attachments: [
          {
            Name: "invoice.pdf",
            Content: "base64-body",
            ContentType: "application/pdf",
          },
        ],
      },
      redactKeys: ["Content"],
    });

    expect(rawSourcePayload.payload).toEqual({
      MessageID: "email-1",
      Attachments: [
        {
          Name: "invoice.pdf",
          Content: RAW_SOURCE_REDACTED_VALUE,
          ContentType: "application/pdf",
        },
      ],
    });
  });
});
