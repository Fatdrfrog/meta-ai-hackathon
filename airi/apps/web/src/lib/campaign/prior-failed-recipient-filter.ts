import type { BulkCampaignRecipient } from "./bulk-campaign-contracts";
import {
  canonicalizeBulkCampaignRecipientIdentity,
  hashBulkCampaignRecipientIdentity,
} from "./bulk-campaign-safety";

const DEFAULT_LOOKUP_CHUNK_SIZE = 5_000;
const DEFAULT_LOOKUP_CONCURRENCY = 4;
const RECIPIENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

type PriorFailedBulkCampaignRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{
    data: unknown;
    error: { message?: string | null } | null;
  }>;
};

type PriorFailedRecipientRow = {
  recipient_hash: string;
};

export class PriorFailedBulkCampaignLookupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PriorFailedBulkCampaignLookupError";
  }
}

function parsePriorFailedRecipientRows(
  data: unknown
): PriorFailedRecipientRow[] {
  if (
    !Array.isArray(data) ||
    data.some(
      row =>
        !row ||
        typeof row !== "object" ||
        !("recipient_hash" in row) ||
        typeof row.recipient_hash !== "string" ||
        !RECIPIENT_HASH_PATTERN.test(row.recipient_hash)
    )
  ) {
    throw new PriorFailedBulkCampaignLookupError(
      "Prior failed recipient lookup returned an invalid response."
    );
  }
  return data as PriorFailedRecipientRow[];
}

export async function filterPriorFailedBulkCampaignCandidates<T>(params: {
  client: PriorFailedBulkCampaignRpcClient;
  secret: string;
  workspaceId: string;
  channel: "whatsapp";
  candidates: readonly T[];
  recipientFor: (candidate: T) => BulkCampaignRecipient;
  lookupChunkSize?: number;
}): Promise<{ candidates: T[]; skippedPriorFailed: number }> {
  if (params.candidates.length === 0) {
    return { candidates: [], skippedPriorFailed: 0 };
  }

  const secret = params.secret;
  if (!secret.trim()) {
    throw new PriorFailedBulkCampaignLookupError(
      "Prior failed recipient lookup is not configured."
    );
  }

  const candidatesWithHashes = params.candidates.map(candidate => {
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: params.channel,
      recipient: params.recipientFor(candidate),
    });
    return {
      candidate,
      hash: identity
        ? hashBulkCampaignRecipientIdentity({
            secret,
            workspaceId: params.workspaceId,
            channel: params.channel,
            identity,
          })
        : null,
    };
  });
  const uniqueHashes = Array.from(
    new Set(candidatesWithHashes.flatMap(({ hash }) => (hash ? [hash] : [])))
  );
  if (uniqueHashes.length === 0) {
    return { candidates: Array.from(params.candidates), skippedPriorFailed: 0 };
  }

  const chunkSize = Math.max(
    1,
    Math.min(params.lookupChunkSize ?? DEFAULT_LOOKUP_CHUNK_SIZE, 10_000)
  );
  const hashChunks: string[][] = [];
  for (let offset = 0; offset < uniqueHashes.length; offset += chunkSize) {
    hashChunks.push(uniqueHashes.slice(offset, offset + chunkSize));
  }
  const excludedHashes = new Set<string>();
  for (
    let offset = 0;
    offset < hashChunks.length;
    offset += DEFAULT_LOOKUP_CONCURRENCY
  ) {
    const rowsByChunk = await Promise.all(
      hashChunks
        .slice(offset, offset + DEFAULT_LOOKUP_CONCURRENCY)
        .map(async recipientHashes => {
          let result: Awaited<
            ReturnType<PriorFailedBulkCampaignRpcClient["rpc"]>
          >;
          try {
            result = await params.client.rpc(
              "get_prior_failed_bulk_campaign_recipient_hashes",
              {
                p_workspace_id: params.workspaceId,
                p_channel: params.channel,
                p_recipient_hashes: recipientHashes,
              }
            );
          } catch (error) {
            throw new PriorFailedBulkCampaignLookupError(
              "Prior failed recipient lookup is unavailable.",
              { cause: error }
            );
          }
          if (result.error) {
            throw new PriorFailedBulkCampaignLookupError(
              "Prior failed recipient lookup is unavailable.",
              { cause: result.error }
            );
          }
          const rows = parsePriorFailedRecipientRows(result.data);
          const submittedHashes = new Set(recipientHashes);
          if (rows.some(row => !submittedHashes.has(row.recipient_hash))) {
            throw new PriorFailedBulkCampaignLookupError(
              "Prior failed recipient lookup returned an unexpected recipient."
            );
          }
          return rows;
        })
    );
    for (const rows of rowsByChunk) {
      for (const row of rows) {
        excludedHashes.add(row.recipient_hash);
      }
    }
  }

  const candidates = candidatesWithHashes
    .filter(({ hash }) => !hash || !excludedHashes.has(hash))
    .map(({ candidate }) => candidate);
  return {
    candidates,
    skippedPriorFailed: params.candidates.length - candidates.length,
  };
}
