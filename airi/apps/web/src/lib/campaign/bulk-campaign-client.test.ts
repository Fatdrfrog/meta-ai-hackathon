import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  BulkCampaignRequestError,
  BulkCampaignSendError,
  buildBulkCampaignBatchPlanUrl,
  buildBulkAnalyticsVariableConfigs,
  buildBulkCampaignAudienceIntent,
  buildBulkCampaignSendRequest,
  bulkCampaignJsonFetcher,
  formatMissingCampaignVariablesMessage,
  postBulkCampaignSend,
  prepareCampaignRecipientsForTemplate,
} from "./bulk-campaign-client";
import { MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES } from "./bulk-campaign-contracts";

describe("bulk campaign client helpers", () => {
  it("scopes WhatsApp readiness checks to the selected source", () => {
    const url = new URL(
      buildBulkCampaignBatchPlanUrl({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        sourceId: "source-selected",
      }),
      "https://example.test"
    );
    expect(url.searchParams.get("sourceId")).toBe("source-selected");
    expect(url.searchParams.get("workspaceId")).toBe("workspace-1");
  });

  it("builds a WhatsApp service text request without template fields", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Thanks for contacting us.",
      recipients: [{ phone: "+77001234567" }],
    });

    expect(request).toEqual({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      whatsappMessageType: "service_text",
      messageText: "Thanks for contacting us.",
      recipients: [{ phone: "+77001234567" }],
    });
  });

  it("sends the WhatsApp number picked on the page", () => {
    expect(
      buildBulkCampaignSendRequest({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        whatsappSourceId: " source-2 ",
        messageText: "Hi",
        recipients: [{ phone: "+77001234567" }],
      })
    ).toMatchObject({ whatsappSourceId: "source-2" });
    expect(
      buildBulkCampaignSendRequest({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        whatsappMessageType: "service_text",
        whatsappSourceId: "  ",
        messageText: "Hi",
        recipients: [{ phone: "+77001234567" }],
      })
    ).not.toHaveProperty("whatsappSourceId");
  });

  it("prepares template variables for uploaded recipients and reports missing values", () => {
    const result = prepareCampaignRecipientsForTemplate({
      recipients: [
        {
          phone: "+77001234567",
          name: "Aibek",
          fields: { city: "Almaty" },
        },
        {
          phone: "+77007654321",
          fields: { city: "" },
        },
      ],
      templateVariables: ["name", "city"],
      variableConfigs: {
        name: { mode: "contact_name" },
        city: { mode: "csv_column", csvColumn: "city" },
      },
    });

    expect(result.recipients).toEqual([
      {
        phone: "+77001234567",
        name: "Aibek",
        fields: { city: "Almaty" },
        variables: { name: "Aibek", city: "Almaty" },
      },
      {
        phone: "+77007654321",
        fields: { city: "" },
        variables: undefined,
      },
    ]);
    expect(result.unresolved).toEqual([
      {
        label: "+77007654321",
        missingVariables: ["name", "city"],
      },
    ]);
  });

  it("builds a scenario WhatsApp bulk send request with scheduling metadata", () => {
    const components: WhatsAppComponent[] = [
      { type: "BODY", text: "Hi {{name}}" },
    ];

    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      campaignName: "VIP Reactivation",
      idempotencyKey: "idem-12345678",
      recipients: [{ phone: "+77001234567", variables: { name: "Aibek" } }],
      whatsappTemplate: {
        name: "vip_offer",
        language: "en",
        category: "MARKETING",
        components,
      },
      scenario: {
        scenarioId: "scenario-1",
        scenarioNodeId: "action-1",
        executionSource: "scenario_run_now",
      },
      scheduledAt: "2099-05-15T10:00:00.000Z",
    });

    expect(request).toMatchObject({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      campaignName: "VIP Reactivation",
      scenarioId: "scenario-1",
      scenarioNodeId: "action-1",
      executionSource: "scenario_run_now",
      scheduledAt: "2099-05-15T10:00:00.000Z",
      idempotencyKey: "idem-12345678",
      templateName: "vip_offer",
      languageCode: "en",
      templateCategory: "MARKETING",
      templateComponents: components,
      recipients: [{ phone: "+77001234567", variables: { name: "Aibek" } }],
    });
  });

  it("forwards opt-in prior-failure exclusion for WhatsApp templates", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      recipients: [{ phone: "+77001234567" }],
      whatsappTemplate: {
        name: "vip_offer",
        category: "MARKETING",
      },
      excludePriorFailedBulkSends: true,
    });

    expect(request).toEqual(
      expect.objectContaining({ excludePriorFailedBulkSends: true })
    );
  });

  it("forwards resend confirmation and upload filename evidence", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      recipients: [{ phone: "+77001234567" }],
      whatsappTemplate: {
        name: "vip_offer",
        category: "MARKETING",
      },
      audienceConfirmationFingerprint: "a".repeat(64),
      overflowQueueConfirmed: true,
      providerCircuitAcknowledged: true,
      audienceUploadEvidence: {
        originalFilename: "vip.csv",
        selectedAt: "2026-07-24T08:00:00.000Z",
        replacementHistory: [
          {
            action: "replaced",
            replacedAt: "2026-07-24T07:59:00.000Z",
            previousFilename: "old.csv",
            nextFilename: "vip.csv",
          },
        ],
      },
    } as Parameters<typeof buildBulkCampaignSendRequest>[0] & {
      audienceConfirmationFingerprint: string;
      overflowQueueConfirmed: boolean;
      providerCircuitAcknowledged: boolean;
      audienceUploadEvidence: {
        originalFilename: string;
        selectedAt: string;
        replacementHistory: Array<{
          action: "replaced";
          replacedAt: string;
          previousFilename: string;
          nextFilename: string;
        }>;
      };
    });

    expect(request).toEqual(
      expect.objectContaining({
        audienceConfirmationFingerprint: "a".repeat(64),
        overflowQueueConfirmed: true,
        providerCircuitAcknowledged: true,
        audienceUploadEvidence: {
          originalFilename: "vip.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
          replacementHistory: [
            {
              action: "replaced",
              replacedAt: "2026-07-24T07:59:00.000Z",
              previousFilename: "old.csv",
              nextFilename: "vip.csv",
            },
          ],
        },
      })
    );
  });

  it("exposes stable overlap error metadata to send-again UX", async () => {
    const payload = {
      code: "bulk_campaign_recent_audience_confirmation_required",
      error: "Confirm sending to this recent audience again.",
      audience: {
        fingerprint: "b".repeat(64),
        requestedTotal: 12,
        queuedTotal: 10,
        skippedOptIn: 2,
        overlap: {
          kind: "high",
          intersectionCount: 10,
          candidateCount: 10,
          ratio: 1,
        },
      },
      audienceConfirmation: {
        required: true,
        confirmed: false,
        fingerprint: "b".repeat(64),
      },
    };
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => payload,
    })) as unknown as typeof fetch;

    await expect(
      postBulkCampaignSend(
        {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          channel: "whatsapp",
          templateName: "promo",
          recipients: [{ phone: "+77001234567" }],
        },
        fetchImpl
      )
    ).rejects.toMatchObject<Partial<BulkCampaignSendError>>({
      name: "BulkCampaignSendError",
      status: 409,
      code: "bulk_campaign_recent_audience_confirmation_required",
      audienceFingerprint: "b".repeat(64),
      confirmationRequired: true,
    });
  });

  it("refuses legacy scenario fields the route's second parse would reject, before calling it", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const request = buildBulkCampaignSendRequest({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp",
      recipients: [{ phone: "+77001234567" }],
      whatsappTemplate: { name: "vip_offer", language: "en" },
      scenario: {
        scenarioId: "scenario-1",
        scenarioNodeId: "action-1",
        executionSource: "scenario_run_now",
      },
    });

    await expect(postBulkCampaignSend(request, fetchImpl)).rejects.toThrow(
      "Scenario bulk sends need provenance (scenarioId and rootNodeId), not the legacy scenarioId and scenarioNodeId fields"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 inline payloads before calling the send route", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;

    await expect(
      postBulkCampaignSend(
        {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          channel: "whatsapp",
          templateName: "promo",
          recipients: [
            {
              phone: "+77001234567",
              name: "🙂".repeat(MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES / 4),
            },
          ],
        },
        fetchImpl
      )
    ).rejects.toMatchObject<Partial<BulkCampaignSendError>>({
      name: "BulkCampaignSendError",
      status: 413,
      code: "bulk_campaign_inline_payload_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds a custom markdown email bulk send request without requiring a prebuilt template", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "email",
      campaignName: "Registered users update",
      recipients: [{ email: "aibek@example.com" }],
      email: {
        content: {
          format: "markdown",
          subject: "Hello {{recipientName}}",
          markdown: "Hi {{recipientName}}",
        },
      },
    });

    expect(request).toMatchObject({
      workspaceId: "workspace-1",
      channel: "email",
      campaignName: "Registered users update",
      recipients: [{ email: "aibek@example.com" }],
      emailContent: {
        format: "markdown",
        subject: "Hello {{recipientName}}",
        markdown: "Hi {{recipientName}}",
      },
    });
    expect(request.templateKey).toBeUndefined();
  });

  it("includes localized custom email content when provided", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "email",
      campaignName: "Localized update",
      recipients: [{ email: "aibek@example.com", variables: { locale: "ru" } }],
      email: {
        content: {
          format: "markdown",
          subject: "Hello",
          markdown: "Hi {{recipientName}}",
        },
        contentByLocale: {
          ru: {
            format: "markdown",
            subject: "Привет",
            markdown: "Здравствуйте, {{recipientName}}",
          },
        },
      },
    });

    expect(request).toMatchObject({
      workspaceId: "workspace-1",
      channel: "email",
      campaignName: "Localized update",
      emailContent: {
        format: "markdown",
        subject: "Hello",
        markdown: "Hi {{recipientName}}",
      },
      emailContentByLocale: {
        ru: {
          format: "markdown",
          subject: "Привет",
          markdown: "Здравствуйте, {{recipientName}}",
        },
      },
    });
  });

  it("normalizes analytics variable configs to the API-supported modes", () => {
    const result = buildBulkAnalyticsVariableConfigs({
      templateVariables: ["name", "coupon", "city", "phone"],
      variableConfigs: {
        name: { mode: "contact_name" },
        coupon: { mode: "custom", customValue: " SAVE20 " },
        city: { mode: "csv_column", csvColumn: "city" },
        phone: { mode: "recipient_phone" },
      },
    });

    expect(result).toEqual({
      variableConfigs: {
        name: { mode: "contact_name" },
        coupon: { mode: "custom", customValue: "SAVE20" },
        phone: { mode: "recipient_phone" },
      },
      missingCustomVariables: [],
    });
  });

  it("reports analytics custom variables that do not have values", () => {
    const result = buildBulkAnalyticsVariableConfigs({
      templateVariables: ["coupon"],
      variableConfigs: {
        coupon: { mode: "custom", customValue: " " },
      },
    });

    expect(result).toEqual({
      variableConfigs: {},
      missingCustomVariables: ["coupon"],
    });
  });

  it("builds canonical audience, recipient policy, and provenance objects", () => {
    const request = buildBulkCampaignSendRequest({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      audience: {
        kind: "inline",
        recipients: [{ phone: "+77001234567" }],
      },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "bulk-root-1",
        actionNodeId: "action-1",
      },
      whatsappTemplate: { name: "vip_offer", category: "MARKETING" },
    });

    expect(request).toMatchObject({
      audience: {
        kind: "inline",
        recipients: [{ phone: "+77001234567" }],
      },
      recipientPolicy: {
        version: 1,
        excludePriorFailedBulkSends: true,
      },
      provenance: {
        kind: "scenario_run_now",
        scenarioId: "scenario-1",
        rootNodeId: "bulk-root-1",
        actionNodeId: "action-1",
      },
    });
  });

  it("parses canonical and legacy bulk campaign successes", async () => {
    const canonicalFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        outcome: {
          disposition: "queued",
          evaluatedAt: "2026-08-21T00:00:00.000Z",
          lifecycleStatus: "queued",
          requestedTotal: 1,
          acceptedTotal: 1,
          queuedTotal: 1,
          uniqueRecipients: { requested: 1, accepted: 1, queued: 1 },
          skippedByReason: {},
          warnings: { missingMarketingConsent: 0 },
        },
      }),
    })) as unknown as typeof fetch;
    const legacyFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ queued: true, total: 1, status: "queued" }),
    })) as unknown as typeof fetch;
    const request = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp" as const,
      templateName: "promo",
      recipients: [{ phone: "+77001234567" }],
    };

    await expect(
      postBulkCampaignSend(request, canonicalFetch)
    ).resolves.toMatchObject({
      ok: true,
      outcome: { disposition: "queued" },
      queued: true,
    });
    await expect(
      postBulkCampaignSend(request, legacyFetch)
    ).resolves.toMatchObject({
      ok: true,
      outcome: { disposition: "queued", requestedTotal: 1 },
      queued: true,
    });
  });

  it("preserves scheduled queued and total compatibility aliases", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        scheduled: true,
        total: 2,
        requestedTotal: 3,
        skippedPriorFailed: 1,
        status: "scheduled",
      }),
    })) as unknown as typeof fetch;

    await expect(
      postBulkCampaignSend(
        {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          channel: "whatsapp",
          templateName: "promo",
          recipients: [{ phone: "+77001234567" }],
        },
        fetchImpl
      )
    ).resolves.toMatchObject({
      ok: true,
      queued: true,
      scheduled: true,
      total: 2,
    });
  });

  it.each([
    {
      name: "WhatsApp service text",
      request: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        channel: "whatsapp" as const,
        whatsappMessageType: "service_text" as const,
        messageText: "Service update",
        recipients: [{ phone: "+77001234567" }],
      },
      reason: "service_window" as const,
      alias: "skippedServiceWindow",
    },
    {
      name: "Telegram",
      request: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        channel: "telegram" as const,
        messageText: "Telegram update",
        recipients: [{ chatId: "123456" }],
      },
      reason: "ineligible" as const,
      alias: "skippedIneligible",
    },
    {
      name: "email",
      request: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        channel: "email" as const,
        recipients: [{ email: "person@example.com" }],
        emailContent: {
          format: "markdown" as const,
          subject: "Email update",
          markdown: "Hello",
        },
      },
      reason: "unsubscribed" as const,
      alias: "skippedUnsubscribed",
    },
  ])(
    "parses one truthful canonical $name outcome and derives matching flat aliases",
    async ({ request, reason, alias }) => {
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          outcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-21T10:00:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 3,
            acceptedTotal: 2,
            queuedTotal: 2,
            uniqueRecipients: { requested: 3, accepted: 2, queued: 2 },
            skippedByReason: { [reason]: 1 },
            warnings: { missingMarketingConsent: 0 },
            campaignId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            dispatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            workflowId: "bulk-campaign-dispatch:test",
          },
        }),
      })) as unknown as typeof fetch;

      const result = await postBulkCampaignSend(request, fetchImpl);

      expect(result.outcome).toMatchObject({
        requestedTotal: 3,
        acceptedTotal: 2,
        queuedTotal: 2,
        skippedByReason: { [reason]: 1 },
      });
      expect(result).toMatchObject({
        requestedTotal: 3,
        successful: 2,
        total: 2,
        skippedRecipientCount: 1,
        [alias]: 1,
      });
    }
  );

  it("rejects malformed 2xx responses and attaches parsed command errors", async () => {
    const malformedFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ queued: true, total: "one" }),
    })) as unknown as typeof fetch;
    const blockedFetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: "confirmation_required", error: "Confirm" }),
    })) as unknown as typeof fetch;
    const request = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp" as const,
      templateName: "promo",
      recipients: [{ phone: "+77001234567" }],
    };

    await expect(
      postBulkCampaignSend(request, malformedFetch)
    ).rejects.toMatchObject({
      name: "BulkCampaignSendError",
      status: 200,
      code: "bulk_campaign_malformed_response",
    });
    await expect(
      postBulkCampaignSend(request, blockedFetch)
    ).rejects.toMatchObject({
      name: "BulkCampaignSendError",
      status: 409,
      result: {
        ok: false,
        disposition: "blocked",
        code: "confirmation_required",
      },
    });
  });
});

describe("formatMissingCampaignVariablesMessage", () => {
  const copy = {
    summary: (count: number) => `summary:${count}`,
    more: (count: number) => `more:${count}`,
  };
  const unresolved = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      label: `+7700000000${index + 1}`,
      missingVariables: ["1", "name"],
    }));

  it("lists every recipient when there are three or fewer", () => {
    expect(formatMissingCampaignVariablesMessage(unresolved(2), copy)).toBe(
      [
        "summary:2",
        "+77000000001: {{1}}, {{name}}",
        "+77000000002: {{1}}, {{name}}",
      ].join("\n")
    );
  });

  it("lists the first three and counts the rest", () => {
    expect(formatMissingCampaignVariablesMessage(unresolved(5), copy)).toBe(
      [
        "summary:5",
        "+77000000001: {{1}}, {{name}}",
        "+77000000002: {{1}}, {{name}}",
        "+77000000003: {{1}}, {{name}}",
        "more:2",
      ].join("\n")
    );
  });
});

describe("buildBulkCampaignAudienceIntent", () => {
  it("builds analytics audiences with optional fill-up and variable configs", () => {
    expect(
      buildBulkCampaignAudienceIntent("analytics", {
        analyticsSource: { filters: { days: 30 }, previewCount: 12 },
      })
    ).toEqual({
      kind: "analytics_with_fill_up",
      analytics: { filters: { days: 30 }, previewCount: 12 },
      fillUpRecipients: [],
    });

    expect(
      buildBulkCampaignAudienceIntent("analytics", {
        analyticsSource: { filters: { days: 7 } },
        fillUpRecipients: [{ phone: "+77001234567" }],
        analyticsVariableConfigs: { name: { mode: "contact_name" } },
      })
    ).toEqual({
      kind: "analytics_with_fill_up",
      analytics: {
        filters: { days: 7 },
        variableConfigs: { name: { mode: "contact_name" } },
      },
      fillUpRecipients: [{ phone: "+77001234567" }],
    });
  });

  it("returns undefined for missing analytics or telegram sources and empty inline lists", () => {
    expect(buildBulkCampaignAudienceIntent("analytics", {})).toBeUndefined();
    expect(
      buildBulkCampaignAudienceIntent("telegram_subscribers", {
        telegramSourceId: "  ",
      })
    ).toBeUndefined();
    expect(
      buildBulkCampaignAudienceIntent("inline", { inlineRecipients: [] })
    ).toBeUndefined();
  });

  it("builds registered, telegram, and inline audiences for preview and send", () => {
    expect(
      buildBulkCampaignAudienceIntent("registered_users", {
        selectedRegisteredUserIds: ["user-1"],
      })
    ).toEqual({
      kind: "registered_users",
      selectedUserIds: ["user-1"],
    });
    expect(
      buildBulkCampaignAudienceIntent("registered_business_phones", {
        selectedPhones: ["+15550000002"],
      })
    ).toEqual({
      kind: "registered_business_phones",
      selectedPhones: ["+15550000002"],
    });
    expect(buildBulkCampaignAudienceIntent("registered_users", {})).toEqual({
      kind: "registered_users",
    });
    expect(
      buildBulkCampaignAudienceIntent("registered_business_phones", {})
    ).toEqual({
      kind: "registered_business_phones",
    });

    expect(
      buildBulkCampaignAudienceIntent("telegram_subscribers", {
        telegramSourceId: "source-1",
        telegramSelectedChatIds: ["123"],
      })
    ).toEqual({
      kind: "telegram_subscribers",
      sourceId: "source-1",
      selectedChatIds: ["123"],
    });

    expect(
      buildBulkCampaignAudienceIntent("inline", {
        inlineRecipients: [{ phone: "+77001234567", name: "Dana" }],
        uploadEvidence: {
          originalFilename: "audience.csv",
          selectedAt: "2026-08-26T00:00:00.000Z",
        },
      })
    ).toEqual({
      kind: "inline",
      recipients: [{ phone: "+77001234567", name: "Dana" }],
      uploadEvidence: {
        originalFilename: "audience.csv",
        selectedAt: "2026-08-26T00:00:00.000Z",
      },
    });
  });
});

describe("bulkCampaignJsonFetcher", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function respondWith(
    status: number,
    payload: unknown,
    headers?: Record<string, string>
  ) {
    global.fetch = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      ...(headers
        ? { headers: { get: (name: string) => headers[name] ?? null } }
        : {}),
      json: async () => payload,
    })) as unknown as typeof fetch;
  }

  it("keeps a coded server error instead of reporting [object Object]", async () => {
    const now = Date.now();
    respondWith(
      503,
      { state: "blocked", error: { code: "meta_rate_limited" } },
      { "Retry-After": "60" }
    );

    const error = await bulkCampaignJsonFetcher("/api/x").catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(BulkCampaignRequestError);
    expect(error).toMatchObject({
      message: "Failed to fetch",
      status: 503,
      code: "meta_rate_limited",
      retryAfterSeconds: 60,
    });
    expect((error as BulkCampaignRequestError).retryAt).toBeGreaterThanOrEqual(
      now + 60_000
    );
  });

  it("keeps a string error as the message, without a code or retry hint", async () => {
    respondWith(500, { error: "WhatsApp credentials are incomplete." });

    await expect(bulkCampaignJsonFetcher("/api/x")).rejects.toMatchObject({
      message: "WhatsApp credentials are incomplete.",
      status: 500,
      code: null,
      retryAt: null,
    });
  });
});
