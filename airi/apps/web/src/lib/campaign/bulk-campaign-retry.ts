import {
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES,
  type BulkCampaignDispatchExecutionSource,
} from "@icecore/scenario-contracts";
import {
  buildBulkCampaignDispatchLogicalRecipientKey,
  type BulkCampaignDispatchItem,
} from "@icecore/temporal";
import { z } from "zod";
import {
  classifyMetaMessageFailureScope,
  isMetaProviderRestrictionCode,
} from "@icecore/shared/lib/meta/message-failure-scope";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

import type {
  CampaignFailedSnapshotForRetry,
  CampaignRetryPreparation,
} from "./campaign-history-store";
import {
  classifyBulkCampaignProviderCircuit,
  type BulkCampaignProviderCircuitResult,
} from "./bulk-campaign-safety";
import type { BulkCampaignChannel } from "./bulk-campaign-contracts";

const nullableText = z.string().optional().nullable();
const executionSourceSchema = z.enum(
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES as unknown as [
    BulkCampaignDispatchExecutionSource,
    ...BulkCampaignDispatchExecutionSource[],
  ]
);
const baseShape = {
  workspaceId: z.string().uuid(),
  snapshotOrdinal: z.number().int().nonnegative().optional(),
  campaignId: z.string().uuid(),
  scenarioId: nullableText,
  scenarioNodeId: nullableText,
  generatedRecipientMessageId: nullableText,
  executionSource: executionSourceSchema.optional(),
  sentByUserId: nullableText,
};
const stringRecord = z.record(z.string());

const whatsAppTemplateSnapshotSchema = z
  .object({
    ...baseShape,
    channel: z.literal("whatsapp"),
    whatsappMessageType: z.literal("template").optional(),
    sourceId: z.string().min(1).optional(),
    recipient: z
      .object({
        phone: z.string().min(1),
        email: z.string().optional(),
      })
      .strict(),
    phoneNumberId: z.string().min(1),
    marketingMessagePricing: z
      .object({
        perMessageBidMultiplier: z.number().positive().finite().optional(),
      })
      .strict()
      .optional(),
    templateName: z.string().min(1),
    languageCode: z.string().min(1).optional(),
    templateCategory: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
    components: z.array(z.unknown()).optional(),
  })
  .strict();

const whatsAppServiceTextSnapshotSchema = z
  .object({
    ...baseShape,
    channel: z.literal("whatsapp"),
    whatsappMessageType: z.literal("service_text"),
    sourceId: z.string().min(1),
    recipient: z
      .object({
        phone: z.string().min(1),
        email: z.string().optional(),
      })
      .strict(),
    phoneNumberId: z.string().min(1),
    messageText: z.string().min(1).max(4096),
    serviceWindowExpiresAt: z.string().datetime(),
  })
  .strict();

const telegramSnapshotSchema = z
  .object({
    ...baseShape,
    channel: z.literal("telegram"),
    sourceId: z.string().min(1),
    businessConnectionId: z.string().min(1).optional(),
    recipient: z
      .object({
        chatId: z.string().min(1),
      })
      .strict(),
    messageText: z.string().min(1),
  })
  .strict();

const emailContentSchema = z
  .object({
    format: z.literal("markdown"),
    subject: z.string().min(1),
    markdown: z.string().min(1),
  })
  .strict();

const emailSnapshotSchema = z
  .object({
    ...baseShape,
    channel: z.literal("email"),
    recipient: z
      .object({
        email: z.string().email(),
        variables: stringRecord.optional(),
      })
      .strict(),
    fromAddress: z.string().min(1).optional(),
    templateKey: z
      .enum(["announcement", "product_update", "event_reminder"])
      .optional(),
    templateModel: stringRecord.optional(),
    subjectOverride: z.string().optional(),
    emailContent: emailContentSchema.optional(),
    messageStream: z.string().min(1).optional(),
  })
  .strict();

const retrySnapshotSchema = z.union([
  whatsAppTemplateSnapshotSchema,
  whatsAppServiceTextSnapshotSchema,
  telegramSnapshotSchema,
  emailSnapshotSchema,
]);

type RetrySnapshotExpectation = {
  workspaceId: string;
  campaignId: string;
  channel: BulkCampaignChannel;
  recipient: string;
  snapshotOrdinal?: number;
};

function withoutAudienceLedgerMetadata(
  snapshot: unknown
): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Campaign immutable dispatch snapshot is invalid.");
  }
  const dispatchSnapshot = {
    ...(snapshot as Record<string, unknown>),
  };
  delete dispatchSnapshot._audience_upload;
  return dispatchSnapshot;
}

export function parseBulkCampaignRetryDispatchItem(
  snapshot: unknown,
  expected: RetrySnapshotExpectation
): BulkCampaignDispatchItem {
  const parsed = retrySnapshotSchema.safeParse(
    withoutAudienceLedgerMetadata(snapshot)
  );
  if (!parsed.success) {
    throw new Error("Campaign immutable dispatch snapshot is invalid.");
  }
  const item = parsed.data as BulkCampaignDispatchItem;
  const logicalRecipient = buildBulkCampaignDispatchLogicalRecipientKey(item);
  if (
    item.workspaceId !== expected.workspaceId ||
    item.campaignId !== expected.campaignId ||
    item.channel !== expected.channel ||
    logicalRecipient !== expected.recipient ||
    (expected.snapshotOrdinal !== undefined &&
      item.snapshotOrdinal !== undefined &&
      item.snapshotOrdinal !== expected.snapshotOrdinal)
  ) {
    throw new Error("Campaign immutable dispatch snapshot is invalid.");
  }
  if (
    item.channel === "whatsapp" &&
    normalizeWhatsAppPhone(item.recipient.phone) !== expected.recipient
  ) {
    throw new Error("Campaign immutable dispatch snapshot is invalid.");
  }
  // Failed-only SQL admission proves an exact snapshot multiset. Validate the
  // destination here, but preserve its original formatting until transport
  // normalization so a retry cannot rewrite historical dispatch intent.
  return item;
}

export function parseBulkCampaignRetryDispatchItems(
  entries: Array<{
    row: CampaignFailedSnapshotForRetry;
    expected: Omit<RetrySnapshotExpectation, "recipient">;
  }>
): BulkCampaignDispatchItem[] {
  const ordinals = new Set<number>();
  return entries.map(({ row, expected }) => {
    if (
      row.campaignId !== expected.campaignId ||
      row.channel !== expected.channel ||
      !Number.isInteger(row.snapshotOrdinal) ||
      row.snapshotOrdinal < 0 ||
      ordinals.has(row.snapshotOrdinal)
    ) {
      throw new Error(
        "Campaign duplicate immutable dispatch snapshot is invalid."
      );
    }
    const item = parseBulkCampaignRetryDispatchItem(row.dispatchSnapshot, {
      ...expected,
      recipient: row.recipient,
      snapshotOrdinal: row.snapshotOrdinal,
    });
    ordinals.add(row.snapshotOrdinal);
    return {
      ...item,
      snapshotOrdinal: row.snapshotOrdinal,
    } as BulkCampaignDispatchItem;
  });
}

type StoredProviderCircuit =
  CampaignRetryPreparation["source"]["providerCircuit"];

export function classifyBulkCampaignRetryProviderCircuit(params: {
  totalRecipients: number;
  failedSnapshots: Array<{
    providerFailure: CampaignFailedSnapshotForRetry["providerFailure"];
  }>;
  storedCircuit: StoredProviderCircuit;
}): BulkCampaignProviderCircuitResult {
  // Older campaigns may have finished before asynchronous restriction callbacks
  // could open their stored circuit. A known Meta provider code is authoritative
  // even when other recipients succeeded or older scope metadata was incorrect.
  const metaFailureCounts = new Map<string, number>();
  for (const { providerFailure } of params.failedSnapshots) {
    const code = String(providerFailure.code ?? "").trim();
    if (
      providerFailure.provider?.trim().toLowerCase() === "meta" &&
      isMetaProviderRestrictionCode(code)
    ) {
      metaFailureCounts.set(code, (metaFailureCounts.get(code) || 0) + 1);
    }
  }
  const dominantMetaFailure = [...metaFailureCounts.entries()].sort(
    ([leftCode, leftCount], [rightCode, rightCount]) =>
      rightCount - leftCount || leftCode.localeCompare(rightCode)
  )[0];
  const currentCircuit: BulkCampaignProviderCircuitResult = dominantMetaFailure
    ? {
        state: "open",
        provider: "meta",
        code: dominantMetaFailure[0],
        failureCount: dominantMetaFailure[1],
      }
    : classifyBulkCampaignProviderCircuit({
        batchStatus:
          params.failedSnapshots.length === params.totalRecipients
            ? "completed"
            : "incomplete",
        results: params.failedSnapshots.map(snapshot => ({
          success: false,
          failureScope:
            snapshot.providerFailure.provider?.trim().toLowerCase() === "meta"
              ? classifyMetaMessageFailureScope(snapshot.providerFailure.code)
              : snapshot.providerFailure.scope === "provider"
                ? "provider"
                : snapshot.providerFailure.scope === "recipient"
                  ? "recipient"
                  : "unknown",
          provider: snapshot.providerFailure.provider,
          code:
            snapshot.providerFailure.code === null
              ? null
              : String(snapshot.providerFailure.code),
        })),
      });

  if (params.storedCircuit.state !== "open") {
    return currentCircuit;
  }
  const provider =
    params.storedCircuit.provider?.trim().toLowerCase() ||
    (currentCircuit.state === "open" ? currentCircuit.provider : null);
  const code =
    params.storedCircuit.code?.trim() ||
    (currentCircuit.state === "open" ? currentCircuit.code : null);
  if (!provider || !code || params.failedSnapshots.length < 1) {
    throw new Error("Campaign provider circuit metadata is invalid.");
  }
  return {
    state: "open",
    provider,
    code,
    failureCount: params.failedSnapshots.length,
  };
}
