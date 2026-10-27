/**
 * Unified Source and Credentials types for Airi.chat
 * Shared across all apps and packages
 */

import type {
  WidgetLanguageCode,
  WidgetQuickRepliesTranslations,
} from "./widget-config";
import type { WhatsAppHistorySyncState } from "../lib/whatsapp/history-sync-state";

// ============================================================================
// CHANNEL TYPES
// ============================================================================

export const SOURCE_CHANNELS = [
  "telegram",
  "whatsapp",
  "email",
  "instagram",
  "web_widget",
  "teams",
  "intercom",
] as const;

export type Channel = (typeof SOURCE_CHANNELS)[number];

export const SOURCE_TYPES = [
  ...SOURCE_CHANNELS,
  "canva",
  "higgsfield",
  "elevenlabs",
  "google_calendar",
  "google_ai",
  "meta_ads",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Channels stored on Conversation documents (Mongo).
 * Subset of {@link Channel}: source integrations may include teams/intercom before
 * conversations are ingested on those channels.
 */
export const CONVERSATION_CHANNELS = [
  "telegram",
  "whatsapp",
  "email",
  "instagram",
  "web_widget",
] as const satisfies ReadonlyArray<Channel>;

export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export function isConversationChannel(
  value: unknown,
): value is ConversationChannel {
  return (
    typeof value === "string" &&
    (CONVERSATION_CHANNELS as readonly string[]).includes(value)
  );
}

/** Standard 400 message when a query/body `channel` is not a persisted conversation channel. */
export const INVALID_CONVERSATION_CHANNEL_QUERY =
  "Invalid channel. Use telegram, whatsapp, email, instagram, or web_widget.";

/**
 * UI / readiness onboarding order (not alphabetical): messaging-first, email last.
 * Every entry must stay a {@link ConversationChannel}.
 */
export const ONBOARDING_INTEGRATION_PRIORITY = [
  "whatsapp",
  "telegram",
  "instagram",
  "web_widget",
  "email",
] as const satisfies ReadonlyArray<ConversationChannel>;

export type OnboardingIntegrationPriorityChannel =
  (typeof ONBOARDING_INTEGRATION_PRIORITY)[number];

export function isOnboardingIntegrationPriorityChannel(
  value: unknown,
): value is OnboardingIntegrationPriorityChannel {
  return (
    typeof value === "string" &&
    (ONBOARDING_INTEGRATION_PRIORITY as readonly string[]).includes(value)
  );
}

/**
 * realtime channel name for realtime conversation updates (subscribe/trigger).
 * Widget clients use `conversation-{id}`; other channels use `private-conversation-{id}`.
 */
/**
 * True when a source is the implicit web_widget created to back the onboarding
 * test chat. Such sources are flagged `onboarding_test` in their credentials and
 * should be excluded from "connected channel" signals everywhere.
 */
export function isOnboardingTestSource(
  source: { type?: unknown; credentials?: unknown } | null | undefined,
): boolean {
  if (!source || source.type !== "web_widget") return false;
  const credentials = source.credentials;
  if (!credentials || typeof credentials !== "object") return false;
  return (credentials as Record<string, unknown>).onboarding_test === true;
}

export function getRealtimeChannelNameForConversation(
  channel: ConversationChannel,
  conversationId: string,
): string {
  return channel === "web_widget"
    ? `conversation-${conversationId}`
    : `private-conversation-${conversationId}`;
}

// ============================================================================
// CREDENTIALS TYPES
// ============================================================================

/**
 * Encrypted-at-rest credential payload. A string is retained only for legacy
 * rows that predate object encryption and must be normalized before use.
 */
export type EncryptedCredential =
  | string
  | {
      iv: string;
      tag: string;
      ciphertext: string;
    };

/**
 * WhatsApp credential fields shared by persisted and runtime credentials.
 *
 * The access token is deliberately excluded here. Persisted source rows store
 * an encrypted token, while provider calls receive a decrypted token. Keeping
 * the common metadata separate prevents either representation from being
 * accidentally used as the other.
 */
export type WhatsAppTokenMaintenanceStatus =
  | "healthy"
  | "renewed"
  | "retrying"
  | "reconnect_required";

export interface WhatsAppCredentialFields {
  /** JSON-backed source rows may retain provider fields added by newer APIs. */
  readonly [key: string]: unknown;
  phone_number_id: string;
  /** Phase 2 account-model alias for phone-number identity; kept nullable until Meta emits it consistently. */
  cs_id?: string;
  waba_id: string;
  /** Messaging Account ID (Cloud API). Falls back to legacy `waba_id` when Meta omits it. */
  messaging_account_id?: string;
  /** Account Model Evolution: WhatsApp Account ID for phone-number identity targeting. */
  waac_id?: string;
  token_expires_at?: string | null;
  token_type?: string | null;
  token_is_valid?: boolean;
  token_verified_at?: string;
  token_never_expires?: boolean;
  token_provider_expires_at?: string | null;
  token_data_access_expires_at?: string | null;
  token_maintenance_status?: WhatsAppTokenMaintenanceStatus;
  token_maintenance_error_code?: string | null;
  token_last_refresh_attempt_at?: string | null;
  bot_app_id?: string;
  /** Customer's Meta Business (portfolio) ID; provided to tech providers on Embedded Signup (Implementation doc). Used for Graph API owned_whatsapp_business_accounts / client_whatsapp_business_accounts. */
  business_id?: string;
  /** Catalog asset IDs selected during Embedded Signup when catalog_management is requested. */
  catalog_ids?: string[];
  catalogIds?: string[];
  // Connection method flags
  embedded_signup?: boolean;
  embedded_signup_flow?: "cloud_api" | "coexistence" | string;
  embedded_signup_event?: string;
  qr_registered?: boolean;
  history_sync?: WhatsAppHistorySyncState;
  contact_sync?: {
    requested_at?: string;
    request_id?: string;
  };
  // Onboarding & readiness tracking
  phone_registered?: boolean;
  phone_registered_at?: string;
  phone_registration_status?: string;
  phone_registration_error?: string | null;
  last_test_message_at?: string;
  last_test_message_to?: string;
  last_test_message_id?: string;
  payment_method_prompted_at?: string;
  onboarding_completed?: boolean;
  onboarding_completed_at?: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  quality_rating?: string;
  /** Current portfolio-level messaging limit returned by Meta's Phone Number API. */
  whatsapp_business_manager_messaging_limit?: string;
  /** Legacy/webhook fallback value kept for older payloads and UI compatibility. */
  phone_messaging_limit?: string;
  messaging_limit_last_checked_at?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  coexistence_mode?: boolean;
  partner_app_installed?: boolean;
  partner_app_installed_at?: string;
  cloud_api_messaging_suspended?: boolean;
  whatsapp_lifecycle_last_event_at?: string;
  whatsapp_lifecycle_last_event_field?: string;
  whatsapp_lifecycle_events?: Record<
    string,
    {
      field?: string;
      receivedAt?: string;
      event?: string | null;
      value?: Record<string, unknown> | null;
    }
  >;
  coexistence_reonboarding_status?:
    | "offboarded"
    | "removed"
    | "reconnected"
    | string;
  coexistence_reonboarding_event?:
    | "ACCOUNT_OFFBOARDED"
    | "ACCOUNT_RECONNECTED"
    | "PARTNER_REMOVED"
    | string;
  /** Start of the latest suspension (offboarded or removed); kept after reconnect. */
  coexistence_reonboarding_offboarded_at?: string;
  coexistence_reonboarding_reconnected_at?: string;
  coexistence_reonboarding_removed_at?: string;
  coexistence_reonboarding_last_event_at?: string;
  partner_removed_reason?: string;
  partner_removed_initiated_by?: string;
  waba_health_state?:
    | "healthy"
    | "warning"
    | "reconnecting"
    | "disconnected"
    | "restricted"
    | "disabled"
    | "payment_required"
    | "inaccessible"
    | "unknown"
    | string;
  waba_health_reasons?: Array<{
    code: string;
    title: string;
    message: string;
    source: string;
    actionUrl?: string;
  }>;
  waba_health_last_checked_at?: string;
  payment_configuration_status?: string;
  payment_configuration_last_event?: string;
  payment_configuration_message?: string;
  account_alerts_last_event?: string;
  account_alerts_last_status?: string;
  account_alerts_last_message?: string;
  security_last_event?: string;
  security_last_status?: string;
  security_last_message?: string;
  waba_banned?: boolean;
  waba_ban_state?: string[];
  waba_ban_date?: string;
  banned_at?: string;
  // Calling auto-enablement tracking
  calls_enabled?: boolean;
  whatsapp_calls_media_enabled?: boolean;
  calls_status?: string;
  calls_icon_visibility?: string;
  calls_callback_permission_status?: string;
  calls_voicemail_enabled?: boolean;
  calls_voicemail_status?: string;
  calls_voicemail_triggers?: string[];
  calls_voicemail_announcement_media_id?: string;
  calls_voicemail_announcement_uploaded_at?: string;
  calls_voicemail_announcement_file_name?: string;
  calls_voicemail_announcement_file_size_bytes?: number;
  calls_voicemail_announcement_mime_type?: string;
  calls_voicemail_timeout_seconds?: number;
  calls_restrictions?: Array<{
    type: string;
    reason?: string;
    expiration?: number;
  }>;
  calls_webhook_subscribed?: boolean;
  waba_subscribed_fields?: string[];
  /** WABA subscribed_apps maintenance state. */
  webhook_subscribed?: boolean | null;
  webhook_error?: string | null;
  webhook_requires_reconnect?: boolean;
  webhook_last_checked?: string;
  phone_webhook_error?: string | null;
  token_last_refreshed_at?: string;
  token_refresh_error?: string | null;
  /** Number of consecutive failed WABA subscription repairs. */
  waba_subscription_consecutive_failures?: number;
  /** True only after a provider authorization failure requires reconnect. */
  waba_subscription_permanently_failed?: boolean;
  calls_last_checked_at?: string;
  calls_enabled_at?: string;
  calls_enablement_error?: string | null;
  calls_enablement_actionable?: string | null;
  auto_defaults_last_attempt_at?: string;
  auto_defaults_last_success_at?: string;
  auto_defaults_last_trigger?: string;
  auto_defaults_last_error?: string | null;
  marketing_messages_enabled?: boolean;
  marketing_messages_api_status?: string | null;
  marketing_messages_onboarding_status?: string | null;
  marketing_messages_onboarding_last_checked_at?: string;
  // Webhook field profile diagnostics
  webhook_profile_version?: string;
  webhook_required_fields?: string[];
  webhook_optional_fields?: string[];
  webhook_missing_required_fields?: string[];
  webhook_missing_optional_fields?: string[];
  webhook_coverage_ok?: boolean;
  webhook_fields_last_checked_at?: string;
  // Calls diagnostics (upgrade/onboarding visibility)
  expected_meta_app_id?: string;
  token_app_id?: string;
  token_app_id_matches_config?: boolean;
  waba_selected_app_id?: string;
  waba_selected_app_name?: string;
  waba_selected_app_matches_config?: boolean;
  waba_subscribed_app_ids?: string[];
  waba_calls_field_present_for_selected_app?: boolean;
  waba_phone_number_ids?: string[];
  phone_number_in_waba?: boolean;
  phone_number_accessible?: boolean;
  phone_number_access_error?: string | null;
  diagnostics_last_checked_at?: string;
  /** Last attempted bounded Meta diagnostics refresh. */
  meta_diagnostics_last_attempt_at?: string;
  /** Last completed Meta diagnostics refresh without provider throttling. */
  meta_diagnostics_last_success_at?: string;
  /** Persisted circuit-breaker deadline shared by UI and maintenance reads. */
  meta_diagnostics_cooldown_until?: string | null;
  meta_diagnostics_consecutive_rate_limits?: number;
  meta_diagnostics_last_error_code?: string | null;
  meta_diagnostics_reconnect_reason?: "meta_authorization" | null;
}

/** Credentials after decryption, suitable for provider calls. */
export interface WhatsAppDecryptedCredentials extends WhatsAppCredentialFields {
  access_token: string;
}

/** Backward-compatible name for the decrypted runtime credential contract. */
export type WhatsAppCredentials = WhatsAppDecryptedCredentials;

/** Credentials as stored in a source row. The token must remain encrypted. */
export interface WhatsAppStoredCredentials extends WhatsAppCredentialFields {
  access_token: EncryptedCredential;
}

/**
 * Telegram bot credentials.
 *
 * @property bot_token - **Required.** The bot token obtained from @BotFather.
 *   Format: `{bot_id}:{token}` (e.g., `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)
 * @property bot_username - Optional. The bot's username (e.g., `my_bot`).
 *   Can be auto-fetched from Telegram API if not provided.
 * @property webhook_secret_token - Optional. Secret token for webhook security.
 *   Generated automatically when webhook is registered. Used to validate incoming webhook requests.
 */
export interface TelegramCredentials {
  /** Bot token from @BotFather - required for all Telegram sources */
  bot_token: string;
  /** Bot username (without @) - optional, can be auto-fetched */
  bot_username?: string;
  /** Secret token for webhook security - generated automatically, used to validate webhook requests */
  webhook_secret_token?: string;
  /** AI message reactions are opt-in and only used when AI is enabled for the chat. */
  ai_reactions_enabled?: boolean;
}

/**
 * Credentials as stored in a source row. The bot token is encrypted; rows
 * saved before that hold plain text until they are re-saved or backfilled.
 */
export interface TelegramStoredCredentials
  extends Omit<TelegramCredentials, "bot_token" | "webhook_secret_token"> {
  bot_token?: EncryptedCredential;
  webhook_secret_token?: EncryptedCredential;
}

/** What the browser receives: never the bot token or the webhook secret. */
export interface PublicTelegramCredentials {
  has_bot_token: boolean;
  bot_username?: string;
  ai_reactions_enabled: boolean;
}

export interface InstagramCredentials {
  instagram_business_account_id?: string;
  instagram_scoped_id?: string;
  page_access_token?:
    | string
    | {
        iv: string;
        tag: string;
        ciphertext: string;
      };
  page_id?: string;
  username?: string;
  name?: string;
  account_type?: string;
  category_name?: string;
  biography?: string;
  website?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  is_verified?: boolean;
  auth_method?: string;
  token_type?: string;
  granted_permissions?: string;
  human_agent_enabled?: boolean;
  connected_at?: string;
  token_expires_at?: string;
}

export interface CanvaCredentials {
  access_token: EncryptedCredential;
  refresh_token?: EncryptedCredential;
  expires_at?: string | null;
  scope?: string;
  token_type?: string;
  connected_at?: string;
}

export interface HiggsfieldCredentials {
  api_key?: string;
  api_secret?: string;
  key?: string;
  connected_at?: string;
}

export interface ElevenLabsCredentials {
  /** Encrypted when saved; older rows hold the key as plain text. */
  api_key?: EncryptedCredential;
  default_voice_id?: string;
  connected_at?: string;
}

/** Workspace-owned Gemini Developer API connection. Plaintext keys are never stored. */
export interface GoogleAiCredentials {
  api_key?: Exclude<EncryptedCredential, string>;
  has_api_key?: boolean;
  key_label?: string | null;
  connected_at?: string | null;
  validated_at?: string | null;
  model_count?: number | null;
}

export interface GoogleCalendarCredentials {
  access_token: EncryptedCredential;
  refresh_token?: EncryptedCredential;
  expires_at?: string | null;
  scope?: string;
  token_type?: string;
  connected_at?: string;
  account_email?: string | null;
  calendar_id?: string;
}

export type MetaAdsAdAccount = {
  id: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  business?: {
    id?: string;
    name?: string;
  };
};

export type MetaAdsMcpReadinessState =
  | "not_connected"
  | "checking"
  | "expired"
  | "expiry_unknown"
  | "missing_scopes"
  | "scope_unverified"
  | "identity_unverified"
  | "asset_unavailable"
  | "provider_unauthorized"
  | "provider_unreachable"
  | "invalid_catalog"
  | "stale"
  | "ready";

/** Safe, display-localized readiness warning codes; never provider text. */
export type MetaAdsMcpWarningCode =
  | "account_inventory_truncated"
  | "account_not_enabled"
  | "expiry_unknown"
  | "graph_user_mismatch"
  | "protected_resource_metadata_unavailable"
  | "provider_capability_drift"
  | "provider_protocol_fallback"
  | "provider_teardown_failed"
  | "scope_contract_added"
  | "scope_contract_removed"
  | "scope_challenge_added"
  | "scope_unverified"
  | "selected_account_direct_only";

export type MetaAdsMcpStoredProbe = {
  checkedAt: string;
  outcome: "success" | "unauthorized" | "unreachable" | "invalid_catalog";
  latencyMs?: number;
  toolCount?: number;
  catalogSha256?: string;
  protocolEra?: "legacy" | "modern";
  protocolVersion?: string;
  serverName?: string;
  selectedAccountEnabled?: boolean;
  selectedAccountQueryable?: boolean;
  warnings: MetaAdsMcpWarningCode[];
};

export type MetaAdsMcpReadiness = {
  state: MetaAdsMcpReadinessState;
  checkedAt?: string;
  expiresAt?: string;
  neverExpires?: boolean;
  grantedScopes: string[];
  requiredScopes: string[];
  missingScopes: string[];
  missingReadScopes: string[];
  missingWriteScopes: string[];
  identity?: { id: string; name?: string };
  selectedAsset?: {
    adAccountId: string;
    businessId?: string;
    businessName?: string;
    currency?: string;
    timezone?: string;
  };
  accessibleAdAccountIds: string[];
  accessibleAdAccountsTruncated: boolean;
  provider?: {
    latencyMs?: number;
    toolCount?: number;
    catalogSha256?: string;
    protocolEra?: "legacy" | "modern";
    protocolVersion?: string;
    serverName?: string;
    selectedAccountEnabled?: boolean;
    selectedAccountQueryable?: boolean;
    warnings: MetaAdsMcpWarningCode[];
  };
  canRead: boolean;
  canWrite: boolean;
  reconnectRequired: boolean;
};

export interface MetaAdsCredentials {
  access_token: EncryptedCredential;
  token_type?: string;
  expires_at?: string | null;
  scope?: string;
  connected_at?: string;
  user_id?: string;
  user_name?: string;
  selected_ad_account_id?: string;
  ad_accounts?: MetaAdsAdAccount[];
  ad_accounts_error?: string;
  ad_accounts_checked_at?: string;
  ads_scopes_verified_at?: string;
  ads_identity_verified_at?: string;
  /** Confirmed invalidity of this Graph token; cleared by verified authorization. */
  ads_access_invalidated_at?: string;
  /** Explicit non-expiry verified by Meta introspection for the Graph token. */
  ads_never_expires?: boolean;
  /** AI token is refreshed with Graph by the unified authorization flow. */
  mcp_access_token?: EncryptedCredential;
  mcp_token_type?: string;
  mcp_expires_at?: string | null;
  /** Explicit non-expiry verified by Meta introspection for this MCP token. */
  mcp_never_expires?: boolean;
  mcp_scope?: string;
  mcp_connected_at?: string;
  mcp_connection_id?: string;
  mcp_user_id?: string;
  mcp_user_name?: string;
  mcp_scopes_verified_at?: string;
  mcp_ad_account_ids?: string[];
  mcp_ad_accounts_truncated?: boolean;
  mcp_selected_ad_account?: MetaAdsAdAccount;
  mcp_assets_checked_at?: string;
  mcp_provider_probe?: MetaAdsMcpStoredProbe;
}

export interface TeamsCredentials {
  tenant_id: string;
  client_id?: string;
  client_secret?:
    | string
    | {
        iv: string;
        tag: string;
        ciphertext: string;
      };
  // Legacy/runtime-compatible fields (currently used in integrations + sending)
  bot_app_id?: string;
  bot_app_password?:
    | string
    | {
        iv: string;
        tag: string;
        ciphertext: string;
      };
  team_id?: string;
  channel_id?: string;
  // Per-source webhook authentication secret for inbound Teams endpoint
  webhook_secret_token?: string;
}

export type EmailSourceVerificationStatus =
  | "disconnected"
  | "pending_dns"
  | "connected";

export interface EmailCredentials {
  email_address: string;
  provider?: "postmark" | "sendgrid" | "custom";
  provider_id?: string;
  provider_status?: "active" | "inactive";
  verification_status?: EmailSourceVerificationStatus;
  status?: "active" | "inactive";
  address_ids?: string[];
  postmark_stream_outbound?: string;
  connected_at?: string;
  smtp_host?: string;
  smtp_port?: number;
  imap_host?: string;
  imap_port?: number;
}

export interface IntercomCredentials {
  app_id: string;
  access_token?:
    | string
    | {
        iv: string;
        tag: string;
        ciphertext: string;
      };
}

export interface WebWidgetCredentials {
  client_key: string;
  secret_key?: string;
  allowed_domains: string[];
  status: "active" | "inactive";
  /**
   * Marks a widget source that backs the onboarding "test chat" only. These are
   * created implicitly the first time a user tries the test chat and must NOT be
   * treated as a real connected channel (routing, onboarding checklist,
   * capacity, integrations list).
   */
  onboarding_test?: boolean;
  theme?: {
    primary_color: string;
    bubble_color?: string;
    header_bg_color?: string;
    header_text_color?: string;
  };
  settings?: {
    welcome_message: string;
    offline_message?: string;
    response_time: string;
    airi_enabled: boolean;
    auto_open: boolean;
    position: "bottom-right" | "bottom-left";
  };
  content?: {
    bot_name?: string;
    header_title?: string;
    hero_title?: string;
    cta_primary_text?: string;
    cta_secondary_text?: string;
    quick_replies?: string[];
    quick_replies_default_locale?: WidgetLanguageCode;
    quick_replies_i18n?: WidgetQuickRepliesTranslations;
  };
  branding?: {
    bubble_mode?: "icon" | "text" | "svg";
    bubble_text?: string;
    bubble_svg_url?: string;
    logo_mode?: "default" | "text" | "svg";
    logo_text?: string;
    logo_svg_url?: string;
  };
  layout?: {
    home_variant?: "intercom" | "simple";
    show_help_tab?: boolean;
    show_news_tab?: boolean;
  };
}

// Union type for all credentials
export type SourceCredentials =
  | WhatsAppCredentials
  | WhatsAppStoredCredentials
  | TelegramCredentials
  | TelegramStoredCredentials
  | PublicTelegramCredentials
  | InstagramCredentials
  | CanvaCredentials
  | HiggsfieldCredentials
  | ElevenLabsCredentials
  | GoogleCalendarCredentials
  | GoogleAiCredentials
  | MetaAdsCredentials
  | TeamsCredentials
  | EmailCredentials
  | IntercomCredentials
  | WebWidgetCredentials;

// ============================================================================
// SOURCE TYPE
// ============================================================================

export interface Source {
  id: string;
  created_at: string;
  company_id: string;
  workspace_id: string;
  type: SourceType;
  name: string;
  credentials: SourceCredentials;
}

// Type-safe source accessors with discriminated unions
export interface WhatsAppSource extends Omit<Source, "credentials" | "type"> {
  type: "whatsapp";
  credentials: WhatsAppStoredCredentials;
}

export interface TelegramSource extends Omit<Source, "credentials" | "type"> {
  type: "telegram";
  credentials: TelegramStoredCredentials;
}

export interface InstagramSource extends Omit<Source, "credentials" | "type"> {
  type: "instagram";
  credentials: InstagramCredentials;
}

export interface CanvaSource extends Omit<Source, "credentials" | "type"> {
  type: "canva";
  credentials: CanvaCredentials;
}

export interface HiggsfieldSource extends Omit<Source, "credentials" | "type"> {
  type: "higgsfield";
  credentials: HiggsfieldCredentials;
}

export interface ElevenLabsSource extends Omit<Source, "credentials" | "type"> {
  type: "elevenlabs";
  credentials: ElevenLabsCredentials;
}

export interface GoogleAiSource extends Omit<Source, "credentials" | "type"> {
  type: "google_ai";
  credentials: GoogleAiCredentials;
}

export interface GoogleCalendarSource
  extends Omit<Source, "credentials" | "type"> {
  type: "google_calendar";
  credentials: GoogleCalendarCredentials;
}

export interface MetaAdsSource extends Omit<Source, "credentials" | "type"> {
  type: "meta_ads";
  credentials: MetaAdsCredentials;
}

export interface TeamsSource extends Omit<Source, "credentials" | "type"> {
  type: "teams";
  credentials: TeamsCredentials;
}

export interface IntercomSource extends Omit<Source, "credentials" | "type"> {
  type: "intercom";
  credentials: IntercomCredentials;
}

export interface EmailSource extends Omit<Source, "credentials" | "type"> {
  type: "email";
  credentials: EmailCredentials;
}

export interface WebWidgetSource extends Omit<Source, "credentials" | "type"> {
  type: "web_widget";
  credentials: WebWidgetCredentials;
}

// Discriminated union for type-safe source access
export type TypedSource =
  | WhatsAppSource
  | TelegramSource
  | InstagramSource
  | CanvaSource
  | HiggsfieldSource
  | ElevenLabsSource
  | GoogleCalendarSource
  | GoogleAiSource
  | MetaAdsSource
  | TeamsSource
  | IntercomSource
  | EmailSource
  | WebWidgetSource;

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isWhatsAppSource(source: Source): source is WhatsAppSource {
  return source.type === "whatsapp";
}

export function isTelegramSource(source: Source): source is TelegramSource {
  return source.type === "telegram";
}

export function isInstagramSource(source: Source): source is InstagramSource {
  return source.type === "instagram";
}

export function isCanvaSource(source: Source): source is CanvaSource {
  return source.type === "canva";
}

export function isHiggsfieldSource(source: Source): source is HiggsfieldSource {
  return source.type === "higgsfield";
}

export function isElevenLabsSource(source: Source): source is ElevenLabsSource {
  return source.type === "elevenlabs";
}

export function isGoogleCalendarSource(
  source: Source,
): source is GoogleCalendarSource {
  return source.type === "google_calendar";
}

export function isMetaAdsSource(source: Source): source is MetaAdsSource {
  return source.type === "meta_ads";
}

export function isEmailSource(source: Source): source is EmailSource {
  return source.type === "email";
}

// ============================================================================
// SOURCE CONTEXT (for webhook handlers and message processing)
// ============================================================================

/**
 * Source context passed to webhook handlers and message processors.
 * Contains essential source information needed for processing messages
 * without requiring additional database lookups.
 *
 * This pattern is used across integrations (Telegram, WhatsApp, etc.)
 * to provide source context to handlers.
 */
export interface SourceContext {
  /** Source ID from the sources table */
  sourceId?: string;
  /** Workspace ID for multi-tenant isolation */
  workspaceId?: string;
  /** Channel-specific authentication token (e.g., bot_token for Telegram, access_token for WhatsApp) */
  botToken?: string;
  /** Alternative name for botToken (used by some integrations) */
  accessToken?: string;
}
