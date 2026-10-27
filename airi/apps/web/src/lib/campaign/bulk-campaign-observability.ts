import "server-only";

import {
  BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES,
  type BulkCampaignDispatchExecutionSource,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignSkipReason,
  type BulkCampaignSuccessOutcome,
} from "@icecore/scenario-contracts";
import type { AdmittedBulkCampaignReplay } from "./bulk-campaign-admission";
import { z } from "zod";

type BulkCampaignPolicyLogger = {
  info(message: string, context?: Record<string, unknown>): unknown;
};

type AggregateCounts = {
  requested: number;
  accepted: number;
  queued: number;
};

export type BulkCampaignPolicyEvent = {
  workspaceId: string;
  channel: "whatsapp" | "telegram" | "email";
  messageKind: "template" | "service_text" | "telegram" | "email";
  executionSource: BulkCampaignDispatchExecutionSource;
  scenarioId?: string | null;
  rootNodeId?: string | null;
  itemCounts: AggregateCounts;
  uniqueRecipientCounts: AggregateCounts;
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  disposition: "queued" | "scheduled" | "no_op" | "blocked" | "failed";
  lifecycleStatus?:
    | "queued"
    | "scheduled"
    | "running"
    | "completed"
    | "failed"
    | "expired"
    | "cancelled"
    | null;
  planLimit: {
    source: "live_meta" | "cached_meta" | "channel_default" | "unavailable";
    value: number | null;
  };
  policy: BulkCampaignRecipientPolicy;
  errorCode?: string | null;
  idempotentReplay: boolean;
};

export type BulkCampaignLegacyReplayEvent = Pick<
  BulkCampaignPolicyEvent,
  | "workspaceId"
  | "itemCounts"
  | "uniqueRecipientCounts"
  | "skippedByReason"
  | "warnings"
  | "disposition"
  | "lifecycleStatus"
> & {
  factsUnavailable: "legacy_response_only";
  idempotentReplay: true;
};

export type BulkCampaignTerminalReplayFactsUnavailableEvent = {
  workspaceId: string;
  factsUnavailable: "terminal_replay";
  errorCode: "bulk_campaign_terminal_replay";
  idempotentReplay: true;
};

export type BulkCampaignPersistedPolicyEventFacts = Omit<
  BulkCampaignPolicyEvent,
  "workspaceId" | "idempotentReplay"
>;

export function createBulkCampaignAdmittedReplayPolicyEventFacts(input: {
  replay: Pick<
    AdmittedBulkCampaignReplay,
    | "channel"
    | "messageKind"
    | "executionSource"
    | "scenarioId"
    | "rootNodeId"
    | "planLimit"
    | "policy"
  >;
  outcome: BulkCampaignSuccessOutcome;
}): BulkCampaignPersistedPolicyEventFacts {
  return {
    channel: input.replay.channel,
    messageKind: input.replay.messageKind,
    executionSource: input.replay.executionSource,
    scenarioId: input.replay.scenarioId,
    rootNodeId: input.replay.rootNodeId,
    itemCounts: {
      requested: input.outcome.requestedTotal,
      accepted: input.outcome.acceptedTotal,
      queued: input.outcome.queuedTotal,
    },
    uniqueRecipientCounts: {
      requested: input.outcome.uniqueRecipients.requested,
      accepted: input.outcome.uniqueRecipients.accepted,
      queued: input.outcome.uniqueRecipients.queued,
    },
    skippedByReason: input.outcome.skippedByReason,
    warnings: input.outcome.warnings,
    disposition: input.outcome.disposition,
    lifecycleStatus: input.outcome.lifecycleStatus,
    planLimit: input.replay.planLimit,
    policy: input.replay.policy,
  };
}

export function createBulkCampaignTerminalReplayPolicyEvent(input: {
  replay: Pick<
    AdmittedBulkCampaignReplay,
    | "workspaceId"
    | "channel"
    | "messageKind"
    | "executionSource"
    | "scenarioId"
    | "rootNodeId"
    | "planLimit"
    | "policy"
  >;
  outcome: BulkCampaignSuccessOutcome;
  dispatchStatus: "completed" | "failed" | "expired" | "cancelled";
}): BulkCampaignPolicyEvent {
  const replayFacts = createBulkCampaignAdmittedReplayPolicyEventFacts(input);
  return {
    ...replayFacts,
    workspaceId: input.replay.workspaceId,
    itemCounts: {
      requested: replayFacts.itemCounts.requested,
      accepted: replayFacts.itemCounts.accepted,
      queued: 0,
    },
    uniqueRecipientCounts: {
      requested: replayFacts.uniqueRecipientCounts.requested,
      accepted: replayFacts.uniqueRecipientCounts.accepted,
      queued: 0,
    },
    disposition: "blocked",
    lifecycleStatus: input.dispatchStatus,
    errorCode: "bulk_campaign_terminal_replay",
    idempotentReplay: true,
  };
}

export function createBulkCampaignTerminalReplayFactsUnavailableEvent(input: {
  workspaceId: string;
}): BulkCampaignTerminalReplayFactsUnavailableEvent {
  return {
    workspaceId: input.workspaceId,
    factsUnavailable: "terminal_replay",
    errorCode: "bulk_campaign_terminal_replay",
    idempotentReplay: true,
  };
}

const AggregateCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const AggregateCountsSchema = z
  .object({
    requested: AggregateCountSchema,
    accepted: AggregateCountSchema,
    queued: AggregateCountSchema,
  })
  .strict();
const AggregateIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9:_-]+$/);
const SkippedByReasonSchema = z
  .object({
    ineligible: AggregateCountSchema.optional(),
    marketing_opt_out: AggregateCountSchema.optional(),
    recipient_limit: AggregateCountSchema.optional(),
    prior_failure: AggregateCountSchema.optional(),
    service_window: AggregateCountSchema.optional(),
    unsubscribed: AggregateCountSchema.optional(),
    recent_contact: AggregateCountSchema.optional(),
  })
  .strict();
const PlanLimitSchema = z
  .object({
    source: z.enum([
      "live_meta",
      "cached_meta",
      "channel_default",
      "unavailable",
    ]),
    value: AggregateCountSchema.nullable(),
  })
  .strict()
  .refine(
    value =>
      value.source === "unavailable"
        ? value.value === null
        : value.value !== null && value.value > 0,
    "Persisted policy event plan limit is inconsistent"
  );
const PersistedPolicyEventFactsSchema = z
  .object({
    channel: z.enum(["whatsapp", "telegram", "email"]),
    messageKind: z.enum(["template", "service_text", "telegram", "email"]),
    executionSource: z.enum(
      BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES as unknown as [
        "scenario_schedule",
        "scenario_run_now",
        "ad_hoc",
      ]
    ),
    scenarioId: AggregateIdentifierSchema.nullable().optional(),
    rootNodeId: AggregateIdentifierSchema.nullable().optional(),
    itemCounts: AggregateCountsSchema,
    uniqueRecipientCounts: AggregateCountsSchema,
    skippedByReason: SkippedByReasonSchema,
    warnings: z
      .object({ missingMarketingConsent: AggregateCountSchema })
      .strict(),
    disposition: z.enum(["queued", "scheduled", "no_op", "blocked", "failed"]),
    lifecycleStatus: z
      .enum([
        "queued",
        "scheduled",
        "running",
        "completed",
        "failed",
        "expired",
        "cancelled",
      ])
      .nullable()
      .optional(),
    planLimit: PlanLimitSchema,
    policy: z
      .object({
        version: z.literal(1),
        excludePriorFailedBulkSends: z.boolean(),
      })
      .strict(),
    errorCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_:-]+$/)
      .nullable()
      .optional(),
  })
  .strict();

export function parseBulkCampaignPersistedPolicyEventFacts(
  value: unknown
): BulkCampaignPersistedPolicyEventFacts | null {
  const parsed = PersistedPolicyEventFactsSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as BulkCampaignPersistedPolicyEventFacts)
    : null;
}

function isBulkCampaignLegacyReplayEvent(
  event:
    | BulkCampaignPolicyEvent
    | BulkCampaignLegacyReplayEvent
    | BulkCampaignTerminalReplayFactsUnavailableEvent
): event is BulkCampaignLegacyReplayEvent {
  return (
    "factsUnavailable" in event &&
    event.factsUnavailable === "legacy_response_only"
  );
}

function isBulkCampaignTerminalReplayFactsUnavailableEvent(
  event:
    | BulkCampaignPolicyEvent
    | BulkCampaignLegacyReplayEvent
    | BulkCampaignTerminalReplayFactsUnavailableEvent
): event is BulkCampaignTerminalReplayFactsUnavailableEvent {
  return (
    "factsUnavailable" in event && event.factsUnavailable === "terminal_replay"
  );
}

export function emitBulkCampaignPolicyEvent(
  logger: BulkCampaignPolicyLogger,
  event:
    | BulkCampaignPolicyEvent
    | BulkCampaignLegacyReplayEvent
    | BulkCampaignTerminalReplayFactsUnavailableEvent
): void {
  if (isBulkCampaignTerminalReplayFactsUnavailableEvent(event)) {
    const context: BulkCampaignTerminalReplayFactsUnavailableEvent = {
      workspaceId: event.workspaceId,
      factsUnavailable: "terminal_replay",
      errorCode: "bulk_campaign_terminal_replay",
      idempotentReplay: true,
    };
    logger.info("bulk_campaign.policy", context);
    return;
  }
  const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> = {};
  for (const reason of [
    "ineligible",
    "marketing_opt_out",
    "recipient_limit",
    "prior_failure",
    "service_window",
    "unsubscribed",
    "recent_contact",
  ] as const satisfies readonly BulkCampaignSkipReason[]) {
    if (event.skippedByReason[reason] !== undefined) {
      skippedByReason[reason] = event.skippedByReason[reason];
    }
  }
  if (isBulkCampaignLegacyReplayEvent(event)) {
    const context: BulkCampaignLegacyReplayEvent = {
      workspaceId: event.workspaceId,
      factsUnavailable: "legacy_response_only",
      itemCounts: {
        requested: event.itemCounts.requested,
        accepted: event.itemCounts.accepted,
        queued: event.itemCounts.queued,
      },
      uniqueRecipientCounts: {
        requested: event.uniqueRecipientCounts.requested,
        accepted: event.uniqueRecipientCounts.accepted,
        queued: event.uniqueRecipientCounts.queued,
      },
      skippedByReason,
      warnings: {
        missingMarketingConsent: event.warnings.missingMarketingConsent,
      },
      disposition: event.disposition,
      ...(event.lifecycleStatus
        ? { lifecycleStatus: event.lifecycleStatus }
        : {}),
      idempotentReplay: true,
    };
    logger.info("bulk_campaign.policy", context);
    return;
  }
  const context: BulkCampaignPolicyEvent = {
    workspaceId: event.workspaceId,
    channel: event.channel,
    messageKind: event.messageKind,
    executionSource: event.executionSource,
    ...(event.scenarioId ? { scenarioId: event.scenarioId } : {}),
    ...(event.rootNodeId ? { rootNodeId: event.rootNodeId } : {}),
    itemCounts: {
      requested: event.itemCounts.requested,
      accepted: event.itemCounts.accepted,
      queued: event.itemCounts.queued,
    },
    uniqueRecipientCounts: {
      requested: event.uniqueRecipientCounts.requested,
      accepted: event.uniqueRecipientCounts.accepted,
      queued: event.uniqueRecipientCounts.queued,
    },
    skippedByReason,
    warnings: {
      missingMarketingConsent: event.warnings.missingMarketingConsent,
    },
    disposition: event.disposition,
    ...(event.lifecycleStatus
      ? { lifecycleStatus: event.lifecycleStatus }
      : {}),
    planLimit: {
      source: event.planLimit.source,
      value: event.planLimit.value,
    },
    policy: {
      version: event.policy.version,
      excludePriorFailedBulkSends: event.policy.excludePriorFailedBulkSends,
    },
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    idempotentReplay: event.idempotentReplay,
  };
  logger.info("bulk_campaign.policy", context);
}
