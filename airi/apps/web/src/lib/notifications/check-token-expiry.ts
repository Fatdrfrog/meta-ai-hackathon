/**
 * Shared token expiry check utility
 *
 * Consolidates the duplicated "check expiry → send alert" pattern
 * used by both check-whatsapp-webhooks and refreshInstagramTokens crons.
 */

import {
  sendTokenExpiryAlert,
  shouldSendExpiryAlert,
} from "@/lib/notifications/token-expiry-alerts";

interface CheckTokenExpiryParams {
  tokenExpiresAt: string | null | undefined;
  workspaceId: string;
  integrationType: "instagram" | "whatsapp";
  logPrefix?: string;
}

interface CheckTokenExpiryResult {
  isExpired: boolean;
  daysUntilExpiry: number | null;
  alertSent: boolean;
}

/**
 * Check token expiry and send proactive alerts if needed.
 *
 * Returns whether the token is expired, how many days remain,
 * and whether an alert was dispatched to workspace admins.
 */
export async function checkTokenExpiryAndAlert({
  tokenExpiresAt,
  workspaceId,
  integrationType,
  logPrefix = `[${integrationType} Token]`,
}: CheckTokenExpiryParams): Promise<CheckTokenExpiryResult> {
  if (!tokenExpiresAt) {
    return { isExpired: false, daysUntilExpiry: null, alertSent: false };
  }

  const expiresAt = new Date(tokenExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return { isExpired: false, daysUntilExpiry: null, alertSent: false };
  }

  const daysUntilExpiry = Math.ceil(
    (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  const isExpired = expiresAt < new Date();
  let alertSent = false;

  if (daysUntilExpiry <= 7 && shouldSendExpiryAlert(daysUntilExpiry)) {
    console.warn(
      `${logPrefix} Expiring in ${daysUntilExpiry} days for workspace ${workspaceId}`
    );

    await sendTokenExpiryAlert({
      workspaceId,
      integrationType,
      daysUntilExpiry,
    });

    alertSent = true;
  }

  return { isExpired, daysUntilExpiry, alertSent };
}
