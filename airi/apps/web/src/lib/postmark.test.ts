import {
  POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY,
  postmarkSendBulkEmails,
} from "./postmark";

describe("postmarkSendBulkEmails", () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("uses a Postmark-safe campaign metadata key", () => {
    expect(
      POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY.length
    ).toBeLessThanOrEqual(20);
  });

  it("submits a shared bulk message with per-recipient template models", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ID: "bulk-request-1",
        Status: "Accepted",
        SubmittedAt: "2026-05-22T10:00:00.000Z",
      }),
    });

    const response = await postmarkSendBulkEmails({
      serverToken: "server-token",
      from: "sender@example.com",
      subject: "Hello {{recipientName}}",
      html: "<p>Hello {{recipientName}}</p>",
      text: "Hello {{recipientName}}",
      messageStream: "broadcast",
      messages: [
        {
          to: "alice@example.com",
          templateModel: { recipientName: "Alice" },
          metadata: {
            [POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY]: "bulk-correlation-1",
          },
        },
      ],
    });

    expect(response).toEqual({
      ID: "bulk-request-1",
      Status: "Accepted",
      SubmittedAt: "2026-05-22T10:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.postmarkapp.com/email/bulk",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": "server-token",
        }),
        body: JSON.stringify({
          From: "sender@example.com",
          Subject: "Hello {{recipientName}}",
          HtmlBody: "<p>Hello {{recipientName}}</p>",
          TextBody: "Hello {{recipientName}}",
          MessageStream: "broadcast",
          Messages: [
            {
              To: "alice@example.com",
              TemplateModel: { recipientName: "Alice" },
              Metadata: {
                [POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY]:
                  "bulk-correlation-1",
              },
            },
          ],
        }),
      })
    );
  });

  it("includes detailed Postmark validation errors in thrown bulk send errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          ErrorCode: 11,
          Message:
            "Multiple errors occurred. Inspect the Errors property for more information.",
          Errors: {
            "Messages[0].Metadata[0]": [
              {
                ErrorCode: 300,
                Message:
                  "Invalid metadata content. Field names are limited to 20 characters.",
              },
            ],
          },
        }),
    });

    await expect(
      postmarkSendBulkEmails({
        serverToken: "server-token",
        from: "sender@example.com",
        subject: "Hello",
        text: "Hello",
        messageStream: "broadcast",
        messages: [
          {
            to: "alice@example.com",
            metadata: {
              [POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY]: "bulk-correlation-1",
            },
          },
        ],
      })
    ).rejects.toThrow(
      "Messages[0].Metadata[0]: Invalid metadata content. Field names are limited to 20 characters."
    );
  });
});
