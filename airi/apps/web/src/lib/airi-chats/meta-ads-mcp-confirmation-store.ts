import "server-only";

import {
  metaAdsMcpTransactionV2Schema,
  type MetaAdsMcpTransactionV2,
} from "@/lib/meta-ads/mcp/confirmation-contract";
import { AiriChatMessage } from "@/models/airi-chat-message";
import { z } from "zod";

const MAX_ID_LENGTH = 256;
const MAX_CLAIM_TOKEN_LENGTH = 120;
const MAX_RESPONSE_CONTENT_LENGTH = 9_000;
const MAX_ERROR_LENGTH = 500;
const MAX_RECONCILIATION_NOTE_LENGTH = 500;
const MAX_PROVIDER_IDENTIFIERS = 20;
const MAX_PROVIDER_IDENTIFIER_KIND_LENGTH = 100;
const MAX_PROVIDER_IDENTIFIER_ID_LENGTH = 200;
const MAX_MATERIALIZED_CREATIVE_ASSETS = 8;
const RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const boundedIdSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);
const claimTokenSchema = z.string().trim().min(1).max(MAX_CLAIM_TOKEN_LENGTH);
const responseContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_RESPONSE_CONTENT_LENGTH);
const errorSchema = z.string().max(MAX_ERROR_LENGTH).nullable();
const sha256Schema = z.string().regex(SHA256_HEX_PATTERN);

export const AIRI_META_ADS_MCP_CONFIRMATION_STATUSES = [
  "executing",
  "succeeded",
  "rejected",
  "outcome_unknown",
] as const;

export const AIRI_META_ADS_MCP_V2_CONFIRMATION_STATUSES = [
  "executing",
  "not_executed",
  "succeeded",
  "outcome_unknown",
] as const;

export type AiriMetaAdsMcpConfirmationStatus =
  (typeof AIRI_META_ADS_MCP_CONFIRMATION_STATUSES)[number];

export type AiriMetaAdsMcpConfirmationStatusV1 =
  AiriMetaAdsMcpConfirmationStatus;

export type AiriMetaAdsMcpConfirmationStatusV2 =
  (typeof AIRI_META_ADS_MCP_V2_CONFIRMATION_STATUSES)[number];

export type AiriMetaAdsMcpReconciliation = {
  userId: string;
  resolution: "succeeded" | "not_executed" | "outcome_unknown";
  note?: string;
  reconciledAt: string;
};

export type AiriMetaAdsMcpReconciliationV2 = {
  actorUserId: string;
  resolution: "succeeded" | "not_executed";
  note: string;
  providerIdentifiers?: Array<{ kind: string; id: string }>;
  reconciledAt: string;
};

export type AiriMetaAdsMcpConfirmationExecutionV1 = {
  version: 1;
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
  status: AiriMetaAdsMcpConfirmationStatusV1;
  claimToken: string;
  resultMessageId: string;
  confirmedByUserId: string;
  claimedAt: string;
  responseContent?: string;
  error?: string | null;
  completedAt?: string;
  reconciliation?: AiriMetaAdsMcpReconciliation;
};

export type AiriMetaAdsMcpConfirmationExecutionV2 = {
  version: 2;
  id: string;
  transaction: MetaAdsMcpTransactionV2;
  status: AiriMetaAdsMcpConfirmationStatusV2;
  claimToken: string;
  resultMessageId: string;
  confirmedByUserId: string;
  claimedAt: string;
  responseContent?: string;
  error?: string | null;
  completedAt?: string;
  effectiveArgumentsSha256?: string;
  materializedCreativeAssetIds?: string[];
  reconciliation?: AiriMetaAdsMcpReconciliationV2;
};

export type AiriMetaAdsMcpConfirmationExecution =
  | AiriMetaAdsMcpConfirmationExecutionV1
  | AiriMetaAdsMcpConfirmationExecutionV2;

export type AiriMetaAdsMcpLegacyPendingMutation = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
};

export type AiriMetaAdsMcpPendingMutation =
  | AiriMetaAdsMcpLegacyPendingMutation
  | MetaAdsMcpTransactionV2;

export type AiriMetaAdsMcpConfirmationState = {
  pendingMutation: AiriMetaAdsMcpPendingMutation | null;
  execution: AiriMetaAdsMcpConfirmationExecution | null;
};

export type AiriMetaAdsMcpConfirmationResultMessage = {
  _id: unknown;
  threadId: unknown;
  workspaceId: string;
  role: "assistant";
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
};

export type ClaimAiriMetaAdsMcpConfirmationInput = {
  workspaceId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  transactionDigest: string;
  claimToken: string;
  resultMessageId: string;
  confirmedByUserId: string;
  claimedAt: string;
};

export type CompleteAiriMetaAdsMcpConfirmationInput = {
  workspaceId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  claimToken: string;
  status: Exclude<AiriMetaAdsMcpConfirmationStatusV2, "executing">;
  responseContent: string;
  error: string | null;
  completedAt: string;
  effectiveArgumentsSha256?: string;
  materializedCreativeAssetIds?: string[];
};

export type ReconcileAiriMetaAdsMcpConfirmationInput = {
  workspaceId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  claimToken: string;
  expectedStatus: "executing" | "outcome_unknown";
  resolution: "succeeded" | "not_executed";
  responseContent: string;
  error: string | null;
  completedAt: string;
  reconciliation: AiriMetaAdsMcpReconciliationV2;
};

export type EnsureAiriMetaAdsMcpResultMessageInput = {
  workspaceId: string;
  threadId: string;
  sourceMessageId: string;
  execution: AiriMetaAdsMcpConfirmationExecution;
};

export type AiriMetaAdsMcpConfirmationStore = {
  loadState(input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    mutationId: string;
  }): Promise<AiriMetaAdsMcpConfirmationState | null>;
  claim(
    input: ClaimAiriMetaAdsMcpConfirmationInput
  ): Promise<AiriMetaAdsMcpConfirmationExecution | null>;
  complete(
    input: CompleteAiriMetaAdsMcpConfirmationInput
  ): Promise<AiriMetaAdsMcpConfirmationExecution | null>;
  reconcile(
    input: ReconcileAiriMetaAdsMcpConfirmationInput
  ): Promise<AiriMetaAdsMcpConfirmationExecution | null>;
  ensureResultMessage(
    input: EnsureAiriMetaAdsMcpResultMessageInput
  ): Promise<AiriMetaAdsMcpConfirmationResultMessage>;
};

type AiriMessageMetadataProjection = {
  _id: unknown;
  metadata?: Record<string, unknown> | null;
};

const legacyPendingMutationSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    toolName: z.string().trim().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

const reconciliationV1Schema = z
  .object({
    userId: z.string().trim().min(1).max(256),
    resolution: z.enum(["succeeded", "not_executed", "outcome_unknown"]),
    note: z.string().trim().min(1).max(500).optional(),
    reconciledAt: z.string().datetime(),
  })
  .strict();

const reconciliationV2Schema: z.ZodType<AiriMetaAdsMcpReconciliationV2> = z
  .object({
    actorUserId: boundedIdSchema,
    resolution: z.enum(["succeeded", "not_executed"]),
    note: z.string().trim().min(1).max(MAX_RECONCILIATION_NOTE_LENGTH),
    providerIdentifiers: z
      .array(
        z
          .object({
            kind: z
              .string()
              .trim()
              .min(1)
              .max(MAX_PROVIDER_IDENTIFIER_KIND_LENGTH),
            id: z.string().trim().min(1).max(MAX_PROVIDER_IDENTIFIER_ID_LENGTH),
          })
          .strict()
      )
      .max(MAX_PROVIDER_IDENTIFIERS)
      .optional(),
    reconciledAt: z.string().datetime(),
  })
  .strict();

const confirmationExecutionV1Schema = z
  .object({
    version: z.literal(1),
    id: z.string().trim().min(1).max(120),
    toolName: z.string().trim().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()),
    summary: z.string().trim().min(1).max(500),
    status: z.enum(AIRI_META_ADS_MCP_CONFIRMATION_STATUSES),
    claimToken: z.string().trim().min(1).max(120),
    resultMessageId: z.string().regex(OBJECT_ID_PATTERN),
    confirmedByUserId: z.string().trim().min(1).max(256),
    claimedAt: z.string().datetime(),
    responseContent: z.string().min(1).max(9_000).optional(),
    error: z.string().max(500).nullable().optional(),
    completedAt: z.string().datetime().optional(),
    reconciliation: reconciliationV1Schema.optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    const terminal = execution.status !== "executing";
    if (terminal && (!execution.responseContent || !execution.completedAt)) {
      context.addIssue({
        code: "custom",
        message:
          "Terminal confirmation records require content and completion time",
      });
    }
    if (
      !terminal &&
      (execution.responseContent !== undefined ||
        execution.error !== undefined ||
        execution.completedAt !== undefined ||
        execution.reconciliation !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Executing confirmation records cannot contain terminal fields",
      });
    }
  });

const confirmationExecutionV2Schema: z.ZodType<AiriMetaAdsMcpConfirmationExecutionV2> =
  z
    .object({
      version: z.literal(2),
      id: boundedIdSchema,
      transaction: metaAdsMcpTransactionV2Schema,
      status: z.enum(AIRI_META_ADS_MCP_V2_CONFIRMATION_STATUSES),
      claimToken: claimTokenSchema,
      resultMessageId: z.string().regex(OBJECT_ID_PATTERN),
      confirmedByUserId: boundedIdSchema,
      claimedAt: z.string().datetime(),
      responseContent: responseContentSchema.optional(),
      error: errorSchema.optional(),
      completedAt: z.string().datetime().optional(),
      effectiveArgumentsSha256: sha256Schema.optional(),
      materializedCreativeAssetIds: z
        .array(boundedIdSchema)
        .max(MAX_MATERIALIZED_CREATIVE_ASSETS)
        .optional(),
      reconciliation: reconciliationV2Schema.optional(),
    })
    .strict()
    .superRefine((execution, context) => {
      if (execution.id !== execution.transaction.id) {
        context.addIssue({
          code: "custom",
          path: ["id"],
          message: "Execution ID must match the transaction ID",
        });
      }
      const terminal = execution.status !== "executing";
      if (terminal && (!execution.responseContent || !execution.completedAt)) {
        context.addIssue({
          code: "custom",
          message:
            "Terminal confirmation records require content and completion time",
        });
      }
      if (
        !terminal &&
        (execution.responseContent !== undefined ||
          execution.error !== undefined ||
          execution.completedAt !== undefined ||
          execution.effectiveArgumentsSha256 !== undefined ||
          execution.materializedCreativeAssetIds !== undefined ||
          execution.reconciliation !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Executing confirmation records cannot contain terminal fields",
        });
      }
      if (execution.reconciliation && execution.status === "outcome_unknown") {
        context.addIssue({
          code: "custom",
          path: ["reconciliation"],
          message: "Reconciled confirmations must have a resolved status",
        });
      }
    }) as unknown as z.ZodType<AiriMetaAdsMcpConfirmationExecutionV2>;

const confirmationExecutionSchema: z.ZodType<AiriMetaAdsMcpConfirmationExecution> =
  z.union([
    confirmationExecutionV1Schema,
    confirmationExecutionV2Schema,
  ]) as z.ZodType<AiriMetaAdsMcpConfirmationExecution>;

const stateLocatorSchema = z
  .object({
    workspaceId: boundedIdSchema,
    threadId: boundedIdSchema,
    messageId: boundedIdSchema,
    mutationId: boundedIdSchema,
  })
  .strict();

const claimInputSchema = stateLocatorSchema.extend({
  transactionDigest: sha256Schema,
  claimToken: claimTokenSchema,
  resultMessageId: z.string().regex(OBJECT_ID_PATTERN),
  confirmedByUserId: boundedIdSchema,
  claimedAt: z.string().datetime(),
});

const completeInputSchema = stateLocatorSchema.extend({
  claimToken: claimTokenSchema,
  status: z.enum(["not_executed", "succeeded", "outcome_unknown"]),
  responseContent: responseContentSchema,
  error: errorSchema,
  completedAt: z.string().datetime(),
  effectiveArgumentsSha256: sha256Schema.optional(),
  materializedCreativeAssetIds: z
    .array(boundedIdSchema)
    .max(MAX_MATERIALIZED_CREATIVE_ASSETS)
    .optional(),
});

const reconcileInputSchema = stateLocatorSchema
  .extend({
    claimToken: claimTokenSchema,
    expectedStatus: z.enum(["executing", "outcome_unknown"]),
    resolution: z.enum(["succeeded", "not_executed"]),
    responseContent: responseContentSchema,
    error: errorSchema,
    completedAt: z.string().datetime(),
    reconciliation: reconciliationV2Schema,
  })
  .superRefine((input, context) => {
    if (input.reconciliation.resolution !== input.resolution) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation", "resolution"],
        message:
          "Reconciliation resolution does not match the requested result",
      });
    }
    if (
      input.resolution === "not_executed" &&
      input.reconciliation.providerIdentifiers?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["reconciliation", "providerIdentifiers"],
        message:
          "Provider identifiers are only allowed for successful reconciliation",
      });
    }
  });

const ensureResultMessageInputSchema = z
  .object({
    workspaceId: boundedIdSchema,
    threadId: boundedIdSchema,
    sourceMessageId: boundedIdSchema,
    execution: confirmationExecutionSchema,
  })
  .strict();

function metadataRecord(
  projection: AiriMessageMetadataProjection
): Record<string, unknown> {
  return projection.metadata && typeof projection.metadata === "object"
    ? projection.metadata
    : {};
}

function parsePendingMutation(
  value: unknown
): AiriMetaAdsMcpPendingMutation | null {
  const v2 = metaAdsMcpTransactionV2Schema.safeParse(value);
  if (v2.success) return v2.data;
  const legacy = legacyPendingMutationSchema.safeParse(value);
  return legacy.success ? legacy.data : null;
}

function parseExecution(
  value: unknown
): AiriMetaAdsMcpConfirmationExecution | null {
  const parsed = confirmationExecutionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function findPendingMutation(
  projection: AiriMessageMetadataProjection,
  mutationId: string
): AiriMetaAdsMcpPendingMutation | null {
  const pending = metadataRecord(projection).airiMetaAdsMcpPending;
  if (!Array.isArray(pending)) return null;
  for (const value of pending) {
    const mutation = parsePendingMutation(value);
    if (mutation?.id === mutationId) return mutation;
  }
  return null;
}

function findExecution(
  projection: AiriMessageMetadataProjection,
  mutationId: string
): AiriMetaAdsMcpConfirmationExecution | null {
  const executions = metadataRecord(projection).airiMetaAdsMcpExecutions;
  if (!Array.isArray(executions)) return null;
  for (const value of executions) {
    const execution = parseExecution(value);
    if (execution?.id === mutationId) return execution;
  }
  return null;
}

function literal(value: string): { $literal: string } {
  return { $literal: value };
}

function arrayOrEmpty(fieldPath: string): Record<string, unknown> {
  return {
    $cond: [{ $isArray: fieldPath }, fieldPath, []],
  };
}

export async function loadAiriMetaAdsMcpConfirmationState(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
}): Promise<AiriMetaAdsMcpConfirmationState | null> {
  const locator = stateLocatorSchema.parse(input);
  const sourceMessage = await AiriChatMessage.findOne({
    _id: locator.messageId,
    workspaceId: locator.workspaceId,
    threadId: locator.threadId,
    role: "assistant",
  })
    .select("_id metadata")
    .lean<AiriMessageMetadataProjection | null>();
  if (!sourceMessage) return null;
  return {
    pendingMutation: findPendingMutation(sourceMessage, locator.mutationId),
    execution: findExecution(sourceMessage, locator.mutationId),
  };
}

const MAX_PENDING_LOOKUP_MESSAGES = 20;

const pendingLookupSchema = z
  .object({
    workspaceId: boundedIdSchema,
    threadId: boundedIdSchema,
    toolName: z.string().trim().min(1).max(200),
    connectionId: boundedIdSchema,
    adAccountId: boundedIdSchema,
    preparedAfter: z.string().datetime(),
  })
  .strict();

export type AiriMetaAdsMcpPendingTransactionRef = {
  threadId: string;
  messageId: string;
  transaction: MetaAdsMcpTransactionV2;
};

/**
 * Prepared writes for one tool and target that still await review in one Airi
 * thread. Threads are private to their creator and can be archived, so a card
 * elsewhere in the workspace may be one the requester cannot open. Claiming a
 * confirmation removes its pending entry, so only unconfirmed transactions are
 * returned.
 */
export async function listAiriMetaAdsMcpPendingTransactions(input: {
  workspaceId: string;
  threadId: string;
  toolName: string;
  connectionId: string;
  adAccountId: string;
  preparedAfter: string;
}): Promise<AiriMetaAdsMcpPendingTransactionRef[]> {
  const parsed = pendingLookupSchema.parse(input);
  const messages = await AiriChatMessage.find({
    workspaceId: parsed.workspaceId,
    threadId: parsed.threadId,
    role: "assistant",
    createdAt: { $gte: new Date(parsed.preparedAfter) },
    "metadata.airiMetaAdsMcpPending": {
      $elemMatch: {
        version: 2,
        "tool.name": parsed.toolName,
        "target.connectionId": parsed.connectionId,
        "target.adAccountId": parsed.adAccountId,
        preparedAt: { $gte: parsed.preparedAfter },
      },
    },
  })
    .sort({ createdAt: -1 })
    .limit(MAX_PENDING_LOOKUP_MESSAGES)
    .select("_id threadId metadata")
    .lean<Array<AiriMessageMetadataProjection & { threadId?: unknown }>>();
  return messages.flatMap(message => {
    const pending = metadataRecord(message).airiMetaAdsMcpPending;
    if (!Array.isArray(pending)) return [];
    return pending.flatMap(value => {
      const transaction = metaAdsMcpTransactionV2Schema.safeParse(value);
      return transaction.success &&
        transaction.data.tool.name === parsed.toolName &&
        transaction.data.target.connectionId === parsed.connectionId &&
        transaction.data.target.adAccountId === parsed.adAccountId
        ? [
            {
              threadId: String(message.threadId),
              messageId: String(message._id),
              transaction: transaction.data,
            },
          ]
        : [];
    });
  });
}

export async function claimAiriMetaAdsMcpConfirmation(
  input: ClaimAiriMetaAdsMcpConfirmationInput
): Promise<AiriMetaAdsMcpConfirmationExecution | null> {
  const parsed = claimInputSchema.parse(input);
  const pendingPath = "$metadata.airiMetaAdsMcpPending";
  const pendingActionsPath = "$metadata.pendingActions";
  const executionsPath = "$metadata.airiMetaAdsMcpExecutions";
  const pendingMatch = {
    $and: [
      { $eq: ["$$pending.version", 2] },
      { $eq: ["$$pending.id", literal(parsed.mutationId)] },
      {
        $eq: ["$$pending.transactionDigest", literal(parsed.transactionDigest)],
      },
    ],
  };
  const matchingPending = {
    $filter: {
      input: arrayOrEmpty(pendingPath),
      as: "pending",
      cond: pendingMatch,
    },
  };
  const claimed = await AiriChatMessage.findOneAndUpdate(
    {
      _id: parsed.messageId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      role: "assistant",
      "metadata.airiMetaAdsMcpPending": {
        $elemMatch: {
          version: 2,
          id: parsed.mutationId,
          transactionDigest: parsed.transactionDigest,
        },
      },
      "metadata.pendingActions": {
        $elemMatch: {
          confirmationVersion: 2,
          id: parsed.mutationId,
          kind: "meta_ads_mcp_mutation",
          mutationId: parsed.mutationId,
          transactionDigest: parsed.transactionDigest,
        },
      },
      "metadata.airiMetaAdsMcpExecutions.id": { $ne: parsed.mutationId },
    },
    [
      {
        $set: {
          "metadata.airiMetaAdsMcpExecutions": {
            $concatArrays: [
              arrayOrEmpty(executionsPath),
              [
                {
                  version: 2,
                  id: literal(parsed.mutationId),
                  transaction: { $arrayElemAt: [matchingPending, 0] },
                  status: "executing",
                  claimToken: literal(parsed.claimToken),
                  resultMessageId: literal(parsed.resultMessageId),
                  confirmedByUserId: literal(parsed.confirmedByUserId),
                  claimedAt: literal(parsed.claimedAt),
                },
              ],
            ],
          },
          "metadata.airiMetaAdsMcpPending": {
            $filter: {
              input: arrayOrEmpty(pendingPath),
              as: "pending",
              cond: { $not: [pendingMatch] },
            },
          },
          "metadata.pendingActions": {
            $filter: {
              input: arrayOrEmpty(pendingActionsPath),
              as: "action",
              cond: {
                $not: [
                  {
                    $and: [
                      { $eq: ["$$action.confirmationVersion", 2] },
                      {
                        $eq: ["$$action.id", literal(parsed.mutationId)],
                      },
                      { $eq: ["$$action.kind", "meta_ads_mcp_mutation"] },
                      {
                        $eq: [
                          "$$action.mutationId",
                          literal(parsed.mutationId),
                        ],
                      },
                      {
                        $eq: [
                          "$$action.transactionDigest",
                          literal(parsed.transactionDigest),
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ],
    { new: true }
  )
    .select("_id metadata")
    .lean<AiriMessageMetadataProjection | null>();
  return claimed ? findExecution(claimed, parsed.mutationId) : null;
}

export async function completeAiriMetaAdsMcpConfirmation(
  input: CompleteAiriMetaAdsMcpConfirmationInput
): Promise<AiriMetaAdsMcpConfirmationExecution | null> {
  const parsed = completeInputSchema.parse(input);
  const terminalFields: Record<string, unknown> = {
    "metadata.airiMetaAdsMcpExecutions.$[execution].status": parsed.status,
    "metadata.airiMetaAdsMcpExecutions.$[execution].responseContent":
      parsed.responseContent,
    "metadata.airiMetaAdsMcpExecutions.$[execution].error": parsed.error,
    "metadata.airiMetaAdsMcpExecutions.$[execution].completedAt":
      parsed.completedAt,
  };
  if (parsed.effectiveArgumentsSha256) {
    terminalFields[
      "metadata.airiMetaAdsMcpExecutions.$[execution].effectiveArgumentsSha256"
    ] = parsed.effectiveArgumentsSha256;
  }
  if (parsed.materializedCreativeAssetIds) {
    terminalFields[
      "metadata.airiMetaAdsMcpExecutions.$[execution].materializedCreativeAssetIds"
    ] = parsed.materializedCreativeAssetIds;
  }
  const completed = await AiriChatMessage.findOneAndUpdate(
    {
      _id: parsed.messageId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      role: "assistant",
      "metadata.airiMetaAdsMcpExecutions": {
        $elemMatch: {
          version: 2,
          id: parsed.mutationId,
          claimToken: parsed.claimToken,
          status: "executing",
        },
      },
    },
    { $set: terminalFields },
    {
      new: true,
      runValidators: true,
      arrayFilters: [
        {
          "execution.version": 2,
          "execution.id": parsed.mutationId,
          "execution.claimToken": parsed.claimToken,
          "execution.status": "executing",
        },
      ],
    }
  )
    .select("_id metadata")
    .lean<AiriMessageMetadataProjection | null>();
  return completed ? findExecution(completed, parsed.mutationId) : null;
}

function reconciliationEligibility(
  expectedStatus: ReconcileAiriMetaAdsMcpConfirmationInput["expectedStatus"]
): Record<string, unknown> {
  if (expectedStatus === "outcome_unknown") {
    return { status: "outcome_unknown" };
  }
  return {
    status: "executing",
    claimedAt: {
      $lte: new Date(Date.now() - RECONCILIATION_DELAY_MS).toISOString(),
    },
  };
}

export async function reconcileAiriMetaAdsMcpConfirmation(
  input: ReconcileAiriMetaAdsMcpConfirmationInput
): Promise<AiriMetaAdsMcpConfirmationExecution | null> {
  const parsed = reconcileInputSchema.parse(input);
  const eligibility = reconciliationEligibility(parsed.expectedStatus);
  const commonElementMatch = {
    id: parsed.mutationId,
    claimToken: parsed.claimToken,
    reconciliation: { $exists: false },
    ...eligibility,
  };
  const v2Reconciled = await AiriChatMessage.findOneAndUpdate(
    {
      _id: parsed.messageId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      role: "assistant",
      "metadata.airiMetaAdsMcpExecutions": {
        $elemMatch: { version: 2, ...commonElementMatch },
      },
    },
    {
      $set: {
        "metadata.airiMetaAdsMcpExecutions.$[execution].status":
          parsed.resolution,
        "metadata.airiMetaAdsMcpExecutions.$[execution].responseContent":
          parsed.responseContent,
        "metadata.airiMetaAdsMcpExecutions.$[execution].error": parsed.error,
        "metadata.airiMetaAdsMcpExecutions.$[execution].completedAt":
          parsed.completedAt,
        "metadata.airiMetaAdsMcpExecutions.$[execution].reconciliation":
          parsed.reconciliation,
      },
    },
    {
      new: true,
      runValidators: true,
      arrayFilters: [
        {
          "execution.version": 2,
          "execution.id": parsed.mutationId,
          "execution.claimToken": parsed.claimToken,
          "execution.reconciliation": { $exists: false },
          ...Object.fromEntries(
            Object.entries(eligibility).map(([key, value]) => [
              `execution.${key}`,
              value,
            ])
          ),
        },
      ],
    }
  )
    .select("_id metadata")
    .lean<AiriMessageMetadataProjection | null>();
  if (v2Reconciled) return findExecution(v2Reconciled, parsed.mutationId);

  const legacyResolution =
    parsed.resolution === "not_executed" ? "rejected" : "succeeded";
  const legacyReconciliation: AiriMetaAdsMcpReconciliation = {
    userId: parsed.reconciliation.actorUserId,
    resolution: parsed.reconciliation.resolution,
    note: parsed.reconciliation.note,
    reconciledAt: parsed.reconciliation.reconciledAt,
  };
  const v1Reconciled = await AiriChatMessage.findOneAndUpdate(
    {
      _id: parsed.messageId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      role: "assistant",
      "metadata.airiMetaAdsMcpExecutions": {
        $elemMatch: { version: 1, ...commonElementMatch },
      },
    },
    {
      $set: {
        "metadata.airiMetaAdsMcpExecutions.$[execution].status":
          legacyResolution,
        "metadata.airiMetaAdsMcpExecutions.$[execution].responseContent":
          parsed.responseContent,
        "metadata.airiMetaAdsMcpExecutions.$[execution].error": parsed.error,
        "metadata.airiMetaAdsMcpExecutions.$[execution].completedAt":
          parsed.completedAt,
        "metadata.airiMetaAdsMcpExecutions.$[execution].reconciliation":
          legacyReconciliation,
      },
    },
    {
      new: true,
      runValidators: true,
      arrayFilters: [
        {
          "execution.version": 1,
          "execution.id": parsed.mutationId,
          "execution.claimToken": parsed.claimToken,
          "execution.reconciliation": { $exists: false },
          ...Object.fromEntries(
            Object.entries(eligibility).map(([key, value]) => [
              `execution.${key}`,
              value,
            ])
          ),
        },
      ],
    }
  )
    .select("_id metadata")
    .lean<AiriMessageMetadataProjection | null>();
  return v1Reconciled ? findExecution(v1Reconciled, parsed.mutationId) : null;
}

function executionToolName(
  execution: AiriMetaAdsMcpConfirmationExecution
): string {
  return execution.version === 2
    ? execution.transaction.tool.name
    : execution.toolName;
}

export async function ensureAiriMetaAdsMcpResultMessage(
  input: EnsureAiriMetaAdsMcpResultMessageInput
): Promise<AiriMetaAdsMcpConfirmationResultMessage> {
  const parsed = ensureResultMessageInputSchema.parse(input);
  if (
    parsed.execution.status === "executing" ||
    !parsed.execution.responseContent ||
    !parsed.execution.completedAt
  ) {
    throw new Error("Meta Ads MCP confirmation result is not terminal");
  }
  const message = await AiriChatMessage.findOneAndUpdate(
    {
      _id: parsed.execution.resultMessageId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      role: "assistant",
      "metadata.intent": "meta_ads_mcp",
      "metadata.confirmedMutationId": parsed.execution.id,
      "metadata.sourceMessageId": parsed.sourceMessageId,
    },
    {
      $set: {
        content: parsed.execution.responseContent,
        "metadata.confirmedToolName": executionToolName(parsed.execution),
        "metadata.confirmationOk": parsed.execution.status === "succeeded",
        "metadata.confirmationStatus": parsed.execution.status,
        "metadata.confirmationSource": parsed.execution.reconciliation
          ? "manual_reconciliation"
          : "provider_execution",
        "metadata.reconciliation": parsed.execution.reconciliation ?? null,
      },
      $setOnInsert: {
        threadId: parsed.threadId,
        workspaceId: parsed.workspaceId,
        role: "assistant",
        "metadata.intent": "meta_ads_mcp",
        "metadata.confirmedMutationId": parsed.execution.id,
        "metadata.sourceMessageId": parsed.sourceMessageId,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  )
    .select("_id threadId workspaceId role content metadata createdAt")
    .lean<AiriMetaAdsMcpConfirmationResultMessage | null>();
  if (
    !message ||
    message.workspaceId !== parsed.workspaceId ||
    String(message.threadId) !== parsed.threadId ||
    message.role !== "assistant" ||
    message.metadata?.intent !== "meta_ads_mcp" ||
    message.metadata?.confirmedMutationId !== parsed.execution.id ||
    message.metadata?.sourceMessageId !== parsed.sourceMessageId
  ) {
    throw new Error("Meta Ads MCP confirmation result message conflict");
  }
  return message;
}

export const airiMetaAdsMcpConfirmationStore: AiriMetaAdsMcpConfirmationStore =
  {
    loadState: loadAiriMetaAdsMcpConfirmationState,
    claim: claimAiriMetaAdsMcpConfirmation,
    complete: completeAiriMetaAdsMcpConfirmation,
    reconcile: reconcileAiriMetaAdsMcpConfirmation,
    ensureResultMessage: ensureAiriMetaAdsMcpResultMessage,
  };
