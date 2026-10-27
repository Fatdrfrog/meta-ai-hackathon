const mockSendWhatsappTemplate = jest.fn();
const mockReserveContact = jest.fn();
jest.mock("./customer-contact-policy", () => ({
  reserveCustomerMarketingContact: (...args: unknown[]) =>
    mockReserveContact(...args),
}));
const mockSendWhatsappMessage = jest.fn();
const mockSendTelegramMessage = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn();
const mockPostmarkSendEmail = jest.fn();
const mockPostmarkSendBulkEmails = jest.fn();
const mockRenderPrebuiltCampaignEmail = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();

import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
  sendWhatsappMessage: (...args: unknown[]) => mockSendWhatsappMessage(...args),
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
}));

jest.mock("@/lib/postmark", () => ({
  postmarkSendEmail: (...args: unknown[]) => mockPostmarkSendEmail(...args),
  postmarkSendBulkEmails: (...args: unknown[]) =>
    mockPostmarkSendBulkEmails(...args),
  POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY: "airi_msg_id",
}));

jest.mock("@/lib/email/templates/registry-render", () => ({
  renderPrebuiltCampaignEmail: (...args: unknown[]) =>
    mockRenderPrebuiltCampaignEmail(...args),
}));

import {
  sendCampaignTransportBatch,
  sendCampaignTransportSingle,
} from "./campaign-transport";

describe("sendCampaignTransportSingle WhatsApp routing", () => {
  it.each(["template", "service_text"] as const)(
    "applies shared consent and frequency policy before %s campaign dispatch",
    async whatsappMessageType => {
      mockReserveContact.mockResolvedValueOnce("contact_frequency_limit");
      const result = await sendCampaignTransportSingle({
        channel: "whatsapp",
        whatsappMessageType,
        recipient: { phone: "77001234567" },
        phoneNumberId: "phone",
        accessToken: "token",
        templateName: "return",
        templateCategory: "MARKETING",
        messageText: "Hello",
        contactPolicy: {
          workspaceId: "workspace",
          deliveryKey: "campaign-attempt",
        },
      } as never);
      expect(result).toMatchObject({
        success: false,
        failureScope: "recipient",
        providerCode: "contact_frequency_limit",
      });
      expect(mockReserveContact).toHaveBeenCalledTimes(1);
    }
  );
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveContact.mockReset().mockResolvedValue(null);
    mockSendWhatsappTemplate.mockImplementation(async (...args: unknown[]) => {
      await (
        args[6] as { beforeSend?: () => Promise<void> } | undefined
      )?.beforeSend?.();
      return {
        messageId: "wamid.campaign",
        date: 1711100000,
        deliveryProduct: "cloud_api",
      };
    });
    mockSendWhatsappMessage.mockImplementation(async (...args: unknown[]) => {
      await (
        args[5] as { beforeSend?: () => Promise<void> } | undefined
      )?.beforeSend?.();
      return { messageId: "wamid.service", date: 1711100000 };
    });
  });

  it("sends service text through the Cloud API text transport", async () => {
    mockSendWhatsappMessage.mockResolvedValue({
      messageId: "wamid.service",
      date: 1711100000,
    });

    const result = await sendCampaignTransportSingle({
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      messageText: "Thanks for contacting us.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        channel: "whatsapp",
        messageId: "wamid.service",
      })
    );
    expect(mockSendWhatsappMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      "15550000001",
      "Thanks for contacting us.",
      undefined,
      { beforeSend: expect.any(Function) }
    );
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("routes MARKETING templates through the Marketing Messages endpoint when enabled", async () => {
    await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      marketingMessagesEnabled: true,
      bizOpaqueCallbackData: "campaign:1",
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      "15550000001",
      "promo",
      "en",
      undefined,
      expect.objectContaining({
        deliveryProduct: "marketing_messages",
        bizOpaqueCallbackData: "campaign:1",
      })
    );
  });

  it("passes marketing message pricing through enabled Marketing Messages sends", async () => {
    await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      marketingMessagesEnabled: true,
      marketingMessagePricing: {
        perMessageBidMultiplier: 1.25,
      },
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      "15550000001",
      "promo",
      "en",
      undefined,
      expect.objectContaining({
        deliveryProduct: "marketing_messages",
        perMessageBidMultiplier: 1.25,
      })
    );
  });

  it("rejects marketing message pricing when Marketing Messages routing is unavailable", async () => {
    const result = await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      marketingMessagesEnabled: false,
      marketingMessagePricing: {
        perMessageBidMultiplier: 1.25,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/marketingMessagePricing requires/);
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("falls MARKETING templates back to Cloud API when Marketing Messages is not enabled", async () => {
    await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "promo",
      languageCode: "en",
      templateCategory: "MARKETING",
      marketingMessagesEnabled: false,
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      "15550000001",
      "promo",
      "en",
      undefined,
      expect.objectContaining({
        deliveryProduct: "cloud_api",
      })
    );
  });

  it("keeps UTILITY templates on Cloud API", async () => {
    await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "shipping_update",
      languageCode: "en",
      templateCategory: "UTILITY",
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      "15550000001",
      "shipping_update",
      "en",
      undefined,
      expect.objectContaining({
        deliveryProduct: "cloud_api",
      })
    );
  });

  it("keeps AUTHENTICATION templates on Cloud API and requires a phone recipient", async () => {
    await sendCampaignTransportSingle({
      channel: "whatsapp",
      recipient: { target: { kind: "bsuid", value: "US.123" } },
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
      templateName: "login_code",
      languageCode: "en",
      templateCategory: "AUTHENTICATION",
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "bsuid", value: "US.123" },
      "login_code",
      "en",
      undefined,
      expect.objectContaining({
        deliveryProduct: "cloud_api",
        requirePhoneRecipient: true,
      })
    );
  });

  it.each([
    [3, "provider"],
    [10, "provider"],
    [368, "provider"],
    [80007, "provider"],
    [131042, "provider"],
    [131048, "provider"],
    [131026, "recipient"],
    [131049, "recipient"],
    [17, "unknown"],
    [131000, "unknown"],
    [131051, "unknown"],
    [131058, "unknown"],
    [131060, "unknown"],
    [999999, "unknown"],
  ] as const)(
    "preserves Meta code %s with deliberately classified %s scope",
    async (code, failureScope) => {
      const metaError = {
        message: `Meta failure ${code}`,
        type: "OAuthException",
        code,
      };
      mockSendWhatsappTemplate.mockRejectedValueOnce(
        new MetaGraphRequestError({
          message: metaError.message,
          status: 400,
          statusText: "Bad Request",
          url: "https://graph.facebook.com/messages",
          details: { error: metaError },
          metaError,
        })
      );

      const result = await sendCampaignTransportSingle({
        channel: "whatsapp",
        recipient: { phone: "+15550000001" },
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        templateName: "promo",
        languageCode: "en",
        templateCategory: "MARKETING",
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          provider: "meta",
          providerCode: String(code),
          failureScope,
        })
      );
    }
  );
});

describe("sendCampaignTransportSingle Telegram routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendTelegramMessage.mockResolvedValue({
      messageId: 123,
      date: 1711100000,
    });
  });

  it("passes the source bot token to Telegram sends", async () => {
    await sendCampaignTransportSingle({
      channel: "telegram",
      recipient: { chatId: "123456" },
      messageText: "Hello",
      botToken: "telegram-source-token",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("123456", "Hello", {
      botToken: "telegram-source-token",
    });
  });

  it("passes Telegram Business connection ids to Telegram sends", async () => {
    await sendCampaignTransportSingle({
      channel: "telegram",
      recipient: { chatId: "777000" },
      messageText: "Hello",
      botToken: "telegram-source-token",
      businessConnectionId: "business-connection-1",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("777000", "Hello", {
      botToken: "telegram-source-token",
      businessConnectionId: "business-connection-1",
    });
  });
});

describe("sendCampaignTransportBatch email routing", () => {
  const originalEmailBatchFlag = process.env.AIRI_CAMPAIGN_EMAIL_BATCH_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AIRI_CAMPAIGN_EMAIL_BATCH_ENABLED = "true";
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      postmarkServerToken: "server-token",
      defaultFromAddress: "sender@example.com",
      broadcastStream: "broadcast",
      status: "active",
      mode: "manual",
    });
    mockIsManagedEmailProviderPending.mockReturnValue(false);
    mockGetWorkspaceEmailSource.mockResolvedValue(null);
    mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);
    mockRenderPrebuiltCampaignEmail.mockImplementation(
      async ({
        templateKey,
        templateModel,
      }: {
        templateKey: string;
        templateModel: Record<string, string>;
      }) => ({
        subject: `Subject ${templateModel.recipientName}`,
        html: `<p>${templateKey}:${templateModel.recipientName}</p>`,
        text: `${templateKey}:${templateModel.recipientName}`,
        templateKey,
      })
    );
    mockPostmarkSendBulkEmails.mockResolvedValue({
      ID: "bulk-request-1",
      Status: "Accepted",
      SubmittedAt: "2026-05-22T10:00:00.000Z",
    });
  });

  afterAll(() => {
    if (originalEmailBatchFlag === undefined) {
      delete process.env.AIRI_CAMPAIGN_EMAIL_BATCH_ENABLED;
    } else {
      process.env.AIRI_CAMPAIGN_EMAIL_BATCH_ENABLED = originalEmailBatchFlag;
    }
  });

  it("uses Postmark Bulk API with one shared template and per-recipient models", async () => {
    const result = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { name: "Alice" },
          },
          templateKey: "announcement",
          templateModel: { company: "Airi" },
        },
        {
          recipient: {
            email: "bob@example.com",
            variables: { name: "Bob" },
          },
          templateKey: "announcement",
          templateModel: { company: "Airi" },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.map(item => item.messageId)).toEqual([
      expect.stringMatching(/^bulk:/),
      expect.stringMatching(/^bulk:/),
    ]);
    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledTimes(1);
    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledWith({
      serverToken: "server-token",
      from: "sender@example.com",
      subject: "Subject {{recipientName}}",
      html: "<p>announcement:{{recipientName}}</p>",
      text: "announcement:{{recipientName}}",
      messageStream: "broadcast",
      messages: [
        {
          to: "alice@example.com",
          templateModel: expect.objectContaining({
            company: "Airi",
            recipientEmail: "alice@example.com",
            recipientName: "Alice",
          }),
          metadata: {
            airi_msg_id: result.results[0].messageId,
          },
        },
        {
          to: "bob@example.com",
          templateModel: expect.objectContaining({
            company: "Airi",
            recipientEmail: "bob@example.com",
            recipientName: "Bob",
          }),
          metadata: {
            airi_msg_id: result.results[1].messageId,
          },
        },
      ],
    });
  });

  it("uses custom markdown content as the shared Postmark Bulk API body", async () => {
    const result = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { recipientName: "Alice" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown:
              "Hi **{{recipientName}}**\n\n![Hero](https://cdn.airi.chat/email-campaign-assets/hero.png)\n\n[Open dashboard](https://app.airi.chat)",
          },
        },
        {
          recipient: {
            email: "bob@example.com",
            variables: { recipientName: "Bob" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown:
              "Hi **{{recipientName}}**\n\n![Hero](https://cdn.airi.chat/email-campaign-assets/hero.png)\n\n[Open dashboard](https://app.airi.chat)",
          },
        },
      ],
    } as never);

    expect(result.success).toBe(true);
    expect(mockRenderPrebuiltCampaignEmail).not.toHaveBeenCalled();
    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Hello {{recipientName}}",
        html: expect.stringContaining(
          'src="https://cdn.airi.chat/email-campaign-assets/hero.png"'
        ),
        text: expect.stringContaining("Hi {{recipientName}}"),
        messages: [
          expect.objectContaining({
            to: "alice@example.com",
            templateModel: expect.objectContaining({
              recipientName: "Alice",
            }),
          }),
          expect.objectContaining({
            to: "bob@example.com",
            templateModel: expect.objectContaining({
              recipientName: "Bob",
            }),
          }),
        ],
      })
    );
  });

  it("adds unsubscribe headers and footer when the template model has an unsubscribe URL", async () => {
    await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { recipientName: "Alice" },
          },
          templateModel: {
            unsubscribeUrl:
              "https://app.airi.chat/api/email/unsubscribe?token=token-1",
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown: "Hi {{recipientName}}",
          },
        },
      ],
    } as never);

    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Unsubscribe"),
        text: expect.stringContaining("Unsubscribe ({{unsubscribeUrl}})"),
        messages: [
          expect.objectContaining({
            templateModel: expect.objectContaining({
              unsubscribeUrl:
                "https://app.airi.chat/api/email/unsubscribe?token=token-1",
            }),
            headers: expect.objectContaining({
              "List-Unsubscribe":
                "<https://app.airi.chat/api/email/unsubscribe?token=token-1>",
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }),
          }),
        ],
      })
    );
  });

  it("uses the workspace broadcast stream for Bulk API sends", async () => {
    await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { recipientName: "Alice" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown: "Hi {{recipientName}}",
          },
          messageStream: "outbound",
        },
      ],
    } as never);

    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        messageStream: "broadcast",
      })
    );
  });

  it("splits bulk requests when optional CTA layout fields differ", async () => {
    mockRenderPrebuiltCampaignEmail.mockImplementation(
      async ({ templateModel }: { templateModel: Record<string, string> }) => {
        const hasCta = "ctaUrl" in templateModel;
        return {
          subject: hasCta ? "Subject with CTA" : "Subject without CTA",
          html: hasCta
            ? '<a href="{{ctaUrl}}">{{ctaLabel}}</a>'
            : "<p>No CTA</p>",
          text: hasCta ? "{{ctaLabel}} {{ctaUrl}}" : "No CTA",
        };
      }
    );

    await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { name: "Alice" },
          },
          templateKey: "announcement",
          templateModel: {
            ctaLabel: "Open",
            ctaUrl: "https://example.com/open",
          },
        },
        {
          recipient: {
            email: "bob@example.com",
            variables: { name: "Bob" },
          },
          templateKey: "announcement",
          templateModel: {},
        },
      ],
    });

    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledTimes(2);
    const calls = mockPostmarkSendBulkEmails.mock.calls.map(([params]) => ({
      html: params.html,
      recipient: params.messages[0]?.to,
      templateModel: params.messages[0]?.templateModel,
    }));

    expect(calls).toContainEqual(
      expect.objectContaining({
        recipient: "alice@example.com",
        html: '<a href="{{ctaUrl}}">{{ctaLabel}}</a>',
        templateModel: expect.objectContaining({
          ctaLabel: "Open",
          ctaUrl: "https://example.com/open",
        }),
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        recipient: "bob@example.com",
        html: "<p>No CTA</p>",
        templateModel: expect.not.objectContaining({
          ctaLabel: expect.anything(),
          ctaUrl: expect.anything(),
        }),
      })
    );
  });

  it("maps Postmark Bulk API recipient errors to only the affected results", async () => {
    mockPostmarkSendBulkEmails.mockResolvedValue({
      ID: "bulk-request-1",
      Status: "Accepted",
      SubmittedAt: "2026-05-22T10:00:00.000Z",
      Errors: {
        "Messages[1].To": [
          {
            ErrorCode: 300,
            Message: "Invalid 'To' address: 'bad@example'",
          },
        ],
      },
    });

    const result = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { name: "Alice" },
          },
          templateKey: "announcement",
          templateModel: {},
        },
        {
          recipient: {
            email: "bad@example",
            variables: { name: "Bad" },
          },
          templateKey: "announcement",
          templateModel: {},
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        success: true,
        recipient: "alice@example.com",
        messageId: expect.stringMatching(/^bulk:/),
      })
    );
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        success: false,
        recipient: "bad@example",
        messageId: undefined,
        error: expect.stringContaining("Invalid 'To' address"),
      })
    );
  });

  it("preserves accepted recipients when a later bulk group fails", async () => {
    mockPostmarkSendBulkEmails
      .mockResolvedValueOnce({
        ID: "bulk-request-1",
        Status: "Accepted",
        SubmittedAt: "2026-05-22T10:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("Postmark unavailable"));

    const result = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { name: "Alice" },
          },
          templateKey: "announcement",
          templateModel: {},
          subjectOverride: "Group A",
        },
        {
          recipient: {
            email: "bob@example.com",
            variables: { name: "Bob" },
          },
          templateKey: "announcement",
          templateModel: {},
          subjectOverride: "Group B",
        },
      ],
    });

    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        success: true,
        recipient: "alice@example.com",
        messageId: expect.stringMatching(/^bulk:/),
      })
    );
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        success: false,
        recipient: "bob@example.com",
        error: "Error: Postmark unavailable",
      })
    );
  });

  it("falls back to single Postmark sends when Bulk API requires approval", async () => {
    mockPostmarkSendBulkEmails.mockRejectedValue(
      new Error(
        "Postmark request failed: 422 This endpoint requires approval to access. Contact support to use the Bulk API postmarkapp.com/contact (code 14)"
      )
    );
    mockPostmarkSendEmail
      .mockResolvedValueOnce({ MessageID: "single-message-1" })
      .mockResolvedValueOnce({ MessageID: "single-message-2" });

    const result = await sendCampaignTransportBatch({
      channel: "email",
      workspaceId: "workspace-1",
      messages: [
        {
          recipient: {
            email: "alice@example.com",
            variables: { recipientName: "Alice" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown: "Hi **{{recipientName}}**",
          },
        },
        {
          recipient: {
            email: "bob@example.com",
            variables: { recipientName: "Bob" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello {{recipientName}}",
            markdown: "Hi **{{recipientName}}**",
          },
        },
      ],
    } as never);

    expect(result.success).toBe(true);
    expect(mockPostmarkSendBulkEmails).toHaveBeenCalledTimes(1);
    expect(mockPostmarkSendEmail).toHaveBeenCalledTimes(2);
    expect(mockPostmarkSendEmail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverToken: "server-token",
        from: "sender@example.com",
        to: "alice@example.com",
        subject: "Hello Alice",
        html: expect.stringContaining("<strong>Alice</strong>"),
        text: "Hi Alice",
        messageStream: "broadcast",
      })
    );
    expect(mockPostmarkSendEmail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "bob@example.com",
        subject: "Hello Bob",
        html: expect.stringContaining("<strong>Bob</strong>"),
        text: "Hi Bob",
      })
    );
    expect(result.results).toEqual([
      expect.objectContaining({
        success: true,
        recipient: "alice@example.com",
        messageId: "single-message-1",
      }),
      expect.objectContaining({
        success: true,
        recipient: "bob@example.com",
        messageId: "single-message-2",
      }),
    ]);
  });
});
