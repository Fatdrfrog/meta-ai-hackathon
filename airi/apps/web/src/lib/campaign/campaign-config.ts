function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function isCampaignEmailBatchEnabled(): boolean {
  return parseBooleanEnv(process.env.AIRI_CAMPAIGN_EMAIL_BATCH_ENABLED, false);
}
