export const WEBHOOK_PROFILE_VERSION = "2026-06-19";

const CORE_REQUIRED_FIELDS = ["messages", "account_update", "calls"] as const;

const EXTENDED_REQUIRED_FIELDS = [
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
  "flows",
  "account_alerts",
  "business_capability_update",
  "message_template_status_update",
  "message_template_quality_update",
  "message_template_components_update",
  "template_category_update",
  "template_correct_category_detection",
  "tracking_events",
  "partner_solutions",
  "payment_configuration_update",
  "security",
  "user_preferences",
] as const;

/**
 * Fields specific to Embedded Signup coexistence mode.
 *
 * These are only relevant when the customer connected via
 * `whatsapp_business_app_onboarding` (aka QR / coexistence), where both
 * the WhatsApp Business app and the Cloud API share the same phone number.
 *
 * Without these subscriptions the integration silently loses:
 * - `history`              first-time backfill of up to 180 days of chats
 * - `smb_app_state_sync`   contact directory sync from the WA Business app
 * - `smb_message_echoes`   messages sent from the business-side WA app
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
 */
export const COEXISTENCE_REQUIRED_FIELDS = [
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
] as const;

export const REQUIRED_FIELDS = [
  ...CORE_REQUIRED_FIELDS,
  ...EXTENDED_REQUIRED_FIELDS,
] as const;

const OPTIONAL_FIELDS = [
  "business_username_updates",
  "phone_number_quality_update",
  "phone_number_username_update",
] as const;

export interface WebhookFieldCoverage {
  profileVersion: string;
  coexistenceMode: boolean;
  requiredFields: string[];
  optionalFields: string[];
  subscribedFields: string[];
  missingRequiredFields: string[];
  missingOptionalFields: string[];
  coverageOk: boolean;
  actionable: string | null;
}

interface AnalyzeSubscribedFieldsOptions {
  /**
   * When true, the coexistence-only webhook fields are added to the required
   * set. Pass the value of `source.credentials.coexistence_mode` (or an
   * equivalent SMB platform type flag) from the caller.
   */
  coexistenceMode?: boolean;
}

function dedupeFields(fields: string[]): string[] {
  return Array.from(
    new Set(
      fields.map((field) => field.trim()).filter((field) => field.length > 0),
    ),
  );
}

export function normalizeSubscribedFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) {
    return [];
  }

  return dedupeFields(
    fields.filter((field): field is string => typeof field === "string"),
  );
}

export function buildRequiredFields(
  options?: AnalyzeSubscribedFieldsOptions,
): string[] {
  const base = [...REQUIRED_FIELDS];
  if (options?.coexistenceMode) {
    return [...base, ...COEXISTENCE_REQUIRED_FIELDS];
  }
  return base;
}

export function analyzeSubscribedFields(
  currentFields: unknown,
  options?: AnalyzeSubscribedFieldsOptions,
): WebhookFieldCoverage {
  const subscribedFields = normalizeSubscribedFields(currentFields);
  const coexistenceMode = Boolean(options?.coexistenceMode);
  const requiredFields = buildRequiredFields(options);
  const optionalFields = [...OPTIONAL_FIELDS];

  const missingRequiredFields = requiredFields.filter(
    (field) => !subscribedFields.includes(field),
  );
  const missingOptionalFields = optionalFields.filter(
    (field) => !subscribedFields.includes(field),
  );
  const coverageOk = missingRequiredFields.length === 0;

  const actionable = coverageOk
    ? null
    : `Enable these webhook fields in Meta App Dashboard > WhatsApp > Configuration > Webhooks: ${missingRequiredFields.join(", ")}. Then re-run WABA subscription.`;

  return {
    profileVersion: WEBHOOK_PROFILE_VERSION,
    coexistenceMode,
    requiredFields,
    optionalFields,
    subscribedFields,
    missingRequiredFields,
    missingOptionalFields,
    coverageOk,
    actionable,
  };
}
