import "server-only";

export const TIKTOK_ADMIN_OAUTH_RESULTS = [
  "connected",
  "cancelled",
  "invalid_state",
  "state_unavailable",
  "unauthorized",
  "forbidden",
  "server_unconfigured",
  "token_exchange_failed",
  "advertiser_selection_required",
  "advertiser_not_authorized",
  "save_failed",
  "coordination_unavailable",
] as const;

export type TikTokAdminOAuthResult =
  (typeof TIKTOK_ADMIN_OAUTH_RESULTS)[number];
