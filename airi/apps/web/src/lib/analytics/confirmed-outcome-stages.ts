import type { PipelineStage } from "mongoose";

/** Mongo $isNumber includes NaN and Infinity; ledger amounts must be finite and nonnegative. */
export const verifiedAmount = (field: string) => ({
  $and: [
    { $isNumber: field },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_VALUE] },
  ],
});

/** Acquisition and retention attach refunds by exact merchant transaction identity. */
export function confirmedRefundLookup(
  workspaceId: string,
  now: Date,
  collection: string
): PipelineStage.Lookup {
  return {
    $lookup: {
      from: collection,
      let: {
        transaction: "$transactionId",
        source: "$sourceId",
        currency: "$currency",
      },
      pipeline: [
        {
          $match: {
            workspaceId,
            conversionType: "refund",
            occurredAt: { $lte: now },
            $expr: {
              $and: [
                { $ne: ["$$transaction", null] },
                { $eq: ["$purchaseTransactionId", "$$transaction"] },
                { $eq: ["$sourceId", "$$source"] },
                { $eq: ["$currency", "$$currency"] },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            value: { $sum: { $cond: [verifiedAmount("$value"), "$value", 0] } },
            unknownValues: {
              $sum: { $cond: [verifiedAmount("$value"), 0, 1] },
            },
          },
        },
      ],
      as: "refunds",
    },
  };
}
