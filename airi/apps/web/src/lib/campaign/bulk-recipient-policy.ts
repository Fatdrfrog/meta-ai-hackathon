import {
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignRecipientPolicy,
  type BulkCampaignSkipReason,
} from "@icecore/scenario-contracts";
import {
  MAX_BULK_CAMPAIGN_RECIPIENTS,
  type BulkCampaignRecipient,
} from "./bulk-campaign-contracts";
import { canonicalizeBulkCampaignRecipientIdentity } from "./bulk-campaign-safety";
import { partitionRecentlyContactedRecipients } from "./customer-contact-policy";
import {
  filterKnownMarketingOptOutRecipients,
  type MarketingConsentFilterResult,
} from "./marketing-opt-in";
import { filterPriorFailedBulkCampaignCandidates } from "./prior-failed-recipient-filter";

export type BulkRecipientPolicyCandidate<T> = {
  value: T;
  stableId: string;
  recipient: BulkCampaignRecipient;
  templateCategory: "MARKETING" | "UTILITY" | "AUTHENTICATION";
};

export type BulkRecipientPolicyEvaluation<T> = {
  retained: BulkRecipientPolicyCandidate<T>[];
  excluded: Array<{
    candidate: BulkRecipientPolicyCandidate<T>;
    reason: PolicyExclusionReason;
  }>;
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  warnings: { missingMarketingConsent: number };
  warningStableIds?: Readonly<
    Partial<Record<"missing_marketing_consent", readonly string[]>>
  >;
  uniqueRecipients: { requested: number; accepted: number };
};

export type BulkRecipientPolicyCompletenessProof = {
  complete: true;
  uniqueRecipients: number;
  dispatchItems: number;
  uniqueRecipientHardCap: number;
  dispatchItemHardCap: number;
};

export type BulkRecipientPolicyInput<T> = {
  workspaceId: string;
  channel: "whatsapp";
  candidates: readonly BulkRecipientPolicyCandidate<T>[];
  recipientLimit: number;
  completeness: BulkRecipientPolicyCompletenessProof;
  policy: BulkCampaignRecipientPolicy;
  /** When contact windows are judged; defaults to now. */
  now?: Date;
  priorFailure?: {
    client: Parameters<
      typeof filterPriorFailedBulkCampaignCandidates
    >[0]["client"];
    secret: string;
  };
};

export type BulkRecipientPolicyDependencies = {
  filterMarketingOptOut: typeof filterKnownMarketingOptOutRecipients;
  filterPriorFailed: typeof filterPriorFailedBulkCampaignCandidates;
  partitionRecentContacts: typeof partitionRecentlyContactedRecipients;
};

type BulkRecipientPolicyErrorCode =
  | "unsupported_policy_version"
  | "invalid_recipient_limit"
  | "incomplete_audience"
  | "invalid_completeness_proof"
  | "hard_cap_exceeded"
  | "duplicate_stable_id"
  | "invalid_recipient_identity"
  | "missing_prior_failure_secret"
  | "marketing_consent_lookup_failed"
  | "contact_policy_unavailable"
  | "prior_failure_lookup_failed"
  | "invariant_imbalance";

type PolicyExclusionReason =
  | "marketing_opt_out"
  | "recent_contact"
  | "recipient_limit"
  | "prior_failure";

export class BulkRecipientPolicyError extends Error {
  constructor(
    readonly code: BulkRecipientPolicyErrorCode,
    options?: { cause?: unknown }
  ) {
    super(`Bulk recipient policy failed: ${code}`, options);
    this.name = "BulkRecipientPolicyError";
  }
}

const defaultDependencies: BulkRecipientPolicyDependencies = {
  filterMarketingOptOut: filterKnownMarketingOptOutRecipients,
  filterPriorFailed: filterPriorFailedBulkCampaignCandidates,
  partitionRecentContacts: partitionRecentlyContactedRecipients,
};

function hasValidDeclaredHardCaps(
  completeness: BulkRecipientPolicyCompletenessProof
): boolean {
  return (
    Number.isInteger(completeness.uniqueRecipientHardCap) &&
    completeness.uniqueRecipientHardCap > 0 &&
    completeness.uniqueRecipientHardCap <= MAX_BULK_CAMPAIGN_RECIPIENTS &&
    Number.isInteger(completeness.dispatchItemHardCap) &&
    completeness.dispatchItemHardCap > 0 &&
    completeness.dispatchItemHardCap <= MAX_BULK_CAMPAIGN_RECIPIENTS
  );
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validatePreflight<T>(input: BulkRecipientPolicyInput<T>): string[] {
  if (!input.policy || typeof input.policy !== "object") {
    throw new BulkRecipientPolicyError("unsupported_policy_version");
  }
  let normalizedPolicy: BulkCampaignRecipientPolicy;
  try {
    normalizedPolicy = normalizeBulkCampaignRecipientPolicy(input.policy);
  } catch (error) {
    throw new BulkRecipientPolicyError("unsupported_policy_version", {
      cause: error,
    });
  }
  if (
    normalizedPolicy.version !== input.policy.version ||
    normalizedPolicy.excludePriorFailedBulkSends !==
      input.policy.excludePriorFailedBulkSends
  ) {
    throw new BulkRecipientPolicyError("unsupported_policy_version");
  }
  if (!Number.isInteger(input.recipientLimit) || input.recipientLimit <= 0) {
    throw new BulkRecipientPolicyError("invalid_recipient_limit");
  }

  const completeness =
    input.completeness as BulkRecipientPolicyCompletenessProof;
  if (completeness?.complete !== true) {
    throw new BulkRecipientPolicyError("incomplete_audience");
  }
  if (
    !validNonNegativeInteger(completeness.uniqueRecipients) ||
    !validNonNegativeInteger(completeness.dispatchItems) ||
    !hasValidDeclaredHardCaps(completeness)
  ) {
    throw new BulkRecipientPolicyError("invalid_completeness_proof");
  }
  if (
    completeness.uniqueRecipients > completeness.uniqueRecipientHardCap ||
    completeness.dispatchItems > completeness.dispatchItemHardCap ||
    input.candidates.length > completeness.dispatchItemHardCap
  ) {
    throw new BulkRecipientPolicyError("hard_cap_exceeded");
  }

  const seenStableIds = new Set<string>();
  const identities: string[] = [];
  for (const candidate of input.candidates) {
    if (
      !candidate.stableId ||
      seenStableIds.has(candidate.stableId) ||
      !candidate.recipient ||
      !["MARKETING", "UTILITY", "AUTHENTICATION"].includes(
        candidate.templateCategory
      )
    ) {
      throw new BulkRecipientPolicyError("duplicate_stable_id");
    }
    seenStableIds.add(candidate.stableId);
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: input.channel,
      recipient: candidate.recipient,
    });
    if (!identity) {
      throw new BulkRecipientPolicyError("invalid_recipient_identity");
    }
    identities.push(identity);
  }

  if (
    completeness.dispatchItems !== input.candidates.length ||
    completeness.uniqueRecipients !== new Set(identities).size
  ) {
    throw new BulkRecipientPolicyError("invariant_imbalance");
  }
  return identities;
}

function idsForRecipients<T>(params: {
  candidates: readonly BulkRecipientPolicyCandidate<T>[];
  recipients: readonly BulkCampaignRecipient[];
}): Set<string> {
  const stableIdsByIdentity = new Map<string, string[]>();
  for (const candidate of params.candidates) {
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: "whatsapp",
      recipient: candidate.recipient,
    });
    if (!identity) continue;
    const stableIds = stableIdsByIdentity.get(identity) || [];
    stableIds.push(candidate.stableId);
    stableIdsByIdentity.set(identity, stableIds);
  }
  return new Set(
    params.recipients.flatMap(recipient => {
      const identity = canonicalizeBulkCampaignRecipientIdentity({
        channel: "whatsapp",
        recipient,
      });
      return identity ? stableIdsByIdentity.get(identity) || [] : [];
    })
  );
}

function countReasons<T>(
  candidates: readonly BulkRecipientPolicyCandidate<T>[],
  exclusionReasonByStableId: ReadonlyMap<string, PolicyExclusionReason>
): Partial<Record<BulkCampaignSkipReason, number>> {
  const skippedByReason: Partial<Record<BulkCampaignSkipReason, number>> = {};
  for (const candidate of candidates) {
    const reason = exclusionReasonByStableId.get(candidate.stableId);
    if (reason) {
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
    }
  }
  return skippedByReason;
}

export async function evaluateBulkRecipientPolicy<T>(
  input: BulkRecipientPolicyInput<T>,
  dependencies: BulkRecipientPolicyDependencies = defaultDependencies
): Promise<BulkRecipientPolicyEvaluation<T>> {
  const identities = validatePreflight(input);
  const identityByStableId = new Map(
    input.candidates.map((candidate, index) => [
      candidate.stableId,
      identities[index],
    ])
  );
  const exclusionReasonByStableId = new Map<string, PolicyExclusionReason>();
  const marketingCandidates = input.candidates.filter(
    candidate => candidate.templateCategory === "MARKETING"
  );

  let missingMarketingConsent = 0;
  let missingMarketingConsentStableIds = new Set<string>();
  if (marketingCandidates.length > 0) {
    let consent: MarketingConsentFilterResult;
    try {
      consent = await dependencies.filterMarketingOptOut({
        workspaceId: input.workspaceId,
        recipients: marketingCandidates.map(candidate => candidate.recipient),
      });
    } catch (error) {
      throw new BulkRecipientPolicyError("marketing_consent_lookup_failed", {
        cause: error,
      });
    }
    for (const stableId of idsForRecipients({
      candidates: marketingCandidates,
      recipients: consent.skippedRecipients,
    })) {
      exclusionReasonByStableId.set(stableId, "marketing_opt_out");
    }
    missingMarketingConsentStableIds = idsForRecipients({
      candidates: marketingCandidates,
      recipients: consent.marketingOptInWarningRecipients,
    });
    missingMarketingConsent = missingMarketingConsentStableIds.size;
  }

  // Marketing recipients contacted within the workspace's contact policy are
  // left out before the daily cap, so the cap fills with recipients who can
  // be messaged now. Delivery still makes the authoritative reservation.
  const contactCandidates = marketingCandidates.filter(
    candidate => !exclusionReasonByStableId.has(candidate.stableId)
  );
  if (contactCandidates.length > 0) {
    let contacts: { recentlyContacted: Array<{ stableId: string }> };
    try {
      contacts = await dependencies.partitionRecentContacts({
        workspaceId: input.workspaceId,
        recipients: contactCandidates.map(candidate => ({
          phone: candidate.recipient.phone || "",
          stableId: candidate.stableId,
        })),
        now: input.now,
      });
    } catch (error) {
      throw new BulkRecipientPolicyError("contact_policy_unavailable", {
        cause: error,
      });
    }
    for (const { stableId } of contacts.recentlyContacted) {
      exclusionReasonByStableId.set(stableId, "recent_contact");
    }
  }

  const admittedByIdentity = new Map<
    string,
    BulkRecipientPolicyCandidate<T>[]
  >();
  for (const [index, candidate] of input.candidates.entries()) {
    if (exclusionReasonByStableId.has(candidate.stableId)) continue;
    const identity = identities[index];
    const rows = admittedByIdentity.get(identity);
    if (rows) {
      rows.push(candidate);
    } else {
      admittedByIdentity.set(identity, [candidate]);
    }
  }

  const admitted = Array.from(admittedByIdentity.values())
    .slice(0, input.recipientLimit)
    .flat();
  const admittedStableIds = new Set(
    admitted.map(candidate => candidate.stableId)
  );
  for (const candidate of input.candidates) {
    if (
      !exclusionReasonByStableId.has(candidate.stableId) &&
      !admittedStableIds.has(candidate.stableId)
    ) {
      exclusionReasonByStableId.set(candidate.stableId, "recipient_limit");
    }
  }

  let retained = admitted;
  if (input.policy.excludePriorFailedBulkSends) {
    if (!input.priorFailure?.secret.trim()) {
      throw new BulkRecipientPolicyError("missing_prior_failure_secret");
    }
    try {
      const priorFailure = await dependencies.filterPriorFailed({
        client: input.priorFailure.client,
        secret: input.priorFailure.secret,
        workspaceId: input.workspaceId,
        channel: input.channel,
        candidates: admitted,
        recipientFor: candidate => candidate.recipient,
      });
      const retainedStableIds = new Set(
        priorFailure.candidates.map(candidate => candidate.stableId)
      );
      if (
        retainedStableIds.size !== priorFailure.candidates.length ||
        priorFailure.candidates.some(
          candidate => !admittedStableIds.has(candidate.stableId)
        )
      ) {
        throw new BulkRecipientPolicyError("invariant_imbalance");
      }
      for (const candidate of admitted) {
        if (!retainedStableIds.has(candidate.stableId)) {
          exclusionReasonByStableId.set(candidate.stableId, "prior_failure");
        }
      }
      retained = priorFailure.candidates;
    } catch (error) {
      if (error instanceof BulkRecipientPolicyError) throw error;
      throw new BulkRecipientPolicyError("prior_failure_lookup_failed", {
        cause: error,
      });
    }
  }

  const retainedStableIds = new Set(
    retained.map(candidate => candidate.stableId)
  );
  const excluded = input.candidates.flatMap(candidate => {
    const reason = exclusionReasonByStableId.get(candidate.stableId);
    return reason ? [{ candidate, reason }] : [];
  });
  if (
    excluded.length + retained.length !== input.candidates.length ||
    retainedStableIds.size !== retained.length ||
    retained.some(candidate => !admittedStableIds.has(candidate.stableId)) ||
    excluded.some(({ candidate }) => retainedStableIds.has(candidate.stableId))
  ) {
    throw new BulkRecipientPolicyError("invariant_imbalance");
  }
  const acceptedUniqueRecipients = new Set(
    retained.map(candidate => identityByStableId.get(candidate.stableId))
  ).size;

  return {
    retained,
    excluded,
    skippedByReason: countReasons(input.candidates, exclusionReasonByStableId),
    warnings: { missingMarketingConsent },
    warningStableIds: {
      missing_marketing_consent: marketingCandidates.flatMap(candidate =>
        missingMarketingConsentStableIds.has(candidate.stableId)
          ? [candidate.stableId]
          : []
      ),
    },
    uniqueRecipients: {
      requested: input.completeness.uniqueRecipients,
      accepted: acceptedUniqueRecipients,
    },
  };
}
