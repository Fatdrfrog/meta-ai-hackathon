/**
 * Token refresh utilities for WhatsApp Embedded Signup System User tokens
 *
 * Embedded Signup tokens can have a provider expiry or remain valid until revoked.
 * This module provides validation and refresh mechanisms to ensure tokens remain valid.
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 */

import { decryptString, type EncryptedString } from "@/lib/crypto";
import { tryGetMetaServerAppConfig } from "@/lib/meta/app-config";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import { WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS } from "./token-lifecycle";
import {
  MetaGraphRequestError,
  formatMetaGraphAPIError,
  parseMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";

export interface TokenValidationResult {
  valid: boolean;
  expired: boolean;
  revoked: boolean;
  neverExpires?: boolean;
  expiresAt?: Date;
  daysUntilExpiry?: number;
  error?: string;
  tokenType?: string;
  dataAccessExpiresAt?: Date;
  metaError?: ReturnType<typeof parseMetaGraphAPIError>;
}

/**
 * Validates a WhatsApp access token by calling Meta's debug_token endpoint
 *
 * @param accessToken The access token to validate
 * @param appId Optional app ID for validation
 * @returns Validation result with token status
 */
export async function validateWhatsAppToken(
  accessToken: string,
  appId?: string
): Promise<TokenValidationResult> {
  try {
    const configuredApp = tryGetMetaServerAppConfig();
    const appIdToUse = appId || configuredApp?.appId || "";
    const debugAppConfig = configuredApp
      ? { ...configuredApp, appId: appIdToUse || configuredApp.appId }
      : null;

    const debugData = await debugConfiguredMetaAccessToken(accessToken, {
      appConfig: debugAppConfig,
      allowInputTokenFallback: true,
    }).catch(error => {
      if (error instanceof MetaGraphRequestError) {
        const metaError =
          error.metaError || parseMetaGraphAPIError(error.details);
        const formattedError = metaError
          ? formatMetaGraphAPIError(metaError)
          : null;

        // Debug requests authenticate with our app credential. A request-level
        // OAuth failure does not establish that the customer's token is revoked.
        return {
          __error: {
            valid: false,
            expired: false,
            revoked: false,
            error:
              formattedError?.message ||
              `Token validation failed: HTTP ${error.status}`,
            metaError: metaError || undefined,
          } satisfies TokenValidationResult,
        };
      }

      throw error;
    });

    if ("__error" in debugData) {
      return debugData.__error;
    }

    const tokenData = debugData;
    if (!tokenData) {
      return {
        valid: false,
        expired: false,
        revoked: false,
        error: "No token data returned from debug_token",
      };
    }

    const evaluation = evaluateMetaAccessToken(tokenData, {
      appId: appIdToUse || undefined,
    });
    const confirmedAppMismatch = Boolean(
      appIdToUse && tokenData.app_id && tokenData.app_id !== appIdToUse
    );
    // Missing debugger fields are not evidence of customer revocation. Keep
    // explicit denial, a real deadline, and a confirmed app mismatch terminal.
    if (
      !evaluation.expired &&
      tokenData.is_valid !== false &&
      !confirmedAppMismatch &&
      (!tokenData.app_id || tokenData.is_valid !== true)
    ) {
      return {
        valid: false,
        expired: false,
        revoked: false,
        error:
          "Meta did not provide enough metadata to verify the access token",
      };
    }

    return {
      ...evaluation,
      tokenType: tokenData.type,
      ...(typeof tokenData.data_access_expires_at === "number" &&
      tokenData.data_access_expires_at > 0
        ? {
            dataAccessExpiresAt: new Date(
              tokenData.data_access_expires_at * 1000
            ),
          }
        : {}),
    };
  } catch (error) {
    return {
      valid: false,
      expired: false,
      revoked: false,
      error:
        error instanceof Error ? error.message : "Failed to validate token",
    };
  }
}

/**
 * Checks whether a token is inside the automatic maintenance window.
 *
 * @param expiresAt Token expiration date (null if never expires)
 * @param daysUntilExpiry Days until token expires (undefined if never expires)
 * @returns True if token should be refreshed
 */
export function shouldRefreshToken(
  expiresAt?: Date,
  daysUntilExpiry?: number
): boolean {
  // If token never expires, don't refresh (but still validate periodically)
  if (!expiresAt || daysUntilExpiry === undefined) {
    return false;
  }

  // Expired credentials require reconnection; callers inspect validity first.
  const now = new Date();
  if (expiresAt < now) {
    return true; // Already expired
  }

  return daysUntilExpiry <= WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS;
}

/**
 * Validates credentials and reports whether background maintenance is due.
 * The scheduled maintenance service performs the supported Meta exchange.
 * @see https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/#refresh-token
 *
 * @param accessToken Current access token
 * @param appId Optional app ID
 * @returns Result indicating if refresh is needed and how to proceed
 */
export async function checkTokenRefreshNeeded(
  accessToken: string,
  appId?: string
): Promise<{
  needsRefresh: boolean;
  canRefresh: boolean;
  validation: TokenValidationResult;
  actionRequired: "none" | "reconnect" | "validate";
  message?: string;
}> {
  const validation = await validateWhatsAppToken(accessToken, appId);

  // A provider expiry makes the token invalid too; retain the precise reason.
  if (validation.expired) {
    return {
      needsRefresh: true,
      canRefresh: false,
      validation,
      actionRequired: "reconnect",
      message:
        "Token has expired. Please reconnect WhatsApp integration via Embedded Signup.",
    };
  }

  // If token is invalid/revoked, needs reconnection
  if (validation.revoked) {
    return {
      needsRefresh: true,
      canRefresh: false,
      validation,
      actionRequired: "reconnect",
      message:
        "Token is invalid or revoked. Please reconnect WhatsApp integration via Embedded Signup.",
    };
  }

  if (!validation.valid) {
    return {
      needsRefresh: false,
      canRefresh: false,
      validation,
      actionRequired: "validate",
      message:
        "We are checking the WhatsApp connection. Please try again later.",
    };
  }

  // Check if token should be refreshed proactively
  const shouldRefresh = shouldRefreshToken(
    validation.expiresAt,
    validation.daysUntilExpiry
  );

  if (shouldRefresh) {
    const dataAccessNeedsConsent = Boolean(
      validation.dataAccessExpiresAt &&
        validation.expiresAt &&
        validation.dataAccessExpiresAt <= validation.expiresAt
    );
    const canRefresh =
      !dataAccessNeedsConsent &&
      (validation.tokenType === "SYSTEM_USER" ||
        validation.tokenType === "USER");
    return {
      needsRefresh: true,
      canRefresh,
      validation,
      actionRequired: canRefresh ? "validate" : "reconnect",
      message: canRefresh
        ? "Your WhatsApp connection is maintained automatically. No action is needed."
        : "Confirm your WhatsApp connection to keep messages working.",
    };
  }

  // Token is valid and doesn't need refresh
  return {
    needsRefresh: false,
    canRefresh: false,
    validation,
    actionRequired: "none",
    message:
      validation.daysUntilExpiry !== undefined
        ? `Token is valid for ${validation.daysUntilExpiry} more days.`
        : validation.neverExpires
          ? "Token is valid and doesn't expire."
          : "Token is valid. Meta did not provide an expiry date.",
  };
}

/**
 * Validates and optionally refreshes a stored WhatsApp token
 *
 * @param encryptedToken Encrypted token from database (can be string JSON or EncryptedString object)
 * @param _tokenExpiresAt Legacy cached expiry; provider metadata is authoritative
 * @param appId Optional app ID for validation
 * @returns Validation result and refresh recommendation
 */
export async function validateStoredToken(
  encryptedToken: string | EncryptedString,
  _tokenExpiresAt?: string | null,
  appId?: string
): Promise<{
  valid: boolean;
  needsRefresh: boolean;
  actionRequired: "none" | "reconnect" | "validate";
  message?: string;
  validation?: TokenValidationResult;
}> {
  try {
    // Decrypt token
    // encryptedToken might be a string (JSON) or EncryptedString object
    let tokenToDecrypt: EncryptedString;
    try {
      if (typeof encryptedToken === "string") {
        tokenToDecrypt = JSON.parse(encryptedToken) as EncryptedString;
      } else {
        tokenToDecrypt = encryptedToken as EncryptedString;
      }
    } catch {
      // If parsing fails, assume it's already an EncryptedString
      tokenToDecrypt = encryptedToken as unknown as EncryptedString;
    }
    const accessToken = decryptString(tokenToDecrypt);

    // Older stored expiries may have been estimated. Always verify with Meta.
    const refreshCheck = await checkTokenRefreshNeeded(accessToken, appId);

    return {
      valid: refreshCheck.validation.valid,
      needsRefresh: refreshCheck.needsRefresh,
      actionRequired: refreshCheck.actionRequired,
      message: refreshCheck.message,
      validation: refreshCheck.validation,
    };
  } catch (error) {
    return {
      valid: false,
      needsRefresh: true,
      actionRequired: "reconnect",
      message:
        error instanceof Error
          ? `Failed to validate token: ${error.message}`
          : "Failed to validate token",
    };
  }
}
