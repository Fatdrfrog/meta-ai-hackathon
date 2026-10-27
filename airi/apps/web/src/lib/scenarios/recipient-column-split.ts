import type {
  ScenarioNodeData,
  ScenarioRecipientColumnSplitConfig,
} from "@icecore/scenario-contracts";
import type { ScenarioCampaignRecipient } from "@icecore/scenario-contracts";
import {
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
  RECIPIENT_COLUMN_SPLIT_NUMBER_OPS,
  RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX,
  RECIPIENT_COLUMN_SPLIT_STRING_OPS,
  buildRecipientColumnSplitPathHandleId,
  coerceRecipientColumnSplitConfig,
  createDefaultRecipientColumnSplitPath,
  createEmptyRecipientColumnSplitConfig,
  getRecipientColumnSplitSourceHandleIds,
  isRecipientColumnSplitConfigReadyForSend,
  matchRecipientColumnSplit,
  normalizeScenarioRecipientColumnSplit,
  parseRecipientColumnSplitInValues,
  parseRecipientColumnSplitPathHandleId,
  summarizeRecipientColumnSplitRoutes,
} from "@icecore/scenario-contracts";

export {
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
  RECIPIENT_COLUMN_SPLIT_NUMBER_OPS,
  RECIPIENT_COLUMN_SPLIT_SOURCE_HANDLE_PREFIX,
  RECIPIENT_COLUMN_SPLIT_STRING_OPS,
  buildRecipientColumnSplitPathHandleId,
  coerceRecipientColumnSplitConfig,
  createDefaultRecipientColumnSplitPath,
  createEmptyRecipientColumnSplitConfig,
  getRecipientColumnSplitSourceHandleIds,
  isRecipientColumnSplitConfigReadyForSend,
  matchRecipientColumnSplit,
  normalizeScenarioRecipientColumnSplit,
  parseRecipientColumnSplitInValues,
  parseRecipientColumnSplitPathHandleId,
  summarizeRecipientColumnSplitRoutes,
};

const BIRTHDAY_COLUMN_NAMES = new Set(["birthday"]);
const MAX_RECIPIENT_COLUMN_VALUE_SUGGESTIONS = 50;

export function isRecipientColumnSplitNodeData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return (
    nodeData?.kind === "logic" &&
    nodeData.logicType === "recipient_column_split"
  );
}

export function getRecipientColumnSplitConfig(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): ScenarioRecipientColumnSplitConfig {
  return coerceRecipientColumnSplitConfig(nodeData?.recipientColumnSplit);
}

export function collectRecipientColumnNames(
  recipients: readonly ScenarioCampaignRecipient[]
): string[] {
  const columns = new Set<string>();

  for (const recipient of recipients) {
    for (const [column, value] of Object.entries(recipient.fields ?? {})) {
      const normalized = column.trim();
      if (!normalized) continue;
      if (BIRTHDAY_COLUMN_NAMES.has(normalized.toLowerCase())) continue;
      if (!String(value ?? "").trim()) continue;
      columns.add(normalized);
    }
  }

  return Array.from(columns).sort((left, right) => left.localeCompare(right));
}

export function collectRecipientColumnValueSuggestions(params: {
  recipients: readonly ScenarioCampaignRecipient[];
  column: string;
}): string[] {
  const normalizedColumn = params.column.trim();
  if (!normalizedColumn) return [];

  const values = new Set<string>();
  for (const recipient of params.recipients) {
    const value = recipient.fields?.[normalizedColumn]?.trim();
    if (!value) continue;
    values.add(value);
    if (values.size >= MAX_RECIPIENT_COLUMN_VALUE_SUGGESTIONS) break;
  }

  return Array.from(values).sort((left, right) => left.localeCompare(right));
}
