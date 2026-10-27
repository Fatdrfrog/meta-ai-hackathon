export type TikTokSafeErrorCode =
  | "credential_decryption_failed"
  | "reconnect_required"
  | "approval_required"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_protocol_error";

export const TIKTOK_SAFE_ERROR_CODES: readonly TikTokSafeErrorCode[] = [
  "credential_decryption_failed",
  "reconnect_required",
  "approval_required",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_protocol_error",
];
