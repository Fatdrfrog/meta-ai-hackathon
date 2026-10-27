import { CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION } from "@icecore/shared/lib/conversation-classification-freshness";
import type mongoose from "mongoose";

export const CONVERSATION_CLASSIFICATION_LEASE_MS = 10 * 60 * 1000;
export const CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS = 10 * 60 * 1000;

export type ClassificationWakeRequest = {
  conversationId: string;
  requestedRevision: number;
  generation: number;
  requestedAt: Date;
};

export type ClassificationWakeScheduler = (
  request: ClassificationWakeRequest
) => Promise<void> | void;

export type ClassificationInputPendingTransitionOptions = {
  now: Date;
  hasInboundInput?: boolean | Record<string, unknown>;
};

const NEXT_REVISION_PATH = "__classification_next_revision";
const HAS_INBOUND_PATH = "__classification_has_inbound";
const LIVE_PROCESSING_PATH = "__classification_live_processing";

export const CLASSIFICATION_INPUT_TRANSITION_TEMPORARY_PATHS = [
  NEXT_REVISION_PATH,
  HAS_INBOUND_PATH,
  LIVE_PROCESSING_PATH,
] as const;

function safeIntegerExpression(path: string, minimum: number) {
  return {
    $and: [
      { $isNumber: path },
      { $gte: [path, minimum] },
      { $lte: [path, Number.MAX_SAFE_INTEGER] },
      { $eq: [{ $trunc: path }, path] },
    ],
  };
}

/**
 * The single authoritative semantic-input transition. Callers must execute
 * this only after they have atomically established that the input changed.
 */
export function buildClassificationInputPendingTransitionPipeline(
  options: ClassificationInputPendingTransitionOptions
): mongoose.PipelineStage[] {
  const hasInboundInput =
    options.hasInboundInput ?? {
      $eq: [{ $type: "$last_inbound_at" }, "date"],
    };

  return [
    {
      $set: {
        [NEXT_REVISION_PATH]: {
          $add: [
            {
              $cond: [
                safeIntegerExpression("$classification_revision", 0),
                "$classification_revision",
                0,
              ],
            },
            1,
          ],
        },
        [HAS_INBOUND_PATH]: hasInboundInput,
        [LIVE_PROCESSING_PATH]: {
          $and: [
            hasInboundInput,
            {
              $eq: [
                "$classification_state.contractVersion",
                CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
              ],
            },
            { $eq: ["$classification_state.status", "processing"] },
            safeIntegerExpression(
              "$classification_state.processingRevision",
              1
            ),
            safeIntegerExpression("$classification_state.fence", 0),
            {
              $eq: [
                { $type: "$classification_state.lease.expiresAt" },
                "date",
              ],
            },
            {
              $gt: ["$classification_state.lease.expiresAt", options.now],
            },
            {
              $eq: [
                { $type: "$classification_state.lease.ownerToken" },
                "string",
              ],
            },
            { $ne: ["$classification_state.lease.ownerToken", ""] },
          ],
        },
      },
    },
    {
      $set: {
        classification_revision: `$${NEXT_REVISION_PATH}`,
        classification_state: {
          contractVersion:
            CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
          status: {
            $cond: [
              `$${HAS_INBOUND_PATH}`,
              {
                $cond: [
                  `$${LIVE_PROCESSING_PATH}`,
                  "processing",
                  "pending",
                ],
              },
              "not_applicable",
            ],
          },
          requestedRevision: `$${NEXT_REVISION_PATH}`,
          processingRevision: {
            $cond: [
              `$${LIVE_PROCESSING_PATH}`,
              "$classification_state.processingRevision",
              null,
            ],
          },
          appliedRevision: {
            $cond: [
              {
                $eq: [
                  "$classification_state.contractVersion",
                  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
                ],
              },
              { $ifNull: ["$classification_state.appliedRevision", null] },
              null,
            ],
          },
          generation: {
            $add: [
              {
                $cond: [
                  {
                    $eq: [
                      "$classification_state.contractVersion",
                      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
                    ],
                  },
                  { $ifNull: ["$classification_state.generation", 0] },
                  0,
                ],
              },
              { $cond: [`$${HAS_INBOUND_PATH}`, 1, 0] },
            ],
          },
          attemptRevision: `$${NEXT_REVISION_PATH}`,
          attemptCount: 0,
          fence: {
            $cond: [
              {
                $eq: [
                  "$classification_state.contractVersion",
                  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
                ],
              },
              { $ifNull: ["$classification_state.fence", 0] },
              0,
            ],
          },
          requestedAt: options.now,
          nextAttemptAt: {
            $cond: [`$${HAS_INBOUND_PATH}`, options.now, null],
          },
          lastEnqueuedAt: null,
          completedAt: null,
          lease: {
            $cond: [
              `$${LIVE_PROCESSING_PATH}`,
              "$classification_state.lease",
              null,
            ],
          },
          error: null,
          review: null,
          blocked: null,
        },
        is_classified: false,
        is_qa_analyzed: false,
        classification_error: null,
      },
    },
    { $unset: [...CLASSIFICATION_INPUT_TRANSITION_TEMPORARY_PATHS] },
  ];
}
