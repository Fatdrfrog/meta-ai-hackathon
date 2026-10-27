import {
  coerceTelegramQuickRepliesToRows,
  flattenTelegramQuickReplyRows,
} from "@/lib/scenarios/normalization";

export type TelegramBranchOption = {
  text: string;
  payload: string;
};

/**
 * Extracts branch options from Telegram quick-reply buttons.
 * Order is row-major to match the sent keyboard.
 */
export function extractTelegramBranchOptions(
  quickReplies: unknown
): TelegramBranchOption[] {
  const rows = coerceTelegramQuickRepliesToRows(quickReplies ?? []);
  return flattenTelegramQuickReplyRows(rows);
}

export function validateTelegramBranchCompleteness(
  branchOptions: TelegramBranchOption[],
  connectedPayloads: readonly string[]
): {
  isComplete: boolean;
  missingOptions: TelegramBranchOption[];
} {
  if (branchOptions.length === 0) {
    return { isComplete: true, missingOptions: [] };
  }

  const connectedSet = new Set(connectedPayloads);
  const missingOptions = branchOptions.filter(
    option => !connectedSet.has(option.payload)
  );

  return {
    isComplete: missingOptions.length === 0,
    missingOptions,
  };
}
