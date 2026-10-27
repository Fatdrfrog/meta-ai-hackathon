export function isSmbPlatformType(platformType?: string | null): boolean {
  if (!platformType) return false;
  const normalized = platformType.trim().toUpperCase();
  return normalized.includes("SMB") || normalized.includes("COEXISTENCE");
}

export function isCloudApiPlatformType(platformType?: string | null): boolean {
  return platformType?.trim().toUpperCase() === "CLOUD_API";
}

export function hasWhatsAppBusinessAppConnectionSignal({
  embeddedSignupFlow,
  embeddedSignupEvent,
  isOnBizApp,
  coexistenceMode,
  partnerAppInstalled,
  qrRegistered,
  platformType,
}: {
  embeddedSignupFlow?: string | null;
  embeddedSignupEvent?: string | null;
  isOnBizApp?: boolean | null;
  coexistenceMode?: boolean | null;
  partnerAppInstalled?: boolean | null;
  qrRegistered?: boolean | null;
  platformType?: string | null;
}) {
  const flow = embeddedSignupFlow?.trim().toLowerCase();
  const event = embeddedSignupEvent?.trim().toUpperCase();
  const platformIsSmb = isSmbPlatformType(platformType);

  if (flow === "cloud_api" && isOnBizApp !== true && !platformIsSmb) {
    return false;
  }

  return Boolean(
    isOnBizApp === true ||
      coexistenceMode === true ||
      partnerAppInstalled === true ||
      qrRegistered === true ||
      flow === "coexistence" ||
      event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ||
      platformIsSmb,
  );
}

export function buildWhatsAppBusinessAppConnectionPatch({
  embeddedSignupFlow,
  embeddedSignupEvent,
  isOnBizApp,
  coexistenceMode,
  partnerAppInstalled,
  partnerAppInstalledAt,
  qrRegistered,
  platformType,
  cloudApiMessagingSuspended,
  now,
}: {
  embeddedSignupFlow?: string | null;
  embeddedSignupEvent?: string | null;
  isOnBizApp?: boolean | null;
  coexistenceMode?: boolean | null;
  partnerAppInstalled?: boolean | null;
  partnerAppInstalledAt?: string | null;
  qrRegistered?: boolean | null;
  platformType?: string | null;
  cloudApiMessagingSuspended?: boolean | null;
  now?: string;
}) {
  const patch: {
    is_on_biz_app?: boolean;
    coexistence_mode?: boolean;
    partner_app_installed?: boolean;
    partner_app_installed_at?: string;
  } = {};

  if (typeof isOnBizApp === "boolean") {
    patch.is_on_biz_app = isOnBizApp;
  }

  const businessAppConnection = hasWhatsAppBusinessAppConnectionSignal({
    embeddedSignupFlow,
    embeddedSignupEvent,
    isOnBizApp,
    coexistenceMode,
    partnerAppInstalled,
    qrRegistered,
    platformType,
  });

  if (!businessAppConnection) {
    return patch;
  }

  patch.coexistence_mode = true;
  // An offboarded or removed source is still a Business app number, but live
  // phone reads must not mark it connected again. Only a reconnect
  // (ACCOUNT_RECONNECTED or a new Embedded Signup) restores the partner app.
  if (cloudApiMessagingSuspended === true) {
    return patch;
  }
  patch.partner_app_installed = true;
  patch.partner_app_installed_at =
    partnerAppInstalledAt || now || new Date().toISOString();

  return patch;
}

export function shouldUseManualPhoneRegistrationGuidance({
  phoneRegistered,
  platformType,
  storedCoexistenceFlagsIndicateSmb,
}: {
  phoneRegistered?: boolean | null;
  platformType?: string | null;
  storedCoexistenceFlagsIndicateSmb: boolean;
}) {
  if (phoneRegistered) return false;

  if (storedCoexistenceFlagsIndicateSmb) return true;

  if (platformType) {
    return isSmbPlatformType(platformType);
  }

  return false;
}

/** Whether stored credentials describe a WhatsApp Business app connection. */
export function wasWhatsAppCoexistenceConnection(
  credentials: Record<string, unknown>,
) {
  return Boolean(
    credentials.coexistence_mode ||
      credentials.partner_app_installed ||
      isSmbPlatformType(
        typeof credentials.platform_type === "string"
          ? credentials.platform_type
          : undefined,
      ),
  );
}

/**
 * Connection-mode fields for a number connected through Embedded Signup.
 * Leaving coexistence (a Cloud API connection, or an explicit upgrade of a
 * Business app number) turns the coexistence flags off and records the
 * upgrade when the number was on the Business app before.
 */
export function buildEmbeddedSignupConnectionModePatch({
  previousCredentials,
  leavesCoexistence,
  upgradeIntent,
  now,
}: {
  previousCredentials: Record<string, unknown>;
  leavesCoexistence: boolean;
  upgradeIntent: boolean;
  now?: string;
}): Record<string, unknown> {
  const wasCoexistence = wasWhatsAppCoexistenceConnection(previousCredentials);
  if (!leavesCoexistence && !(upgradeIntent && wasCoexistence)) return {};

  return {
    coexistence_mode: false,
    partner_app_installed: false,
    ...(wasCoexistence && {
      coexistence_upgraded_at: now || new Date().toISOString(),
      previous_coexistence: true,
    }),
  };
}
