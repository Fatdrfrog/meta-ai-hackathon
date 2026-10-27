/**
 * Stored WhatsApp reply-quote snapshot (our domain model, not Meta wire format).
 *
 * Meta wire mapping:
 * - Inbound webhook: `messages[].context.id` → `replyToWhatsAppMessageId`
 * - Inbound webhook: `messages[].context.from` / `from_user_id` (not stored; lookup uses id)
 * - Outbound Graph send: `context.message_id` (raw `wamid.…`, no `ws_` prefix)
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/contextual-replies/
 */
export interface WhatsAppStoredMessageMeta {
  /** Normalized stored id (`ws_wamid.…`) of the quoted WhatsApp message. */
  replyToWhatsAppMessageId?: string | null;
  /** Snapshot of parent text/media placeholder for thread quote UI. */
  replyToTextPreview?: string | null;
  /** Inbound was forwarded (`context.forwarded`). */
  forwarded?: boolean | null;
  /** Inbound was forwarded many times (`context.frequently_forwarded`). */
  frequentlyForwarded?: boolean | null;
}
