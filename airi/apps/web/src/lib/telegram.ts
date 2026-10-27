import {
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import { convertContentToHtml } from "@/lib/kb/content-utils";
import { cleanHtmlContent } from "@icecore/shared/lib/html-utils";

const botToken = process.env.TELEGRAM_BOT_TOKEN;

/**
 * Matches `<a href="...">text</a>`. Case-insensitive, multiline, tolerates
 * single or double quotes and extra attributes (e.g. `target="_blank"`).
 * `[\s\S]*?` lets the inner text span line breaks produced by `marked`.
 */
const HTML_ANCHOR_REGEX =
  /<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Strips markdown to plain text for Telegram messages.
 *
 * Telegram shows raw markdown symbols (*, _, `, etc.) when parse_mode is not
 * used, so we flatten formatting to clean text. BUT we must first preserve
 * link URLs, because the default `cleanHtmlContent` path removes entire
 * `<a href="...">` tags and drops the URL along with them — which caused
 * Airi replies like "[Google form](https://…)" to arrive at the user as just
 * "Google form" with no way to reach the link.
 *
 * Here we inline `<a>` href values as a `"text: https://…"` suffix BEFORE the
 * tag strip runs. Telegram clients auto-linkify bare URLs, so the result
 * renders as a tappable link without needing HTML parse_mode (which would
 * require sanitizing everything else down to Telegram's tiny HTML subset).
 */
function stripMarkdownForTelegram(text: string): string {
  if (!text || typeof text !== "string") return "";
  try {
    const html = convertContentToHtml(text);
    if (!html) return text;
    const inlined = html.replace(
      HTML_ANCHOR_REGEX,
      (_, href: string, inner: string) => {
        const url = (href || "").trim();
        const label = inner.replace(/<[^>]+>/g, "").trim();
        if (!url) return label;
        // `mailto:` / `tel:` links typically carry the raw address in both the
        // href and the label — e.g. `<a href="mailto:x@y.com">x@y.com</a>`.
        // Rendering that as `x@y.com: mailto:x@y.com` is redundant noise; drop
        // the scheme so we emit just `x@y.com` which Telegram auto-linkifies.
        const stripped = url.replace(/^(?:mailto|tel):/i, "");
        if (!label || label === url || label === stripped) return stripped;
        // Telegram clients auto-linkify this URL; "label: url" stays readable
        // if the linkifier is disabled or the URL contains characters it
        // doesn't recognize as part of a hyperlink.
        return `${label}: ${url}`;
      }
    );
    return (
      cleanHtmlContent(inlined, { preserveLineBreaks: true }).trim() || text
    );
  } catch {
    return text;
  }
}

type TelegramApiResponse<T> =
  | {
      ok: true;
      result: T;
      description?: string;
      error_code?: number;
      parameters?: Record<string, unknown>;
    }
  | {
      ok: false;
      result?: undefined;
      description?: string;
      error_code?: number;
      parameters?: Record<string, unknown>;
    };

type TelegramRequestOptions = {
  botToken?: string;
  businessConnectionId?: string;
};

function addTelegramBusinessConnection(
  body: Record<string, unknown>,
  options?: Pick<TelegramRequestOptions, "businessConnectionId">
) {
  if (options?.businessConnectionId) {
    body.business_connection_id = options.businessConnectionId;
  }
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status?: number;
  readonly errorCode?: number;
  readonly parameters?: Record<string, unknown>;

  constructor(
    method: string,
    message: string,
    options?: {
      status?: number;
      errorCode?: number;
      parameters?: Record<string, unknown>;
      cause?: unknown;
    }
  ) {
    super(message, options);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = options?.status;
    this.errorCode = options?.errorCode;
    this.parameters = options?.parameters;
  }
}

/**
 * Call Telegram Bot API with an explicit bot token.
 * This is the preferred method for multi-tenant scenarios.
 */
export async function callTelegramApiWithToken<T = unknown>(
  botToken: string,
  method: string,
  body: object
): Promise<T> {
  if (!botToken) {
    throw new Error("Bot token is required");
  }

  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new TelegramApiError(
      method,
      `Telegram API HTTP ${response.status}: ${errorText}`,
      { status: response.status }
    );
  }

  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!data.ok) {
    throw new TelegramApiError(
      method,
      data.description ?? "Telegram API error",
      {
        errorCode: data.error_code,
        parameters: data.parameters,
      }
    );
  }
  return data.result;
}

/**
 * Call Telegram Bot API using the bot token from environment variable or provided token.
 * Maintains backward compatibility with TELEGRAM_BOT_TOKEN env var.
 */
async function callTelegramApi<T = unknown>(
  method: string,
  body: object,
  botTokenOverride?: string
): Promise<T> {
  const token = botTokenOverride || botToken;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured and no token provided"
    );
  }

  return callTelegramApiWithToken(token, method, body);
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  options?: { botToken?: string }
) {
  return callTelegramApi<boolean>(
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      text,
    },
    options?.botToken
  );
}

export async function editTelegramMessage(
  chatId: string,
  messageId: string,
  text: string,
  options?: { botToken?: string; parseMode?: "HTML" }
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    reply_markup: { inline_keyboard: [] },
  };
  if (options?.parseMode) {
    body.parse_mode = options.parseMode;
  }
  return callTelegramApi<boolean>("editMessageText", body, options?.botToken);
}

/**
 * Remove the inline keyboard from an existing Telegram message without
 * changing the message text.  Uses the `editMessageReplyMarkup` API:
 * https://core.telegram.org/bots/api#editmessagereplymarkup
 */
export type TelegramInlineButton =
  | { text: string; callback_data: string; url?: undefined }
  | { text: string; url: string; callback_data?: undefined };

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

export async function removeInlineKeyboard(
  chatId: string,
  messageId: string,
  options?: TelegramRequestOptions
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  };
  addTelegramBusinessConnection(body, options);

  return callTelegramApi<boolean>(
    "editMessageReplyMarkup",
    body,
    options?.botToken
  );
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options?: TelegramRequestOptions & {
    replyToMessageId?: number;
    messageThreadId?: number;
    parseMode?: "HTML";
    replyMarkup?: TelegramInlineKeyboard;
  }
) {
  const useHtmlParseMode = options?.parseMode === "HTML";
  const plainText = useHtmlParseMode ? text : stripMarkdownForTelegram(text);
  const body: Record<string, unknown> = { chat_id: chatId, text: plainText };
  addTelegramBusinessConnection(body, options);
  if (typeof options?.replyToMessageId === "number") {
    body.reply_to_message_id = options.replyToMessageId;
  }
  if (typeof options?.messageThreadId === "number") {
    body.message_thread_id = options.messageThreadId;
  }
  if (useHtmlParseMode) {
    body.parse_mode = "HTML";
  }
  if (options?.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }
  const result = await callTelegramApi<{
    message_id: number;
    date: number;
    status?: string;
  }>("sendMessage", body, options?.botToken);
  return {
    messageId: result.message_id,
    date: result.date,
    status: result.status,
  };
}

export type TelegramOutboundMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "voice"
  | "file";

/**
 * Streams a partial message draft to a user while the final message is being
 * generated. Telegram clients animate consecutive updates that share the same
 * {@link draftId}.
 *
 * PRIVATE CHATS ONLY. `chat_id` must be a numeric user id. Groups, supergroups,
 * channels, and business-connection messages are not supported by this method.
 *
 * Note: Bot API 9.5 does NOT provide a documented way to remove a draft. The
 * docs require text to be 1-4096 chars (empty text returns HTTP 400
 * "Text must be non-empty"; see AstrBot #7398, openclaw #19001). Telegram
 * clients dismiss the animated draft bubble roughly ~4s after the last
 * update, OR immediately once a `sendMessage` with *matching text and
 * parse_mode* arrives from the same bot reusing the same logical stream.
 *
 * To avoid a duplicate bubble, the final draft update MUST render to the
 * exact same string (and use the same `parse_mode`) as the subsequent
 * `sendMessage`. Rendering mismatches (e.g. prefixing "Airi: " only on the
 * real send, or using HTML for one and plain text for the other) will cause
 * the client to show both bubbles until the draft times out.
 *
 * @see https://core.telegram.org/bots/api#sendmessagedraft (Bot API 9.5+)
 */
export async function sendTelegramMessageDraft(
  chatId: number | string,
  draftId: number,
  text: string,
  options?: {
    botToken?: string;
    messageThreadId?: number;
    parseMode?: "HTML";
  }
): Promise<boolean> {
  // Telegram rejects empty text with HTTP 400 "Text must be non-empty".
  // Fail fast so callers aren't tempted to use this method to "clear" a draft.
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  const normalized =
    options?.parseMode === "HTML" ? text : stripMarkdownForTelegram(text);
  if (normalized.length === 0) {
    return false;
  }
  const body: Record<string, unknown> = {
    chat_id: typeof chatId === "string" ? Number(chatId) : chatId,
    draft_id: draftId,
    text: normalized,
  };
  if (typeof options?.messageThreadId === "number") {
    body.message_thread_id = options.messageThreadId;
  }
  if (options?.parseMode === "HTML") {
    body.parse_mode = "HTML";
  }
  return callTelegramApi<boolean>("sendMessageDraft", body, options?.botToken);
}

const TELEGRAM_DRAFT_MAX_TEXT_LENGTH = 4000;

export type TelegramDraftRender = {
  /** Rendered body, passed verbatim as `text` to `sendMessageDraft`. */
  text: string;
  /** Matching `parse_mode` for the rendered body (currently only `HTML`). */
  parseMode?: "HTML";
};

/**
 * Shows the final reply as one Telegram `sendMessageDraft` bubble right
 * before the real `sendMessage`, so private chats see the answer appear
 * instead of a long typing pause.
 *
 * The Bot API has no "finalize draft" call. The client drops the draft when
 * a `sendMessage` with the same `text` + `parse_mode` arrives (or ~4 s after
 * the last draft update), so `renderText` must render exactly like the final
 * send. Partial generation text is never shown: a repair pass can still
 * rewrite it, so only the settled reply is revealed.
 *
 * Telegram limits: text 1-4096 chars, integer `chat_id`, private chats only
 * (no `business_connection_id`). Failures are swallowed so the real send is
 * never affected.
 */
export class TelegramDraftReveal {
  private readonly chatId: number;
  private readonly draftId = Math.floor(Math.random() * 0x7fffffff) + 1;
  private readonly botToken?: string;
  private readonly onFirstDraft?: () => void | Promise<void>;
  private readonly renderText: (text: string) => TelegramDraftRender;
  private done = false;

  constructor(params: {
    chatId: number | string;
    botToken?: string;
    /** Called once the draft has been shown. */
    onFirstDraft?: () => void | Promise<void>;
    /** Renders the reply exactly like the final `sendMessage`. */
    renderText: (text: string) => TelegramDraftRender;
  }) {
    const numericChatId =
      typeof params.chatId === "string" ? Number(params.chatId) : params.chatId;
    if (!Number.isFinite(numericChatId)) {
      throw new Error(
        `TelegramDraftReveal requires a numeric chat_id, got: ${params.chatId}`
      );
    }
    this.chatId = numericChatId;
    this.botToken = params.botToken;
    this.onFirstDraft = params.onFirstDraft;
    this.renderText = params.renderText;
  }

  /** Reveals the settled reply once; later calls do nothing. */
  async commit(fullText: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    if (!fullText.trim()) return;
    const rendered = this.renderText(fullText);
    if (!rendered.text) return;
    try {
      await sendTelegramMessageDraft(
        this.chatId,
        this.draftId,
        rendered.text.slice(0, TELEGRAM_DRAFT_MAX_TEXT_LENGTH),
        { botToken: this.botToken, parseMode: rendered.parseMode }
      );
      await this.onFirstDraft?.();
    } catch {
      /* Drafts are best-effort; the real sendMessage still goes out. */
    }
  }

  /**
   * Stops a reveal on paths that send no reply. The Bot API cannot remove a
   * draft, so nothing else is needed.
   */
  dispose(): void {
    this.done = true;
  }
}

export async function sendTelegramMedia(
  chatId: string,
  media: {
    type: TelegramOutboundMediaType;
    url: string;
    caption?: string;
    fileName?: string;
  },
  options?: TelegramRequestOptions & {
    replyToMessageId?: number;
    messageThreadId?: number;
    parseMode?: "HTML";
  }
) {
  const type = media.type === "file" ? "document" : media.type;
  let method = "sendDocument";
  let field = "document";

  if (type === "image") {
    method = "sendPhoto";
    field = "photo";
  } else if (type === "video") {
    method = "sendVideo";
    field = "video";
  } else if (type === "audio") {
    method = "sendAudio";
    field = "audio";
  } else if (type === "voice") {
    method = "sendVoice";
    field = "voice";
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    // Telegram downloads the file from this URL.
    [field]: await resolveCustomerMediaReadUrl(
      media.url,
      CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
    ),
  };

  if (media.caption) {
    body.caption =
      options?.parseMode === "HTML"
        ? media.caption
        : stripMarkdownForTelegram(media.caption);
  }

  addTelegramBusinessConnection(body, options);
  if (typeof options?.replyToMessageId === "number") {
    body.reply_to_message_id = options.replyToMessageId;
  }
  if (typeof options?.messageThreadId === "number") {
    body.message_thread_id = options.messageThreadId;
  }
  if (options?.parseMode === "HTML") {
    body.parse_mode = "HTML";
  }

  const result = await callTelegramApi<{
    message_id: number;
    date: number;
    status?: string;
  }>(method, body, options?.botToken);

  return {
    messageId: result.message_id,
    date: result.date,
    status: result.status,
  };
}

/**
 * Telegram Bot API chat actions. Lives here to avoid stringly-typed usage
 * at call sites — switching on `mediaType` should be exhaustive.
 *
 * Docs: https://core.telegram.org/bots/api#sendchataction
 */
export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export async function sendChatAction(
  chatId: string,
  action: TelegramChatAction,
  options?: TelegramRequestOptions & {
    messageThreadId?: number;
  }
) {
  const body: Record<string, unknown> = { chat_id: chatId, action };
  addTelegramBusinessConnection(body, options);
  if (typeof options?.messageThreadId === "number") {
    body.message_thread_id = options.messageThreadId;
  }
  return callTelegramApi<boolean>("sendChatAction", body, options?.botToken);
}

/**
 * Sets (or clears) the bot's reaction on a Telegram message.
 *
 * Passing `null` or an empty array clears any existing bot reaction from the
 * message. As non-premium, bots may set at most one reaction per message and
 * cannot use custom/paid reactions, so callers should pass a single standard
 * emoji. `is_big` triggers the large animation used for "big" reactions.
 *
 * Docs: https://core.telegram.org/bots/api#setmessagereaction
 *
 * Note: `setMessageReaction` does not accept a `business_connection_id`. In
 * business-connection chats the bot usually can't react to customer messages;
 * callers should treat failures as non-fatal (hence `safeSetMessageReaction`).
 */
export async function setMessageReaction(
  chatId: number | string,
  messageId: number,
  reaction: string | string[] | null,
  options?: {
    isBig?: boolean;
    botToken?: string;
  }
): Promise<boolean> {
  const emojis = Array.isArray(reaction)
    ? reaction
    : reaction
      ? [reaction]
      : [];
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    reaction: emojis.map(emoji => ({ type: "emoji", emoji })),
  };
  if (options?.isBig) body.is_big = true;
  return callTelegramApi<boolean>(
    "setMessageReaction",
    body,
    options?.botToken
  );
}

/**
 * Fire-and-forget reaction setter. Swallows network / permission errors so
 * callers in hot UX paths (e.g. the inbound-ack "👀") never take the whole
 * auto-reply down because of a reaction failure in a group the bot can't
 * react in, or a business-connection chat where reactions aren't supported.
 */
export async function safeSetMessageReaction(
  chatId: number | string,
  messageId: number,
  reaction: string | string[] | null,
  options?: {
    isBig?: boolean;
    botToken?: string;
  }
): Promise<boolean> {
  try {
    return await setMessageReaction(chatId, messageId, reaction, options);
  } catch {
    return false;
  }
}

export async function getFile(
  fileId: string,
  botTokenOverride?: string
): Promise<{
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}> {
  const token = botTokenOverride || botToken;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured and no token provided"
    );
  }

  const url = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new TelegramApiError(
      "getFile",
      `Telegram getFile failed: ${response.status} ${errorText}`,
      { status: response.status }
    );
  }

  const data = (await response.json()) as TelegramApiResponse<{
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  }>;
  if (!data.ok) {
    throw new TelegramApiError(
      "getFile",
      data.description ?? "Failed to get file info from Telegram",
      {
        errorCode: data.error_code,
        parameters: data.parameters,
      }
    );
  }
  return data.result;
}

export function getFileUrl(filePath: string, botTokenOverride?: string) {
  const token = botTokenOverride || botToken;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured and no token provided"
    );
  }

  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

/**
 * Get information about the bot using getMe API.
 * Useful for validating bot tokens.
 */
export async function getMe(botTokenOverride?: string): Promise<{
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}> {
  return callTelegramApi<{
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
    supports_inline_queries?: boolean;
  }>("getMe", {}, botTokenOverride);
}

export async function getUserProfilePhotos(
  userId: number,
  options?: { offset?: number; limit?: number; botToken?: string }
): Promise<{
  total_count: number;
  photos: {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }[][];
}> {
  return callTelegramApi(
    "getUserProfilePhotos",
    {
      user_id: userId,
      offset: options?.offset,
      limit: options?.limit,
    },
    options?.botToken
  );
}
