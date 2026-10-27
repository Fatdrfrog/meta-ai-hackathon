"use server";

import { encryptString } from "@/lib/crypto";
import { toPublicElevenLabsCredentials } from "@/lib/elevenlabs/elevenlabs-source";
import { toPublicHiggsfieldCredentials } from "@/lib/higgsfield/higgsfield-source";
import { isLocale } from "@/i18n/locales";
import {
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
  ensureCompanyChannelCapacity,
  toPublicLimitPayload,
} from "@/lib/limits/company-limits";
import { createServerLogger } from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { registerTelegramWebhook } from "@/lib/telegram/register-webhook";
import {
  sealTelegramCredentials,
  toPublicTelegramCredentials,
} from "@/lib/telegram/telegram-source";
import { validateAndEnrichTelegramCredentials } from "@/lib/telegram/validate-token";
import { normalizeAllowedDomains } from "@/lib/widget/domain-validator";
import { translateWidgetQuickRepliesSet } from "@/lib/widget/quick-reply-translations";
import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import {
  DEFAULT_WIDGET_LANGUAGE_CODE,
  MAX_WIDGET_QUICK_REPLY_LENGTH,
  normalizeWidgetLanguageCode,
  normalizeWidgetQuickReplies,
  normalizeWidgetQuickRepliesTranslations,
} from "@icecore/shared/lib/widget-localization";
import {
  type ElevenLabsCredentials,
  type HiggsfieldCredentials,
  isTelegramSource,
  type TelegramCredentials,
  type WebWidgetCredentials,
} from "@icecore/shared/types/sources";
import type {
  WidgetLanguageCode,
  WidgetQuickRepliesTranslations,
} from "@icecore/shared/types/widget-config";
import { cookies } from "next/headers";
import { after } from "next/server";
import { cleanString } from "@icecore/shared/lib/value-utils";

const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const sourceActionsLogger = createServerLogger("app.actions.sources");

const isHexColor = (value: string) => HEX_COLOR_REGEX.test(value);

// The browser never receives the bot token or the webhook secret, so it can
// only send a new token, that bot's username and the reaction setting.
const TELEGRAM_CLIENT_CREDENTIAL_KEYS = new Set([
  "bot_token",
  "bot_username",
  "ai_reactions_enabled",
]);

function validateTelegramCredentialsInput(
  credentials: Record<string, unknown>
): string | null {
  if (
    Object.keys(credentials).some(
      key => !TELEGRAM_CLIENT_CREDENTIAL_KEYS.has(key)
    )
  ) {
    return "Unsupported Telegram credentials";
  }
  if (
    (credentials.bot_token !== undefined &&
      typeof credentials.bot_token !== "string") ||
    (credentials.bot_username !== undefined &&
      typeof credentials.bot_username !== "string")
  ) {
    return "Invalid bot token";
  }
  return credentials.ai_reactions_enabled !== undefined &&
    typeof credentials.ai_reactions_enabled !== "boolean"
    ? "AI reactions setting must be a boolean"
    : null;
}

function scheduleTelegramWebhookRegistration(params: {
  botToken: string;
  sourceId: string;
  operation: "createTelegramSource" | "updateSource";
}) {
  const run = async () => {
    try {
      const webhookResult = await registerTelegramWebhook(
        params.botToken,
        params.sourceId
      );

      if (!webhookResult.success) {
        sourceActionsLogger.error(
          "telegram_webhook_registration_failed",
          undefined,
          {
            operation: params.operation,
            sourceId: params.sourceId,
            error: webhookResult.error || null,
          }
        );
      }
    } catch (error) {
      sourceActionsLogger.error("telegram_webhook_registration_error", error, {
        operation: params.operation,
        sourceId: params.sourceId,
      });
    }
  };

  try {
    after(run);
  } catch {
    void run();
  }
}

const validateWidgetQuickReplies = (quickReplies: unknown) => {
  if (quickReplies === undefined) {
    return { value: undefined as string[] | undefined, error: undefined };
  }

  if (!Array.isArray(quickReplies)) {
    return {
      value: undefined,
      error: "Quick replies must be an array of strings.",
    };
  }

  for (const item of quickReplies) {
    if (typeof item !== "string") {
      continue;
    }

    const value = item.trim().replace(/\s+/g, " ");
    if (!value) {
      continue;
    }

    if (value.length > MAX_WIDGET_QUICK_REPLY_LENGTH) {
      return {
        value: undefined,
        error: `Quick replies must be ${MAX_WIDGET_QUICK_REPLY_LENGTH} characters or less.`,
      };
    }
  }

  return {
    value: normalizeWidgetQuickReplies(quickReplies),
    error: undefined,
  };
};

const validateWidgetQuickRepliesTranslations = (
  localizedQuickReplies: unknown
) => {
  if (localizedQuickReplies === undefined) {
    return {
      value: undefined as WidgetQuickRepliesTranslations | undefined,
      error: undefined,
    };
  }

  if (
    !localizedQuickReplies ||
    typeof localizedQuickReplies !== "object" ||
    Array.isArray(localizedQuickReplies)
  ) {
    return {
      value: undefined,
      error: "Quick reply translations must be an object keyed by locale.",
    };
  }

  const source = localizedQuickReplies as Record<string, unknown>;
  for (const [locale, value] of Object.entries(source)) {
    const normalizedLocale = normalizeWidgetLanguageCode(locale);
    if (!normalizedLocale) {
      continue;
    }

    const validatedReplies = validateWidgetQuickReplies(value);
    if (validatedReplies.error) {
      return {
        value: undefined,
        error: `${normalizedLocale.toUpperCase()} quick replies: ${validatedReplies.error}`,
      };
    }
  }

  return {
    value: normalizeWidgetQuickRepliesTranslations(localizedQuickReplies),
    error: undefined,
  };
};

const validateWidgetQuickRepliesDefaultLocale = (locale: unknown) => {
  if (locale === undefined) {
    return {
      value: undefined as WidgetLanguageCode | undefined,
      error: undefined,
    };
  }

  const normalizedLocale = normalizeWidgetLanguageCode(locale);
  if (!normalizedLocale) {
    return {
      value: undefined,
      error: "Quick reply fallback language must be one of en, ru, kz, uz.",
    };
  }

  return { value: normalizedLocale, error: undefined };
};

// Public locale preference only writes a constrained cookie, not workspace/user data.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function setLocale(locale: string) {
  const normalizedLocale = normalizeWidgetLanguageCode(locale);
  if (!normalizedLocale || !isLocale(normalizedLocale)) return;

  // A year, so an explicit pick outlives the session and keeps beating the
  // browser-language default the proxy seeds on app pages.
  const cookieStore = await cookies();
  cookieStore.set("NEXT_LOCALE", normalizedLocale, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function updateSource(
  sourceId: string,
  data: { credentials: Record<string, unknown> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  // Fetch existing source to check type and verify access
  const { data: existingSource, error: fetchError } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("id", sourceId)
    .single();

  if (fetchError || !existingSource) {
    return { error: "Source not found" };
  }

  // Verify user has access to this workspace
  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", existingSource.workspace_id)
    .single();

  if (!companyUser) {
    return { error: "Access denied to this workspace" };
  }

  if (existingSource.type === "google_ai") {
    return {
      error:
        "Use Google AI integration settings to validate and replace the API key.",
    };
  }

  // WhatsApp connections are only written by the routes that validate the
  // token with Meta, check number ownership and keep routing in sync.
  if (existingSource.type === "whatsapp") {
    return {
      error: "Use WhatsApp integration settings to change this connection.",
    };
  }

  if (
    !data.credentials ||
    typeof data.credentials !== "object" ||
    Array.isArray(data.credentials)
  ) {
    return { error: "Invalid credentials" };
  }

  // A new bot token, validated with Telegram; the stored one stays encrypted.
  let newTelegramBotToken: string | null = null;
  if (isTelegramSource(existingSource)) {
    const inputError = validateTelegramCredentialsInput(data.credentials);
    if (inputError) return { error: inputError };
    const incomingCredentials = data.credentials as Partial<TelegramCredentials>;
    let nextCredentials: Record<string, unknown> = {
      ...existingSource.credentials,
      ...incomingCredentials,
    };

    if (typeof incomingCredentials.bot_token === "string") {
      const validation = await validateAndEnrichTelegramCredentials(
        incomingCredentials as TelegramCredentials,
        { fetchUsername: true } // Fetch username if not provided
      );

      if (!validation.valid) {
        return { error: validation.error || "Invalid bot token" };
      }

      // Keep stored settings and the webhook secret while enriching the new token.
      nextCredentials = {
        ...existingSource.credentials,
        ...validation.credentials,
      };
      newTelegramBotToken = validation.credentials.bot_token;
    }

    // Also encrypts a token saved in plain text before encryption.
    data.credentials = sealTelegramCredentials(nextCredentials);
  }

  // Only credentials are editable here; the client never moves a source to
  // another workspace or type. Telegram rows are server-managed: members
  // cannot write them directly, so this checked write uses the service role.
  const { error } = isTelegramSource(existingSource)
    ? await supabaseAdmin
        .from("sources")
        .update({ credentials: data.credentials })
        .eq("id", sourceId)
        .eq("workspace_id", existingSource.workspace_id)
        .eq("type", "telegram")
    : await supabase
        .from("sources")
        .update({ credentials: data.credentials })
        .eq("id", sourceId);

  if (error) {
    return { error: error.message };
  }

  // Register the webhook when the bot token changes; settings-only saves need no provider call.
  if (newTelegramBotToken) {
    scheduleTelegramWebhookRegistration({
      botToken: newTelegramBotToken,
      sourceId,
      operation: "updateSource",
    });
  }

  return { success: true };
}

export async function createTelegramSource(
  workspaceId: string,
  credentials: TelegramCredentials
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!companyUser) {
    return { error: "Access denied to this workspace" };
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.company_id) {
    return { error: "Workspace not found" };
  }

  const inputError = validateTelegramCredentialsInput(
    credentials as unknown as Record<string, unknown>
  );
  if (inputError) return { error: inputError };

  const validation = await validateAndEnrichTelegramCredentials(credentials, {
    fetchUsername: true,
  });

  if (!validation.valid) {
    return { error: validation.error || "Invalid bot token" };
  }

  const { data: existingSource } = await supabaseAdmin
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "telegram")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const botToken = validation.credentials.bot_token;
  const nextCredentials = sealTelegramCredentials({
    ...existingSource?.credentials,
    ...validation.credentials,
    ai_reactions_enabled:
      validation.credentials.ai_reactions_enabled ??
      existingSource?.credentials?.ai_reactions_enabled === true,
  });

  if (!existingSource?.id) {
    const channelCapacity = await ensureCompanyChannelCapacity(
      supabaseAdmin,
      workspaceId,
      "telegram"
    );
    if (!channelCapacity.allowed) {
      return {
        error:
          "Company channel limit exceeded. Upgrade to Pro to connect more channels.",
        code: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
        limit: toPublicLimitPayload(channelCapacity.limit),
      };
    }
  }

  const sourceResult = existingSource?.id
    ? await supabaseAdmin
        .from("sources")
        .update({
          name: nextCredentials.bot_username
            ? `@${nextCredentials.bot_username}`
            : "Telegram Bot",
          credentials: nextCredentials,
        })
        .eq("id", existingSource.id)
        .select("*")
        .single()
    : await supabaseAdmin
        .from("sources")
        .insert({
          name: nextCredentials.bot_username
            ? `@${nextCredentials.bot_username}`
            : "Telegram Bot",
          type: "telegram",
          workspace_id: workspaceId,
          company_id: workspace.company_id,
          credentials: nextCredentials,
        })
        .select("*")
        .single();

  if (sourceResult.error || !sourceResult.data) {
    return {
      error: sourceResult.error?.message || "Failed to create Telegram source",
    };
  }

  scheduleTelegramWebhookRegistration({
    botToken,
    sourceId: sourceResult.data.id,
    operation: "createTelegramSource",
  });

  return {
    success: true,
    source: {
      ...sourceResult.data,
      credentials: toPublicTelegramCredentials(sourceResult.data.credentials),
    },
  };
}

export async function upsertHiggsfieldSource(
  workspaceId: string,
  credentials: HiggsfieldCredentials
) {
  const apiKey = cleanString(credentials.api_key, 1000);
  const apiSecret = cleanString(credentials.api_secret, 1000);
  const singleKey = cleanString(credentials.key, 1000);

  if (!singleKey && (!apiKey || !apiSecret)) {
    return { error: "Enter both Higgsfield API key and API secret." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!companyUser) {
    return { error: "Access denied to this workspace" };
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.company_id) {
    return { error: "Workspace not found" };
  }

  const nextCredentials: HiggsfieldCredentials = singleKey
    ? {
        key: singleKey,
        connected_at: new Date().toISOString(),
      }
    : {
        api_key: apiKey,
        api_secret: apiSecret,
        connected_at: new Date().toISOString(),
      };

  const { data: existingSource } = await supabase
    .from("sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", "higgsfield")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sourceResult = existingSource?.id
    ? await supabase
        .from("sources")
        .update({
          name: "Higgsfield",
          credentials: nextCredentials,
        })
        .eq("id", existingSource.id)
        .select("*")
        .single()
    : await supabase
        .from("sources")
        .insert({
          name: "Higgsfield",
          type: "higgsfield",
          workspace_id: workspaceId,
          company_id: workspace.company_id,
          credentials: nextCredentials,
        })
        .select("*")
        .single();

  if (sourceResult.error || !sourceResult.data) {
    return {
      error: sourceResult.error?.message || "Failed to save Higgsfield source",
    };
  }

  return {
    success: true,
    source: {
      ...sourceResult.data,
      credentials: toPublicHiggsfieldCredentials(sourceResult.data.credentials),
    },
  };
}

export async function upsertElevenLabsSource(
  workspaceId: string,
  credentials: ElevenLabsCredentials
) {
  const apiKey = cleanString(credentials.api_key, 4000);
  const defaultVoiceId = cleanString(credentials.default_voice_id, 200);

  if (!apiKey) {
    return { error: "Enter an ElevenLabs API key." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  const { data: companyUser } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!companyUser) {
    return { error: "Access denied to this workspace" };
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.company_id) {
    return { error: "Workspace not found" };
  }

  const nextCredentials: ElevenLabsCredentials = {
    // A connected key pays for the workspace's generations: kept encrypted.
    api_key: encryptString(apiKey),
    default_voice_id: defaultVoiceId || undefined,
    connected_at: new Date().toISOString(),
  };

  const { data: existingSource } = await supabase
    .from("sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", "elevenlabs")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sourceResult = existingSource?.id
    ? await supabase
        .from("sources")
        .update({
          name: "ElevenLabs",
          credentials: nextCredentials,
        })
        .eq("id", existingSource.id)
        .select("*")
        .single()
    : await supabase
        .from("sources")
        .insert({
          name: "ElevenLabs",
          type: "elevenlabs",
          workspace_id: workspaceId,
          company_id: workspace.company_id,
          credentials: nextCredentials,
        })
        .select("*")
        .single();

  if (sourceResult.error || !sourceResult.data) {
    return {
      error: sourceResult.error?.message || "Failed to save ElevenLabs source",
    };
  }

  return {
    success: true,
    source: {
      ...sourceResult.data,
      credentials: toPublicElevenLabsCredentials(sourceResult.data.credentials),
    },
  };
}

export async function createWebWidgetSource(
  workspaceId: string,
  name: string,
  allowedDomains: string[]
) {
  try {
    const normalizedAllowedDomains = normalizeAllowedDomains(allowedDomains);
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Unauthorized" };
    }

    // Verify user has access to workspace
    const { data: companyUser } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .single();

    if (!companyUser) {
      return { error: "Access denied" };
    }

    // Generate secure keys
    const crypto = await import("crypto");
    const clientKey = "widget_" + crypto.randomBytes(16).toString("hex");
    const secretKey = crypto.randomBytes(32).toString("hex");

    // Get company_id from workspace
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("company_id")
      .eq("id", workspaceId)
      .single();

    if (!workspace) {
      return { error: "Workspace not found" };
    }

    const channelCapacity = await ensureCompanyChannelCapacity(
      supabaseAdmin,
      workspaceId,
      "web_widget"
    );
    if (!channelCapacity.allowed) {
      return {
        error:
          "Company channel limit exceeded. Upgrade to Pro to connect more channels.",
        code: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
        limit: toPublicLimitPayload(channelCapacity.limit),
      };
    }

    // Create source with default configuration
    const { data: source, error } = await supabase
      .from("sources")
      .insert({
        name,
        type: "web_widget",
        workspace_id: workspaceId,
        company_id: workspace.company_id,
        credentials: {
          client_key: clientKey,
          secret_key: secretKey,
          allowed_domains: normalizedAllowedDomains,
          theme: {
            primary_color: "#0B6BCB",
            bubble_color: "#0B6BCB",
            header_bg_color: "#FFFFFF",
            header_text_color: "#111827",
          },
          settings: {
            welcome_message: "Hello! How can we help you today?",
            response_time: "Usually responds within 2 hours",
            airi_enabled: true,
            auto_open: false,
            position: "bottom-right",
          },
          content: {
            bot_name: "Airi",
            header_title: "Chat with us",
            hero_title: "Hi, I'm Airi!",
            cta_primary_text: "Send us a message",
            cta_secondary_text: "We typically reply in a few minutes",
          },
          branding: {
            bubble_mode: "icon",
            bubble_text: "",
            bubble_svg_url: "",
            logo_mode: "default",
            logo_text: "",
            logo_svg_url: "",
          },
          layout: {
            home_variant: "intercom",
            show_help_tab: true,
            show_news_tab: true,
          },
          status: normalizedAllowedDomains.length > 0 ? "active" : "inactive",
        },
      })
      .select()
      .single();

    if (error) {
      return { error: error.message };
    }

    return { success: true, source };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "An unexpected error occurred",
    };
  }
}

export async function updateWebWidgetSource(
  sourceId: string,
  updates: { name?: string; allowedDomains?: string[] }
) {
  try {
    const normalizedAllowedDomains =
      updates.allowedDomains !== undefined
        ? normalizeAllowedDomains(updates.allowedDomains)
        : undefined;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Unauthorized" };
    }

    // Get source and verify access
    const { data: source } = await supabase
      .from("sources")
      .select("workspace_id, credentials, type")
      .eq("id", sourceId)
      .eq("type", "web_widget")
      .single();

    if (!source) {
      return { error: "Source not found" };
    }
    if (source.type !== "web_widget") {
      return { error: "Source is not a web widget" };
    }

    // Verify user has access
    const { data: companyUser } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", source.workspace_id)
      .single();

    if (!companyUser) {
      return { error: "Access denied" };
    }

    // Update source
    const updateData: {
      name?: string;
      credentials?: {
        allowed_domains?: string[];
        status?: "active" | "inactive";
        theme?: {
          primary_color?: string;
          accent_color?: string;
          surface_color?: string;
          font_family?: string;
          corner_radius?: string;
        };
        settings?: {
          welcome_message?: string;
          response_time?: string;
          airi_enabled?: boolean;
          auto_open?: boolean;
          position?: string;
        };
      };
    } = {};
    if (updates.name) updateData.name = updates.name;
    if (normalizedAllowedDomains !== undefined) {
      updateData.credentials = {
        ...source.credentials,
        allowed_domains: normalizedAllowedDomains,
        status: normalizedAllowedDomains.length > 0 ? "active" : "inactive",
      };
    }

    const { error } = await supabase
      .from("sources")
      .update(updateData)
      .eq("id", sourceId)
      .eq("workspace_id", source.workspace_id)
      .eq("type", "web_widget");

    if (error) {
      return { error: error.message };
    }

    return { success: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "An unexpected error occurred",
    };
  }
}

export async function regenerateWebWidgetKeys(sourceId: string) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Unauthorized" };
    }

    // Get source and verify access
    const { data: source } = await supabase
      .from("sources")
      .select("workspace_id, credentials, type")
      .eq("id", sourceId)
      .eq("type", "web_widget")
      .single();

    if (!source) {
      return { error: "Source not found" };
    }
    if (source.type !== "web_widget") {
      return { error: "Source is not a web widget" };
    }

    // Verify user has access
    const { data: companyUser } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", source.workspace_id)
      .single();

    if (!companyUser) {
      return { error: "Access denied" };
    }

    // Generate new keys
    const crypto = await import("crypto");
    const clientKey = "widget_" + crypto.randomBytes(16).toString("hex");
    const secretKey = crypto.randomBytes(32).toString("hex");

    const { error } = await supabase
      .from("sources")
      .update({
        credentials: {
          ...source.credentials,
          client_key: clientKey,
          secret_key: secretKey,
        },
      })
      .eq("id", sourceId)
      .eq("workspace_id", source.workspace_id)
      .eq("type", "web_widget");

    if (error) {
      return { error: "Failed to regenerate keys" };
    }

    return { success: true, clientKey, secretKey };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "An unexpected error occurred",
    };
  }
}

type WidgetBrandingUpdates = {
  theme?: {
    primary_color?: string;
    bubble_color?: string;
    header_bg_color?: string;
    header_text_color?: string;
  };
  settings?: {
    welcome_message?: string;
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
};

export async function translateWidgetQuickReplies(
  quickReplies: string[],
  sourceLocale: WidgetLanguageCode,
  targetLocales?: WidgetLanguageCode[],
  sourceId?: string
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  try {
    // Read through the authenticated client's source RLS before billing its workspace.
    if (!sourceId) return { error: "Widget source is required" };
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .select("workspace_id")
      .eq("id", sourceId)
      .eq("type", "web_widget")
      .maybeSingle();
    if (sourceError || !source?.workspace_id) return { error: "Widget source not found" };
    const translations = await withWorkspaceTextAiAction(
      { workspaceId: source.workspace_id, actionId: `widget-translation:${randomUUID()}` },
      () => translateWidgetQuickRepliesSet({
      quickReplies,
      sourceLocale,
      targetLocales,
    }));

    return { success: true, translations };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Failed to translate quick replies",
    };
  }
}

export async function updateWebWidgetBranding(
  sourceId: string,
  updates: WidgetBrandingUpdates
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: "Unauthorized" };
    }

    const { data: source } = await supabase
      .from("sources")
      .select("workspace_id, type, credentials")
      .eq("id", sourceId)
      .eq("type", "web_widget")
      .single();

    if (!source) {
      return { error: "Source not found" };
    }

    if (source.type !== "web_widget") {
      return { error: "Source is not a web widget" };
    }

    const { data: companyUser } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", source.workspace_id)
      .single();

    if (!companyUser) {
      return { error: "Access denied" };
    }

    const credentials = (source.credentials || {}) as WebWidgetCredentials;

    if (updates.theme) {
      const themeColors = [
        updates.theme.primary_color,
        updates.theme.bubble_color,
        updates.theme.header_bg_color,
        updates.theme.header_text_color,
      ].filter((value): value is string => Boolean(value));

      const invalidColor = themeColors.find(value => !isHexColor(value));
      if (invalidColor) {
        return { error: `Invalid color value: ${invalidColor}` };
      }
    }

    const quickRepliesUpdate = validateWidgetQuickReplies(
      updates.content?.quick_replies
    );
    if (quickRepliesUpdate.error) {
      return { error: quickRepliesUpdate.error };
    }

    const quickRepliesI18nUpdate = validateWidgetQuickRepliesTranslations(
      updates.content?.quick_replies_i18n
    );
    if (quickRepliesI18nUpdate.error) {
      return { error: quickRepliesI18nUpdate.error };
    }

    const quickRepliesDefaultLocaleUpdate =
      validateWidgetQuickRepliesDefaultLocale(
        updates.content?.quick_replies_default_locale
      );
    if (quickRepliesDefaultLocaleUpdate.error) {
      return { error: quickRepliesDefaultLocaleUpdate.error };
    }

    const contentUpdates = { ...(updates.content || {}) };
    delete contentUpdates.quick_replies;
    delete contentUpdates.quick_replies_default_locale;
    delete contentUpdates.quick_replies_i18n;

    const nextQuickRepliesDefaultLocale =
      quickRepliesDefaultLocaleUpdate.value ||
      normalizeWidgetLanguageCode(
        credentials.content?.quick_replies_default_locale
      ) ||
      DEFAULT_WIDGET_LANGUAGE_CODE;

    const nextQuickReplies =
      quickRepliesUpdate.value ??
      normalizeWidgetQuickReplies(credentials.content?.quick_replies);

    const nextQuickRepliesI18n =
      quickRepliesI18nUpdate.value ??
      normalizeWidgetQuickRepliesTranslations(
        credentials.content?.quick_replies_i18n
      );

    if (nextQuickReplies.length > 0) {
      nextQuickRepliesI18n[nextQuickRepliesDefaultLocale] = nextQuickReplies;
    } else {
      delete nextQuickRepliesI18n[nextQuickRepliesDefaultLocale];
    }

    const nextCredentials: WebWidgetCredentials = {
      ...credentials,
      theme: {
        ...(credentials.theme || { primary_color: "#0B6BCB" }),
        ...(updates.theme || {}),
      },
      settings: {
        ...(credentials.settings || {
          welcome_message: "Hello! How can we help you today?",
          response_time: "Usually responds within 2 hours",
          airi_enabled: true,
          auto_open: false,
          position: "bottom-right" as const,
        }),
        ...(updates.settings || {}),
      },
      content: {
        ...(credentials.content || {}),
        ...contentUpdates,
        quick_replies: nextQuickReplies,
        quick_replies_default_locale: nextQuickRepliesDefaultLocale,
        quick_replies_i18n: nextQuickRepliesI18n,
      },
      branding: {
        ...(credentials.branding || {}),
        ...(updates.branding || {}),
      },
      layout: {
        ...(credentials.layout || {}),
        ...(updates.layout || {}),
      },
    };

    const { error } = await supabase
      .from("sources")
      .update({ credentials: nextCredentials })
      .eq("id", sourceId)
      .eq("workspace_id", source.workspace_id)
      .eq("type", "web_widget");

    if (error) {
      return { error: error.message };
    }

    return { success: true };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "An unexpected error occurred",
    };
  }
}
