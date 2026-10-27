import type { PipelineStage } from "mongoose";

const MAX_EVALUATION_PAIRS = 10_000;

export type OfflineEvaluationPair = {
  _id: { workspace_key: string; pred: string | null; gold: string | null };
  count: number;
};

type Confusion = { tp: number; fp: number; fn: number };

export function buildOfflineEvaluationPipeline(
  since: Date,
  until: Date
): PipelineStage[] {
  return [
    {
      $match: {
        createdAt: { $gte: since, $lt: until },
        "classification.category": { $exists: true },
        "shadow_classification.category": { $exists: true },
      },
    },
    {
      $group: {
        _id: {
          workspace_key: {
            $concat: [
              {
                $cond: [
                  { $eq: [{ $ifNull: ["$workspaceId", ""] }, ""] },
                  "unknown",
                  "$workspaceId",
                ],
              },
              "::",
              {
                $cond: [
                  {
                    $eq: [
                      { $ifNull: ["$classification_meta.taxonomy_id", ""] },
                      "",
                    ],
                  },
                  "default",
                  "$classification_meta.taxonomy_id",
                ],
              },
            ],
          },
          pred: { $ifNull: ["$classification.category", null] },
          gold: { $ifNull: ["$shadow_classification.category", null] },
        },
        count: { $sum: 1 },
      },
    },
    // Aggregate the complete window before checking output cardinality.
    { $limit: MAX_EVALUATION_PAIRS + 1 },
  ];
}

export function summarizeOfflineEvaluation(pairs: OfflineEvaluationPair[]) {
  if (pairs.length > MAX_EVALUATION_PAIRS) {
    throw new Error("Offline evaluation exceeds its dimension budget");
  }
  const grouped = new Map<string, Map<string, Confusion>>();
  for (const {
    _id: { workspace_key, pred, gold },
    count,
  } of pairs) {
    let confusions = grouped.get(workspace_key);
    if (!confusions) {
      confusions = new Map();
      grouped.set(workspace_key, confusions);
    }
    for (const label of [pred, gold]) {
      if (label && !confusions.has(label)) {
        confusions.set(label, { tp: 0, fp: 0, fn: 0 });
      }
    }
    // One-sided empty pairs still contribute labels to the macro denominator.
    if (!pred || !gold) continue;
    if (pred === gold) confusions.get(pred)!.tp += count;
    else {
      confusions.get(pred)!.fp += count;
      confusions.get(gold)!.fn += count;
    }
  }
  return Array.from(grouped, ([workspace_key, confusions]) => {
    const labels = Array.from(confusions, ([label, { tp, fp, fn }]) => {
      const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
      const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
      const f1 =
        precision + recall > 0
          ? (2 * precision * recall) / (precision + recall)
          : 0;
      return { label, tp, fp, fn, precision, recall, f1 };
    });
    return {
      workspace_key,
      labels,
      macro: {
        precision: labels.length
          ? labels.reduce((sum, m) => sum + m.precision, 0) / labels.length
          : 0,
        recall: labels.length
          ? labels.reduce((sum, m) => sum + m.recall, 0) / labels.length
          : 0,
        f1: labels.length
          ? labels.reduce((sum, m) => sum + m.f1, 0) / labels.length
          : 0,
      },
    };
  });
}
