import { z } from "zod";

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 240;
const MAX_PATH_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_WARNING_LENGTH = 500;
const MAX_DISCLOSURE_ITEMS = 2_000;
const MAX_CREATIVE_ASSETS = 8;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const boundedIdSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const boundedNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const boundedPathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const sha256Schema = z.string().regex(SHA256_HEX_PATTERN);
const requiredUnknownSchema = z
  .unknown()
  .refine(value => value !== undefined, "Value is required");

const targetSchema = z
  .object({
    sourceId: boundedIdSchema,
    connectionId: boundedIdSchema,
    mcpUserId: boundedIdSchema,
    mcpUserName: boundedNameSchema.optional(),
    adAccountId: boundedIdSchema,
    adAccountName: boundedNameSchema.optional(),
    businessId: boundedIdSchema.optional(),
    businessName: boundedNameSchema.optional(),
    currency: z.string().trim().min(1).max(16),
    timezone: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const toolSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    definitionSha256: sha256Schema,
    catalogSha256: sha256Schema,
  })
  .strict();

const entitySchema = z
  .object({
    type: z.string().trim().min(1).max(120),
    id: boundedIdSchema.optional(),
    action: z.string().trim().min(1).max(120).optional(),
    requestedStatus: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const moneySchema = z
  .object({
    path: boundedPathSchema,
    rawValue: requiredUnknownSchema,
    currency: z.string().trim().min(1).max(16),
    unit: z.literal("provider_raw"),
  })
  .strict();

const scheduleSchema = z
  .object({
    path: boundedPathSchema,
    value: requiredUnknownSchema,
    timezone: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const targetingSchema = z
  .object({
    path: boundedPathSchema,
    value: requiredUnknownSchema,
  })
  .strict();

const creativeAssetSchema = z
  .object({
    id: boundedIdSchema,
    kind: z.string().trim().min(1).max(80),
    name: boundedNameSchema,
  })
  .strict();

const disclosureSchema = z
  .object({
    operation: z.string().trim().min(1).max(200),
    accountIds: z.array(boundedIdSchema).max(MAX_DISCLOSURE_ITEMS),
    businessIds: z.array(boundedIdSchema).max(MAX_DISCLOSURE_ITEMS),
    entities: z.array(entitySchema).max(MAX_DISCLOSURE_ITEMS),
    money: z.array(moneySchema).max(MAX_DISCLOSURE_ITEMS),
    schedule: z.array(scheduleSchema).max(MAX_DISCLOSURE_ITEMS),
    targeting: z.array(targetingSchema).max(MAX_DISCLOSURE_ITEMS),
    creativeAssets: z.array(creativeAssetSchema).max(MAX_CREATIVE_ASSETS),
    unmappedArgumentPaths: z.array(boundedPathSchema).max(MAX_DISCLOSURE_ITEMS),
    warnings: z
      .array(z.string().trim().min(1).max(MAX_WARNING_LENGTH))
      .max(100),
  })
  .strict();

export type MetaAdsMcpTransactionV2 = {
  version: 2;
  id: string;
  preparedAt: string;
  target: {
    sourceId: string;
    connectionId: string;
    mcpUserId: string;
    mcpUserName?: string;
    adAccountId: string;
    adAccountName?: string;
    businessId?: string;
    businessName?: string;
    currency: string;
    timezone?: string;
  };
  tool: { name: string; definitionSha256: string; catalogSha256: string };
  logicalArguments: Record<string, unknown>;
  logicalArgumentsSha256: string;
  disclosure: {
    operation: string;
    accountIds: string[];
    businessIds: string[];
    entities: Array<{
      type: string;
      id?: string;
      action?: string;
      requestedStatus?: string;
    }>;
    money: Array<{
      path: string;
      rawValue: unknown;
      currency: string;
      unit: "provider_raw";
    }>;
    schedule: Array<{ path: string; value: unknown; timezone?: string }>;
    targeting: Array<{ path: string; value: unknown }>;
    creativeAssets: Array<{ id: string; kind: string; name: string }>;
    unmappedArgumentPaths: string[];
    warnings: string[];
  };
  summary: string;
  transactionDigest: string;
};

export const metaAdsMcpTransactionV2Schema: z.ZodType<MetaAdsMcpTransactionV2> =
  z
    .object({
      version: z.literal(2),
      id: boundedIdSchema,
      preparedAt: z.string().datetime(),
      target: targetSchema,
      tool: toolSchema,
      logicalArguments: z.record(z.string().min(1).max(256), z.unknown()),
      logicalArgumentsSha256: sha256Schema,
      disclosure: disclosureSchema,
      summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH),
      transactionDigest: sha256Schema,
    })
    .strict() as unknown as z.ZodType<MetaAdsMcpTransactionV2>;

/**
 * A prepared write is reviewed against the account state Airi read when it
 * was prepared. After this window it can no longer be confirmed; the user
 * asks Airi to prepare it again with current data.
 */
export const META_ADS_MCP_TRANSACTION_TTL_MS = 45 * 60 * 1_000;
const MAX_PREPARED_AT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
/** Stored as the execution error of an expired, never-sent confirmation. */
export const META_ADS_MCP_TRANSACTION_EXPIRED_ERROR =
  "The prepared Meta Ads change expired before it was confirmed.";

export function isMetaAdsMcpTransactionExpired(
  transaction: Pick<MetaAdsMcpTransactionV2, "preparedAt">,
  nowMs: number
): boolean {
  const preparedAtMs = Date.parse(transaction.preparedAt);
  return (
    !Number.isFinite(preparedAtMs) ||
    nowMs - preparedAtMs > META_ADS_MCP_TRANSACTION_TTL_MS ||
    preparedAtMs - nowMs > MAX_PREPARED_AT_CLOCK_SKEW_MS
  );
}

export function parseMetaAdsMcpTransactionV2(
  value: unknown
): MetaAdsMcpTransactionV2 {
  return metaAdsMcpTransactionV2Schema.parse(value);
}
