import {
  classifyBulkCampaignRetryProviderCircuit,
  parseBulkCampaignRetryDispatchItem,
  parseBulkCampaignRetryDispatchItems,
} from "./bulk-campaign-retry";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

const validWhatsAppSnapshot = {
  workspaceId: WORKSPACE_ID,
  campaignId: CAMPAIGN_ID,
  channel: "whatsapp",
  sourceId: "source-1",
  recipient: { phone: "+7 (701) 000-00-01" },
  phoneNumberId: "phone-number-1",
  templateName: "july_follow_up",
  languageCode: "en",
  templateCategory: "MARKETING",
  components: [{ type: "body", parameters: [] }],
  _audience_upload: {
    original_filename: "private-ledger-metadata.csv",
  },
};

describe("bulk campaign failed snapshot parser", () => {
  it("preserves a spreadsheet phone snapshot for the SQL retry multiset proof", () => {
    const snapshot = {
      ...validWhatsAppSnapshot,
      snapshotOrdinal: 17,
      recipient: { phone: "'+77010000001", email: "person@example.com" },
    };

    expect(
      parseBulkCampaignRetryDispatchItem(snapshot, {
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        channel: "whatsapp",
        recipient: "77010000001",
        snapshotOrdinal: 17,
      })
    ).toMatchObject({
      snapshotOrdinal: 17,
      recipient: { phone: "'+77010000001", email: "person@example.com" },
    });
    expect(snapshot.recipient.phone).toBe("'+77010000001");
  });

  it.each([
    ["spreadsheet formula", '=\"77010000001\"', "77010000001"],
    ["opaque WhatsApp user ID", "KZ.77010000001", "77010000001"],
    ["embedded text", "customer-77010000001", "77010000001"],
    ["scientific notation", "7.701000001e+10", "770100000110"],
    ["national phone changing persisted identity", "87010000001", "87010000001"],
  ])("rejects %s even when digit stripping matches the ledger", (_label, phone, recipient) => {
    expect(() =>
      parseBulkCampaignRetryDispatchItem(
        { ...validWhatsAppSnapshot, recipient: { phone } },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "whatsapp",
          recipient,
        }
      )
    ).toThrow("immutable dispatch snapshot");
  });

  it("reconstructs a WhatsApp service-text snapshot without template metadata", () => {
    expect(
      parseBulkCampaignRetryDispatchItem(
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "whatsapp",
          whatsappMessageType: "service_text",
          sourceId: "source-1",
          recipient: { phone: "+7 (701) 000-00-01" },
          phoneNumberId: "phone-number-1",
          messageText: "Thanks for contacting us.",
          serviceWindowExpiresAt: "2026-07-28T09:00:00.000Z",
        },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "whatsapp",
          recipient: "77010000001",
        }
      )
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      sourceId: "source-1",
      recipient: { phone: "+7 (701) 000-00-01" },
      phoneNumberId: "phone-number-1",
      messageText: "Thanks for contacting us.",
      serviceWindowExpiresAt: "2026-07-28T09:00:00.000Z",
    });
  });

  it("reconstructs an allowlisted dispatch item and removes ledger metadata", () => {
    expect(
      parseBulkCampaignRetryDispatchItem(validWhatsAppSnapshot, {
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        channel: "whatsapp",
        recipient: "77010000001",
      })
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      channel: "whatsapp",
      sourceId: "source-1",
      recipient: { phone: "+7 (701) 000-00-01" },
      phoneNumberId: "phone-number-1",
      templateName: "july_follow_up",
      languageCode: "en",
      templateCategory: "MARKETING",
      components: [{ type: "body", parameters: [] }],
    });
  });

  it.each([
    [
      "workspace mismatch",
      {
        ...validWhatsAppSnapshot,
        workspaceId: "44444444-4444-4444-8444-444444444444",
      },
    ],
    [
      "campaign mismatch",
      {
        ...validWhatsAppSnapshot,
        campaignId: "44444444-4444-4444-8444-444444444444",
      },
    ],
    ["channel mismatch", { ...validWhatsAppSnapshot, channel: "email" }],
    [
      "missing template category",
      { ...validWhatsAppSnapshot, templateCategory: undefined },
    ],
    [
      "credential material",
      { ...validWhatsAppSnapshot, accessToken: "secret" },
    ],
    [
      "stale provider capability snapshots",
      {
        ...validWhatsAppSnapshot,
        messagingAccountId: "stale-account",
        marketingMessagesEnabled: true,
      },
    ],
    ["unknown fields", { ...validWhatsAppSnapshot, attackerMetadata: true }],
    [
      "malformed recipient",
      { ...validWhatsAppSnapshot, recipient: { phone: "" } },
    ],
  ])("fails closed on %s", (_label, snapshot) => {
    expect(() =>
      parseBulkCampaignRetryDispatchItem(snapshot, {
        workspaceId: WORKSPACE_ID,
        campaignId: CAMPAIGN_ID,
        channel: "whatsapp",
        recipient: "77010000001",
      })
    ).toThrow("immutable dispatch snapshot");
  });

  it("validates channel-specific Telegram and email snapshots", () => {
    expect(
      parseBulkCampaignRetryDispatchItem(
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "telegram",
          sourceId: "BOT-1",
          recipient: { chatId: " chat-1 " },
          messageText: "Hello",
        },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "telegram",
          recipient: "bot-1:chat-1",
        }
      )
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      channel: "telegram",
      sourceId: "BOT-1",
      recipient: { chatId: " chat-1 " },
      messageText: "Hello",
    });

    expect(
      parseBulkCampaignRetryDispatchItem(
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "email",
          recipient: {
            email: "Person@Example.com",
            variables: { firstName: "Ada" },
          },
          emailContent: {
            format: "markdown",
            subject: "Hello",
            markdown: "Welcome",
          },
        },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "email",
          recipient: "person@example.com",
        }
      )
    ).toEqual({
      workspaceId: WORKSPACE_ID,
      campaignId: CAMPAIGN_ID,
      channel: "email",
      recipient: {
        email: "Person@Example.com",
        variables: { firstName: "Ada" },
      },
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Welcome",
      },
    });
  });

  it("fails closed when embedded snapshot ordinal disagrees with the ledger ordinal", () => {
    expect(() =>
      parseBulkCampaignRetryDispatchItem(
        {
          ...validWhatsAppSnapshot,
          snapshotOrdinal: 0,
        },
        {
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          channel: "whatsapp",
          recipient: "77010000001",
          snapshotOrdinal: 1,
        }
      )
    ).toThrow("immutable dispatch snapshot");
  });

  it("fails the entire retry when one snapshot is malformed", () => {
    expect(() =>
      parseBulkCampaignRetryDispatchItems([
        {
          row: {
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp",
            recipient: "77010000001",
            snapshotOrdinal: 0,
            dispatchSnapshot: validWhatsAppSnapshot,
            providerFailure: {
              provider: "meta",
              code: "131042",
              scope: "provider",
              message: "Payment issue",
            },
          },
          expected: {
            workspaceId: WORKSPACE_ID,
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp",
          },
        },
        {
          row: {
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp",
            recipient: "77010000002",
            snapshotOrdinal: 1,
            dispatchSnapshot: {
              ...validWhatsAppSnapshot,
              recipient: { phone: "+7 701 000 00 02" },
              accessToken: "must-not-replay",
            },
            providerFailure: {
              provider: "meta",
              code: "131042",
              scope: "provider",
              message: "Payment issue",
            },
          },
          expected: {
            workspaceId: WORKSPACE_ID,
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp",
          },
        },
      ])
    ).toThrow("immutable dispatch snapshot");
  });

  it("retains repeated logical recipients with distinct immutable source ordinals", () => {
    expect(
      parseBulkCampaignRetryDispatchItems(
        [0, 1].map(snapshotOrdinal => ({
          row: {
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp" as const,
            recipient: "77010000001",
            snapshotOrdinal,
            dispatchSnapshot: {
              ...validWhatsAppSnapshot,
              snapshotOrdinal,
              generatedRecipientMessageId: `message-${snapshotOrdinal}`,
            },
            providerFailure: {
              provider: "meta",
              code: "131042",
              scope: "provider",
              message: "Payment issue",
            },
          },
          expected: {
            workspaceId: WORKSPACE_ID,
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp" as const,
          },
        }))
      )
    ).toEqual([
      expect.objectContaining({
        snapshotOrdinal: 0,
        generatedRecipientMessageId: "message-0",
        recipient: { phone: "+7 (701) 000-00-01" },
      }),
      expect.objectContaining({
        snapshotOrdinal: 1,
        generatedRecipientMessageId: "message-1",
        recipient: { phone: "+7 (701) 000-00-01" },
      }),
    ]);
  });

  it("fails closed when two retry rows claim the same source ordinal", () => {
    expect(() =>
      parseBulkCampaignRetryDispatchItems(
        ["+7 701 000 00 01", "+7 701 000 00 02"].map(phone => ({
          row: {
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp" as const,
            recipient: phone.replace(/\D/g, ""),
            snapshotOrdinal: 0,
            dispatchSnapshot: {
              ...validWhatsAppSnapshot,
              snapshotOrdinal: 0,
              recipient: { phone },
            },
            providerFailure: {
              provider: "meta",
              code: "131042",
              scope: "provider",
              message: "Payment issue",
            },
          },
          expected: {
            workspaceId: WORKSPACE_ID,
            campaignId: CAMPAIGN_ID,
            channel: "whatsapp" as const,
          },
        }))
      )
    ).toThrow("duplicate immutable dispatch snapshot");
  });
});

describe("bulk campaign retry provider circuit", () => {
  const providerFailures = [
    {
      providerFailure: {
        provider: "meta",
        code: 131042,
        scope: "provider",
        message: "Payment issue",
      },
    },
    {
      providerFailure: {
        provider: "META",
        code: "131042",
        scope: "provider",
        message: "Payment issue",
      },
    },
  ];

  it("opens for a complete intended audience with one provider signature", () => {
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 2,
        failedSnapshots: providerFailures,
        storedCircuit: {
          state: "closed",
          provider: null,
          code: null,
          openedAt: null,
        },
      })
    ).toEqual({
      state: "open",
      provider: "meta",
      code: "131042",
      failureCount: 2,
    });
  });

  it("does not ask to acknowledge recipients Meta only throttled", () => {
    const throttled = {
      providerFailure: {
        provider: "meta",
        code: 130429,
        scope: "provider",
        message: "Rate limit hit",
      },
    };
    const closedCircuit = {
      state: "closed" as const,
      provider: null,
      code: null,
      openedAt: null,
    };
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 2,
        failedSnapshots: [throttled, throttled],
        storedCircuit: closedCircuit,
      })
    ).toEqual({ state: "closed" });
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 4,
        failedSnapshots: [throttled, throttled, throttled, providerFailures[0]!],
        storedCircuit: closedCircuit,
      })
    ).toEqual({
      state: "open",
      provider: "meta",
      code: "131042",
      failureCount: 1,
    });
  });

  it.each([
    [
      "partial failures",
      {
        totalRecipients: 3,
        failedSnapshots: providerFailures,
      },
    ],
    [
      "recipient failure",
      {
        totalRecipients: 2,
        failedSnapshots: [
          providerFailures[0],
          {
            providerFailure: {
              provider: "meta",
              code: 131042,
              scope: "recipient",
              message: "Invalid recipient",
            },
          },
        ],
      },
    ],
    [
      "mixed signature",
      {
        totalRecipients: 2,
        failedSnapshots: [
          providerFailures[0],
          {
            providerFailure: {
              provider: "meta",
              code: 131026,
              scope: "provider",
              message: "Undeliverable",
            },
          },
        ],
      },
    ],
  ])(
    "requires acknowledgement for an authoritative Meta failure despite %s",
    (_label, input) => {
      expect(
        classifyBulkCampaignRetryProviderCircuit({
          ...input,
          storedCircuit: {
            state: "closed",
            provider: null,
            code: null,
            openedAt: null,
          },
        })
      ).toMatchObject({ state: "open", provider: "meta", code: "131042" });
    }
  );

  it("recognizes EduDemo's 84 restrictions among 111 recipients without a stored circuit", () => {
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 111,
        failedSnapshots: [
          ...Array.from({ length: 84 }, () => ({
            providerFailure: {
              provider: "meta",
              code: 131048,
              scope: "provider",
              message: "Spam Rate limit hit",
            },
          })),
          {
            providerFailure: {
              provider: "meta",
              code: 131049,
              scope: "recipient",
              message: "Healthy ecosystem",
            },
          },
          {
            providerFailure: {
              provider: "meta",
              code: 130472,
              scope: "recipient",
              message: "Experiment",
            },
          },
        ],
        storedCircuit: {
          state: "closed",
          provider: null,
          code: null,
          openedAt: null,
        },
      })
    ).toEqual({
      state: "open",
      provider: "meta",
      code: "131048",
      failureCount: 84,
    });
  });

  it.each([
    ["local contact cooldown", "meta", "contact_frequency_limit"],
    ["recipient failure", "meta", 131049],
    ["another provider's numeric code", "postmark", 131048],
    ["unknown Meta code", "meta", 999999],
  ])("does not infer a restriction from %s", (_label, provider, code) => {
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 111,
        failedSnapshots: [
          {
            providerFailure: {
              provider: String(provider),
              code,
              scope: "provider",
              message: "Failure",
            },
          },
        ],
        storedCircuit: {
          state: "closed",
          provider: null,
          code: null,
          openedAt: null,
        },
      })
    ).toEqual({ state: "closed" });
  });

  it("preserves complete common failures for other providers", () => {
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 2,
        failedSnapshots: Array.from({ length: 2 }, () => ({
          providerFailure: {
            provider: "postmark",
            code: "inactive_server",
            scope: "provider",
            message: "Server inactive",
          },
        })),
        storedCircuit: {
          state: "closed",
          provider: null,
          code: null,
          openedAt: null,
        },
      })
    ).toEqual({
      state: "open",
      provider: "postmark",
      code: "inactive_server",
      failureCount: 2,
    });
  });

  it.each(["contact_frequency_limit", 131049, 999999])(
    "does not turn a complete Meta audience with non-provider code %s into a restriction",
    code => {
      expect(
        classifyBulkCampaignRetryProviderCircuit({
          totalRecipients: 2,
          failedSnapshots: Array.from({ length: 2 }, () => ({
            providerFailure: {
              provider: "meta",
              code,
              scope: "provider",
              message: "Legacy scope was wrong",
            },
          })),
          storedCircuit: {
            state: "closed",
            provider: null,
            code: null,
            openedAt: null,
          },
        })
      ).toEqual({ state: "closed" });
    }
  );

  it("preserves a stored provider circuit for an interrupted campaign", () => {
    expect(
      classifyBulkCampaignRetryProviderCircuit({
        totalRecipients: 20,
        failedSnapshots: providerFailures,
        storedCircuit: {
          state: "open",
          provider: "meta",
          code: "131042",
          openedAt: "2026-07-24T09:00:00.000Z",
        },
      })
    ).toEqual({
      state: "open",
      provider: "meta",
      code: "131042",
      failureCount: 2,
    });
  });
});
