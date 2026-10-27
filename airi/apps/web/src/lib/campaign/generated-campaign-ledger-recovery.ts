import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import { SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES } from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";

import {
  AdmittedCampaignLedgerRecoveryAmbiguousError,
  recoverAdmittedCampaignDispatch,
} from "./admitted-campaign-ledger-recovery";
import type { BulkCampaignPolicyAdmissionMetadata } from "./bulk-campaign-admission";
import { serializeStableJson } from "./bulk-campaign-content-hash";
import { deriveBulkSendChildCampaignId } from "./bulk-send-api-idempotency";
import type { CampaignStoreClient } from "./campaign-history-store";
import {
  advanceGeneratedRecipientAudience,
  createGeneratedRecipientAudience,
  generatedRecipientAudiencesEqual,
  normalizeGeneratedRecipientAudience,
  type GeneratedRecipientAudience,
} from "./generated-recipient-audience";

const GENERATED_EXECUTION_SOURCE = "scenario_run_now";
const GENERATED_AUDIENCE_SOURCE_TYPE = "scenario_generated";

type GeneratedRecoveryChannel = "whatsapp" | "telegram" | "email";

type GeneratedPolicyMetadataHistoryRow = {
  audience_metadata?: unknown;
};

type GeneratedPolicyMetadataHistoryQuery = {
  eq: (column: string, value: string) => GeneratedPolicyMetadataHistoryQuery;
  maybeSingle: () => Promise<{
    data?: GeneratedPolicyMetadataHistoryRow | null;
    error?: { message?: string | null } | null;
  }>;
};

type GeneratedPolicyMetadataHistoryTable = {
  select: (columns: string) => GeneratedPolicyMetadataHistoryQuery;
};

const GENERATED_POLICY_METADATA_KEYS = [
  "policy",
  "authoritativeRecipientLimit",
  "outcome",
  "batchPlan",
  "requestDigest",
] as const;

export type GeneratedChildCampaignRecoveryResult =
  | { status: "not_admitted" }
  | {
      status: "admitted";
      campaign: {
        campaignId: string;
        workspaceId: string;
        scenarioId: string;
        scenarioNodeId: string;
        sentBy: string;
        channel: GeneratedRecoveryChannel;
        dispatchStatus:
          | "queued"
          | "scheduled"
          | "running"
          | "completed"
          | "failed"
          | "expired"
          | "cancelled";
        workflowId: string;
        totalRecipients: number;
        requestedAt: string;
        scheduledAt: string | null;
        dispatchExpiresAt: string;
        contentHash: string;
        audience: {
          count: number;
          fingerprint: string;
          hashVersion: string;
          sourceType: "scenario_generated";
        };
      };
      admittedAudience: GeneratedRecipientAudience;
      admittedItems: BulkCampaignDispatchItem[];
    };

export class GeneratedChildCampaignRecoveryAmbiguousError extends Error {
  readonly code = "generated_child_campaign_recovery_ambiguous";

  constructor(message: string) {
    super(message);
    this.name = "GeneratedChildCampaignRecoveryAmbiguousError";
  }
}

function failAmbiguous(message: string): never {
  throw new GeneratedChildCampaignRecoveryAmbiguousError(message);
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    failAmbiguous(`Generated child recovery ${label} is invalid`);
  }
  return normalized;
}

function advanceAudienceFromItems(
  items: BulkCampaignDispatchItem[]
): GeneratedRecipientAudience {
  let audience = createGeneratedRecipientAudience();
  const seenMessageIds = new Set<string>();
  for (let offset = 0; offset < items.length; offset += 1000) {
    const messageIds = items
      .slice(offset, offset + 1000)
      .map(item =>
        requiredIdentifier(
          item.generatedRecipientMessageId,
          "snapshot generated message ID"
        )
      );
    if (messageIds.some(messageId => seenMessageIds.has(messageId))) {
      failAmbiguous(
        "Generated child recovery snapshot message identity is ambiguous"
      );
    }
    messageIds.forEach(messageId => seenMessageIds.add(messageId));
    audience = advanceGeneratedRecipientAudience(audience, messageIds);
  }
  return audience;
}

async function assertGeneratedPolicyMetadataCompatibility(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  campaignId: string;
  expectedPolicyMetadata: BulkCampaignPolicyAdmissionMetadata | null;
}): Promise<void> {
  const result = await (
    params.supabase.from(
      "campaign_history"
    ) as GeneratedPolicyMetadataHistoryTable
  )
    .select("audience_metadata")
    .eq("id", params.campaignId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (result.error || !result.data) {
    failAmbiguous(
      `Generated child recovery policy metadata read failed: ${
        result.error?.message?.trim() || "history disappeared"
      }`
    );
  }
  const metadata = isRecord(result.data.audience_metadata)
    ? result.data.audience_metadata
    : {};
  const presentKeys = GENERATED_POLICY_METADATA_KEYS.filter(key =>
    Object.prototype.hasOwnProperty.call(metadata, key)
  );
  if (params.expectedPolicyMetadata === null) {
    if (presentKeys.length !== 0) {
      failAmbiguous(
        "Generated child recovery policy admission metadata does not match compatibility"
      );
    }
    return;
  }
  if (presentKeys.length !== GENERATED_POLICY_METADATA_KEYS.length) {
    failAmbiguous(
      "Generated child recovery policy admission metadata does not match compatibility"
    );
  }
  const recoveredPolicyMetadata = Object.fromEntries(
    GENERATED_POLICY_METADATA_KEYS.map(key => [key, metadata[key]])
  );
  if (
    serializeStableJson(recoveredPolicyMetadata) !==
    serializeStableJson(params.expectedPolicyMetadata)
  ) {
    failAmbiguous(
      "Generated child recovery policy admission metadata does not match compatibility"
    );
  }
}

export async function recoverGeneratedChildCampaignAdmission(params: {
  supabase: CampaignStoreClient;
  workspaceId: string;
  scenarioId: string;
  scenarioNodeId: string;
  parentOperationId: string;
  partitionKey: string;
  campaignId: string;
  channel: GeneratedRecoveryChannel;
  /**
   * Exact ordered audience after the queue owner's canonical normalization.
   * It must describe the IDs assigned in Mongo and persisted in SQL.
   */
  assignedAudience: GeneratedRecipientAudience;
  /**
   * Omit only when recovering an already-admitted child before provider
   * rehydration. The SQL history hash and immutable snapshots remain the
   * authoritative content proof.
   */
  expectedContentHash?: string;
  /**
   * Current-v2 children require the exact canonical five-key group. Legacy-v1
   * children pass null and must retain the historical exact zero-key shape.
   */
  expectedPolicyMetadata: BulkCampaignPolicyAdmissionMetadata | null;
  pageSize?: number;
}): Promise<GeneratedChildCampaignRecoveryResult> {
  const workspaceId = requiredIdentifier(params.workspaceId, "workspace ID");
  const scenarioId = requiredIdentifier(params.scenarioId, "scenario ID");
  const scenarioNodeId = requiredIdentifier(
    params.scenarioNodeId,
    "scenario node ID"
  );
  const parentOperationId = requiredIdentifier(
    params.parentOperationId,
    "parent operation ID"
  );
  const partitionKey = requiredIdentifier(params.partitionKey, "partition key");
  const campaignId = requiredIdentifier(params.campaignId, "child campaign ID");
  const channel = requiredIdentifier(
    params.channel,
    "channel"
  ) as GeneratedRecoveryChannel;
  if (channel !== "whatsapp" && channel !== "telegram" && channel !== "email") {
    failAmbiguous("Generated child recovery channel is invalid");
  }
  if (
    deriveBulkSendChildCampaignId(parentOperationId, partitionKey) !==
    campaignId
  ) {
    failAmbiguous("Generated child recovery campaign ID is not deterministic");
  }
  let assignedAudience: GeneratedRecipientAudience;
  try {
    assignedAudience = normalizeGeneratedRecipientAudience(
      params.assignedAudience
    );
  } catch {
    failAmbiguous("Generated child recovery assigned audience is invalid");
  }
  if (
    assignedAudience.count <= 0 ||
    assignedAudience.count > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES
  ) {
    failAmbiguous("Generated child recovery assigned audience is invalid");
  }

  let recovered;
  try {
    recovered = await recoverAdmittedCampaignDispatch({
      supabase: params.supabase,
      workspaceId,
      campaignId,
      expectedRecipientCount: assignedAudience.count,
      maxRecipients: SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES,
      expectedChannel: channel,
      expectedScenarioId: scenarioId,
      expectedScenarioNodeId: scenarioNodeId,
      expectedExecutionSource: GENERATED_EXECUTION_SOURCE,
      expectedAudienceSourceType: GENERATED_AUDIENCE_SOURCE_TYPE,
      expectedContentHash: params.expectedContentHash,
      pageSize: params.pageSize,
    });
  } catch (error) {
    if (error instanceof AdmittedCampaignLedgerRecoveryAmbiguousError) {
      failAmbiguous(
        error.message.replace(
          /^Admitted campaign recovery /,
          "Generated child recovery "
        )
      );
    }
    throw error;
  }
  if (recovered.status === "not_admitted") return recovered;
  await assertGeneratedPolicyMetadataCompatibility({
    supabase: params.supabase,
    workspaceId,
    campaignId,
    expectedPolicyMetadata: params.expectedPolicyMetadata,
  });
  const admittedAudience = advanceAudienceFromItems(recovered.admittedItems);
  if (!generatedRecipientAudiencesEqual(admittedAudience, assignedAudience)) {
    failAmbiguous(
      "Generated child recovery message audience is incomplete or foreign"
    );
  }
  for (const item of recovered.admittedItems) {
    if (
      requiredIdentifier(item.scenarioId, "snapshot scenario ID") !==
        scenarioId ||
      !requiredIdentifier(item.scenarioNodeId, "snapshot recipient node ID")
    ) {
      failAmbiguous(
        "Generated child recovery immutable dispatch snapshot is foreign"
      );
    }
  }
  const { campaign } = recovered;
  if (
    campaign.scenarioId !== scenarioId ||
    campaign.scenarioNodeId !== scenarioNodeId ||
    campaign.executionSource !== GENERATED_EXECUTION_SOURCE ||
    campaign.audience.sourceType !== GENERATED_AUDIENCE_SOURCE_TYPE
  ) {
    failAmbiguous("Generated child recovery history identity is foreign");
  }
  return {
    status: "admitted",
    campaign: {
      campaignId: campaign.campaignId,
      workspaceId: campaign.workspaceId,
      scenarioId,
      scenarioNodeId,
      sentBy: campaign.sentBy,
      channel,
      dispatchStatus: campaign.dispatchStatus,
      workflowId: campaign.workflowId,
      totalRecipients: campaign.totalRecipients,
      requestedAt: campaign.requestedAt,
      scheduledAt: campaign.scheduledAt,
      dispatchExpiresAt: campaign.dispatchExpiresAt,
      contentHash: campaign.contentHash,
      audience: {
        count: campaign.audience.count,
        fingerprint: campaign.audience.fingerprint,
        hashVersion: campaign.audience.hashVersion,
        sourceType: GENERATED_AUDIENCE_SOURCE_TYPE,
      },
    },
    admittedAudience,
    admittedItems: recovered.admittedItems,
  };
}
