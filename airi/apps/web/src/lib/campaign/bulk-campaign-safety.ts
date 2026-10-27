import { createHmac } from "node:crypto";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { META_THROUGHPUT_ERROR_CODE } from "@icecore/shared/lib/meta/message-failure-scope";

import type {
  BulkCampaignChannel,
  BulkCampaignRecipient,
} from "./bulk-campaign-contracts";

export const BULK_CAMPAIGN_AUDIENCE_HASH_VERSION = "v1";
export const BULK_CAMPAIGN_HIGH_OVERLAP_RATIO = 0.8;
export const BULK_CAMPAIGN_HIGH_OVERLAP_MIN_RECIPIENTS = 10;
export const BULK_CAMPAIGN_RECENT_OVERLAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const BULK_CAMPAIGN_EXPIRY_GRACE_MS = 15 * 60 * 1000;

const RECIPIENT_HASH_DOMAIN = `airi.chat:bulk-campaign:recipient:${BULK_CAMPAIGN_AUDIENCE_HASH_VERSION}`;
const AUDIENCE_HASH_DOMAIN = `airi.chat:bulk-campaign:audience:${BULK_CAMPAIGN_AUDIENCE_HASH_VERSION}`;

export type BulkCampaignAudienceOverlapKind = "none" | "high" | "exact";

export type BulkCampaignAudienceOverlap = {
  kind: BulkCampaignAudienceOverlapKind;
  blocksActiveDispatch: boolean;
  intersectionCount: number;
  candidateCount: number;
  previousCount: number;
  ratio: number;
};

export type BulkCampaignProviderFailureScope =
  | "provider"
  | "recipient"
  | "unknown";

export type BulkCampaignProviderCircuitResult =
  | {
      state: "open";
      provider: string;
      code: string;
      failureCount: number;
    }
  | { state: "closed" };

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function normalizeRequiredValue(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim().normalize("NFC");
  return normalized ? normalized : null;
}

/** Returns the channel-scoped identity that is safe to hash, never to expose. */
export function canonicalizeBulkCampaignRecipientIdentity(params: {
  channel: BulkCampaignChannel;
  recipient: BulkCampaignRecipient;
}): string | null {
  if (params.channel === "whatsapp") {
    if (!normalizeWhatsAppPhone(params.recipient.phone)) return null;
    // Preserve the v1 ledger/hash identity, including historical national
    // formats. Validation must not silently rewrite immutable retry identities.
    const phone = (params.recipient.phone || "").replace(/\D/g, "");
    return phone || null;
  }

  if (params.channel === "telegram") {
    const chatId = normalizeRequiredValue(params.recipient.chatId);
    const sourceId = normalizeRequiredValue(
      params.recipient.sourceId
    )?.toLowerCase();
    return chatId && sourceId ? `${sourceId}:${chatId}` : null;
  }

  return normalizeRequiredValue(params.recipient.email)?.toLowerCase() ?? null;
}

export function hashBulkCampaignRecipientIdentity(params: {
  secret: string;
  workspaceId: string;
  channel: BulkCampaignChannel;
  identity: string;
}): string {
  return hmac(
    params.secret,
    [
      RECIPIENT_HASH_DOMAIN,
      params.workspaceId,
      params.channel,
      params.identity,
    ].join("\u0000")
  );
}

/**
 * The hashes are server-only admission inputs. API contracts expose only the
 * fingerprint and aggregate overlap metadata.
 */
export function createBulkCampaignAudienceFingerprint(params: {
  secret: string;
  workspaceId: string;
  channel: BulkCampaignChannel;
  recipients: BulkCampaignRecipient[];
}): { fingerprint: string; recipientHashes: string[] } {
  const recipientHashes = Array.from(
    new Set(
      params.recipients.flatMap(recipient => {
        const identity = canonicalizeBulkCampaignRecipientIdentity({
          channel: params.channel,
          recipient,
        });
        return identity
          ? [
              hashBulkCampaignRecipientIdentity({
                secret: params.secret,
                workspaceId: params.workspaceId,
                channel: params.channel,
                identity,
              }),
            ]
          : [];
      })
    )
  ).sort();

  return {
    fingerprint: createBulkCampaignAudienceFingerprintFromRecipientHashes({
      secret: params.secret,
      workspaceId: params.workspaceId,
      channel: params.channel,
      recipientHashes,
    }),
    recipientHashes,
  };
}

/**
 * Computes the audience fingerprint from server-only recipient hashes without
 * reimplementing the Task 1 domain separator or canonical ordering.
 */
export function createBulkCampaignAudienceFingerprintFromRecipientHashes(params: {
  secret: string;
  workspaceId: string;
  channel: BulkCampaignChannel;
  recipientHashes: readonly string[];
}): string {
  const recipientHashes = Array.from(new Set(params.recipientHashes)).sort();
  return hmac(
    params.secret,
    [
      AUDIENCE_HASH_DOMAIN,
      params.workspaceId,
      params.channel,
      ...recipientHashes,
    ].join("\u0000")
  );
}

export function calculateBulkCampaignAudienceOverlap(params: {
  candidateRecipientHashes: readonly string[];
  previousRecipientHashes: readonly string[];
  candidateFingerprint?: string | null;
  previousFingerprint?: string | null;
}): BulkCampaignAudienceOverlap {
  const candidate = new Set(params.candidateRecipientHashes);
  const previous = new Set(params.previousRecipientHashes);
  const intersectionCount = Array.from(candidate).filter(hash =>
    previous.has(hash)
  ).length;
  const candidateCount = candidate.size;
  const ratio = candidateCount === 0 ? 0 : intersectionCount / candidateCount;
  const exact = Boolean(
    params.candidateFingerprint &&
      params.previousFingerprint &&
      params.candidateFingerprint === params.previousFingerprint
  );
  const high =
    intersectionCount >= BULK_CAMPAIGN_HIGH_OVERLAP_MIN_RECIPIENTS &&
    ratio >= BULK_CAMPAIGN_HIGH_OVERLAP_RATIO;

  return {
    kind: exact ? "exact" : high ? "high" : "none",
    blocksActiveDispatch: exact || high,
    intersectionCount,
    candidateCount,
    previousCount: previous.size,
    ratio,
  };
}

export function requiresBulkCampaignAudienceConfirmation(params: {
  overlap: BulkCampaignAudienceOverlap;
  previousFinishedAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  if (params.overlap.kind === "none") return false;
  const completedAt = new Date(params.previousFinishedAt || "").getTime();
  if (!Number.isFinite(completedAt)) return false;
  const now = params.now?.getTime() ?? Date.now();
  return (
    now >= completedAt &&
    now - completedAt <= BULK_CAMPAIGN_RECENT_OVERLAP_WINDOW_MS
  );
}

export function hasConfirmedBulkCampaignAudienceResend(params: {
  candidateFingerprint: string;
  confirmationFingerprint: string | null | undefined;
  overlap: BulkCampaignAudienceOverlap;
  previousFinishedAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  return (
    requiresBulkCampaignAudienceConfirmation(params) &&
    params.confirmationFingerprint === params.candidateFingerprint
  );
}

export function getBulkCampaignDispatchExpiresAt(params: {
  requestedAt: string | Date;
  scheduledAt?: string | Date | null;
}): string {
  const requestedAt = new Date(params.requestedAt).getTime();
  if (!Number.isFinite(requestedAt)) {
    throw new Error("Bulk campaign requestedAt must be a valid date");
  }
  const scheduledAt = params.scheduledAt
    ? new Date(params.scheduledAt).getTime()
    : NaN;
  const dispatchStartAt = Number.isFinite(scheduledAt)
    ? scheduledAt
    : requestedAt;
  return new Date(
    dispatchStartAt + BULK_CAMPAIGN_EXPIRY_GRACE_MS
  ).toISOString();
}

export function isBulkCampaignDispatchExpired(params: {
  dispatchExpiresAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  const expiresAt = new Date(params.dispatchExpiresAt || "").getTime();
  return (
    !Number.isFinite(expiresAt) ||
    (params.now?.getTime() ?? Date.now()) >= expiresAt
  );
}

export function classifyBulkCampaignProviderCircuit(params: {
  batchStatus: "completed" | "incomplete";
  results: Array<{
    success: boolean;
    attempted?: boolean;
    failureScope?: BulkCampaignProviderFailureScope | null;
    provider?: string | null;
    code?: string | null;
  }>;
}): BulkCampaignProviderCircuitResult {
  if (params.batchStatus !== "completed" || params.results.length < 2) {
    return { state: "closed" };
  }
  if (
    params.results.some(
      result =>
        result.success ||
        result.attempted === false ||
        result.failureScope !== "provider"
    )
  ) {
    return { state: "closed" };
  }

  const signatures = new Set(
    params.results.map(result => {
      const provider = normalizeRequiredValue(result.provider)?.toLowerCase();
      const code = normalizeRequiredValue(result.code);
      return provider && code ? `${provider}\u0000${code}` : null;
    })
  );
  if (signatures.size !== 1 || signatures.has(null)) return { state: "closed" };

  const [provider, code] = Array.from(signatures)[0]!.split("\u0000");
  // A batch that only hit Meta's throughput limit is retryable, not restricted.
  if (provider === "meta" && code === META_THROUGHPUT_ERROR_CODE) {
    return { state: "closed" };
  }
  return { state: "open", provider, code, failureCount: params.results.length };
}
