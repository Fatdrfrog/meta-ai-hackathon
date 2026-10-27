/**
 * Login for Business configuration IDs for Meta Ads Graph + Ads MCP.
 * WhatsApp Embedded Signup config IDs must not be reused here.
 */

export function resolveMetaAdsLoginConfigId(): string {
  return (process.env.META_ADS_LOGIN_CONFIG_ID || "").trim();
}

/**
 * Prefer a dedicated Ads MCP Login config; fall back to the Graph Ads Login
 * config so local/prod envs that already have META_ADS_LOGIN_CONFIG_ID work.
 */
export function resolveMetaAdsMcpLoginConfigId(): string {
  const dedicated = (process.env.META_ADS_MCP_LOGIN_CONFIG_ID || "").trim();
  if (dedicated) return dedicated;
  return resolveMetaAdsLoginConfigId();
}

export function getMetaAdsAppConfig(): {
  appId: string;
  appSecret: string;
} | null {
  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || "").trim();
  const appSecret = (
    process.env.META_ADS_APP_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.FACEBOOK_APP_SECRET ||
    ""
  ).trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}
