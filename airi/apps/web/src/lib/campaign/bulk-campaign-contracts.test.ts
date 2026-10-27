import { SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE } from "@icecore/scenario-contracts";
import {
  BulkCampaignSendRequestSchema,
  MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
  parseBulkCampaignSendRequest,
  TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
  type BulkCampaignSendResponse,
} from "./bulk-campaign-contracts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const uploadEvidence = {
  originalFilename: "customers.csv",
  selectedAt: "2026-07-24T08:00:00.000Z",
};

function telegramRequest(messageText: string) {
  return {
    workspaceId,
    channel: "telegram",
    campaignName: "Telegram send",
    messageText,
    telegramSubscribersAudience: {
      type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
      sourceId: "telegram-source-1",
      previewCount: 1,
    },
  };
}

describe("BulkCampaignSendRequestSchema", () => {
  it("bounds inline recipients independently from server-resolved audiences", () => {
    const recipientsAtLimit = Array.from(
      { length: MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS },
      (_, index) => ({ phone: `+1${String(index).padStart(10, "0")}` })
    );
    const recipientsOverLimit = Array.from(
      { length: MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS + 1 },
      (_, index) => ({ phone: `+1${String(index).padStart(10, "0")}` })
    );

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        recipients: recipientsAtLimit,
      }).success
    ).toBe(true);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        recipients: recipientsOverLimit,
      }).success
    ).toBe(false);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        analyticsAudience: {
          type: "bulk_analytics",
          filters: { days: 14 },
          previewCount: MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
        },
        recipients: [],
      }).success
    ).toBe(true);
  });

  it("accepts a bounded WhatsApp service text without a template", () => {
    const result = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Thanks for contacting us.",
      recipients: [{ phone: "+10000000001" }],
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
      })
    );
  });

  it("accepts prior-failure exclusion only for WhatsApp template campaigns", () => {
    const whatsappTemplate = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+10000000001" }],
      excludePriorFailedBulkSends: true,
    });

    expect(whatsappTemplate.success).toBe(true);
    expect(whatsappTemplate.data).toEqual(
      expect.objectContaining({ excludePriorFailedBulkSends: true })
    );

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        workspaceId,
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
        recipients: [{ phone: "+10000000001" }],
        excludePriorFailedBulkSends: true,
      }).success
    ).toBe(false);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...telegramRequest("Hello"),
        excludePriorFailedBulkSends: true,
      }).success
    ).toBe(false);
  });

  it("rejects blank and oversized WhatsApp service text", () => {
    const request = {
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      recipients: [{ phone: "+10000000001" }],
    };

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...request,
        messageText: " ",
      }).success
    ).toBe(false);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...request,
        messageText: "x".repeat(4097),
      }).success
    ).toBe(false);
  });

  it("keeps WhatsApp service campaigns immediate and manual-recipient only", () => {
    const request = {
      workspaceId,
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Thanks for contacting us.",
      recipients: [{ phone: "+10000000001" }],
    };

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...request,
        scheduledAt: "2026-07-28T12:00:00.000Z",
      }).success
    ).toBe(false);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...request,
        recipients: undefined,
        analyticsAudience: {
          type: "bulk_analytics",
          filters: { days: 14 },
        },
      }).success
    ).toBe(false);
  });

  it("accepts fingerprint-bound resend confirmation and exposes only aggregate audience dispatch state", () => {
    const request = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+10000000001" }],
      audienceConfirmationFingerprint: "a".repeat(64),
      providerCircuitAcknowledged: true,
    });
    const response: BulkCampaignSendResponse = {
      campaignId: "campaign-1",
      dispatchId: "campaign-1",
      workflowId: "workflow-1",
      status: "queued",
      audience: {
        fingerprint: "b".repeat(64),
        requestedTotal: 12,
        queuedTotal: 10,
        skippedOptIn: 2,
        overlap: { intersectionCount: 10, candidateCount: 12, ratio: 10 / 12 },
      },
      audienceConfirmation: {
        required: true,
        confirmed: false,
        fingerprint: "b".repeat(64),
      },
      retry: {
        kind: "failed_only",
        providerCircuit: { state: "open", provider: "meta", code: "131000" },
      },
    };

    expect(request.success).toBe(true);
    expect(request.data?.audienceConfirmationFingerprint).toBe("a".repeat(64));
    expect(request.data?.providerCircuitAcknowledged).toBe(true);
    expect(response.audience?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(response.audience).not.toHaveProperty("recipientHashes");
    expect(response.dispatchId).toBe(response.campaignId);
  });

  it("accepts bounded filename-only upload evidence", () => {
    const request = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+10000000001" }],
      audienceUploadEvidence: {
        originalFilename: "customers.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
        replacementHistory: [
          {
            action: "replaced",
            replacedAt: "2026-07-24T07:59:00.000Z",
            previousFilename: "old.csv",
            nextFilename: "customers.csv",
          },
        ],
      },
    });

    expect(request.success).toBe(true);
    expect(request.data).toEqual(
      expect.objectContaining({
        audienceUploadEvidence: {
          originalFilename: "customers.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
          replacementHistory: [
            {
              action: "replaced",
              replacedAt: "2026-07-24T07:59:00.000Z",
              previousFilename: "old.csv",
              nextFilename: "customers.csv",
            },
          ],
        },
      })
    );
  });

  it("rejects client authority over upload hashes and uploader identity", () => {
    const request = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+10000000001" }],
      audienceUploadEvidence: {
        originalFilename: "customers.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
        uploadedBy: "forged-user",
        contentHash: "a".repeat(64),
      },
    });

    expect(request.success).toBe(false);
  });

  it("rejects empty upload evidence that would mislabel a manual audience", () => {
    const request = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      recipients: [{ phone: "+10000000001" }],
      audienceUploadEvidence: {},
    });

    expect(request.success).toBe(false);
    expect(request.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["audienceUploadEvidence"],
          message:
            "audienceUploadEvidence must include filename or selection evidence",
        }),
      ])
    );
  });

  it("rejects upload evidence when no uploaded recipient rows are present", () => {
    const request = BulkCampaignSendRequestSchema.safeParse({
      workspaceId,
      channel: "whatsapp",
      templateName: "promo",
      analyticsAudience: {
        type: "bulk_analytics",
        filters: { days: 14 },
      },
      audienceUploadEvidence: {
        originalFilename: "customers.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
      },
    });

    expect(request.success).toBe(false);
    expect(request.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["audienceUploadEvidence"],
          message:
            "audienceUploadEvidence requires uploaded recipient rows in recipients",
        }),
      ])
    );

    const canonicalAnalytics = (fillUpRecipients: Array<{ phone: string }>) =>
      BulkCampaignSendRequestSchema.safeParse({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        audience: {
          kind: "analytics_with_fill_up",
          analytics: { filters: { days: 14 } },
          fillUpRecipients,
        },
        audienceUploadEvidence: {
          originalFilename: "customers.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
        },
      });
    expect(canonicalAnalytics([]).success).toBe(false);
    // The normalized form of a flat Analytics send with uploaded fill-up rows.
    expect(canonicalAnalytics([{ phone: "+10000000001" }]).success).toBe(true);
  });

  it("rejects blank Telegram message text", () => {
    const result = BulkCampaignSendRequestSchema.safeParse(
      telegramRequest("   ")
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["messageText"],
          message: "messageText is required for Telegram campaigns",
        }),
      ])
    );
  });

  it("enforces Telegram Bot API sendMessage text limit", () => {
    expect(
      BulkCampaignSendRequestSchema.safeParse(
        telegramRequest("x".repeat(TELEGRAM_SEND_MESSAGE_TEXT_LIMIT))
      ).success
    ).toBe(true);

    const result = BulkCampaignSendRequestSchema.safeParse(
      telegramRequest("x".repeat(TELEGRAM_SEND_MESSAGE_TEXT_LIMIT + 1))
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["messageText"],
          message: `messageText must be ${TELEGRAM_SEND_MESSAGE_TEXT_LIMIT} characters or fewer for Telegram campaigns`,
        }),
      ])
    );
  });

  it("requires per-recipient templates when useColumnSplitRouting is set", () => {
    const base = {
      workspaceId,
      channel: "whatsapp",
      campaignName: "Split send",
      useColumnSplitRouting: true,
    };

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        recipients: [{ phone: "+10000000001" }],
      }).success
    ).toBe(false);

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        recipients: [
          { phone: "+10000000001", templateName: "gold_offer" },
          { phone: "+10000000002" },
        ],
      }).success
    ).toBe(false);

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        recipients: [
          { phone: "+10000000001", templateName: "gold_offer" },
          { phone: "+10000000002", templateName: "silver_offer" },
        ],
      }).success
    ).toBe(true);
  });

  it("reads per-recipient templates from a canonical inline audience when useColumnSplitRouting is set", () => {
    const base = {
      workspaceId,
      channel: "whatsapp",
      campaignName: "Split send",
      useColumnSplitRouting: true,
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "bulk-1",
        columnSplitNodeId: "split-1",
      },
    };
    const splitIssue = expect.objectContaining({
      message:
        "useColumnSplitRouting requires every recipient to include a templateName",
    });

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        audience: {
          kind: "inline",
          recipients: [
            { phone: "+10000000001", templateName: "gold_offer" },
            { phone: "+10000000002", templateName: "silver_offer" },
          ],
        },
      }).success
    ).toBe(true);

    const missingOne = BulkCampaignSendRequestSchema.safeParse({
      ...base,
      audience: {
        kind: "inline",
        recipients: [
          { phone: "+10000000001", templateName: "gold_offer" },
          { phone: "+10000000002" },
        ],
      },
    });
    expect(missingOne.success).toBe(false);
    expect(missingOne.error?.issues).toEqual(
      expect.arrayContaining([splitIssue])
    );

    const emptyInline = BulkCampaignSendRequestSchema.safeParse({
      ...base,
      audience: { kind: "inline", recipients: [] },
    });
    expect(emptyInline.success).toBe(false);
    expect(emptyInline.error?.issues).toEqual(
      expect.arrayContaining([splitIssue])
    );

    // A server-resolved audience has no uploaded rows to carry templates.
    const registeredPhones = BulkCampaignSendRequestSchema.safeParse({
      ...base,
      audience: {
        kind: "registered_business_phones",
        selectedPhones: ["+10000000001"],
      },
    });
    expect(registeredPhones.success).toBe(false);
    expect(registeredPhones.error?.issues).toEqual(
      expect.arrayContaining([splitIssue])
    );
  });

  it("accepts per-recipient templates from a canonical inline audience without a top-level template", () => {
    const base = { workspaceId, channel: "whatsapp", campaignName: "Send" };

    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        audience: {
          kind: "inline",
          recipients: [{ phone: "+10000000001", templateName: "gold_offer" }],
        },
      }).success
    ).toBe(true);
    expect(
      BulkCampaignSendRequestSchema.safeParse({
        ...base,
        audience: { kind: "inline", recipients: [{ phone: "+10000000001" }] },
      }).success
    ).toBe(false);
  });
});

describe("parseBulkCampaignSendRequest", () => {
  it.each([
    "KZ.12345678901234",
    "=77010000001",
    "client77010000001",
    "7.701E+10",
  ])(
    "rejects non-phone %s in inline and analytics fill-up audiences before admission",
    phone => {
      for (const audience of [
        { kind: "inline", recipients: [{ phone }] },
        {
          kind: "analytics_with_fill_up",
          analytics: { filters: { days: 7 } },
          fillUpRecipients: [{ phone }],
        },
      ]) {
        expect(() =>
          parseBulkCampaignSendRequest({
            workspaceId,
            channel: "whatsapp",
            templateName: "promo",
            audience,
          })
        ).toThrow(/phone/i);
      }
    }
  );

  it("keeps the picked WhatsApp source and rejects a blank one", () => {
    expect(
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        whatsappSourceId: " source-2 ",
        audience: { kind: "inline", recipients: [{ phone: "+77010000001" }] },
      }).whatsappSourceId
    ).toBe("source-2");
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        whatsappSourceId: "   ",
        audience: { kind: "inline", recipients: [{ phone: "+77010000001" }] },
      })
    ).toThrow();
  });

  it("validates spreadsheet phones without rewriting the idempotency request payload", () => {
    const phone = "'+77010000001";
    expect(
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        templateName: "promo",
        audience: { kind: "inline", recipients: [{ phone }] },
      }).audience
    ).toEqual({ kind: "inline", recipients: [{ phone }] });
  });

  it("accepts canonical inline WhatsApp service text when exclusion is disabled", () => {
    expect(
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000001" }],
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      })
    ).toMatchObject({
      audience: {
        kind: "inline",
        recipients: [{ phone: "+15550000001" }],
      },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: false,
      },
    });
  });

  it("rejects canonical scenario-run-now provenance for inline WhatsApp service text", () => {
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000001" }],
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
        provenance: {
          kind: "scenario_run_now",
          scenarioId: "scenario-1",
          rootNodeId: "bulk-root-1",
        },
      })
    ).toThrow(
      /WhatsApp service campaigns support only immediate manual recipients/
    );
  });

  it("rejects enabled exclusion for canonical inline WhatsApp service text", () => {
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000001" }],
        },
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    ).toThrow(/excludePriorFailedBulkSends/);
  });

  it("normalizes canonical and flat Analytics requests to one audience intent", () => {
    const normalized = parseBulkCampaignSendRequest({
      workspaceId,
      channel: "whatsapp",
      analyticsAudience: { type: "bulk_analytics", filters: { status: "all" } },
      recipients: [{ phone: "+15550000003" }],
      templateName: "promo",
      excludePriorFailedBulkSends: true,
    });

    expect(normalized.audience).toEqual({
      kind: "analytics_with_fill_up",
      analytics: { filters: { status: "all" } },
      fillUpRecipients: [{ phone: "+15550000003" }],
    });
    expect(normalized.recipientPolicy).toEqual({
      version: 1,
      excludePriorFailedBulkSends: true,
    });
  });

  it.each([
    [
      "flat column-split recipients",
      {
        useColumnSplitRouting: true,
        recipients: [
          { phone: "+15550000001", templateName: "gold_offer" },
          { phone: "+15550000002", templateName: "silver_offer" },
        ],
      },
    ],
    [
      "a canonical column-split audience",
      {
        useColumnSplitRouting: true,
        audience: {
          kind: "inline",
          recipients: [
            { phone: "+15550000001", templateName: "gold_offer" },
            { phone: "+15550000002", templateName: "silver_offer" },
          ],
        },
        provenance: {
          kind: "scenario_run_now",
          scenarioId: "scenario-1",
          rootNodeId: "bulk-1",
          columnSplitNodeId: "split-1",
        },
      },
    ],
    [
      "flat per-recipient templates without the split flag",
      {
        recipients: [{ phone: "+15550000001", templateName: "gold_offer" }],
      },
    ],
    [
      "flat uploaded recipients with upload evidence",
      {
        templateName: "promo",
        recipients: [{ phone: "+15550000001" }],
        audienceUploadEvidence: uploadEvidence,
      },
    ],
    [
      "a canonical inline audience with upload evidence",
      {
        templateName: "promo",
        audience: {
          kind: "inline",
          recipients: [{ phone: "+15550000001" }],
          uploadEvidence,
        },
      },
    ],
    [
      "a flat Analytics audience with uploaded fill-up rows and upload evidence",
      {
        templateName: "promo",
        analyticsAudience: {
          type: "bulk_analytics",
          filters: { days: 14 },
          previewCount: 3,
        },
        recipients: [{ phone: "+15550000003" }],
        audienceUploadEvidence: uploadEvidence,
      },
    ],
    [
      "a canonical Analytics audience with fill-up rows",
      {
        templateName: "promo",
        audience: {
          kind: "analytics_with_fill_up",
          analytics: { filters: { days: 14 } },
          fillUpRecipients: [{ phone: "+15550000003" }],
        },
      },
    ],
    [
      "a flat registered business phones audience",
      {
        templateName: "promo",
        registeredBusinessPhonesAudience: {
          type: "registered_business_phones",
          selectedPhones: ["+15550000004"],
        },
      },
    ],
    [
      "a flat Telegram subscribers audience",
      {
        channel: "telegram",
        messageText: "Hello",
        telegramSubscribersAudience: {
          type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
          sourceId: "telegram-source-1",
        },
      },
    ],
    [
      "a flat registered users Email audience",
      {
        channel: "email",
        emailContent: { format: "markdown", subject: "Hi", markdown: "Hello" },
        registeredUsersAudience: {
          type: "registered_users",
          selectedUserIds: ["user-1"],
        },
      },
    ],
    [
      "WhatsApp service text to uploaded recipients",
      {
        whatsappMessageType: "service_text",
        messageText: "Thanks for contacting us.",
        recipients: [{ phone: "+15550000001" }],
      },
    ],
    [
      "flat prior-failure exclusion and scenario run-now provenance",
      {
        templateName: "promo",
        recipients: [{ phone: "+15550000001" }],
        excludePriorFailedBulkSends: true,
        provenance: {
          kind: "scenario_run_now",
          scenarioId: "scenario-1",
          rootNodeId: "bulk-1",
          actionNodeId: "action-1",
        },
      },
    ],
  ])(
    "parses the normalized body again for %s, as the server does",
    (_label, request) => {
      // The client posts the normalized body; the server parses it again and
      // must arrive at the same request.
      const posted = JSON.parse(
        JSON.stringify(
          parseBulkCampaignSendRequest({
            workspaceId,
            channel: "whatsapp",
            ...request,
          })
        )
      );

      expect(posted).not.toHaveProperty("recipients");
      expect(parseBulkCampaignSendRequest(posted)).toEqual(posted);
    }
  );

  it("rejects canonical plus legacy audience ambiguity", () => {
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
        registeredBusinessPhonesAudience: {
          type: "registered_business_phones",
          selectedPhones: ["+15550000002"],
        },
        templateName: "promo",
      })
    ).toThrow(/Only one audience intent can be selected/);
  });

  it("rejects browser scenario_schedule provenance", () => {
    expect(() =>
      parseBulkCampaignSendRequest({
        workspaceId,
        channel: "whatsapp",
        audience: { kind: "inline", recipients: [{ phone: "+15550000001" }] },
        provenance: { kind: "scenario_schedule", scenarioId: "scenario-1" },
        templateName: "promo",
      })
    ).toThrow();
  });
});
