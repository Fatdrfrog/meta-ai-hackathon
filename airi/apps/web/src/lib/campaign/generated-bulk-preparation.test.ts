jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw new Error(
      "Unexpected database access in generated preparation unit test"
    );
  }),
}));
const mockResolveWhatsAppSendContext = jest.fn();
const mockListApprovedWhatsAppTemplatesForSend = jest.fn();
const mockFilterKnownMarketingOptOutRecipients = jest.fn();
const mockResolveWhatsAppConversationHistoryEligibility = jest.fn();
const mockResolveTelegramSendContext = jest.fn();
const mockResolveEligibleTelegramBulkRecipients = jest.fn();
const mockResolveEmailBulkSendContext = jest.fn();
const mockFilterEmailUnsubscribedRecipients = jest.fn();
const mockResolveCampaignBatchPlanPreview = jest.fn();

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
  resolveWhatsAppSendContextResult: async (...args: unknown[]) => {
    const value = await mockResolveWhatsAppSendContext(...args);
    return value && typeof value === "object" && "ok" in value
      ? value
      : value
        ? { ok: true, context: value }
        : {
            ok: false,
            kind: "unavailable",
            reason: "source_not_found",
          };
  },
}));

jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  listApprovedWhatsAppTemplatesForSend: (...args: unknown[]) =>
    mockListApprovedWhatsAppTemplatesForSend(...args),
}));

jest.mock("./marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
    mockFilterKnownMarketingOptOutRecipients(...args),
}));

jest.mock("./whatsapp-bulk-preflight", () => ({
  resolveWhatsAppConversationHistoryEligibility: (...args: unknown[]) =>
    mockResolveWhatsAppConversationHistoryEligibility(...args),
}));

const mockPartitionRecentlyContactedRecipients = jest.fn();
jest.mock("./customer-contact-policy", () => ({
  partitionRecentlyContactedRecipients: (...args: unknown[]) =>
    mockPartitionRecentlyContactedRecipients(...args),
}));

jest.mock("@/lib/telegram/source-context", () => ({
  resolveTelegramSendContext: (...args: unknown[]) =>
    mockResolveTelegramSendContext(...args),
  resolveTelegramSendContextResult: async (...args: unknown[]) => {
    const value = await mockResolveTelegramSendContext(...args);
    return value && typeof value === "object" && "ok" in value
      ? value
      : value
        ? { ok: true, context: value }
        : {
            ok: false,
            kind: "unavailable",
            reason: "source_not_found",
          };
  },
}));

jest.mock("./telegram-bulk-preflight", () => ({
  resolveEligibleTelegramBulkRecipients: (...args: unknown[]) =>
    mockResolveEligibleTelegramBulkRecipients(...args),
}));

jest.mock("./email-bulk-preflight", () => ({
  resolveEmailBulkSendContext: (...args: unknown[]) =>
    mockResolveEmailBulkSendContext(...args),
  resolveEmailBulkSendContextStrict: (...args: unknown[]) =>
    mockResolveEmailBulkSendContext(...args),
  filterEmailUnsubscribedRecipients: (...args: unknown[]) =>
    mockFilterEmailUnsubscribedRecipients(...args),
  resolveBulkCampaignAppBaseUrl: (requestUrl: string) =>
    new URL(requestUrl).origin,
}));

jest.mock("./campaign-batch-plan", () => ({
  ...jest.requireActual("./campaign-batch-plan"),
  resolveCampaignBatchPlanPreview: (...args: unknown[]) =>
    mockResolveCampaignBatchPlanPreview(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

import { WhatsAppTemplateCatalogError } from "@/lib/whatsapp/templates/catalog-contracts";
import type { BulkCampaignRecipient } from "./bulk-campaign-contracts";
import { BulkCampaignEligibilityError } from "./bulk-campaign-recipient-eligibility";
import {
  prepareGeneratedBulkCampaignPartitions,
  type GeneratedBulkCampaignMessageInput,
  type GeneratedBulkCampaignNodeInput,
  type PreparedGeneratedBulkCampaignResult,
} from "./generated-bulk-preparation";

const providerConfig = {
  id: "provider-1",
  workspaceId: "workspace-1",
  provider: "postmark" as const,
  postmarkServerToken: "postmark-token",
  transactionalStream: "outbound",
  broadcastStream: "broadcast",
  defaultFromAddress: "updates@airi.chat",
  webhookToken: "webhook-token",
  mode: "manual" as const,
  verificationStatus: "verified" as const,
  managedState: null,
  status: "active" as const,
};

const defaultBatchPlans = {
  whatsapp: {
    channel: "whatsapp",
    readiness: {
      state: "ready",
      checkedAt: "2026-09-16T00:00:00.000Z",
      remainingCapacity: null,
      reasons: [],
    },
    batchPlan: {
      batchSize: 20,
      delayMs: 250,
      ratePerSecond: 80,
      rateSource: "meta_default_throughput",
      throughputLevel: "STANDARD",
    },
    recipientLimit: {
      maxRecipients: 100,
      source: "live_meta",
      rawLimit: "100",
    },
  },
  telegram: {
    channel: "telegram",
    batchPlan: {
      batchSize: 30,
      delayMs: 1000,
      ratePerSecond: 30,
      rateSource: "telegram_free_broadcast_limit",
      throughputLevel: null,
    },
    recipientLimit: {
      maxRecipients: 1000,
      source: "channel_default",
      rawLimit: "1000",
    },
  },
  email: {
    channel: "email",
    batchPlan: {
      batchSize: 20,
      delayMs: 334,
      ratePerSecond: 60,
      rateSource: "channel_default",
      throughputLevel: null,
    },
    recipientLimit: {
      maxRecipients: 1000,
      source: "channel_default",
      rawLimit: "1000",
    },
  },
} as const;

function message(
  id: string,
  channel: "whatsapp" | "telegram" | "email",
  recipient: string,
  overrides: Partial<GeneratedBulkCampaignMessageInput> = {}
): GeneratedBulkCampaignMessageInput {
  return {
    _id: id,
    nodeId: `node-${id}`,
    channel,
    recipient,
    recipientName: "Aibek",
    sourceId:
      channel === "whatsapp"
        ? "wa-source"
        : channel === "telegram"
          ? "tg-source"
          : "email-source",
    text: `Message ${id}`,
    ...overrides,
  };
}

function node(
  id: string,
  overrides: Record<string, unknown> = {}
): GeneratedBulkCampaignNodeInput {
  return {
    id,
    data: {
      kind: "action",
      actionType: "send_message",
      ...overrides,
    },
  };
}

function whatsappNode(
  id: string,
  templateName = "welcome",
  overrides: Record<string, unknown> = {}
): GeneratedBulkCampaignNodeInput {
  return node(id, {
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: templateName,
    actionWhatsAppTemplateLanguage: "en",
    generatedTemplateDraft: {
      status: "approved",
      category: "UTILITY",
    },
    ...overrides,
  });
}

function approvedTemplate(
  name = "welcome",
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION" = "UTILITY",
  components: unknown[] = [{ type: "BODY", text: "Hi {{1}}" }]
) {
  return {
    id: `${name}-id`,
    name,
    language: "en",
    status: "APPROVED",
    category,
    components,
  };
}

function input(
  messages: GeneratedBulkCampaignMessageInput[],
  nodes: GeneratedBulkCampaignNodeInput[],
  fallbackSourceIds: string[] = [],
  overrides: Record<string, unknown> = {}
) {
  return {
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    sentByUserId: "user-1",
    operationId: "operation-1",
    campaignName: "Generated launch",
    requestUrl: "https://console.airi.chat/panel/w/workspace-1",
    messages,
    nodes,
    fallbackSourceIds,
    recipientPolicy: {
      version: 1 as const,
      excludePriorFailedBulkSends: false,
    },
    ...overrides,
  };
}

function expectExactClassification(
  result: PreparedGeneratedBulkCampaignResult,
  requestedMessageIds: string[]
) {
  const candidateIds = result.partitions.flatMap(
    partition => partition.candidateMessageIds
  );
  const skippedIds = Object.keys(result.skippedByMessageId);
  expect(result.requestedMessageIds).toEqual(requestedMessageIds);
  expect([...candidateIds, ...skippedIds].sort()).toEqual(
    [...requestedMessageIds].sort()
  );
  expect(new Set([...candidateIds, ...skippedIds]).size).toBe(
    requestedMessageIds.length
  );
  for (const partition of result.partitions) {
    expect(
      partition.items.map(item => item.generatedRecipientMessageId)
    ).toEqual(partition.candidateMessageIds);
    expect(
      partition.items.every(item => item.channel === partition.channel)
    ).toBe(true);
  }
}

describe("prepareGeneratedBulkCampaignPartitions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";

    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) =>
        sourceId === "wa-source"
          ? {
              workspaceId,
              sourceId,
              phoneNumberId: "wa-phone",
              accessToken: "wa-token",
              messagingAccountId: "messaging-account-1",
              cachedMessagingLimit: "100",
              marketingMessagesEnabled: true,
            }
          : null
    );
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate(),
    ]);
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: BulkCampaignRecipient[] }) => ({
        recipients,
        skippedRecipients: [],
        skippedOptIn: 0,
        skippedPhones: [],
        marketingOptInWarningRecipients: recipients,
        marketingOptInWarningCount: recipients.length,
        marketingOptInWarningPhones: recipients.map(recipient =>
          String(recipient.phone || "")
        ),
      })
    );
    mockResolveWhatsAppConversationHistoryEligibility.mockImplementation(
      async ({ phones }: { phones: string[] }) => ({
        eligiblePhones: phones,
        skippedPhones: [],
      })
    );
    mockPartitionRecentlyContactedRecipients.mockImplementation(
      async ({ recipients }: { recipients: unknown[] }) => ({
        allowed: recipients,
        recentlyContacted: [],
        nextEligibleAt: null,
      })
    );
    mockResolveTelegramSendContext.mockImplementation(async ({ sourceId }) =>
      sourceId === "tg-source"
        ? { sourceId: "tg-source", botToken: "tg-token" }
        : null
    );
    mockResolveEligibleTelegramBulkRecipients.mockImplementation(
      async ({
        recipients,
        defaultSourceId,
      }: {
        recipients: BulkCampaignRecipient[];
        defaultSourceId: string;
      }) => ({
        recipients: recipients.map(recipient => ({
          ...recipient,
          chatId: recipient.chatId,
          sourceId: defaultSourceId,
        })),
        skippedRecipientDetails: [],
      })
    );
    mockResolveEmailBulkSendContext.mockResolvedValue({
      ok: true,
      sourceId: "email-source",
      providerConfig,
      fromAddress: "updates@airi.chat",
    });
    mockFilterEmailUnsubscribedRecipients.mockImplementation(
      async ({ recipients }: { recipients: BulkCampaignRecipient[] }) => ({
        recipients,
        skippedUnsubscribed: 0,
        skippedRecipientDetails: [],
      })
    );
    mockResolveCampaignBatchPlanPreview.mockImplementation(
      async ({ channel }: { channel: keyof typeof defaultBatchPlans }) =>
        defaultBatchPlans[channel]
    );
  });

  afterEach(() => {
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  });

  it.each(["current_v3", "legacy_v2_disabled"] as const)(
    "rejects explicit conversation bindings before preparing generated payloads in %s",
    async digestMode => {
      await expect(
        prepareGeneratedBulkCampaignPartitions({
          ...input(
            [message("bound", "whatsapp", "15550000001")],
            [
              whatsappNode("node-bound", "welcome", {
                actionWhatsAppTemplateBindings: {
                  version: 1,
                  parameters: {
                    "body:1": {
                      source: "literal",
                      value: "Must not be ignored",
                    },
                  },
                },
              }),
            ]
          ),
          digestMode,
        })
      ).rejects.toMatchObject({
        reason: "template_bindings_require_conversation",
        message: expect.stringContaining("campaign recipient mappings"),
      });
      expect(mockListApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    }
  );

  it("ignores bindings on unrelated follow-up nodes when preparing the primary bulk message", async () => {
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [message("primary", "whatsapp", "15550000001")],
        [
          whatsappNode("node-primary"),
          whatsappNode("follow-up", "welcome", {
            actionWhatsAppTemplateBindings: { version: 1, parameters: {} },
          }),
        ]
      )
    );
    expectExactClassification(result, ["primary"]);
    expect(result.partitions).toHaveLength(1);
  });

  it.each([
    "12345",
    "1555000000112345",
    "++15550000001",
    "KZ.123456789012",
    "'=SUM(15550000001)",
  ])(
    "rejects invalid generated WhatsApp phone %s before producing queue partitions",
    async recipient => {
      await expect(
        prepareGeneratedBulkCampaignPartitions(
          input(
            [message("invalid-phone", "whatsapp", recipient)],
            [whatsappNode("node-invalid-phone")]
          )
        )
      ).rejects.toThrow(/invalid.*recipient/i);
      expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
      expect(mockListApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    }
  );

  it.each(["current_v3", "legacy_v2_disabled"] as const)(
    "blocks new generated WhatsApp work with unavailable health in %s",
    async digestMode => {
      mockResolveCampaignBatchPlanPreview.mockResolvedValue({
        ...defaultBatchPlans.whatsapp,
        readiness: {
          state: "unavailable",
          checkedAt: "2026-09-16T00:00:00.000Z",
          remainingCapacity: null,
          reasons: [{ code: "meta_check_unavailable" }],
        },
      });
      await expect(
        prepareGeneratedBulkCampaignPartitions({
          ...input(
            [message("health-wa", "whatsapp", "15550001001")],
            [whatsappNode("node-health-wa")]
          ),
          digestMode,
        })
      ).rejects.toThrow(/WhatsApp campaign sending/);
    }
  );

  it("checks every generated source and does not silently drop a blocked partition", async () => {
    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) => ({
        workspaceId,
        sourceId,
        phoneNumberId: sourceId,
        accessToken: "token",
        wabaId: sourceId,
      })
    );
    mockResolveCampaignBatchPlanPreview.mockImplementation(
      async ({ phoneNumberId }) => ({
        ...defaultBatchPlans.whatsapp,
        ...(phoneNumberId === "blocked-source"
          ? {
              readiness: {
                state: "blocked",
                checkedAt: "2026-09-16T00:00:00.000Z",
                remainingCapacity: null,
                reasons: [
                  { code: "meta_sender_restricted", providerCode: "131048" },
                ],
              },
            }
          : {}),
      })
    );
    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(
          [
            message("ready-wa", "whatsapp", "15550001001"),
            message("blocked-wa", "whatsapp", "15550001002", {
              sourceId: "blocked-source",
            }),
          ],
          [whatsappNode("node-ready-wa"), whatsappNode("node-blocked-wa")]
        )
      )
    ).rejects.toThrow(/WhatsApp campaign sending/);
  });

  it("creates three ordered homogeneous partitions for one logical recipient across channels", async () => {
    mockResolveEligibleTelegramBulkRecipients.mockResolvedValueOnce({
      recipients: [
        {
          chatId: "1001",
          sourceId: "tg-source",
          businessConnectionId: "business-1",
        },
      ],
      skippedRecipientDetails: [],
    });

    const messages = [
      message("message-wa", "whatsapp", "+7 701 000 00 01"),
      message("message-tg", "telegram", "1001"),
      message("message-email", "email", "Client@Example.com"),
    ];
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [
        whatsappNode("node-message-wa"),
        node("node-message-tg"),
        node("node-message-email"),
      ])
    );

    expect(result.partitions.map(partition => partition.partitionKey)).toEqual([
      "whatsapp:wa-source:wa-phone",
      "telegram:tg-source",
      "email:email-source:provider-1",
    ]);
    expect(result.partitions.map(partition => partition.channel)).toEqual([
      "whatsapp",
      "telegram",
      "email",
    ]);
    expect(result.partitions[0]?.items[0]).toMatchObject({
      channel: "whatsapp",
      sourceId: "wa-source",
      phoneNumberId: "wa-phone",
      templateCategory: "UTILITY",
    });
    for (const field of [
      "accessToken",
      "messagingAccountId",
      "marketingMessagesEnabled",
    ]) {
      expect(result.partitions[0]?.items[0]).not.toHaveProperty(field);
    }
    expect(result.partitions[1]?.items[0]).toMatchObject({
      channel: "telegram",
      sourceId: "tg-source",
      businessConnectionId: "business-1",
      recipient: { chatId: "1001" },
    });
    expect(result.partitions[2]?.items[0]).toMatchObject({
      channel: "email",
      fromAddress: "updates@airi.chat",
      messageStream: "broadcast",
      templateKey: "announcement",
      recipient: {
        email: "client@example.com",
        variables: {
          unsubscribeUrl: expect.stringContaining(
            "https://console.airi.chat/api/email/unsubscribe?token="
          ),
        },
      },
    });
    expectExactClassification(
      result,
      messages.map(item => String(item._id))
    );
  });

  it("evaluates all WhatsApp partitions once with the minimum source limit before stable repartitioning", async () => {
    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) => ({
        workspaceId,
        sourceId,
        phoneNumberId: `phone-${sourceId}`,
        accessToken: `token-${sourceId}`,
        messagingAccountId: `account-${sourceId}`,
      })
    );
    mockListApprovedWhatsAppTemplatesForSend.mockImplementation(
      async (_workspaceId, { sourceId }) => [
        approvedTemplate(`template-${sourceId}`),
      ]
    );
    mockResolveCampaignBatchPlanPreview.mockImplementation(
      async ({ phoneNumberId }) => ({
        ...defaultBatchPlans.whatsapp,
        batchPlan: {
          ...defaultBatchPlans.whatsapp.batchPlan,
          rateSource: `plan-${phoneNumberId}`,
        },
        recipientLimit: {
          maxRecipients: 1,
          source: "live_meta",
          rawLimit: "1",
        },
      })
    );
    const messages = [
      message("a-1", "whatsapp", "15550001001", { sourceId: "source-a" }),
      message("a-2", "whatsapp", "15550001002", { sourceId: "source-a" }),
      message("b-1", "whatsapp", "15550001001", { sourceId: "source-b" }),
      message("b-2", "whatsapp", "15550002002", { sourceId: "source-b" }),
    ];
    const nodes = messages.map(item =>
      whatsappNode(
        item.nodeId,
        `template-${item.sourceId}`,
        item.sourceId === "source-a" ? {} : {}
      )
    );

    const evaluateRecipientPolicy = jest.fn(
      async ({
        candidates,
      }: {
        candidates: Array<Record<string, unknown>>;
      }) => ({
        retained: [candidates[0], candidates[2]],
        excluded: [
          { candidate: candidates[1], reason: "recipient_limit" as const },
          { candidate: candidates[3], reason: "recipient_limit" as const },
        ],
        skippedByReason: { recipient_limit: 2 },
        warnings: { missingMarketingConsent: 0 },
        uniqueRecipients: { requested: 3, accepted: 1 },
      })
    );
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, nodes, [], {
        dependencies: { evaluateRecipientPolicy },
      })
    );

    expect(result.partitions).toHaveLength(2);
    expect(
      result.partitions.map(partition => partition.candidateMessageIds)
    ).toEqual([["a-1"], ["b-1"]]);
    expect(
      result.partitions.map(partition => partition.batchPlan.rateSource)
    ).toEqual(["plan-phone-source-a", "plan-phone-source-b"]);
    expect(result.skippedByMessageId).toEqual({
      "a-2": {
        reason: "recipient_limit",
        detail: "1",
      },
      "b-2": {
        reason: "recipient_limit",
        detail: "1",
      },
    });
    expect(evaluateRecipientPolicy).toHaveBeenCalledTimes(1);
    expect(evaluateRecipientPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientLimit: 1,
        candidates: expect.arrayContaining([
          expect.objectContaining({ stableId: "a-1" }),
          expect.objectContaining({ stableId: "a-2" }),
          expect.objectContaining({ stableId: "b-1" }),
          expect.objectContaining({ stableId: "b-2" }),
        ]),
      })
    );
    expect(
      evaluateRecipientPolicy.mock.calls[0]?.[0].candidates.map(
        candidate => candidate.stableId
      )
    ).toEqual(["a-1", "a-2", "b-1", "b-2"]);
    expectExactClassification(result, ["a-1", "a-2", "b-1", "b-2"]);
  });

  it("keeps first-retained partition order and attributes consent warnings to their exact child stable IDs", async () => {
    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) => ({
        workspaceId,
        sourceId,
        phoneNumberId: `phone-${sourceId}`,
        accessToken: `token-${sourceId}`,
      })
    );
    mockListApprovedWhatsAppTemplatesForSend.mockImplementation(
      async (_workspaceId, { sourceId }) => [
        approvedTemplate(`template-${sourceId}`),
      ]
    );
    const messages = [
      message("warning-b", "whatsapp", "15550001002", { sourceId: "source-b" }),
      message("clear-a", "whatsapp", "15550001001", { sourceId: "source-a" }),
    ];
    const evaluateRecipientPolicy = jest.fn(async ({ candidates }) => ({
      retained: [...candidates],
      excluded: [],
      skippedByReason: {},
      warnings: { missingMarketingConsent: 1 },
      warningStableIds: {
        missing_marketing_consent: ["warning-b"],
      },
      uniqueRecipients: { requested: 2, accepted: 2 },
    }));

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        messages,
        messages.map(item =>
          whatsappNode(item.nodeId, `template-${item.sourceId}`)
        ),
        [],
        { dependencies: { evaluateRecipientPolicy } }
      )
    );

    expect(result.partitions.map(partition => partition.partitionKey)).toEqual([
      "whatsapp:source-b:phone-source-b",
      "whatsapp:source-a:phone-source-a",
    ]);
    expect(
      result.partitions.map(
        partition => partition.policyOutcome?.warnings.missingMarketingConsent
      )
    ).toEqual([1, 0]);
    expect(result.whatsappPolicyFacts?.outcome.warnings).toEqual({
      missingMarketingConsent: 1,
    });
  });

  it("keeps standard Cloud API sources eligible when no optional Messaging Account ID exists", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      workspaceId: "workspace-1",
      sourceId: "wa-source",
      phoneNumberId: "wa-phone",
      accessToken: "wa-token",
      marketingMessagesEnabled: false,
    });

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [message("standard-cloud", "whatsapp", "15550001001")],
        [whatsappNode("node-standard-cloud")]
      )
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual([
      "standard-cloud",
    ]);
    expect(result.partitions[0]?.items[0]).toMatchObject({
      channel: "whatsapp",
    });
    expect(result.partitions[0]?.items[0]).not.toHaveProperty(
      "messagingAccountId"
    );
    expectExactClassification(result, ["standard-cloud"]);
  });

  it("uses the approved source template category for consent and skips explicit opt-outs only", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("promo", "MARKETING"),
    ]);
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: BulkCampaignRecipient[] }) => ({
        recipients: [recipients[0]],
        skippedRecipients: [recipients[1]],
        skippedOptIn: 1,
        skippedPhones: ["15550001002"],
        marketingOptInWarningRecipients: [recipients[0]],
        marketingOptInWarningCount: 1,
        marketingOptInWarningPhones: ["15550001001"],
      })
    );
    const messages = [
      message("unknown", "whatsapp", "15550001001"),
      message("opted-out", "whatsapp", "15550001002"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [
        whatsappNode("node-unknown", "promo", {
          generatedTemplateDraft: {
            status: "approved",
            category: "UTILITY",
          },
        }),
        whatsappNode("node-opted-out", "promo", {
          generatedTemplateDraft: {
            status: "approved",
            category: "UTILITY",
          },
        }),
      ])
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual(["unknown"]);
    expect(result.partitions[0]).toMatchObject({
      requestedTotal: 2,
      skippedOptIn: 1,
    });
    expect(result.partitions[0]?.items[0]).toMatchObject({
      templateCategory: "MARKETING",
    });
    expect(result.skippedByMessageId).toEqual({
      "opted-out": {
        reason: "marketing_opt_out",
        detail: null,
      },
    });
    expect(
      mockResolveWhatsAppConversationHistoryEligibility
    ).not.toHaveBeenCalled();
    expectExactClassification(result, ["unknown", "opted-out"]);
  });

  it("skips a recently contacted marketing recipient as recent_contact", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("promo", "MARKETING"),
    ]);
    mockPartitionRecentlyContactedRecipients.mockImplementation(
      async ({ recipients }: { recipients: Array<{ phone: string }> }) => ({
        allowed: recipients.filter(
          recipient => recipient.phone !== "15550001002"
        ),
        recentlyContacted: recipients.filter(
          recipient => recipient.phone === "15550001002"
        ),
        nextEligibleAt: "2026-10-20T08:00:00.000Z",
      })
    );
    const messages = [
      message("fresh", "whatsapp", "15550001001"),
      message("recent", "whatsapp", "15550001002"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [
        whatsappNode("node-fresh", "promo"),
        whatsappNode("node-recent", "promo"),
      ])
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual(["fresh"]);
    expect(result.skippedByMessageId).toEqual({
      recent: { reason: "recent_contact", detail: null },
    });
    expectExactClassification(result, ["fresh", "recent"]);
  });

  it("counts first-seen unique WhatsApp recipients for the cap while retaining in-cap duplicates", async () => {
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      ...defaultBatchPlans.whatsapp,
      recipientLimit: {
        maxRecipients: 1,
        source: "live_meta",
        rawLimit: "1",
      },
    });
    const messages = [
      message("first", "whatsapp", "+1 555 000 0001"),
      message("duplicate", "whatsapp", "15550000001"),
      message("overflow", "whatsapp", "15550000002"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        messages,
        messages.map(item => whatsappNode(item.nodeId))
      )
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual([
      "first",
      "duplicate",
    ]);
    expect(result.skippedByMessageId).toEqual({
      overflow: {
        reason: "recipient_limit",
        detail: "1",
      },
    });
    expectExactClassification(result, ["first", "duplicate", "overflow"]);
  });

  it("retains exact Telegram source and Business eligibility while a missing source fails closed", async () => {
    mockResolveEligibleTelegramBulkRecipients.mockResolvedValue({
      recipients: [
        {
          chatId: "1001",
          sourceId: "tg-source",
          businessConnectionId: "business-1",
        },
      ],
      skippedRecipientDetails: [],
    });
    const messages = [
      message("eligible", "telegram", "1001"),
      message("no-source", "telegram", "1002", { sourceId: null }),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [node("node-eligible"), node("node-no-source")])
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual(["eligible"]);
    expect(result.partitions[0]?.items[0]).toMatchObject({
      sourceId: "tg-source",
      businessConnectionId: "business-1",
    });
    expect(result.skippedByMessageId).toEqual({
      "no-source": {
        reason: "ineligible",
        detail: null,
      },
    });
    expectExactClassification(result, ["eligible", "no-source"]);
  });

  it("normalizes email recipients and materializes sender, stream, unsubscribe URL, and exact unsubscribe skips", async () => {
    mockFilterEmailUnsubscribedRecipients.mockImplementation(
      async ({ recipients }: { recipients: BulkCampaignRecipient[] }) => ({
        recipients: recipients.filter(
          recipient => recipient.email === "allowed@example.com"
        ),
        skippedUnsubscribed: 1,
        skippedRecipientDetails: [
          { reason: "email_unsubscribed", detail: "blocked@example.com" },
        ],
      })
    );
    const messages = [
      message("allowed", "email", " Allowed@Example.COM "),
      message("blocked", "email", "blocked@example.com"),
      message("invalid", "email", "not-an-email"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        messages,
        messages.map(item => node(item.nodeId))
      )
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual(["allowed"]);
    expect(result.partitions[0]?.items[0]).toMatchObject({
      fromAddress: "updates@airi.chat",
      templateKey: "announcement",
      subjectOverride: "Generated launch",
      messageStream: "broadcast",
      recipient: {
        email: "allowed@example.com",
        variables: {
          unsubscribeUrl: expect.stringContaining(
            "https://console.airi.chat/api/email/unsubscribe?token="
          ),
        },
      },
    });
    expect(result.skippedByMessageId).toEqual({
      blocked: {
        reason: "unsubscribed",
        detail: "blocked@example.com",
      },
      invalid: {
        reason: "ineligible",
        detail: "not-an-email",
      },
    });
    expectExactClassification(result, ["allowed", "blocked", "invalid"]);
  });

  it("classifies missing nodes, source-approved templates, and header media at exact message IDs", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("media", "UTILITY", [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: [] },
        },
        { type: "BODY", text: "Hi {{1}}" },
      ]),
    ]);
    const messages = [
      message("missing-node", "whatsapp", "15550001001"),
      message("missing-template", "whatsapp", "15550001002"),
      message("missing-media", "whatsapp", "15550001003"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [
        whatsappNode("node-missing-template", "not-approved"),
        whatsappNode("node-missing-media", "media"),
      ])
    );

    expect(result.partitions).toEqual([]);
    expect(result.skippedByMessageId).toEqual({
      "missing-node": {
        reason: "ineligible",
        detail: "node-missing-node",
      },
      "missing-template": {
        reason: "ineligible",
        detail: "not-approved:en",
      },
      "missing-media": {
        reason: "ineligible",
        detail: "node-missing-media:IMAGE",
      },
    });
    expectExactClassification(result, [
      "missing-node",
      "missing-template",
      "missing-media",
    ]);
  });

  it("fails closed for wrong-workspace explicit sources and fallback ambiguity beyond twenty sources", async () => {
    const fallbackSourceIds = Array.from(
      { length: 21 },
      (_, index) => `fallback-${index + 1}`
    );
    mockResolveWhatsAppSendContext.mockImplementation(async ({ sourceId }) =>
      sourceId === "wrong-workspace"
        ? {
            workspaceId: "workspace-2",
            sourceId,
            phoneNumberId: "wrong-phone",
            accessToken: "wrong-token",
            messagingAccountId: "wrong-account",
          }
        : sourceId?.startsWith("fallback-")
          ? {
              workspaceId: "workspace-1",
              sourceId,
              phoneNumberId: `phone-${sourceId}`,
              accessToken: `token-${sourceId}`,
              messagingAccountId: `account-${sourceId}`,
            }
          : null
    );
    const messages = [
      message("wrong", "whatsapp", "15550001001", {
        sourceId: "wrong-workspace",
        nodeId: "also-missing",
      }),
      message("ambiguous", "whatsapp", "15550001002", {
        sourceId: null,
        nodeId: "also-missing",
      }),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [], fallbackSourceIds)
    );

    expect(result.skippedByMessageId).toEqual({
      wrong: {
        reason: "ineligible",
        detail: "wrong-workspace",
      },
      ambiguous: {
        reason: "ineligible",
        detail: "21",
      },
    });
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledTimes(22);
    expect(mockListApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
    expectExactClassification(result, ["wrong", "ambiguous"]);
  });

  it("builds deterministic Flow and quick-reply callbacks on replay", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("interactive", "UTILITY", [
        { type: "BODY", text: "Hi {{1}}" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Choose" },
            {
              type: "FLOW",
              text: "Open",
              flow_id: "flow-1",
              navigate_screen: "START",
            },
          ],
        },
      ]),
    ]);
    const messages = [
      message("interactive-message", "whatsapp", "15550001001"),
    ];
    const preparationInput = input(messages, [
      whatsappNode("node-interactive-message", "interactive"),
    ]);

    const first =
      await prepareGeneratedBulkCampaignPartitions(preparationInput);
    const second =
      await prepareGeneratedBulkCampaignPartitions(preparationInput);

    expect(first.partitions[0]?.items[0]).toEqual(
      second.partitions[0]?.items[0]
    );
    expect(first.partitions[0]?.items[0]).toMatchObject({
      components: expect.arrayContaining([
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [
            {
              type: "payload",
              payload: "sg:scenario-1:interactive-message:0",
            },
          ],
        },
        {
          type: "button",
          sub_type: "flow",
          index: "1",
          parameters: [
            {
              type: "action",
              action: {
                flow_token: "sg:scenario-1:interactive-message",
              },
            },
          ],
        },
      ]),
    });
  });

  it("emits a versioned semantic digest that ignores retry-varying credentials and unsubscribe hosts", async () => {
    let tokenVersion = 0;
    let readinessVersion = 0;
    mockResolveCampaignBatchPlanPreview.mockImplementation(
      async ({ channel }: { channel: keyof typeof defaultBatchPlans }) => ({
        ...defaultBatchPlans[channel],
        ...(channel === "whatsapp"
          ? {
              readiness: {
                ...defaultBatchPlans.whatsapp.readiness,
                checkedAt: new Date(
                  Date.UTC(2026, 8, 16, 0, ++readinessVersion)
                ).toISOString(),
              },
            }
          : {}),
      })
    );
    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) =>
        sourceId === "wa-source"
          ? {
              workspaceId,
              sourceId,
              phoneNumberId: "wa-phone",
              accessToken: `wa-token-${++tokenVersion}`,
              messagingAccountId: "messaging-account-1",
              cachedMessagingLimit: tokenVersion === 1 ? "100" : "1000",
              marketingMessagesEnabled: true,
            }
          : null
    );
    const messages = [
      message("digest-wa", "whatsapp", "15550001001"),
      message("digest-email", "email", "client@example.com"),
    ];
    const nodes = [whatsappNode("node-digest-wa"), node("node-digest-email")];

    const first = await prepareGeneratedBulkCampaignPartitions({
      ...input(messages, nodes),
      requestUrl: "https://first-preview.example.com/panel",
    });
    const second = await prepareGeneratedBulkCampaignPartitions({
      ...input(messages, nodes),
      requestUrl: "https://second-preview.example.com/panel",
    });
    const changed = await prepareGeneratedBulkCampaignPartitions({
      ...input(
        [
          messages[0],
          { ...messages[1], text: "Semantically changed email body" },
        ],
        nodes
      ),
      requestUrl: "https://third-preview.example.com/panel",
    });

    expect(first.preparationDigestVersion).toBe(3);
    expect(first.preparationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preparationDigest).toBe(first.preparationDigest);
    expect(readinessVersion).toBe(3);
    expect(changed.preparationDigest).not.toBe(first.preparationDigest);
    expect(first.partitions[0]?.items[0]).toEqual(
      second.partitions[0]?.items[0]
    );
    expect(first.partitions[0]?.items[0]).not.toHaveProperty("accessToken");
    expect(first.partitions[1]?.items[0]).not.toEqual(
      second.partitions[1]?.items[0]
    );
  });

  it("binds the normalized persisted recipient policy into preparation v3 while preserving an explicit legacy v2 builder", async () => {
    const messages = [message("policy-row", "whatsapp", "15550000001")];
    const nodes = [whatsappNode("node-policy-row")];
    const evaluateRecipientPolicy = jest.fn(
      async ({
        candidates,
      }: {
        candidates: Array<Record<string, unknown>>;
      }) => ({
        retained: candidates,
        excluded: [],
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
        uniqueRecipients: { requested: 1, accepted: 1 },
      })
    );

    const disabled = await prepareGeneratedBulkCampaignPartitions(
      input(messages, nodes, [], {
        dependencies: { evaluateRecipientPolicy },
      })
    );
    const enabled = await prepareGeneratedBulkCampaignPartitions(
      input(messages, nodes, [], {
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
        dependencies: { evaluateRecipientPolicy },
      })
    );
    const legacy = await prepareGeneratedBulkCampaignPartitions(
      input(messages, nodes, [], {
        digestMode: "legacy_v2_disabled",
        dependencies: { evaluateRecipientPolicy },
      })
    );

    expect(disabled.preparationDigestVersion).toBe(3);
    expect(enabled.preparationDigestVersion).toBe(3);
    expect(disabled.preparationDigest).not.toBe(enabled.preparationDigest);
    expect(legacy.preparationDigestVersion).toBe(2);
    expect(legacy.preparationDigest).not.toBe(disabled.preparationDigest);
  });

  it("rejects generated item and canonical WhatsApp identity cap sentinels before source work", async () => {
    const tooManyItems = Array.from({ length: 3_001 }, (_, index) =>
      message(`email-${index}`, "email", `user-${index}@example.com`)
    );
    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(tooManyItems, [node("node-email-0")])
      )
    ).rejects.toThrow(/3,000 generated messages/);

    const tooManyWhatsAppIdentities = Array.from(
      { length: 1_001 },
      (_, index) =>
        message(
          `wa-${index}`,
          "whatsapp",
          `1555${String(index).padStart(7, "0")}`,
          {
            nodeId: "node-cap-wa",
          }
        )
    );
    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(tooManyWhatsAppIdentities, [whatsappNode("node-cap-wa")])
      )
    ).rejects.toThrow(/1,000 canonical WhatsApp identities/);

    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockResolveEmailBulkSendContext).not.toHaveBeenCalled();
  });

  it("keeps Telegram on its existing path when the persisted WhatsApp policy is disabled", async () => {
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [message("telegram-only", "telegram", "1001")],
        [node("node-telegram-only")],
        [],
        {
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
          verifiedWhatsAppTemplateCapability: false,
          verifiedRoutes: [
            {
              recipientStableId: "telegram-only",
              actionNodeId: "node-telegram-only",
              channel: "telegram",
              sourceId: "tg-source",
              actionNode: node("node-telegram-only"),
            },
          ],
        }
      )
    );

    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0]).toMatchObject({ channel: "telegram" });
    expect(mockResolveEligibleTelegramBulkRecipients).toHaveBeenCalledTimes(1);
    expect(mockListApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("rejects an enabled policy when the verified generated graph has no supported WhatsApp template capability", async () => {
    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(
          [message("telegram-only", "telegram", "1001")],
          [node("node-telegram-only")],
          [],
          {
            recipientPolicy: {
              version: 1,
              excludePriorFailedBulkSends: true,
            },
            verifiedWhatsAppTemplateCapability: false,
            verifiedRoutes: [
              {
                recipientStableId: "telegram-only",
                actionNodeId: "node-telegram-only",
                channel: "telegram",
                sourceId: "tg-source",
                actionNode: node("node-telegram-only"),
              },
            ],
          }
        )
      )
    ).rejects.toMatchObject({ code: "bulk_recipient_policy_unsupported" });
    expect(mockResolveEligibleTelegramBulkRecipients).not.toHaveBeenCalled();
  });

  it("consumes the verified generated source, action snapshot, and provider template without rereading a mutable catalog", async () => {
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [message("verified-wa", "whatsapp", "15550000001")],
        [whatsappNode("node-verified-wa", "stale-template")],
        [],
        {
          verifiedRoutes: [
            {
              recipientStableId: "verified-wa",
              actionNodeId: "node-verified-wa",
              channel: "whatsapp",
              sourceId: "wa-source",
              template: approvedTemplate("welcome", "UTILITY"),
              actionNode: whatsappNode("node-verified-wa", "welcome"),
            },
          ],
        }
      )
    );

    expect(result.partitions[0]).toMatchObject({
      channel: "whatsapp",
      sourceId: "wa-source",
      templateName: "welcome",
      templateLanguage: "en",
    });
    expect(mockListApprovedWhatsAppTemplatesForSend).not.toHaveBeenCalled();
  });

  it("resolves only the verified participating WhatsApp source when the row source is absent", async () => {
    mockResolveWhatsAppSendContext.mockImplementation(
      async ({ workspaceId, sourceId }) => {
        if (sourceId === "stale-root-source") {
          return {
            ok: false,
            kind: "query_error",
            error: new Error("stale root source must not participate"),
          };
        }
        return {
          workspaceId,
          sourceId,
          phoneNumberId: "wa-phone",
          accessToken: "wa-token",
          messagingAccountId: "messaging-account-1",
          cachedMessagingLimit: "100",
          marketingMessagesEnabled: true,
        };
      }
    );

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [
          message("verified-source-only", "whatsapp", "15550000001", {
            sourceId: undefined,
          }),
        ],
        [whatsappNode("node-verified-source-only")],
        ["wa-source", "stale-root-source"],
        {
          verifiedWhatsAppTemplateCapability: true,
          verifiedRoutes: [
            {
              recipientStableId: "verified-source-only",
              actionNodeId: "node-verified-source-only",
              channel: "whatsapp",
              sourceId: "wa-source",
              template: approvedTemplate("welcome", "UTILITY"),
              actionNode: whatsappNode("node-verified-source-only"),
            },
          ],
        }
      )
    );

    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0]?.sourceId).toBe("wa-source");
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledTimes(1);
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "wa-source",
    });
  });

  it("binds the source-owned batch plan into the preparation digest", async () => {
    const preparationInput = input(
      [message("digest-batch-plan", "whatsapp", "15550001001")],
      [whatsappNode("node-digest-batch-plan")]
    );
    const first =
      await prepareGeneratedBulkCampaignPartitions(preparationInput);
    mockResolveCampaignBatchPlanPreview.mockResolvedValue({
      ...defaultBatchPlans.whatsapp,
      batchPlan: {
        ...defaultBatchPlans.whatsapp.batchPlan,
        batchSize: 10,
        delayMs: 500,
        ratePerSecond: 40,
        rateSource: "changed_meta_throughput",
      },
    });

    const changed =
      await prepareGeneratedBulkCampaignPartitions(preparationInput);

    expect(changed.partitions[0]?.batchPlan).not.toEqual(
      first.partitions[0]?.batchPlan
    );
    expect(changed.preparationDigest).not.toBe(first.preparationDigest);
  });

  it("reuses persisted public header media without letting persisted template identity override Meta", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("welcome", "MARKETING", [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::opaque-meta-handle"] },
        },
        { type: "BODY", text: "Authoritative Meta body {{1}}" },
      ]),
    ]);
    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        [
          message("media-message", "whatsapp", "15550001001", {
            mediaAssetIds: ["asset-image-1"],
          }),
        ],
        [
          whatsappNode("node-media-message", "welcome", {
            actionMediaAssets: [
              {
                id: "asset-image-1",
                kind: "image",
                source: "uploaded",
                url: "https://media.airi.chat/workspace-1/header.png",
              },
            ],
            actionWhatsAppTemplateComponents: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: {
                  header_handle: [
                    "https://media.airi.chat/workspace-1/header.png",
                  ],
                },
              },
              { type: "BODY", text: "Stale persisted body" },
            ],
          }),
        ]
      )
    );

    expect(result.partitions[0]?.items[0]).toMatchObject({
      channel: "whatsapp",
      templateName: "welcome",
      templateCategory: "MARKETING",
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "image",
              image: {
                link: "https://media.airi.chat/workspace-1/header.png",
              },
            },
          ],
        },
        {
          type: "body",
          parameters: [{ type: "text", text: "Aibek" }],
        },
      ],
    });
    expect(result.skippedByMessageId).toEqual({});
  });

  it("normalizes volatile media URLs in the digest while binding stable media and component identity", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("welcome", "MARKETING", [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::opaque-meta-handle"] },
        },
        { type: "BODY", text: "Hello {{1}}" },
      ]),
    ]);
    const makeMediaInput = (
      mediaUrl: string,
      nodeMediaAssetId: string,
      generatedTemplateDraftId = "draft-template-1",
      format: "IMAGE" | "VIDEO" = "IMAGE"
    ) =>
      input(
        [message("digest-media", "whatsapp", "15550001001")],
        [
          whatsappNode("node-digest-media", "welcome", {
            actionMediaAssets: [
              {
                id: nodeMediaAssetId,
                kind: format.toLowerCase(),
                source: "uploaded",
                url: mediaUrl,
              },
            ],
            actionWhatsAppTemplateComponents: [
              {
                type: "HEADER",
                format,
                example: { header_handle: [mediaUrl] },
              },
              { type: "BODY", text: "Stale persisted body" },
            ],
            generatedTemplateDraft: {
              id: generatedTemplateDraftId,
              status: "approved",
              category: "MARKETING",
            },
          }),
        ]
      );

    const first = await prepareGeneratedBulkCampaignPartitions(
      makeMediaInput(
        "https://signed-a.example.com/header.png?signature=first",
        "asset-image-1"
      )
    );
    const refreshedUrl = await prepareGeneratedBulkCampaignPartitions(
      makeMediaInput(
        "https://signed-b.example.com/header.png?signature=second",
        "asset-image-1"
      )
    );
    const changedAsset = await prepareGeneratedBulkCampaignPartitions(
      makeMediaInput(
        "https://signed-b.example.com/header.png?signature=second",
        "asset-image-2"
      )
    );
    const changedTemplate = await prepareGeneratedBulkCampaignPartitions(
      makeMediaInput(
        "https://signed-b.example.com/header.png?signature=second",
        "asset-image-1",
        "draft-template-2"
      )
    );
    const changedShape = await prepareGeneratedBulkCampaignPartitions(
      makeMediaInput(
        "https://signed-b.example.com/header.mp4?signature=second",
        "asset-image-1",
        "draft-template-1",
        "VIDEO"
      )
    );

    expect(refreshedUrl.preparationDigest).toBe(first.preparationDigest);
    expect(changedAsset.preparationDigest).not.toBe(first.preparationDigest);
    expect(changedTemplate.preparationDigest).not.toBe(first.preparationDigest);
    expect(changedShape.preparationDigest).not.toBe(first.preparationDigest);
    expect(refreshedUrl.partitions[0]?.items[0]).not.toEqual(
      first.partitions[0]?.items[0]
    );
  });

  it("binds the selected header asset ID while preserving URL-refresh stability across a two-asset set", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("welcome", "MARKETING", [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::opaque-meta-handle"] },
        },
        { type: "BODY", text: "Hello {{1}}" },
      ]),
    ]);
    const makeTwoAssetInput = (params: {
      selectedHeaderUrl: string;
      assetAUrl: string;
      assetBUrl: string;
    }) =>
      input(
        [message("two-asset-digest", "whatsapp", "15550001001")],
        [
          whatsappNode("node-two-asset-digest", "welcome", {
            actionMediaAssets: [
              {
                id: "asset-a",
                kind: "image",
                source: "uploaded",
                url: params.assetAUrl,
              },
              {
                id: "asset-b",
                kind: "image",
                source: "uploaded",
                url: params.assetBUrl,
              },
            ],
            actionWhatsAppTemplateComponents: [
              {
                type: "HEADER",
                format: "IMAGE",
                example: { header_handle: [params.selectedHeaderUrl] },
              },
              { type: "BODY", text: "Persisted stale body" },
            ],
            generatedTemplateDraft: {
              id: "draft-template-1",
              status: "approved",
              category: "MARKETING",
            },
          }),
        ]
      );

    const firstAssetAUrl =
      "https://signed-a.example.com/header-a.png?signature=first";
    const refreshedAssetAUrl =
      "https://signed-b.example.com/header-a.png?signature=second";
    const assetBUrl =
      "https://signed.example.com/header-b.png?signature=stable";
    const first = await prepareGeneratedBulkCampaignPartitions(
      makeTwoAssetInput({
        selectedHeaderUrl: firstAssetAUrl,
        assetAUrl: firstAssetAUrl,
        assetBUrl,
      })
    );
    const refreshed = await prepareGeneratedBulkCampaignPartitions(
      makeTwoAssetInput({
        selectedHeaderUrl: refreshedAssetAUrl,
        assetAUrl: refreshedAssetAUrl,
        assetBUrl,
      })
    );
    const switchedToB = await prepareGeneratedBulkCampaignPartitions(
      makeTwoAssetInput({
        selectedHeaderUrl: assetBUrl,
        assetAUrl: refreshedAssetAUrl,
        assetBUrl,
      })
    );

    expect(refreshed.preparationDigest).toBe(first.preparationDigest);
    expect(switchedToB.preparationDigest).not.toBe(first.preparationDigest);
  });

  it("fails closed when a persisted public header cannot map to one stable action asset", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("welcome", "MARKETING", [
        {
          type: "HEADER",
          format: "IMAGE",
          example: { header_handle: ["4::opaque-meta-handle"] },
        },
      ]),
    ]);

    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(
          [message("unmapped-media", "whatsapp", "15550001001")],
          [
            whatsappNode("node-unmapped-media", "welcome", {
              actionMediaAssets: [
                {
                  id: "asset-a",
                  kind: "image",
                  source: "uploaded",
                  url: "https://media.airi.chat/asset-a.png",
                },
              ],
              actionWhatsAppTemplateComponents: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: [
                      "https://media.airi.chat/not-the-selected-asset.png",
                    ],
                  },
                },
              ],
            }),
          ]
        )
      )
    ).rejects.toThrow(
      "Cannot derive stable selected header media identity for node-unmapped-media"
    );
  });

  it("emits singular template metadata only when every item agrees", async () => {
    mockListApprovedWhatsAppTemplatesForSend.mockResolvedValue([
      approvedTemplate("template-a"),
      approvedTemplate("template-b"),
    ]);
    const messages = [
      message("a", "whatsapp", "15550001001"),
      message("b", "whatsapp", "15550001002"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(messages, [
        whatsappNode("node-a", "template-a"),
        whatsappNode("node-b", "template-b"),
      ])
    );

    expect(result.partitions[0]).toMatchObject({
      templateName: null,
      templateLanguage: "en",
      messageText: null,
    });
  });

  it("maps source-scoped history rejection to every exact non-marketing generated ID", async () => {
    mockResolveWhatsAppConversationHistoryEligibility.mockResolvedValue({
      eligiblePhones: ["15550001001"],
      skippedPhones: ["15550001002"],
    });
    const messages = [
      message("known", "whatsapp", "15550001001"),
      message("unknown", "whatsapp", "15550001002"),
    ];

    const result = await prepareGeneratedBulkCampaignPartitions(
      input(
        messages,
        messages.map(item => whatsappNode(item.nodeId))
      )
    );

    expect(result.partitions[0]?.candidateMessageIds).toEqual(["known"]);
    expect(result.skippedByMessageId).toEqual({
      unknown: {
        reason: "ineligible",
        detail: "15550001002",
      },
    });
    expect(
      mockResolveWhatsAppConversationHistoryEligibility
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "wa-source",
      phones: ["15550001001", "15550001002"],
    });
    expectExactClassification(result, ["known", "unknown"]);
  });

  it("throws infrastructure lookup failures instead of persisting permanent skips", async () => {
    const graphError = new Error("Graph unavailable");
    mockListApprovedWhatsAppTemplatesForSend.mockRejectedValue(graphError);

    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(
          [message("message-1", "whatsapp", "15550001001")],
          [whatsappNode("node-message-1")]
        )
      )
    ).rejects.toMatchObject({
      name: "BulkCampaignEligibilityError",
      code: "template_lookup_unavailable",
      cause: graphError,
    });
  });

  it("codes a throttled template listing as meta_rate_limited with its retry time", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    mockListApprovedWhatsAppTemplatesForSend.mockRejectedValue(
      new WhatsAppTemplateCatalogError({
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        message: "Meta temporarily limited WhatsApp template requests.",
        retryAt,
      })
    );

    const failure = await prepareGeneratedBulkCampaignPartitions(
      input(
        [message("message-1", "whatsapp", "15550001001")],
        [whatsappNode("node-message-1")]
      )
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BulkCampaignEligibilityError);
    expect(failure).toMatchObject({ code: "meta_rate_limited" });
    expect(
      (failure as BulkCampaignEligibilityError).retryAfterSeconds
    ).toBeGreaterThan(100);
  });

  it.each([
    {
      channel: "whatsapp" as const,
      configure: () =>
        mockResolveWhatsAppSendContext.mockResolvedValue({
          ok: false,
          kind: "query_error",
          error: new Error("WhatsApp source query unavailable"),
        }),
      expected: "WhatsApp source query unavailable",
    },
    {
      channel: "telegram" as const,
      configure: () =>
        mockResolveTelegramSendContext.mockResolvedValue({
          ok: false,
          kind: "query_error",
          error: new Error("Telegram source query unavailable"),
        }),
      expected: "Telegram source query unavailable",
    },
    {
      channel: "email" as const,
      configure: () =>
        mockResolveEmailBulkSendContext.mockResolvedValue({
          ok: false,
          kind: "query_error",
          code: "email_source_query_failed",
          error: new Error("Email source query unavailable"),
        }),
      expected: "Email source query unavailable",
    },
  ])(
    "throws $channel source query failures instead of recording terminal skips",
    async ({ channel, configure, expected }) => {
      configure();
      const generatedMessage = message(
        `query-failure-${channel}`,
        channel,
        channel === "email"
          ? "client@example.com"
          : channel === "whatsapp"
            ? "15550001001"
            : "1001"
      );

      await expect(
        prepareGeneratedBulkCampaignPartitions(
          input(
            [generatedMessage],
            [
              channel === "whatsapp"
                ? whatsappNode(generatedMessage.nodeId)
                : node(generatedMessage.nodeId),
            ]
          )
        )
      ).rejects.toThrow(expected);
    }
  );

  it("fails preflight when a verified participating WhatsApp source becomes unavailable", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue(null);

    await expect(
      prepareGeneratedBulkCampaignPartitions(
        input(
          [message("verified-source", "whatsapp", "15550000001")],
          [whatsappNode("node-verified-source")],
          [],
          {
            verifiedWhatsAppTemplateCapability: true,
            verifiedRoutes: [
              {
                recipientStableId: "verified-source",
                actionNodeId: "node-verified-source",
                channel: "whatsapp",
                sourceId: "wa-source",
                template: approvedTemplate("welcome", "UTILITY"),
                actionNode: whatsappNode("node-verified-source"),
              },
            ],
          }
        )
      )
    ).rejects.toThrow(
      "Verified generated WhatsApp source wa-source is unavailable"
    );
    expect(mockResolveCampaignBatchPlanPreview).not.toHaveBeenCalled();
  });
});
