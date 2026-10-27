import type { ScenarioCampaignRecipient } from "./scenario-bulk";
import { isRecord } from "./value-guards";

export const RECIPIENT_COLUMN_SPLIT_CONFIG_VERSION = 1 as const;
export const MAX_RECIPIENT_COLUMN_SPLIT_PATHS = 20;
export const MAX_RECIPIENT_COLUMN_SPLIT_RULES_PER_PATH = 5;
export const MAX_RECIPIENT_COLUMN_SPLIT_COLUMN_LENGTH = 120;
export const MAX_RECIPIENT_COLUMN_SPLIT_VALUE_LENGTH = 240;
export const MAX_RECIPIENT_COLUMN_SPLIT_IN_VALUES = 50;
export const MAX_RECIPIENT_COLUMN_SPLIT_LABEL_LENGTH = 120;
export const MAX_RECIPIENT_COLUMN_SPLIT_PATH_ID_LENGTH = 80;
export const MAX_RECIPIENT_COLUMN_SPLIT_RULE_ID_LENGTH = 80;

export const RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX =
  "right-source-column-split";
export const RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID = "else" as const;
export const RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID =
  `${RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX}-${RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID}`;

export const RECIPIENT_COLUMN_SPLIT_STRING_OPS = [
  "equals",
  "not_equals",
  "in",
  "contains",
  "is_empty",
  "is_not_empty",
] as const;

export const RECIPIENT_COLUMN_SPLIT_NUMBER_OPS = [
  "eq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
] as const;

export type ScenarioRecipientColumnSplitStringOp =
  (typeof RECIPIENT_COLUMN_SPLIT_STRING_OPS)[number];
export type ScenarioRecipientColumnSplitNumberOp =
  (typeof RECIPIENT_COLUMN_SPLIT_NUMBER_OPS)[number];
export type ScenarioRecipientColumnSplitOp =
  | ScenarioRecipientColumnSplitStringOp
  | ScenarioRecipientColumnSplitNumberOp;

export type ScenarioRecipientColumnSplitRule = {
  id: string;
  column: string;
  op: ScenarioRecipientColumnSplitOp;
  value?: string;
  values?: string[];
  valueTo?: string;
};

export type ScenarioRecipientColumnSplitPath = {
  id: string;
  label?: string;
  rules: ScenarioRecipientColumnSplitRule[];
};

export type ScenarioRecipientColumnSplitConfig = {
  version: typeof RECIPIENT_COLUMN_SPLIT_CONFIG_VERSION;
  paths: ScenarioRecipientColumnSplitPath[];
};

export type ScenarioRecipientColumnSplitRecipient = ScenarioCampaignRecipient;

export type ScenarioRecipientColumnSplitMatchResult = {
  pathId: string;
  handleId: string;
  label?: string;
  isElse: boolean;
};

export type ScenarioRecipientColumnSplitRouteSummary = {
  byPathId: Record<string, number>;
  elseCount: number;
  total: number;
};

export type ScenarioRecipientColumnSplitNormalization =
  | { status: "absent"; value: null }
  | { status: "supported"; value: ScenarioRecipientColumnSplitConfig }
  | {
      status: "unsupported";
      value: null;
      version: unknown;
      raw: unknown;
    };

const STRING_OP_SET = new Set<string>(RECIPIENT_COLUMN_SPLIT_STRING_OPS);
const NUMBER_OP_SET = new Set<string>(RECIPIENT_COLUMN_SPLIT_NUMBER_OPS);

function normalizeString(
  value: unknown,
  maxLength = MAX_RECIPIENT_COLUMN_SPLIT_VALUE_LENGTH,
): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalString(
  value: unknown,
  maxLength = MAX_RECIPIENT_COLUMN_SPLIT_VALUE_LENGTH,
): string | undefined {
  const normalized = normalizeString(value, maxLength);
  return normalized || undefined;
}

function normalizeIdentifier(
  value: unknown,
  fallbackIndex: number,
  maxLength: number,
): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return `item_${fallbackIndex + 1}`;
  }

  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);

  return normalized || `item_${fallbackIndex + 1}`;
}

function normalizePathId(value: unknown, fallbackIndex: number): string {
  const normalized = normalizeIdentifier(
    value,
    fallbackIndex,
    MAX_RECIPIENT_COLUMN_SPLIT_PATH_ID_LENGTH,
  );
  return normalized === RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID
    ? `path_${fallbackIndex + 1}`
    : normalized;
}

function normalizeRuleId(value: unknown, fallbackIndex: number): string {
  return normalizeIdentifier(
    value,
    fallbackIndex,
    MAX_RECIPIENT_COLUMN_SPLIT_RULE_ID_LENGTH,
  );
}

function normalizeOp(value: unknown): ScenarioRecipientColumnSplitOp | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (STRING_OP_SET.has(normalized)) {
    return normalized as ScenarioRecipientColumnSplitStringOp;
  }
  if (NUMBER_OP_SET.has(normalized)) {
    return normalized as ScenarioRecipientColumnSplitNumberOp;
  }
  return null;
}

export function parseRecipientColumnSplitInValues(
  value: unknown,
): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeString(item))
      .filter(Boolean)
      .slice(0, MAX_RECIPIENT_COLUMN_SPLIT_IN_VALUES);
  }

  const raw = normalizeOptionalString(value);
  if (!raw) return [];

  const values: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const normalized = normalizeString(part);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
    if (values.length >= MAX_RECIPIENT_COLUMN_SPLIT_IN_VALUES) break;
  }
  return values;
}

function resolveInValues(rule: ScenarioRecipientColumnSplitRule): string[] {
  if (Array.isArray(rule.values) && rule.values.length > 0) {
    return rule.values;
  }
  return parseRecipientColumnSplitInValues(rule.value);
}

function normalizeRule(
  value: unknown,
  fallbackIndex: number,
): ScenarioRecipientColumnSplitRule | null {
  if (!isRecord(value)) return null;

  const column = normalizeString(
    value.column,
    MAX_RECIPIENT_COLUMN_SPLIT_COLUMN_LENGTH,
  );
  const op = normalizeOp(value.op);
  if (!column || !op) return null;

  const rule: ScenarioRecipientColumnSplitRule = {
    id: normalizeRuleId(value.id, fallbackIndex),
    column,
    op,
  };

  const normalizedValue = normalizeOptionalString(value.value);
  if (normalizedValue) {
    rule.value = normalizedValue;
  }

  const normalizedValueTo = normalizeOptionalString(value.valueTo);
  if (normalizedValueTo) {
    rule.valueTo = normalizedValueTo;
  }

  if (op === "in") {
    const values = parseRecipientColumnSplitInValues(
      Array.isArray(value.values) && value.values.length > 0
        ? value.values
        : value.value,
    );
    if (values.length > 0) {
      rule.values = values;
      // Keep a joined display value so editors round-trip cleanly.
      rule.value = values.join(", ");
    }
  } else if (Array.isArray(value.values)) {
    const values = parseRecipientColumnSplitInValues(value.values);
    if (values.length > 0) {
      rule.values = values;
    }
  }

  return rule;
}

function normalizePath(
  value: unknown,
  fallbackIndex: number,
): ScenarioRecipientColumnSplitPath | null {
  if (!isRecord(value)) return null;

  const rulesInput = Array.isArray(value.rules) ? value.rules : [];
  const rules = rulesInput
    .map((rule, ruleIndex) => normalizeRule(rule, ruleIndex))
    .filter((rule): rule is ScenarioRecipientColumnSplitRule => rule !== null)
    .slice(0, MAX_RECIPIENT_COLUMN_SPLIT_RULES_PER_PATH);

  return {
    id: normalizePathId(value.id, fallbackIndex),
    label: normalizeOptionalString(
      value.label,
      MAX_RECIPIENT_COLUMN_SPLIT_LABEL_LENGTH,
    ),
    rules,
  };
}

export function normalizeScenarioRecipientColumnSplit(
  value: unknown,
): ScenarioRecipientColumnSplitNormalization {
  if (value == null) {
    return { status: "absent", value: null };
  }

  if (!isRecord(value)) {
    return { status: "unsupported", value: null, version: undefined, raw: value };
  }

  const version = value.version;
  if (version !== RECIPIENT_COLUMN_SPLIT_CONFIG_VERSION) {
    return { status: "unsupported", value: null, version, raw: value };
  }

  const pathsInput = Array.isArray(value.paths) ? value.paths : [];
  const paths = pathsInput
    .map((path, pathIndex) => normalizePath(path, pathIndex))
    .filter((path): path is ScenarioRecipientColumnSplitPath => path !== null)
    .slice(0, MAX_RECIPIENT_COLUMN_SPLIT_PATHS);

  return {
    status: "supported",
    value: {
      version: RECIPIENT_COLUMN_SPLIT_CONFIG_VERSION,
      paths,
    },
  };
}

export function coerceRecipientColumnSplitConfig(
  value: unknown,
): ScenarioRecipientColumnSplitConfig {
  const normalized = normalizeScenarioRecipientColumnSplit(value);
  if (normalized.status === "supported") {
    return normalized.value;
  }
  return createEmptyRecipientColumnSplitConfig();
}

export function createEmptyRecipientColumnSplitConfig(): ScenarioRecipientColumnSplitConfig {
  return {
    version: RECIPIENT_COLUMN_SPLIT_CONFIG_VERSION,
    paths: [],
  };
}

export function createDefaultRecipientColumnSplitPath(
  index = 0,
  existingPathIds: Iterable<string> = [],
): ScenarioRecipientColumnSplitPath {
  const usedIds = new Set(
    Array.from(existingPathIds, id =>
      typeof id === "string" ? id.trim() : "",
    ).filter(Boolean),
  );
  let nextIndex = Math.max(0, index) + 1;
  let pathId = `path_${nextIndex}`;
  while (usedIds.has(pathId)) {
    nextIndex += 1;
    pathId = `path_${nextIndex}`;
  }

  return {
    id: normalizePathId(pathId, Math.max(0, nextIndex - 1)),
    rules: [
      {
        id: normalizeRuleId(`rule_${nextIndex}`, 0),
        column: "",
        op: "equals",
        value: "",
      },
    ],
  };
}

export function buildRecipientColumnSplitPathHandleId(pathId: string): string {
  const trimmed = typeof pathId === "string" ? pathId.trim() : "";
  if (trimmed === RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID) {
    return RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID;
  }
  const normalizedPathId = normalizePathId(pathId, 0);
  return `${RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX}-${normalizedPathId}`;
}

export function parseRecipientColumnSplitPathHandleId(
  handleId: string | null | undefined,
): { pathId: string; isElse: boolean } | null {
  const normalizedHandleId =
    typeof handleId === "string" ? handleId.trim() : "";
  if (!normalizedHandleId) return null;

  if (normalizedHandleId === RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID) {
    return {
      pathId: RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
      isElse: true,
    };
  }

  const prefix = `${RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX}-`;
  if (!normalizedHandleId.startsWith(prefix)) return null;

  const pathId = normalizedHandleId.slice(prefix.length).trim();
  if (!pathId || pathId === RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID) {
    return {
      pathId: RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
      isElse: true,
    };
  }

  return { pathId, isElse: false };
}

export function getRecipientColumnSplitSourceHandleIds(
  config: ScenarioRecipientColumnSplitConfig,
): string[] {
  const handles = config.paths.map(path =>
    buildRecipientColumnSplitPathHandleId(path.id),
  );
  handles.push(RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID);
  return handles;
}

function getRecipientColumnValue(
  recipient: ScenarioRecipientColumnSplitRecipient,
  column: string,
): string {
  const normalizedColumn = column.trim();
  if (!normalizedColumn) return "";

  return (
    recipient.fields?.[normalizedColumn] ??
    recipient.variables?.[normalizedColumn] ??
    ""
  )
    .normalize("NFKC")
    .trim();
}

function compareNormalizedStrings(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function parseNumericValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function ruleHasRequiredValues(rule: ScenarioRecipientColumnSplitRule): boolean {
  switch (rule.op) {
    case "is_empty":
    case "is_not_empty":
      return true;
    case "in":
      return resolveInValues(rule).length > 0;
    case "between":
      return Boolean(rule.value?.trim() && rule.valueTo?.trim());
    default:
      return Boolean(rule.value?.trim());
  }
}

function isNumberOp(
  op: ScenarioRecipientColumnSplitOp,
): op is ScenarioRecipientColumnSplitNumberOp {
  return NUMBER_OP_SET.has(op);
}

function matchesStringRule(
  cellValue: string,
  rule: ScenarioRecipientColumnSplitRule,
): boolean {
  switch (rule.op) {
    case "equals":
      return compareNormalizedStrings(cellValue, rule.value ?? "");
    case "not_equals":
      return !compareNormalizedStrings(cellValue, rule.value ?? "");
    case "contains":
      return cellValue
        .toLocaleLowerCase()
        .includes((rule.value ?? "").toLocaleLowerCase());
    case "in":
      return resolveInValues(rule).some(candidate =>
        compareNormalizedStrings(cellValue, candidate),
      );
    case "is_empty":
      return cellValue.length === 0;
    case "is_not_empty":
      return cellValue.length > 0;
    default:
      return false;
  }
}

function matchesNumberRule(
  cellValue: string,
  rule: ScenarioRecipientColumnSplitRule,
): boolean {
  const numericCellValue = parseNumericValue(cellValue);
  const numericRuleValue = parseNumericValue(rule.value ?? "");
  if (numericCellValue === null || numericRuleValue === null) {
    return false;
  }

  switch (rule.op) {
    case "eq":
      return numericCellValue === numericRuleValue;
    case "gt":
      return numericCellValue > numericRuleValue;
    case "gte":
      return numericCellValue >= numericRuleValue;
    case "lt":
      return numericCellValue < numericRuleValue;
    case "lte":
      return numericCellValue <= numericRuleValue;
    case "between": {
      const upperBound = parseNumericValue(rule.valueTo ?? "");
      if (upperBound === null) return false;
      const lowerBound = Math.min(numericRuleValue, upperBound);
      const upper = Math.max(numericRuleValue, upperBound);
      return numericCellValue >= lowerBound && numericCellValue <= upper;
    }
    default:
      return false;
  }
}

function matchesRule(
  recipient: ScenarioRecipientColumnSplitRecipient,
  rule: ScenarioRecipientColumnSplitRule,
): boolean {
  const cellValue = getRecipientColumnValue(recipient, rule.column);
  if (isNumberOp(rule.op)) {
    return matchesNumberRule(cellValue, rule);
  }
  return matchesStringRule(cellValue, rule);
}

function matchesPath(
  recipient: ScenarioRecipientColumnSplitRecipient,
  path: ScenarioRecipientColumnSplitPath,
): boolean {
  if (path.rules.length === 0) return false;
  return path.rules.every(rule => matchesRule(recipient, rule));
}

export function matchRecipientColumnSplit(
  recipient: ScenarioRecipientColumnSplitRecipient,
  config: ScenarioRecipientColumnSplitConfig,
): ScenarioRecipientColumnSplitMatchResult {
  for (const path of config.paths) {
    if (!matchesPath(recipient, path)) continue;

    return {
      pathId: path.id,
      handleId: buildRecipientColumnSplitPathHandleId(path.id),
      label: path.label,
      isElse: false,
    };
  }

  return {
    pathId: RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
    handleId: RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
    label: undefined,
    isElse: true,
  };
}

export function summarizeRecipientColumnSplitRoutes(params: {
  recipients: ScenarioRecipientColumnSplitRecipient[];
  config: ScenarioRecipientColumnSplitConfig;
}): ScenarioRecipientColumnSplitRouteSummary {
  const byPathId: Record<string, number> = {};
  for (const path of params.config.paths) {
    byPathId[path.id] = 0;
  }

  let elseCount = 0;
  for (const recipient of params.recipients) {
    const match = matchRecipientColumnSplit(recipient, params.config);
    if (match.isElse) {
      elseCount += 1;
      continue;
    }
    byPathId[match.pathId] = (byPathId[match.pathId] ?? 0) + 1;
  }

  return {
    byPathId,
    elseCount,
    total: params.recipients.length,
  };
}

export function isRecipientColumnSplitConfigReadyForSend(
  config: ScenarioRecipientColumnSplitConfig | null | undefined,
): boolean {
  if (!config || config.paths.length === 0) return false;

  return config.paths.every(path => {
    if (path.rules.length === 0) return false;
    return path.rules.every(rule => {
      if (!rule.column.trim()) return false;
      if (!normalizeOp(rule.op)) return false;
      return ruleHasRequiredValues(rule);
    });
  });
}
