import type { PipelineStage } from "mongoose";
const RECEIPT_LOOKBACK_MS = 86_400_000;
export function buildCanonicalProviderMessageIdExpr(field = "$messageId") {
  return {
    $cond: [
      { $eq: [{ $type: field }, "string"] },
      {
        $cond: [
          { $eq: [{ $substrBytes: [field, 0, 3] }, "ws_"] },
          {
            $substrBytes: [
              field,
              3,
              { $subtract: [{ $strLenBytes: field }, 3] },
            ],
          },
          field,
        ],
      },
      "",
    ],
  };
}
/** Mongo equivalent of shared normalizeWhatsAppPhone: ignore BSUIDs, preserve wa_ and 8/7 phone aliases. */
export function buildNormalizedWhatsAppPhoneExpr(field: string) {
  const trim = {
    $trim: {
      input: {
        $convert: { input: field, to: "string", onError: "", onNull: "" },
      },
    },
  };
  return {
    $let: {
      vars: { raw: trim },
      in: {
        $let: {
          vars: {
            input: {
              $cond: [
                {
                  $regexMatch: {
                    input: "$$raw",
                    regex: "^'\\+?\\d[\\d\\s().-]*$",
                  },
                },
                {
                  $substrCP: [
                    "$$raw",
                    1,
                    { $subtract: [{ $strLenCP: "$$raw" }, 1] },
                  ],
                },
                "$$raw",
              ],
            },
          },
          in: {
            $let: {
              vars: {
                phone: {
                  $cond: [
                    { $eq: [{ $substrCP: ["$$input", 0, 3] }, "wa_"] },
                    {
                      $substrCP: [
                        "$$input",
                        3,
                        { $subtract: [{ $strLenCP: "$$input" }, 3] },
                      ],
                    },
                    "$$input",
                  ],
                },
              },
              in: {
                $let: {
                  vars: {
                    digits: {
                      $reduce: {
                        input: {
                          $regexFindAll: { input: "$$phone", regex: "[0-9]" },
                        },
                        initialValue: "",
                        in: { $concat: ["$$value", "$$this.match"] },
                      },
                    },
                  },
                  in: {
                    $cond: [
                      {
                        $and: [
                          {
                            $regexMatch: {
                              input: "$$phone",
                              regex: "^\\+?[0-9\\s().-]+$",
                            },
                          },
                          { $gte: [{ $strLenCP: "$$digits" }, 6] },
                          { $lte: [{ $strLenCP: "$$digits" }, 15] },
                        ],
                      },
                      {
                        $cond: [
                          {
                            $regexMatch: {
                              input: "$$digits",
                              regex: "^8[0-9]{10}$",
                            },
                          },
                          {
                            $concat: ["7", { $substrCP: ["$$digits", 1, 10] }],
                          },
                          "$$digits",
                        ],
                      },
                      null,
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export type BulkSqlDeliveryReceipt = {
  providerMessageId: string;
  delivery: {
    status: string;
    sentAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
    failedAt: Date | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  providerRecipient: string | null;
  providerRecipients?: string[];
};
export function buildWhatsAppDeliveryReconciliationStages(params: {
  workspaceId: string;
  startDate: Date;
  observedAt: Date;
  sqlReceipts?: BulkSqlDeliveryReceipt[];
}): PipelineStage[] {
  const firstStatus = (statuses: string[]) => ({
    $min: { $cond: [{ $in: ["$status", statuses] }, "$eventAt", null] },
  });
  const latestReceipt = (rank: unknown, value: unknown) => ({
    $max: { rank: { $cond: [rank, 1, 0] }, at: "$eventAt", id: "$_id", value },
  });
  const present = (field: string) => ({
    $not: [{ $in: [{ $ifNull: [`$${field}`, null] }, [null, ""]] }],
  });
  const atObservation = (field: string) => ({
    $cond: [
      {
        $and: [
          { $ne: [{ $ifNull: [field, null] }, null] },
          { $lte: [field, params.observedAt] },
        ],
      },
      field,
      null,
    ],
  });
  const latestStateVisible = {
    $lte: [
      { $ifNull: ["$delivery.lastEventAt", params.observedAt] },
      params.observedAt,
    ],
  };
  return [
    {
      $set: {
        "delivery.sentAt": atObservation("$delivery.sentAt"),
        "delivery.deliveredAt": atObservation("$delivery.deliveredAt"),
        "delivery.readAt": atObservation("$delivery.readAt"),
        "delivery.failedAt": atObservation("$delivery.failedAt"),
        "delivery.status": {
          $cond: [latestStateVisible, "$delivery.status", null],
        },
        "delivery.errorCode": {
          $cond: [latestStateVisible, "$delivery.errorCode", null],
        },
        "delivery.errorMessage": {
          $cond: [latestStateVisible, "$delivery.errorMessage", null],
        },
      },
    },
    {
      $unionWith: {
        coll: "messagedeliveryevents",
        pipeline: [
          {
            $match: {
              workspaceId: params.workspaceId,
              eventAt: {
                $gte: new Date(
                  params.startDate.getTime() - RECEIPT_LOOKBACK_MS
                ),
                $lte: params.observedAt,
              },
            },
          },
          {
            $group: {
              _id: buildCanonicalProviderMessageIdExpr("$messageId"),
              recipientIds: { $addToSet: "$recipientId" },
              recipientWaIds: { $addToSet: "$recipientWaId" },
              sentAt: firstStatus(["sent", "delivered", "read", "played"]),
              deliveredAt: firstStatus(["delivered", "read", "played"]),
              readAt: firstStatus(["read", "played"]),
              failedAt: firstStatus(["failed"]),
              phone: latestReceipt(present("phoneNumberId"), "$phoneNumberId"),
              source: latestReceipt(present("sourceId"), "$sourceId"),
              pricing: latestReceipt(
                {
                  $or: [
                    { $ne: [{ $ifNull: ["$pricingType", null] }, null] },
                    { $ne: [{ $ifNull: ["$pricingBillable", null] }, null] },
                  ],
                },
                {
                  pricingType: "$pricingType",
                  pricingBillable: "$pricingBillable",
                  pricingCategory: "$pricingCategory",
                }
              ),
              failure: latestReceipt(
                {
                  $and: [
                    { $eq: ["$status", "failed"] },
                    { $ne: [{ $ifNull: ["$errorCode", null] }, null] },
                  ],
                },
                "$errorCode"
              ),
            },
          },
          { $set: { _receipts: true } },
        ],
      },
    },
    ...(params.sqlReceipts?.length
      ? [
          {
            $unionWith: {
              coll: "messages",
              pipeline: [
                {
                  $match: {
                    workspaceId: params.workspaceId,
                    channel: "whatsapp",
                  },
                },
                { $limit: 1 },
                {
                  $project: {
                    rows: {
                      $literal: params.sqlReceipts.map(row => ({
                        _id: row.providerMessageId,
                        _receipts: true,
                        sentAt: row.delivery.sentAt,
                        deliveredAt: row.delivery.deliveredAt,
                        readAt: row.delivery.readAt,
                        failedAt: row.delivery.failedAt,
                        sqlDelivery: row.delivery,
                        providerRecipient: row.providerRecipient,
                        recipientIds:
                          row.providerRecipients ||
                          (row.providerRecipient
                            ? [row.providerRecipient]
                            : []),
                        failure: {
                          rank: row.delivery.errorCode ? 1 : 0,
                          value: row.delivery.errorCode,
                        },
                      })),
                    },
                  },
                },
                { $unwind: "$rows" },
                { $replaceRoot: { newRoot: "$rows" } },
              ],
            },
          },
        ]
      : []),
    {
      $group: {
        _id: { $ifNull: ["$providerMessageId", "$_id"] },
        sends: { $push: { $cond: ["$_receipts", "$$REMOVE", "$$ROOT"] } },
        receipts: { $push: { $cond: ["$_receipts", "$$ROOT", "$$REMOVE"] } },
      },
    },
    { $unwind: "$sends" },
    { $unwind: { path: "$receipts", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: {
          $ifNull: [
            "$sends.whatsappWamidFingerprint",
            "$sends.providerMessageId",
          ],
        },
        message: {
          $top: {
            sortBy: { "sends.date": 1, "sends._id": 1 },
            output: "$sends",
          },
        },
        providerMessageIds: { $addToSet: "$sends.providerMessageId" },
        receipts: {
          $max: { $cond: [{ $eq: [{ $type: "$receipts" }, "object"] }, 1, 0] },
        },
        sentAt: { $min: "$receipts.sentAt" },
        storedSentAt: { $min: "$sends.delivery.sentAt" },
        storedDeliveredAt: { $min: "$sends.delivery.deliveredAt" },
        storedReadAt: { $min: "$sends.delivery.readAt" },
        storedFailedAt: { $min: "$sends.delivery.failedAt" },
        storedStatuses: { $addToSet: "$sends.delivery.status" },
        sqlDelivery: { $max: "$receipts.sqlDelivery" },
        providerRecipient: { $max: "$receipts.providerRecipient" },
        providerRecipients: { $addToSet: "$receipts.providerRecipient" },
        identityConversationIds: { $addToSet: "$sends.conversation" },
        receiptRecipientIdSets: { $addToSet: "$receipts.recipientIds" },
        receiptRecipientWaIdSets: { $addToSet: "$receipts.recipientWaIds" },
        storedRecipientIds: { $addToSet: "$sends.delivery.recipientId" },
        storedRecipientWaIds: { $addToSet: "$sends.delivery.recipientWaId" },
        storedChats: { $addToSet: "$sends.chat" },
        deliveredAt: { $min: "$receipts.deliveredAt" },
        readAt: { $min: "$receipts.readAt" },
        failedAt: { $min: "$receipts.failedAt" },
        phone: { $max: "$receipts.phone" },
        source: { $max: "$receipts.source" },
        pricing: { $max: "$receipts.pricing" },
        failure: { $max: "$receipts.failure" },
      },
    },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: [
            "$message",
            {
              providerMessageIds: "$providerMessageIds",
              providerRecipient: "$providerRecipient",
              providerRecipients: {
                $filter: {
                  input: "$providerRecipients",
                  cond: { $ne: ["$$this", null] },
                },
              },
              identityConversationIds: "$identityConversationIds",
              receiptRecipientIdSets: "$receiptRecipientIdSets",
              receiptRecipientWaIdSets: "$receiptRecipientWaIdSets",
              storedRecipientIds: "$storedRecipientIds",
              storedRecipientWaIds: "$storedRecipientWaIds",
              storedChats: "$storedChats",
              sqlDelivery: "$sqlDelivery",
              storedStatuses: "$storedStatuses",
              storedSentAt: "$storedSentAt",
              storedDeliveredAt: "$storedDeliveredAt",
              storedReadAt: "$storedReadAt",
              storedFailedAt: "$storedFailedAt",
              pricingReceipt: {
                $cond: [
                  { $eq: ["$pricing.rank", 1] },
                  "$pricing.value",
                  "$$REMOVE",
                ],
              },
              eventState: {
                $mergeObjects: [
                  {
                    $cond: [
                      { $eq: ["$receipts", 1] },
                      {
                        sentAt: "$sentAt",
                        deliveredAt: "$deliveredAt",
                        readAt: "$readAt",
                        failedAt: "$failedAt",
                        phoneNumberId: { $ifNull: ["$phone.value", null] },
                        sourceId: { $ifNull: ["$source.value", null] },
                      },
                      null,
                    ],
                  },
                  {
                    $cond: [
                      { $eq: ["$failure.rank", 1] },
                      { errorCode: "$failure.value" },
                      null,
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
    {
      $set: {
        providerRecipients: {
          $setUnion: [
            {
              $filter: {
                input: {
                  $map: {
                    input: {
                      $concatArrays: [
                        {
                          $reduce: {
                            input: "$receiptRecipientIdSets",
                            initialValue: [],
                            in: {
                              $concatArrays: [
                                "$$value",
                                {
                                  $cond: [{ $isArray: "$$this" }, "$$this", []],
                                },
                              ],
                            },
                          },
                        },
                        {
                          $reduce: {
                            input: "$receiptRecipientWaIdSets",
                            initialValue: [],
                            in: {
                              $concatArrays: [
                                "$$value",
                                {
                                  $cond: [{ $isArray: "$$this" }, "$$this", []],
                                },
                              ],
                            },
                          },
                        },
                        "$storedRecipientIds",
                        "$storedRecipientWaIds",
                        "$storedChats",
                        "$providerRecipients",
                      ],
                    },
                    as: "identity",
                    in: buildNormalizedWhatsAppPhoneExpr("$$identity"),
                  },
                },
                cond: { $ne: ["$$this", null] },
              },
            },
            [],
          ],
        },
      },
    },
    {
      $set: {
        providerRecipient: {
          $ifNull: [{ $arrayElemAt: ["$providerRecipients", 0] }, null],
        },
      },
    },
    {
      $set: {
        "delivery.sentAt": {
          $ifNull: [
            "$storedSentAt",
            { $ifNull: ["$sqlDelivery.sentAt", "$eventState.sentAt"] },
          ],
        },
        "delivery.deliveredAt": {
          $ifNull: [
            "$storedDeliveredAt",
            {
              $ifNull: ["$sqlDelivery.deliveredAt", "$eventState.deliveredAt"],
            },
          ],
        },
        "delivery.readAt": {
          $ifNull: [
            "$storedReadAt",
            { $ifNull: ["$sqlDelivery.readAt", "$eventState.readAt"] },
          ],
        },
        "delivery.failedAt": {
          $ifNull: [
            "$storedFailedAt",
            { $ifNull: ["$sqlDelivery.failedAt", "$eventState.failedAt"] },
          ],
        },
        "delivery.errorCode": {
          $ifNull: [
            "$sqlDelivery.errorCode",
            { $ifNull: ["$delivery.errorCode", "$eventState.errorCode"] },
          ],
        },
        "delivery.status": {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    { $in: ["read", "$storedStatuses"] },
                    { $in: ["played", "$storedStatuses"] },
                    { $in: ["$sqlDelivery.status", ["read", "played"]] },
                  ],
                },
                then: "read",
              },
              {
                case: {
                  $or: [
                    { $in: ["delivered", "$storedStatuses"] },
                    { $eq: ["$sqlDelivery.status", "delivered"] },
                  ],
                },
                then: "delivered",
              },
              {
                case: {
                  $or: [
                    { $in: ["failed", "$storedStatuses"] },
                    { $eq: ["$sqlDelivery.status", "failed"] },
                  ],
                },
                then: "failed",
              },
            ],
            default: { $ifNull: ["$delivery.status", "$sqlDelivery.status"] },
          },
        },
        "delivery.errorMessage": {
          $ifNull: ["$sqlDelivery.errorMessage", "$delivery.errorMessage"],
        },
        analyticsSourceId: {
          $ifNull: ["$origin.sourceId", "$eventState.sourceId"],
        },
        analyticsPhoneNumberId: {
          $ifNull: [
            "$whatsappGroup.phoneNumberId",
            "$eventState.phoneNumberId",
          ],
        },
      },
    },
  ] as PipelineStage[];
}
