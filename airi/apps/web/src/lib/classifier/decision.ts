const OTHER_LABEL = "Other";

function normalizeOptions(options: string[]): string[] {
  return Array.from(
    new Set(
      (options || []).map(option => String(option || "").trim()).filter(Boolean)
    )
  );
}

export function matchAllowedOption(
  value: string | null | undefined,
  options: string[]
): string | null {
  const normalizedValue = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalizedValue) return null;

  const allowedOptions = normalizeOptions(options);
  return (
    allowedOptions.find(
      option => option.trim().toLowerCase() === normalizedValue
    ) || null
  );
}

function getCategoryFallback(
  allowedCategories: string[],
  defaultCategory: string
): string {
  return (
    matchAllowedOption(defaultCategory, allowedCategories) ||
    matchAllowedOption(OTHER_LABEL, allowedCategories) ||
    normalizeOptions(allowedCategories)[0] ||
    OTHER_LABEL
  );
}

export function resolveStableCategory(params: {
  predictedCategory: string | null | undefined;
  predictedConfidence: number;
  confidenceThreshold: number;
  existingCategory?: string | null;
  allowedCategories: string[];
  defaultCategory: string;
  changeConfidenceFloor: number;
}): string {
  const predicted = matchAllowedOption(
    params.predictedCategory,
    params.allowedCategories
  );
  const existing = matchAllowedOption(
    params.existingCategory,
    params.allowedCategories
  );
  const fallback = getCategoryFallback(
    params.allowedCategories,
    params.defaultCategory
  );

  if (
    predicted &&
    existing &&
    predicted.toLowerCase() === existing.toLowerCase()
  ) {
    return predicted;
  }

  if (!predicted) {
    return existing || fallback;
  }

  if (!existing) {
    return params.predictedConfidence >= params.confidenceThreshold
      ? predicted
      : fallback;
  }

  const minConfidenceToChange = Math.max(
    params.confidenceThreshold,
    params.changeConfidenceFloor
  );

  return params.predictedConfidence >= minConfidenceToChange
    ? predicted
    : existing;
}
