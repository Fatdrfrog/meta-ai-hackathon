import type { ScenarioNodeData } from "@/components/scenarios/types";
import {
  coerceTelegramQuickRepliesToRows,
  isTelegramQuickRepliesNestedRowShape,
} from "@/lib/scenarios/normalization";
import { TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS } from "@/lib/telegram/bot-api-inline-keyboard";
import { truncateUtf8, utf8ByteLength } from "@icecore/shared/lib/utf8";

/**
 * Conservative payload budget to avoid callback_data truncation after
 * prefixing with `sqr:<conversationId>:` during send.
 */
export const MAX_CALLBACK_DATA_BYTES = 32;
/** Max branch buttons in a single inline keyboard (builder cap). */
export const MAX_QUICK_REPLIES = 8;
/** Max buttons on one row (Telegram allows more; keeps tap targets reasonable). */
export const MAX_BUTTONS_PER_ROW = 8;

export type TelegramQuickReplyDraft = {
  text: string;
  payload: string;
};

function stableTextHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash.toString(36);
}

function fallbackPayload(seed: string): string {
  const hash = stableTextHash(seed || "button");
  return `btn_${hash}`;
}

function normalizePayloadCandidate(
  payload: string,
  fallbackText: string
): string {
  const normalized = payload
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = normalized || fallbackPayload(fallbackText);
  const clamped = truncateUtf8(base, MAX_CALLBACK_DATA_BYTES);
  return clamped || fallbackPayload(fallbackText);
}

export function generatePayloadFromText(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = slug || fallbackPayload(text);
  return truncateUtf8(base, MAX_CALLBACK_DATA_BYTES);
}

export function normalizeButtonText(value: string): string {
  if (value.length <= TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS) return value;
  return value.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS);
}

export function ensureUniquePayload(params: {
  payload: string;
  buttons: TelegramQuickReplyDraft[];
  excludeIndex?: number;
}): string {
  const { payload, buttons, excludeIndex } = params;
  const used = new Set(
    buttons.flatMap((button, index) =>
      index !== excludeIndex && button.payload ? [button.payload] : []
    )
  );
  if (!used.has(payload)) return payload;

  let suffix = 2;
  while (suffix < 10_000) {
    const suffixText = `_${suffix}`;
    const budget = Math.max(
      1,
      MAX_CALLBACK_DATA_BYTES - utf8ByteLength(suffixText)
    );
    const candidate = `${truncateUtf8(payload, budget)}${suffixText}`;
    if (!used.has(candidate)) {
      return candidate;
    }
    suffix += 1;
  }

  return `${truncateUtf8(payload, MAX_CALLBACK_DATA_BYTES - 2)}_x`;
}

export function flattenQuickReplyRows(
  rows: TelegramQuickReplyDraft[][]
): TelegramQuickReplyDraft[] {
  return rows.flat();
}

/**
 * Validates payloads/text and preserves row boundaries from coerced input.
 */
export function normalizeQuickReplyRows(
  quickReplies: ScenarioNodeData["actionTelegramQuickReplies"]
): TelegramQuickReplyDraft[][] {
  const coerced = coerceTelegramQuickRepliesToRows(quickReplies ?? []);
  if (coerced.length === 0) return [];

  const rowLengths = coerced.map(row => row.length);
  const flat = coerced.flat();
  const normalizedFlat: TelegramQuickReplyDraft[] = [];

  for (const button of flat) {
    const text = normalizeButtonText(
      typeof button.text === "string" ? button.text : ""
    );
    const fallbackText = text.trim() || "button";
    const payload = ensureUniquePayload({
      payload:
        typeof button.payload === "string" && button.payload.trim().length > 0
          ? normalizePayloadCandidate(button.payload, fallbackText)
          : generatePayloadFromText(fallbackText),
      buttons: normalizedFlat,
    });

    normalizedFlat.push({ text, payload });
  }

  const result: TelegramQuickReplyDraft[][] = [];
  let offset = 0;
  for (const length of rowLengths) {
    result.push(normalizedFlat.slice(offset, offset + length));
    offset += length;
  }
  return result;
}

function rowsDeepEqual(
  left: TelegramQuickReplyDraft[][],
  right: TelegramQuickReplyDraft[][]
): boolean {
  if (left.length !== right.length) return false;

  for (let rowIndex = 0; rowIndex < left.length; rowIndex += 1) {
    if (left[rowIndex].length !== right[rowIndex].length) return false;

    for (
      let buttonIndex = 0;
      buttonIndex < left[rowIndex].length;
      buttonIndex += 1
    ) {
      if (
        left[rowIndex][buttonIndex].text !==
          right[rowIndex][buttonIndex].text ||
        left[rowIndex][buttonIndex].payload !==
          right[rowIndex][buttonIndex].payload
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * True when persisted value already matches normalized rows (no auto-write).
 */
export function isStorageEquivalentToRows(
  stored: ScenarioNodeData["actionTelegramQuickReplies"],
  normalizedRows: TelegramQuickReplyDraft[][]
): boolean {
  if (!Array.isArray(stored) || stored.length === 0) {
    return normalizedRows.length === 0;
  }
  if (normalizedRows.length === 0) return false;

  if (isTelegramQuickRepliesNestedRowShape(stored)) {
    return rowsDeepEqual(stored as TelegramQuickReplyDraft[][], normalizedRows);
  }

  const flatStored = stored as TelegramQuickReplyDraft[];
  const flatNormalized = flattenQuickReplyRows(normalizedRows);
  if (flatStored.length !== flatNormalized.length) return false;

  const textPayloadMatch = flatStored.every(
    (button, index) =>
      button.text === flatNormalized[index].text &&
      button.payload === flatNormalized[index].payload
  );
  if (!textPayloadMatch) return false;

  // Legacy flat array implies one Telegram row per button; if normalization
  // merged buttons onto one row, we must persist nested shape.
  const impliedOneButtonPerRow =
    normalizedRows.length === flatNormalized.length &&
    normalizedRows.every(row => row.length === 1);

  return impliedOneButtonPerRow;
}
