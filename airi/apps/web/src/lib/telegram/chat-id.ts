export function buildTelegramCompositeChatId(
  chatId: string | number,
  sourceId: string
): string {
  return `tg_${chatId}_${sourceId}`;
}

export function parseTelegramCompositeChatId(value: string | number): string {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith("tg_")) return trimmed;
  const withoutPrefix = trimmed.slice(3);
  const sourceSeparator = withoutPrefix.indexOf("_");
  return sourceSeparator === -1
    ? withoutPrefix
    : withoutPrefix.slice(0, sourceSeparator);
}

export function normalizeTelegramChatId(value: unknown): string {
  const raw = String(value ?? "").trim();
  return raw ? parseTelegramCompositeChatId(raw).trim() : "";
}

export function isTelegramPrivateChatId(chatId: string): boolean {
  return /^\d+$/.test(chatId);
}
