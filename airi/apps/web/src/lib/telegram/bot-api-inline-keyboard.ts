/**
 * Telegram Bot API — {@link https://core.telegram.org/bots/api#inlinekeyboardmarkup InlineKeyboardMarkup}
 * and {@link https://core.telegram.org/bots/api#inlinekeyboardbutton InlineKeyboardButton}.
 */
export const TELEGRAM_CALLBACK_DATA_MAX_UTF8_BYTES = 64;

/**
 * Button `text` has no small hard cap in the Bot API table; clients truncate long
 * labels. We align with the send layer and keep labels reasonable.
 */
export const TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS = 256;
