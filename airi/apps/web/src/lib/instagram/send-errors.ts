import {
  MetaGraphRequestError,
  formatMetaGraphAPIError,
  isMetaGraphRateLimitError,
  parseMetaGraphAPIError,
  type MetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";

type InstagramSendErrorCode =
  | "instagram_customer_message_required"
  | "instagram_window_closed"
  | "instagram_human_agent_window_expired"
  | "instagram_outside_allowed_window"
  | "instagram_human_agent_not_approved"
  | "instagram_comments_permission_missing"
  | "instagram_permission_missing"
  | "instagram_token_invalid"
  | "instagram_rate_limited"
  | "instagram_recipient_unavailable"
  | "instagram_attachment_rejected"
  | "instagram_text_too_long"
  | "instagram_send_failed";

/** English fallbacks; the inbox translates by `code`. */
const INSTAGRAM_SEND_ERROR_MESSAGES: Record<InstagramSendErrorCode, string> = {
  instagram_customer_message_required:
    "The customer must message you first before you can reply.",
  instagram_window_closed:
    "The Instagram 24-hour messaging window is closed. Wait for the customer to message again.",
  instagram_human_agent_window_expired:
    "Human Agent replies are allowed only within 7 days of the customer's last message. Wait for the customer to message again.",
  instagram_outside_allowed_window:
    "Meta rejected the message because it is outside the allowed messaging window.",
  instagram_human_agent_not_approved:
    "Human Agent permission is missing or not approved for this app. Reconnect Instagram and ensure Human Agent is approved in App Review.",
  instagram_comments_permission_missing:
    "Instagram comments permission is missing or not approved for this app. Reconnect Instagram and ensure instagram_business_manage_comments is approved in App Review.",
  instagram_permission_missing:
    "Instagram messaging permission is missing. Reconnect Instagram.",
  instagram_token_invalid:
    "Instagram access has expired. Reconnect Instagram in Sources.",
  instagram_rate_limited:
    "Instagram is limiting messages right now. Try again in a few minutes.",
  instagram_recipient_unavailable:
    "This Instagram user can't receive messages right now.",
  instagram_attachment_rejected:
    "Instagram couldn't accept this attachment. Check its format and size.",
  instagram_text_too_long:
    "Instagram messages are limited to 1000 bytes (about 500 Cyrillic characters).",
  instagram_send_failed: "Instagram rejected the message.",
};

const INSTAGRAM_SEND_ERROR_HTTP_STATUS: Record<InstagramSendErrorCode, number> =
  {
    instagram_customer_message_required: 409,
    instagram_window_closed: 409,
    instagram_human_agent_window_expired: 409,
    instagram_outside_allowed_window: 409,
    instagram_human_agent_not_approved: 502,
    instagram_comments_permission_missing: 502,
    instagram_permission_missing: 502,
    instagram_token_invalid: 502,
    instagram_rate_limited: 429,
    instagram_recipient_unavailable: 422,
    instagram_attachment_rejected: 422,
    instagram_text_too_long: 400,
    instagram_send_failed: 502,
  };

// Meta answers code 10 for both missing permissions and an expired window;
// these subcodes mark the window case (Instagram, then Messenger).
const OUTSIDE_WINDOW_SUBCODES = new Set([2534022, 2018278]);
const RECIPIENT_UNAVAILABLE_CODES = new Set([551]);
const RECIPIENT_UNAVAILABLE_SUBCODES = new Set([1545041, 2534014]);

export class InstagramSendError extends Error {
  readonly code: InstagramSendErrorCode;
  readonly httpStatus: number;
  readonly metaError: MetaGraphAPIError | null;

  constructor(params: {
    code: InstagramSendErrorCode;
    message?: string;
    metaError?: MetaGraphAPIError | null;
    cause?: unknown;
  }) {
    super(params.message || INSTAGRAM_SEND_ERROR_MESSAGES[params.code], {
      cause: params.cause,
    });
    this.name = "InstagramSendError";
    this.code = params.code;
    this.httpStatus = INSTAGRAM_SEND_ERROR_HTTP_STATUS[params.code];
    this.metaError = params.metaError ?? null;
  }
}

export function isInstagramSendError(
  error: unknown
): error is InstagramSendError {
  return error instanceof InstagramSendError;
}

/**
 * Part of a multi-part send reached the customer before a later part failed.
 * The delivered part is already saved, so the inbox shows it next to the error.
 */
export class InstagramPartialSendError<
  TMessage = unknown,
> extends InstagramSendError {
  readonly persistedMessage: TMessage;

  constructor(failure: InstagramSendError, persistedMessage: TMessage) {
    super({
      code: failure.code,
      message: failure.message,
      metaError: failure.metaError,
      cause: failure,
    });
    this.name = "InstagramPartialSendError";
    this.persistedMessage = persistedMessage;
  }
}

export async function readInstagramGraphFailure(
  response: Response,
  url: string
): Promise<MetaGraphRequestError> {
  const text = await response.text().catch(() => "");
  let details: unknown = text || null;
  try {
    details = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text when Meta (or a proxy) answers with non-JSON.
  }
  const metaError = parseMetaGraphAPIError(details) ?? undefined;
  return new MetaGraphRequestError({
    message:
      metaError?.message ||
      `Instagram Graph API request failed with HTTP ${response.status}`,
    status: response.status,
    statusText: response.statusText,
    url,
    details,
    metaError,
    formattedError: metaError ? formatMetaGraphAPIError(metaError) : undefined,
  });
}

export type InstagramSendFailureContext = {
  kind: "dm" | "private_reply" | "comment_reply";
  usedHumanAgentTag?: boolean;
  isAttachment?: boolean;
};

function resolveInstagramSendErrorCode(
  error: MetaGraphRequestError,
  context: InstagramSendFailureContext
): InstagramSendErrorCode {
  const code = error.metaError?.code;
  const subcode = error.metaError?.error_subcode;
  const message = String(error.metaError?.message || "").toLowerCase();

  if (
    (subcode !== undefined && OUTSIDE_WINDOW_SUBCODES.has(subcode)) ||
    message.includes("outside of allowed window")
  ) {
    return "instagram_outside_allowed_window";
  }
  if (code === 190) return "instagram_token_invalid";
  if (isMetaGraphRateLimitError(error)) return "instagram_rate_limited";
  if (
    (code !== undefined && RECIPIENT_UNAVAILABLE_CODES.has(code)) ||
    (subcode !== undefined && RECIPIENT_UNAVAILABLE_SUBCODES.has(subcode))
  ) {
    return "instagram_recipient_unavailable";
  }
  if (
    context.usedHumanAgentTag &&
    (code === 200 || /human[_\s]?agent|message tag/.test(message))
  ) {
    return "instagram_human_agent_not_approved";
  }
  if (
    context.kind !== "dm" &&
    (code === 10 || code === 200 || message.includes("manage_comments"))
  ) {
    return "instagram_comments_permission_missing";
  }
  if (code === 10 || code === 200) return "instagram_permission_missing";
  if (
    context.isAttachment &&
    (code === 100 || /attachment|url|media|file/.test(message))
  ) {
    return "instagram_attachment_rejected";
  }
  return "instagram_send_failed";
}

export function toInstagramSendError(
  error: MetaGraphRequestError,
  context: InstagramSendFailureContext
): InstagramSendError {
  const code = resolveInstagramSendErrorCode(error, context);
  const metaMessage = error.metaError?.message?.trim();
  return new InstagramSendError({
    code,
    // Unclassified rejections keep Meta's own sentence (never the raw JSON).
    ...(code === "instagram_send_failed" && metaMessage
      ? { message: `Instagram rejected the message: ${metaMessage}` }
      : {}),
    metaError: error.metaError ?? null,
    cause: error,
  });
}

export async function throwInstagramGraphFailure(
  response: Response,
  url: string,
  context: InstagramSendFailureContext
): Promise<never> {
  throw toInstagramSendError(
    await readInstagramGraphFailure(response, url),
    context
  );
}
