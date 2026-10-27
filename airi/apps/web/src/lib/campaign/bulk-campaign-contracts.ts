import {
  BULK_ANALYTICS_DELIVERY_STATUSES,
  type BulkAnalyticsAudienceSource,
} from "@/lib/analytics/bulk-analytics-contract";
import {
  BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT,
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES,
  normalizeBulkCampaignRecipientPolicy,
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type BulkCampaignAudienceIntent,
  type BulkCampaignDispatchExecutionSource,
  type BulkCampaignProvenanceIntent,
  type BulkCampaignReadiness,
  type BulkCampaignRecipientPolicy,
  type ScenarioBulkRootConfig,
} from "@icecore/scenario-contracts";
import type {
  BulkCampaignDispatchBatchPlan as TemporalBulkCampaignDispatchBatchPlan,
  BulkCampaignDispatchLifecycleState as TemporalBulkCampaignDispatchLifecycleState,
} from "@icecore/temporal";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { EMAIL_CAMPAIGN_LOCALES } from "@/lib/email/email-campaign-locales";
import { z } from "zod";

export const BULK_CAMPAIGN_CHANNELS = [
  "whatsapp",
  "telegram",
  "email",
] as const;

export const TELEGRAM_SEND_MESSAGE_TEXT_LIMIT = 4096;
export const WHATSAPP_SERVICE_MESSAGE_TEXT_LIMIT =
  WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text;
// Keep one exact application dispatch cap until large audiences are staged and
// joined server-side instead of being materialized inside one Route Handler.
export const MAX_BULK_CAMPAIGN_RECIPIENTS = 50_000;
export const MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS = MAX_BULK_CAMPAIGN_RECIPIENTS;
// Vercel Functions reject bodies above 4.5 MB. Keep margin below that hard limit.
export const MAX_INLINE_BULK_CAMPAIGN_REQUEST_BYTES = 4_000_000;
export const BulkCampaignIdempotencyKeySchema = z.string().min(8).max(128);

export type BulkCampaignChannel = (typeof BULK_CAMPAIGN_CHANNELS)[number];
export type BulkCampaignDispatchBatchPlan =
  TemporalBulkCampaignDispatchBatchPlan;
export type BulkCampaignDispatchStatus =
  TemporalBulkCampaignDispatchLifecycleState;

export type BulkCampaignAudienceOverlapInfo = {
  kind?: "none" | "high" | "exact" | "unknown";
  intersectionCount: number;
  candidateCount: number;
  ratio: number;
};

export const BulkCampaignRecipientSchema = z.object({
  phone: z.string().optional(),
  chatId: z.string().optional(),
  sourceId: z.string().optional().nullable(),
  email: z.string().optional(),
  name: z.string().optional(),
  birthday: z.string().optional(),
  fields: z.record(z.string()).optional(),
  variables: z.record(z.string()).optional(),
  templateName: z.string().optional(),
  languageCode: z.string().optional(),
  templateCategory: z
    .enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
    .optional(),
  scenarioNodeId: z.string().optional(),
});

export type BulkCampaignRecipient = z.infer<typeof BulkCampaignRecipientSchema>;

export const BulkAnalyticsAudienceFilterSchema = z.object({
  days: z.union([z.string(), z.number()]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  timezone: z.string().optional(),
  templates: z.array(z.string()).optional(),
  campaignIds: z.array(z.string()).optional(),
  status: z.enum(["all", "replied", "not_replied"]).optional(),
  engagement: z.enum(["all", "high", "medium", "low", "unscored"]).optional(),
  conversationScope: z
    .enum(["campaign_sends", "all", "fresh", "campaign_or_fresh"])
    .optional(),
  // Preserve this diagnostic filter so the audience resolver rejects it instead of broadening recipients.
  recipientSearch: z.string().optional(),
  deliveryStatus: z.enum(BULK_ANALYTICS_DELIVERY_STATUSES).optional(),
  deliveryErrorCode: z.string().optional(),
  messageContains: z.string().optional(),
  messageContainsMode: z.enum(["contains", "not_contains"]).optional(),
  replyWindowHours: z.union([z.string(), z.number()]).optional(),
  excludeRecentClientMessageWithin24h: z.boolean().optional(),
  excludeTemplates: z.boolean().optional(),
});

export const BulkAnalyticsVariableSourceConfigSchema = z.object({
  mode: z.enum(["auto", "contact_name", "recipient_phone", "custom"]),
  customValue: z.string().optional(),
});

export const BulkAnalyticsAudienceSchema = z.object({
  type: z.literal("bulk_analytics"),
  filters: BulkAnalyticsAudienceFilterSchema,
  previewCount: z.number().optional().nullable(),
  variableConfigs: z.record(BulkAnalyticsVariableSourceConfigSchema).optional(),
});

export const RegisteredUsersAudienceSchema = z.object({
  type: z.literal("registered_users"),
  previewCount: z.number().int().nonnegative().optional().nullable(),
  selectedUserIds: z.array(z.string().min(1)).max(10_000).optional(),
});

export const RegisteredBusinessPhonesAudienceSchema = z.object({
  type: z.literal(SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE),
  previewCount: z.number().int().nonnegative().optional().nullable(),
  selectedPhones: z.array(z.string().min(1)).max(10_000).optional(),
});

export type RegisteredBusinessPhonesAudiencePreviewRow = {
  phone: string;
  name?: string | null;
  email?: string | null;
};

export type RegisteredBusinessPhonesAudienceSummary = {
  enabled?: boolean;
  total: number;
  preview?: RegisteredBusinessPhonesAudiencePreviewRow[];
};

export const TelegramSubscribersAudienceSchema = z.object({
  type: z.literal(SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE),
  sourceId: z.string().min(1),
  previewCount: z.number().int().nonnegative().optional().nullable(),
  selectedChatIds: z.array(z.string().min(1)).max(100_000).optional(),
});

export const EmailCampaignContentSchema = z.object({
  format: z.literal("markdown"),
  subject: z.string().min(1).max(500),
  markdown: z.string().min(1).max(100_000),
});

export type EmailCampaignContent = z.infer<typeof EmailCampaignContentSchema>;

export const EmailCampaignContentByLocaleSchema = z
  .object(
    Object.fromEntries(
      EMAIL_CAMPAIGN_LOCALES.map(locale => [
        locale,
        EmailCampaignContentSchema.optional(),
      ])
    ) as Record<
      (typeof EMAIL_CAMPAIGN_LOCALES)[number],
      z.ZodOptional<typeof EmailCampaignContentSchema>
    >
  )
  .partial()
  .strict();

export const WhatsAppMarketingMessagePricingSchema = z
  .object({
    perMessageBidMultiplier: z
      .number()
      .positive()
      .refine(value => Number.isFinite(value), {
        message: "perMessageBidMultiplier must be finite",
      })
      .optional(),
  })
  .strict();

const BulkCampaignAudienceFilenameSchema = z.string().trim().min(1).max(512);

export const BulkCampaignAudienceReplacementEvidenceSchema = z
  .object({
    action: z.enum(["replaced", "cleared"]),
    replacedAt: z.string().datetime({ offset: true }),
    previousFilename: BulkCampaignAudienceFilenameSchema.optional(),
    nextFilename: BulkCampaignAudienceFilenameSchema.optional(),
  })
  .strict();

export const BulkCampaignAudienceUploadEvidenceSchema = z
  .object({
    originalFilename: BulkCampaignAudienceFilenameSchema.optional(),
    selectedAt: z.string().datetime({ offset: true }).optional(),
    replacementHistory: z
      .array(BulkCampaignAudienceReplacementEvidenceSchema)
      .max(BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT)
      .optional(),
  })
  .strict()
  .refine(
    data =>
      Boolean(
        data.originalFilename ||
          data.selectedAt ||
          (data.replacementHistory && data.replacementHistory.length > 0)
      ),
    "audienceUploadEvidence must include filename or selection evidence"
  );

export const BulkCampaignRecipientPolicySchema = z
  .object({
    version: z.literal(1),
    excludePriorFailedBulkSends: z.boolean(),
  })
  .strict();

export const BulkCampaignAudienceIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inline"),
      recipients: z
        .array(BulkCampaignRecipientSchema)
        .max(MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS),
      uploadEvidence: BulkCampaignAudienceUploadEvidenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("analytics_with_fill_up"),
      analytics: BulkAnalyticsAudienceSchema.omit({ type: true }),
      fillUpRecipients: z
        .array(BulkCampaignRecipientSchema)
        .max(MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("registered_users"),
      selectedUserIds: z.array(z.string().min(1)).max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("registered_business_phones"),
      selectedPhones: z.array(z.string().min(1)).max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("telegram_subscribers"),
      sourceId: z.string().min(1),
      selectedChatIds: z.array(z.string().min(1)).max(100_000).optional(),
    })
    .strict(),
]);

export const BulkCampaignProvenanceIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ad_hoc") }).strict(),
  z
    .object({
      kind: z.literal("scenario_run_now"),
      scenarioId: z.string().min(1),
      rootNodeId: z.string().min(1),
      actionNodeId: z.string().min(1).optional(),
      columnSplitNodeId: z.string().min(1).optional(),
    })
    .strict(),
]);

export type { BulkCampaignAudienceUploadEvidence } from "@icecore/scenario-contracts";

/**
 * The uploaded rows a send request carries, flat or canonical. The client
 * posts the normalized body, where parseBulkCampaignSendRequest has moved flat
 * `recipients` into `audience`, and the server parses that body again, so a
 * per-row rule must read both shapes to give the same answer twice.
 */
function bulkCampaignRequestRecipientRows(data: {
  recipients?: BulkCampaignRecipient[];
  audience?: z.infer<typeof BulkCampaignAudienceIntentSchema>;
}): BulkCampaignRecipient[] {
  if (!data.audience) return data.recipients || [];
  if (data.audience.kind === "inline") return data.audience.recipients;
  if (data.audience.kind === "analytics_with_fill_up") {
    return data.audience.fillUpRecipients;
  }
  return [];
}

export const BulkCampaignSendRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    channel: z.enum(BULK_CAMPAIGN_CHANNELS),
    recipients: z
      .array(BulkCampaignRecipientSchema)
      .max(MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS)
      .optional(),
    audience: BulkCampaignAudienceIntentSchema.optional(),
    analyticsAudience: BulkAnalyticsAudienceSchema.optional(),
    registeredUsersAudience: RegisteredUsersAudienceSchema.optional(),
    registeredBusinessPhonesAudience:
      RegisteredBusinessPhonesAudienceSchema.optional(),
    telegramSubscribersAudience: TelegramSubscribersAudienceSchema.optional(),
    campaignName: z.string().optional(),
    scenarioId: z.string().optional(),
    scenarioNodeId: z.string().optional(),
    executionSource: z
      .enum(
        BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES as unknown as [
          string,
          ...string[],
        ]
      )
      .optional(),
    recipientPolicy: BulkCampaignRecipientPolicySchema.optional(),
    provenance: BulkCampaignProvenanceIntentSchema.optional(),
    templateName: z.string().optional(),
    languageCode: z.string().default("en"),
    templateCategory: z
      .enum(["MARKETING", "UTILITY", "AUTHENTICATION"])
      .optional(),
    templateComponents: z.array(z.any()).optional(),
    marketingMessagePricing: WhatsAppMarketingMessagePricingSchema.optional(),
    whatsappMessageType: z.enum(["template", "service_text"]).optional(),
    // The WhatsApp number picked on the bulk page. The server resolves the
    // send context from this source, scoped to the workspace; without it,
    // the workspace's default WhatsApp source is used.
    whatsappSourceId: z.string().trim().min(1).max(200).optional(),
    messageText: z.string().optional(),
    fromAddress: z.string().optional(),
    templateKey: z
      .enum(["announcement", "product_update", "event_reminder"])
      .optional(),
    templateModel: z.record(z.string()).optional(),
    subjectOverride: z.string().optional(),
    emailContent: EmailCampaignContentSchema.optional(),
    emailContentByLocale: EmailCampaignContentByLocaleSchema.optional(),
    messageStream: z.string().optional(),
    idempotencyKey: BulkCampaignIdempotencyKeySchema.optional(),
    scheduledAt: z.string().optional(),
    useColumnSplitRouting: z.boolean().optional(),
    audienceConfirmationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    overflowQueueConfirmed: z.boolean().optional(),
    providerCircuitAcknowledged: z.boolean().optional(),
    audienceUploadEvidence: BulkCampaignAudienceUploadEvidenceSchema.optional(),
    excludePriorFailedBulkSends: z.boolean().optional(),
  })
  .refine(
    data =>
      (!data.excludePriorFailedBulkSends &&
        !data.recipientPolicy?.excludePriorFailedBulkSends) ||
      (data.channel === "whatsapp" &&
        data.whatsappMessageType !== "service_text"),
    {
      message:
        "excludePriorFailedBulkSends is supported only for WhatsApp template campaigns",
      path: ["excludePriorFailedBulkSends"],
    }
  )
  .refine(
    data =>
      data.useColumnSplitRouting ||
      data.channel !== "whatsapp" ||
      data.whatsappMessageType === "service_text" ||
      !!data.templateName ||
      bulkCampaignRequestRecipientRows(data).some(
        recipient => !!recipient.templateName
      ),
    {
      message:
        "templateName is required for WhatsApp campaigns unless useColumnSplitRouting is enabled with per-recipient templates",
      path: ["templateName"],
    }
  )
  .refine(
    data =>
      data.channel !== "whatsapp" ||
      data.whatsappMessageType !== "service_text" ||
      !!data.messageText?.trim(),
    {
      message: "messageText is required for WhatsApp service campaigns",
      path: ["messageText"],
    }
  )
  .refine(
    data =>
      data.channel !== "whatsapp" ||
      data.whatsappMessageType !== "service_text" ||
      !data.messageText ||
      data.messageText.length <= WHATSAPP_SERVICE_MESSAGE_TEXT_LIMIT,
    {
      message: `messageText must be ${WHATSAPP_SERVICE_MESSAGE_TEXT_LIMIT} characters or fewer for WhatsApp service campaigns`,
      path: ["messageText"],
    }
  )
  .refine(
    data =>
      data.whatsappMessageType !== "service_text" ||
      (data.channel === "whatsapp" &&
        !data.analyticsAudience &&
        !data.registeredBusinessPhonesAudience &&
        !data.registeredUsersAudience &&
        !data.telegramSubscribersAudience &&
        (!data.audience || data.audience.kind === "inline") &&
        (!data.provenance || data.provenance.kind === "ad_hoc") &&
        !data.scheduledAt &&
        !data.useColumnSplitRouting &&
        !data.scenarioId &&
        !data.scenarioNodeId &&
        !data.executionSource &&
        !data.templateName &&
        !data.templateCategory &&
        !data.templateComponents &&
        !data.marketingMessagePricing),
    {
      message:
        "WhatsApp service campaigns support only immediate manual recipients",
      path: ["whatsappMessageType"],
    }
  )
  .refine(
    data => {
      if (!data.useColumnSplitRouting || data.channel !== "whatsapp") {
        return true;
      }
      const recipients = bulkCampaignRequestRecipientRows(data);
      return (
        recipients.length > 0 &&
        recipients.every(recipient => !!recipient.templateName)
      );
    },
    {
      message:
        "useColumnSplitRouting requires every recipient to include a templateName",
      path: ["recipients"],
    }
  )
  .refine(
    data => (data.channel === "telegram" ? !!data.messageText?.trim() : true),
    {
      message: "messageText is required for Telegram campaigns",
      path: ["messageText"],
    }
  )
  .refine(
    data =>
      data.channel === "telegram" && data.messageText
        ? data.messageText.length <= TELEGRAM_SEND_MESSAGE_TEXT_LIMIT
        : true,
    {
      message: `messageText must be ${TELEGRAM_SEND_MESSAGE_TEXT_LIMIT} characters or fewer for Telegram campaigns`,
      path: ["messageText"],
    }
  )
  .refine(
    data =>
      data.channel === "email"
        ? !!data.templateKey ||
          !!data.emailContent ||
          Boolean(
            data.emailContentByLocale &&
              Object.values(data.emailContentByLocale).some(Boolean)
          )
        : true,
    {
      message: "templateKey or emailContent is required for Email campaigns",
      path: ["emailContent"],
    }
  )
  .refine(
    data =>
      Boolean(
        data.audience ||
          data.analyticsAudience ||
          data.registeredUsersAudience ||
          data.registeredBusinessPhonesAudience ||
          data.telegramSubscribersAudience ||
          (data.recipients || []).length > 0
      ),
    {
      message:
        "recipients, analyticsAudience, registeredUsersAudience, registeredBusinessPhonesAudience, or telegramSubscribersAudience is required",
      path: ["recipients"],
    }
  )
  .refine(
    // Normalization keeps this field beside an analytics_with_fill_up
    // audience, and the route reads it there, so count fill-up rows too.
    data =>
      !data.audienceUploadEvidence ||
      bulkCampaignRequestRecipientRows(data).length > 0 ||
      data.audience?.kind === "inline",
    {
      message:
        "audienceUploadEvidence requires uploaded recipient rows in recipients",
      path: ["audienceUploadEvidence"],
    }
  )
  .refine(
    data => (data.analyticsAudience ? data.channel === "whatsapp" : true),
    {
      message: "analyticsAudience is only supported for WhatsApp campaigns",
      path: ["analyticsAudience"],
    }
  )
  .refine(
    data => (data.marketingMessagePricing ? data.channel === "whatsapp" : true),
    {
      message:
        "marketingMessagePricing is only supported for WhatsApp campaigns",
      path: ["marketingMessagePricing"],
    }
  )
  .refine(
    data =>
      data.telegramSubscribersAudience ? data.channel === "telegram" : true,
    {
      message:
        "telegramSubscribersAudience is only supported for Telegram campaigns",
      path: ["telegramSubscribersAudience"],
    }
  )
  .refine(
    data => (data.registeredUsersAudience ? data.channel === "email" : true),
    {
      message: "registeredUsersAudience is only supported for Email campaigns",
      path: ["registeredUsersAudience"],
    }
  )
  .refine(
    data =>
      data.registeredBusinessPhonesAudience
        ? data.channel === "whatsapp"
        : true,
    {
      message:
        "registeredBusinessPhonesAudience is only supported for WhatsApp campaigns",
      path: ["registeredBusinessPhonesAudience"],
    }
  )
  .refine(
    data =>
      [
        data.audience,
        data.analyticsAudience,
        data.registeredUsersAudience,
        data.registeredBusinessPhonesAudience,
        data.telegramSubscribersAudience,
      ].filter(Boolean).length <= 1,
    {
      message: "Only one audience intent can be selected",
      path: ["registeredBusinessPhonesAudience"],
    }
  )
  .refine(
    data =>
      data.audience ||
      data.registeredUsersAudience ||
      data.registeredBusinessPhonesAudience ||
      data.telegramSubscribersAudience
        ? (data.recipients || []).length === 0
        : true,
    {
      message:
        "registered audience sources cannot be combined with uploaded recipients",
      path: ["recipients"],
    }
  )
  .refine(
    data => {
      if (
        data.audience ||
        data.analyticsAudience ||
        data.registeredUsersAudience ||
        data.registeredBusinessPhonesAudience ||
        data.telegramSubscribersAudience
      )
        return true;
      if (data.channel === "whatsapp") {
        return (data.recipients || []).every(recipient => !!recipient.phone);
      }
      if (data.channel === "telegram") {
        return (data.recipients || []).every(recipient => !!recipient.chatId);
      }
      if (data.channel === "email") {
        return (data.recipients || []).every(recipient => !!recipient.email);
      }
      return true;
    },
    {
      message:
        "All recipients must have phone (WhatsApp), chatId (Telegram), or email (Email)",
      path: ["recipients"],
    }
  );

export type BulkCampaignCompatibleProvenanceIntent =
  | BulkCampaignProvenanceIntent
  | {
      kind: "legacy_scenario_run_now";
      scenarioId: string;
      claimedNodeId: string;
    };

export type BulkCampaignCompatibleSendRequest = Omit<
  z.infer<typeof BulkCampaignSendRequestSchema>,
  | "audience"
  | "analyticsAudience"
  | "recipientPolicy"
  | "provenance"
  | "executionSource"
  | "languageCode"
  | "templateComponents"
> & {
  audience?: BulkCampaignAudienceIntent;
  analyticsAudience?: BulkAnalyticsAudienceSource;
  recipientPolicy?: BulkCampaignRecipientPolicy;
  provenance?: BulkCampaignCompatibleProvenanceIntent;
  executionSource?: BulkCampaignDispatchExecutionSource;
  languageCode?: string;
  templateComponents?: WhatsAppComponent[];
};

/** @deprecated Use the canonical NormalizedBulkCampaignSendRequest boundary. */
export type BulkCampaignSendRequest = BulkCampaignCompatibleSendRequest;

export type NormalizedBulkCampaignSendRequest = Omit<
  BulkCampaignCompatibleSendRequest,
  | "audience"
  | "recipients"
  | "analyticsAudience"
  | "registeredUsersAudience"
  | "registeredBusinessPhonesAudience"
  | "telegramSubscribersAudience"
  | "recipientPolicy"
  | "excludePriorFailedBulkSends"
  | "provenance"
  | "scenarioId"
  | "scenarioNodeId"
  | "executionSource"
> & {
  audience: BulkCampaignAudienceIntent;
  recipientPolicy: BulkCampaignRecipientPolicy;
  provenance: BulkCampaignCompatibleProvenanceIntent;
};

function assertCanonicalAudienceChannel(params: {
  channel: BulkCampaignChannel;
  audience: BulkCampaignAudienceIntent;
}): void {
  if (params.channel === "whatsapp") {
    const phones =
      params.audience.kind === "inline"
        ? params.audience.recipients.map(recipient => recipient.phone)
        : params.audience.kind === "analytics_with_fill_up"
          ? params.audience.fillUpRecipients.map(recipient => recipient.phone)
          : params.audience.kind === "registered_business_phones"
            ? params.audience.selectedPhones || []
            : [];
    const invalidIndex = phones.findIndex(
      phone => !normalizeWhatsAppPhone(phone)
    );
    if (invalidIndex !== -1) {
      throw new TypeError(
        `WhatsApp recipient ${invalidIndex + 1} must contain a valid phone number with country code`
      );
    }
  }
  if (
    params.audience.kind === "analytics_with_fill_up" ||
    params.audience.kind === "registered_business_phones"
  ) {
    if (params.channel !== "whatsapp") {
      throw new TypeError(
        "This audience intent is only supported for WhatsApp campaigns"
      );
    }
    return;
  }
  if (params.audience.kind === "registered_users") {
    if (params.channel !== "email") {
      throw new TypeError(
        "registered_users is only supported for Email campaigns"
      );
    }
    return;
  }
  if (params.audience.kind === "telegram_subscribers") {
    if (params.channel !== "telegram") {
      throw new TypeError(
        "telegram_subscribers is only supported for Telegram campaigns"
      );
    }
    return;
  }

  const recipients = params.audience.recipients;
  const requiredKey =
    params.channel === "whatsapp"
      ? "phone"
      : params.channel === "telegram"
        ? "chatId"
        : "email";
  if (recipients.some(recipient => !recipient[requiredKey])) {
    throw new TypeError(
      "All recipients must have phone (WhatsApp), chatId (Telegram), or email (Email)"
    );
  }
}

export function parseBulkCampaignSendRequest(
  input: unknown
): NormalizedBulkCampaignSendRequest {
  const parsed = BulkCampaignSendRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError(
      parsed.error.issues.map(issue => issue.message).join("; ")
    );
  }
  const data = parsed.data;
  const flatAudienceSources = [
    data.analyticsAudience,
    data.registeredUsersAudience,
    data.registeredBusinessPhonesAudience,
    data.telegramSubscribersAudience,
  ].filter(Boolean);
  const hasFlatRecipients = (data.recipients || []).length > 0;

  let audience: BulkCampaignAudienceIntent;
  if (data.audience) {
    if (flatAudienceSources.length > 0 || hasFlatRecipients) {
      throw new TypeError("Only one audience intent can be selected");
    }
    audience = data.audience as BulkCampaignAudienceIntent;
  } else if (data.analyticsAudience) {
    audience = {
      kind: "analytics_with_fill_up",
      analytics: {
        filters: data.analyticsAudience.filters,
        ...(data.analyticsAudience.previewCount !== undefined
          ? { previewCount: data.analyticsAudience.previewCount }
          : {}),
        ...(data.analyticsAudience.variableConfigs
          ? { variableConfigs: data.analyticsAudience.variableConfigs }
          : {}),
      },
      fillUpRecipients: data.recipients || [],
    };
  } else if (data.registeredUsersAudience) {
    audience = {
      kind: "registered_users",
      ...(data.registeredUsersAudience.selectedUserIds
        ? { selectedUserIds: data.registeredUsersAudience.selectedUserIds }
        : {}),
    };
  } else if (data.registeredBusinessPhonesAudience) {
    audience = {
      kind: "registered_business_phones",
      ...(data.registeredBusinessPhonesAudience.selectedPhones
        ? {
            selectedPhones:
              data.registeredBusinessPhonesAudience.selectedPhones,
          }
        : {}),
    };
  } else if (data.telegramSubscribersAudience) {
    audience = {
      kind: "telegram_subscribers",
      sourceId: data.telegramSubscribersAudience.sourceId,
      ...(data.telegramSubscribersAudience.selectedChatIds
        ? { selectedChatIds: data.telegramSubscribersAudience.selectedChatIds }
        : {}),
    };
  } else {
    audience = {
      kind: "inline",
      recipients: data.recipients || [],
      ...(data.audienceUploadEvidence
        ? { uploadEvidence: data.audienceUploadEvidence }
        : {}),
    };
  }
  assertCanonicalAudienceChannel({ channel: data.channel, audience });

  const recipientPolicy = normalizeBulkCampaignRecipientPolicy(
    data.recipientPolicy
  );
  if (
    data.recipientPolicy &&
    data.excludePriorFailedBulkSends !== undefined &&
    recipientPolicy.excludePriorFailedBulkSends !==
      data.excludePriorFailedBulkSends
  ) {
    throw new TypeError(
      "recipientPolicy conflicts with excludePriorFailedBulkSends"
    );
  }
  if (!data.recipientPolicy && data.excludePriorFailedBulkSends !== undefined) {
    recipientPolicy.excludePriorFailedBulkSends =
      data.excludePriorFailedBulkSends;
  }
  if (
    recipientPolicy.excludePriorFailedBulkSends &&
    (data.channel !== "whatsapp" || data.whatsappMessageType === "service_text")
  ) {
    throw new TypeError(
      "excludePriorFailedBulkSends is supported only for WhatsApp template campaigns"
    );
  }

  const hasLegacyScenarioProvenance =
    data.scenarioId !== undefined ||
    data.scenarioNodeId !== undefined ||
    data.executionSource !== undefined;
  let provenance: BulkCampaignCompatibleProvenanceIntent;
  if (data.provenance) {
    if (hasLegacyScenarioProvenance) {
      throw new TypeError(
        "provenance cannot be combined with legacy scenario fields"
      );
    }
    provenance = data.provenance as BulkCampaignProvenanceIntent;
  } else if (hasLegacyScenarioProvenance) {
    if (!data.scenarioId?.trim() || !data.scenarioNodeId?.trim()) {
      throw new TypeError(
        "legacy scenario provenance requires scenarioId and scenarioNodeId"
      );
    }
    if (
      data.executionSource !== undefined &&
      data.executionSource !== "scenario_run_now"
    ) {
      throw new TypeError(
        "Browser scenario_schedule and generated execution sources are invalid"
      );
    }
    provenance = {
      kind: "legacy_scenario_run_now",
      scenarioId: data.scenarioId,
      claimedNodeId: data.scenarioNodeId,
    };
  } else {
    provenance = { kind: "ad_hoc" };
  }

  const {
    audience: _audience,
    recipients: _recipients,
    analyticsAudience: _analyticsAudience,
    registeredUsersAudience: _registeredUsersAudience,
    registeredBusinessPhonesAudience: _registeredBusinessPhonesAudience,
    telegramSubscribersAudience: _telegramSubscribersAudience,
    recipientPolicy: _recipientPolicy,
    excludePriorFailedBulkSends: _excludePriorFailedBulkSends,
    provenance: _provenance,
    scenarioId: _scenarioId,
    scenarioNodeId: _scenarioNodeId,
    executionSource: _executionSource,
    ...rest
  } = data;
  return { ...rest, audience, recipientPolicy, provenance };
}

export type BulkCampaignRecipientLimit = {
  maxRecipients: number | null;
  rawLimit?: string | null;
  source: "live_meta" | "cached_meta" | "channel_default" | "unavailable";
  warning?: string | null;
  error?: string | null;
  unlimited?: boolean;
};

export type BulkCampaignBatchPlanPreviewResponse = {
  configured: boolean;
  channel: BulkCampaignChannel;
  readiness?: BulkCampaignReadiness;
  batchPlan?: BulkCampaignDispatchBatchPlan;
  recipientLimit?: BulkCampaignRecipientLimit;
  whatsappMeta?: {
    sourceId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
    qualityRating?: string | null;
    throughputLevel?: string | null;
    detailsSource: "meta_phone_details" | "meta_lookup_failed";
    warning?: string | null;
  };
  /** Why `configured` is false; `error` is English text for logs. */
  code?: BulkCampaignBatchPlanUnconfiguredCode;
  error?: string;
};

export type BulkCampaignBatchPlanUnconfiguredCode =
  | "whatsapp_not_connected"
  | "whatsapp_credentials_incomplete";

export type BulkCampaignQueuedDispatchInfo = {
  total: number;
  campaignId?: string | null;
  dispatchId?: string | null;
  workflowId?: string;
  status?: BulkCampaignDispatchStatus;
  audienceFingerprint?: string;
  overlap?: BulkCampaignAudienceOverlapInfo;
  temporalDispatchStaging?: string;
  batchPlan?: BulkCampaignDispatchBatchPlan;
};

export type GeneratedBulkSendChild = {
  partitionKey: string;
  channel: BulkCampaignChannel;
  sourceId: string | null;
  campaignId: string;
  dispatchId: string;
  workflowId: string;
  status: BulkCampaignDispatchStatus;
  total: number;
  skippedRecipientCount: number;
  batchPlan: BulkCampaignDispatchBatchPlan;
  temporalDispatchStaging: "inline" | "gcs" | "existing";
  audience: {
    fingerprint: string;
    requestedTotal: number;
    queuedTotal: number;
    skippedOptIn: number;
    overlap?: BulkCampaignAudienceOverlapInfo;
  };
  audienceConfirmation: {
    required: boolean;
    confirmed: boolean;
    fingerprint: string;
  };
};

export type GeneratedBulkSendScenarioUpdate = {
  nodeId: string;
  bulkRootConfigPatch: Required<
    Pick<
      ScenarioBulkRootConfig,
      "sendStatus" | "generatedSendState" | "generatedRecipientCount"
    >
  >;
  scenarioUpdatedAt: string;
};

export type BulkCampaignSendResponse = {
  code?: string;
  error?: string;
  operationDisposition?: "not_started" | "in_progress" | "completed";
  queued?: boolean;
  noOp?: boolean;
  scheduled?: boolean;
  total?: number;
  successful?: number;
  failed?: number;
  results?: unknown[];
  campaignId?: string | null;
  /** Immutable dispatch identity; currently equal to campaignId. */
  dispatchId?: string | null;
  workflowId?: string;
  temporalDispatchStaging?: string;
  batchPlan?: BulkCampaignDispatchBatchPlan;
  idempotentReplay?: boolean;
  status?: BulkCampaignDispatchStatus;
  audience?: {
    fingerprint: string;
    requestedTotal: number;
    queuedTotal: number;
    skippedOptIn: number;
    overlap?: BulkCampaignAudienceOverlapInfo;
  };
  audienceConfirmation?: {
    required: boolean;
    confirmed: boolean;
    fingerprint?: string;
  };
  overflowQueue?: {
    required?: boolean;
    confirmed?: boolean;
    recipientCount: number;
    dailyLimit: number;
    exceedsDailyLimit: boolean;
    waveCount: number;
    firstWaveCount: number;
    queuedCount: number;
    lastWaveAt: string | null;
  };
  retry?: {
    kind?: "failed_only" | "send_again";
    providerCircuit?: {
      state: "open" | "closed";
      provider?: string;
      code?: string;
      requiresAcknowledgement?: boolean;
    };
  };
  skippedRecipientCount?: number;
  skippedOptIn?: number;
  skippedPriorFailed?: number;
  skippedServiceWindow?: number;
  marketingOptInWarningCount?: number;
  marketingOptInWarningPhones?: string[];
  requestedTotal?: number;
  requestedAt?: string;
  scheduledAt?: string | null;
  scenarioStatus?: string;
  /** Send turned the scenario on; present only on the send that did it. */
  scenarioActivated?: boolean;
  /** Scenario revision committed by that activation, for the editor to adopt. */
  scenarioUpdatedAt?: string;
  /** Revision the activation replaced; the editor adopts only from it. */
  previousScenarioUpdatedAt?: string;
  scenarioId?: string;
  children?: GeneratedBulkSendChild[];
  childrenTotal?: number;
  childrenTruncated?: boolean;
  partial?: boolean;
  retryable?: boolean;
  failedPartitionKey?: string;
  skippedRecipientDetails?: Array<{
    messageId?: string;
    reason: string;
    detail?: string;
  }>;
  skippedRecipientDetailsTotal?: number;
  skippedRecipientDetailsTruncated?: boolean;
  scenarioUpdate?: GeneratedBulkSendScenarioUpdate;
  message?: string;
};
