/**
 * Shared helpers to strip legacy Instagram-comment metadata from message text.
 *
 * Earlier webhook logic stored inbound comments as:
 *   `[Comment by @<username>]: <text>\n[Post]: <url>`
 *
 * New messages are stored without the prefix, but we still need to clean
 * legacy messages on the display side.
 */

/** Matches the `[Comment by @username]: ` prefix. */
const COMMENT_PREFIX_RE = /^\[Comment by @[^\]]+\]:\s*/;

/** Matches a trailing `\n[Post]: <url>` suffix. */
const POST_SUFFIX_RE = /\n\[Post\]:\s*https?:\/\/\S+$/;

/**
 * Strip legacy `[Comment by @…]` prefix and `[Post]: url` suffix from
 * an Instagram comment message text.  Returns clean display text.
 */
export function stripInstagramCommentMeta(text: string): string {
  return text.replace(COMMENT_PREFIX_RE, "").replace(POST_SUFFIX_RE, "").trim();
}
