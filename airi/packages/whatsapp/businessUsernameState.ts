import { readNonEmptyStringOrUndefined } from "@icecore/shared/lib/value-utils";

export type WhatsAppBusinessUsernameState = {
  username?: string;
  requested_username?: string;
  status?: string;
  rejection_reason?: string;
  last_webhook_at?: string;
  phone_number_id?: string;
  display_phone_number?: string;
};

export function readBusinessUsernameState(
  value: unknown,
): WhatsAppBusinessUsernameState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const state: WhatsAppBusinessUsernameState = {
    username:
      readNonEmptyStringOrUndefined(record.username) ||
      readNonEmptyStringOrUndefined(record.current_username),
    requested_username: readNonEmptyStringOrUndefined(
      record.requested_username,
    ),
    status:
      readNonEmptyStringOrUndefined(record.status) ||
      readNonEmptyStringOrUndefined(record.username_status) ||
      readNonEmptyStringOrUndefined(record.username_review_status) ||
      readNonEmptyStringOrUndefined(record.business_username_status),
    rejection_reason: readNonEmptyStringOrUndefined(record.rejection_reason),
    last_webhook_at: readNonEmptyStringOrUndefined(record.last_webhook_at),
    phone_number_id: readNonEmptyStringOrUndefined(record.phone_number_id),
    display_phone_number: readNonEmptyStringOrUndefined(
      record.display_phone_number,
    ),
  };

  return Object.values(state).some(Boolean) ? state : undefined;
}
