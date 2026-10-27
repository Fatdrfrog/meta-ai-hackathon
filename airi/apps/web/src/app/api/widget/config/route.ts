import { widgetLogger } from "@/lib/logger";
import { getRealtimeGatewayUrl } from "@/lib/realtime/gateway-url";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import {
  getWorkspaceRecommendedQuickReplies,
  isLegacyDefaultWidgetQuickReplies,
} from "@/lib/widget/quick-reply-recommendations";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  normalizeWidgetQuickRepliesTranslations,
  parseWidgetAcceptLanguageHeader,
  resolveLocalizedWidgetQuickReplies,
} from "@icecore/shared/lib/widget-localization";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import type { WidgetConfigResponse } from "@icecore/shared/types/widget-config";
import { NextRequest } from "next/server";

// Widget rate limiters
const configLimiter = createRateLimiter(rateLimitPresets.widgetConfig);

/**
 * OPTIONS /api/widget/config
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/config
 *
 * Fetches widget configuration based on client_key
 * This endpoint is called by the widget on initialization
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");

  try {
    const clientKey = req.nextUrl.searchParams.get("client_key");
    const requestedLocale = req.nextUrl.searchParams.get("locale");

    if (!clientKey) {
      return jsonWithCors<WidgetConfigResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    // Rate limiting
    const rateLimitResult = await checkRateLimit(configLimiter, clientKey, 30);
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded("/api/widget/config", clientKey);
      return jsonWithCors<WidgetConfigResponse>(
        {
          success: false,
          error: "Too many requests. Please try again later.",
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": rateLimitResult.limit.toString(),
            "X-RateLimit-Remaining": rateLimitResult.remaining.toString(),
          },
        }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<WidgetConfigResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status, origin }
      );
    }

    const { source, credentials } = sourceAuth;

    const theme = {
      primaryColor: credentials.theme?.primary_color || "#0B6BCB",
      bubbleColor: credentials.theme?.bubble_color,
      headerBgColor: credentials.theme?.header_bg_color,
      headerTextColor: credentials.theme?.header_text_color,
    };

    const settings = {
      welcomeMessage:
        credentials.settings?.welcome_message ||
        "Hello! How can we help you today?",
      offlineMessage:
        credentials.settings?.offline_message ||
        "We're currently offline. Leave us a message!",
      responseTime:
        credentials.settings?.response_time ||
        "Usually responds within 2 hours",
      aiEnabled: credentials.settings?.airi_enabled ?? true,
      autoOpen: credentials.settings?.auto_open ?? false,
      position: credentials.settings?.position || "bottom-right",
    } as const;

    const hasConfiguredQuickReplies =
      Array.isArray(credentials.content?.quick_replies) ||
      Object.keys(
        normalizeWidgetQuickRepliesTranslations(
          credentials.content?.quick_replies_i18n
        )
      ).length > 0;
    const hasLegacyDefaultQuickReplies = isLegacyDefaultWidgetQuickReplies(
      credentials.content?.quick_replies
    );
    const fallbackQuickReplies =
      hasConfiguredQuickReplies && !hasLegacyDefaultQuickReplies
        ? []
        : await getWorkspaceRecommendedQuickReplies(source.workspace_id);
    const quickReplyContent = resolveLocalizedWidgetQuickReplies({
      defaultQuickReplies: credentials.content?.quick_replies,
      localizedQuickReplies: credentials.content?.quick_replies_i18n,
      defaultLocale: credentials.content?.quick_replies_default_locale,
      preferredLocaleCandidates: [
        requestedLocale,
        ...parseWidgetAcceptLanguageHeader(req.headers.get("accept-language")),
      ],
      fallbackQuickReplies,
    });

    const content = {
      botName: credentials.content?.bot_name || "Airi",
      headerTitle: credentials.content?.header_title || "Chat with us",
      heroTitle: credentials.content?.hero_title || "Hi, I'm Airi!",
      ctaPrimaryText:
        credentials.content?.cta_primary_text || "Send us a message",
      ctaSecondaryText:
        credentials.content?.cta_secondary_text ||
        "We typically reply in a few minutes",
      quickReplies: quickReplyContent.quickReplies,
    };

    const branding = {
      bubbleMode: credentials.branding?.bubble_mode || "icon",
      bubbleText: credentials.branding?.bubble_text || "",
      bubbleSvgUrl: credentials.branding?.bubble_svg_url || "",
      logoMode: credentials.branding?.logo_mode || "default",
      logoText: credentials.branding?.logo_text || "",
      logoSvgUrl: credentials.branding?.logo_svg_url || "",
    };

    const layout = {
      homeVariant: credentials.layout?.home_variant || "intercom",
      showHelpTab: credentials.layout?.show_help_tab ?? true,
      showNewsTab: credentials.layout?.show_news_tab ?? true,
    };

    widgetLogger.configFetched(
      source.workspace_id,
      source.company_id,
      clientKey
    );

    return jsonWithCors<WidgetConfigResponse>({
      success: true,
      config: {
        sourceId: source.id,
        workspaceId: source.workspace_id,
        companyId: source.company_id,
        theme,
        settings,
        content,
        branding,
        layout,
        locale: quickReplyContent.locale,
        realtime: {
          url: getRealtimeGatewayUrl(process.env, "ws://localhost:8080"),
        },
      },
    });
  } catch (error) {
    widgetLogger.error("config_fetch", error, { origin });
    return jsonWithCors<WidgetConfigResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
