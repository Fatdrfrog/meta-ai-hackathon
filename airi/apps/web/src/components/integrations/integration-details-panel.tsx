"use client";

import { IntegrationSetupGuide } from "@/components/integrations/integration-setup-guide";
import { CardSkeleton } from "@/components/settings/settings-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isConfiguredIntegrationSource,
  isConfiguredTelegramSource,
} from "@/lib/integrations/source-status";
import type { EmailProviderStatus } from "@/types/integrations";
import { Source } from "@/types/supabase";
import { ArrowLeft, CheckCircle2, Clock3, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { IntegrationIcon } from "./integration-icon";
import type { IntegrationsPresentation } from "./integration-presentation";
import { getIntegrationById } from "./integration-registry";
import { buildIntegrationSelectionUrl } from "./integration-selection-url";

const EmailIntegrationContent = dynamic(
  () =>
    import("./email-integration-content").then(module => ({
      default: module.EmailIntegrationContent,
    })),
  { loading: () => <CardSkeleton /> }
);

const CanvaIntegration = dynamic(
  () =>
    import("./canva-integration").then(module => ({
      default: module.CanvaIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const MetaAdsIntegration = dynamic(
  () =>
    import("./meta-ads-integration").then(module => ({
      default: module.MetaAdsIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const GoogleCalendarIntegration = dynamic(
  () =>
    import("./google-calendar-integration").then(module => ({
      default: module.GoogleCalendarIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const GoogleAIIntegration = dynamic(
  () =>
    import("./google-ai-integration").then(module => ({
      default: module.GoogleAIIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const InstagramIntegration = dynamic(
  () =>
    import("./instagram-integration").then(module => ({
      default: module.InstagramIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const HiggsfieldIntegration = dynamic(
  () =>
    import("./higgsfield-integration").then(module => ({
      default: module.HiggsfieldIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const ElevenLabsIntegration = dynamic(
  () =>
    import("./elevenlabs-integration").then(module => ({
      default: module.ElevenLabsIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const TelegramIntegration = dynamic(
  () =>
    import("./telegram-integration").then(module => ({
      default: module.TelegramIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const WebWidgetIntegration = dynamic(
  () =>
    import("./web-widget-integration").then(module => ({
      default: module.WebWidgetIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

const WhatsAppIntegration = dynamic(
  () =>
    import("./whatsapp-integration").then(module => ({
      default: module.WhatsAppIntegration,
    })),
  { loading: () => <CardSkeleton /> }
);

interface IntegrationDetailsPanelProps {
  sources: Source[];
  emailIntegrationEnabled: boolean;
  emailProviderStatus: EmailProviderStatus;
  workspaceId: string;
  onSourcesChanged?: () => Promise<unknown>;
  selectedIntegrationId?: string | null;
  isSelectionPending?: boolean;
  onClearSelection?: () => void;
  error?: string | null;
  errorDetails?: string | null;
  warning?: string | null;
  warningDetails?: string | null;
  connectionActionsDisabled?: boolean;
  secondaryActionHref?: string;
  presentation?: IntegrationsPresentation;
}

export function IntegrationDetailsPanel({
  sources,
  emailIntegrationEnabled,
  emailProviderStatus,
  workspaceId,
  onSourcesChanged,
  selectedIntegrationId: selectedIntegrationIdProp,
  isSelectionPending = false,
  onClearSelection,
  error: errorProp,
  errorDetails: errorDetailsProp,
  warning: warningProp,
  warningDetails: warningDetailsProp,
  connectionActionsDisabled = false,
  secondaryActionHref,
  presentation = "default",
}: IntegrationDetailsPanelProps) {
  const { theme } = useTheme();
  const searchParams = useSearchParams();
  const tDetails = useTranslations("IntegrationDetails");
  const tRegistry = useTranslations("IntegrationRegistry");

  const explicitIntegrationId = searchParams?.get("integration");
  const activeType = searchParams?.get("type");
  const fallbackIntegrationId =
    explicitIntegrationId ??
    (activeType && activeType !== "all" ? activeType : null);
  const integrationId =
    selectedIntegrationIdProp !== undefined
      ? selectedIntegrationIdProp
      : fallbackIntegrationId;

  const error =
    errorProp !== undefined ? errorProp : (searchParams?.get("error") ?? null);
  const errorDetails =
    errorDetailsProp !== undefined
      ? errorDetailsProp
      : (searchParams?.get("error_details") ?? null);
  const warning =
    warningProp !== undefined
      ? warningProp
      : (searchParams?.get("warning") ?? null);
  const warningDetails =
    warningDetailsProp !== undefined
      ? warningDetailsProp
      : (searchParams?.get("warning_details") ?? null);

  const clearSelection = () => {
    if (onClearSelection) {
      onClearSelection();
      return;
    }

    const { href } = buildIntegrationSelectionUrl({
      pathname: window.location.pathname,
      currentSearch: searchParams?.toString() ?? "",
      integrationId: null,
    });
    window.history.pushState(null, "", href);
  };

  if (!integrationId) {
    return (
      <div className="hidden min-h-[320px] rounded-lg bg-muted/20 @min-[48rem]/integrations:flex @min-[48rem]/integrations:flex-col @min-[48rem]/integrations:justify-center">
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-background/80">
            <Plus className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-base font-semibold text-foreground">
              {tDetails("emptyTitle")}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {tDetails("emptyDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const integration = getIntegrationById(integrationId);

  if (!integration) {
    return (
      <div className="rounded-2xl bg-muted/20 p-6 text-sm text-muted-foreground">
        {tDetails("notFound")}
      </div>
    );
  }

  const connectionState =
    integration.id === "email"
      ? emailProviderStatus
      : integration.id === "telegram"
        ? sources.some(source => isConfiguredTelegramSource(source))
          ? "connected"
          : "disconnected"
        : sources.some(
              source =>
                source.type === integration.id &&
                isConfiguredIntegrationSource(source)
            )
          ? "connected"
          : "disconnected";
  const guideSource =
    integration.id === "whatsapp"
      ? sources.find(source => source.type === "whatsapp")
      : undefined;

  const statusClassName =
    connectionState === "connected"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300"
      : connectionState === "pending_dns"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300"
        : "bg-muted text-muted-foreground";

  const statusIcon =
    connectionState === "connected" ? (
      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
    ) : connectionState === "pending_dns" ? (
      <Clock3 className="mr-1 h-3.5 w-3.5" />
    ) : (
      <Plus className="mr-1 h-3.5 w-3.5" />
    );

  if (presentation === "landingCompact") {
    const hasCompactGuide =
      integrationId === "telegram" ||
      integrationId === "whatsapp" ||
      integrationId === "instagram";

    return (
      <section className="min-w-0 rounded-[1rem] bg-[#cfffe1]/45 p-3 text-slate-950">
        <div className="space-y-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center bg-transparent">
              <IntegrationIcon
                integration={integration}
                alt={tRegistry(`${integration.id}.name`)}
                theme={theme}
                className="h-6 w-6"
              />
            </div>
            <h2 className="truncate text-sm font-black text-slate-950">
              {tRegistry(`${integration.id}.name`)}
            </h2>
          </div>
          <p className="text-xs font-medium leading-5 text-slate-700">
            {tRegistry(`${integration.id}.description`)}
          </p>
        </div>

        {hasCompactGuide && (
          <div className="mt-3">
            <IntegrationSetupGuide
              integrationId={integrationId}
              workspaceId={workspaceId}
              secondaryActionHref={secondaryActionHref}
              source={guideSource}
              presentation={presentation}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted/40 ">
            <IntegrationIcon
              integration={integration}
              alt={tRegistry(`${integration.id}.name`)}
              theme={theme}
              className="h-7 w-7"
            />
          </div>

          <div className="space-y-2">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-foreground">
                {tRegistry(`${integration.id}.name`)}
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {tRegistry(`${integration.id}.description`)}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge className={statusClassName}>
                {statusIcon}
                {tRegistry(`status.${connectionState}`)}
              </Badge>
            </div>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearSelection}
          className="self-start @min-[48rem]/integrations:hidden"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {tDetails("back")}
        </Button>
      </div>

      {isSelectionPending && (
        <div
          aria-label="Loading integration"
          role="status"
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      )}

      <div className="space-y-6">
        <IntegrationContent
          integrationId={integrationId}
          sources={sources}
          emailIntegrationEnabled={emailIntegrationEnabled}
          emailProviderStatus={emailProviderStatus}
          workspaceId={workspaceId}
          onSourcesChanged={onSourcesChanged}
          error={error}
          errorDetails={errorDetails}
          warning={warning}
          warningDetails={warningDetails}
          connectionActionsDisabled={connectionActionsDisabled}
        />
        <IntegrationSetupGuide
          integrationId={integrationId}
          workspaceId={workspaceId}
          secondaryActionHref={secondaryActionHref}
          source={guideSource}
          presentation={presentation}
        />
      </div>
    </section>
  );
}

interface IntegrationContentProps {
  integrationId: string;
  sources: Source[];
  emailIntegrationEnabled: boolean;
  emailProviderStatus: EmailProviderStatus;
  workspaceId: string;
  onSourcesChanged?: () => Promise<unknown>;
  error: string | null;
  errorDetails: string | null;
  warning: string | null;
  warningDetails: string | null;
  connectionActionsDisabled: boolean;
}

function IntegrationContent({
  integrationId,
  sources,
  emailIntegrationEnabled,
  emailProviderStatus,
  workspaceId,
  onSourcesChanged,
  error,
  errorDetails,
  warning,
  warningDetails,
  connectionActionsDisabled,
}: IntegrationContentProps) {
  const telegram = sources.find(source => source.type === "telegram");
  const whatsapp = sources.find(source => source.type === "whatsapp");
  const webWidget = sources.find(source => source.type === "web_widget");
  const instagram = sources.find(source => source.type === "instagram");
  const canva = sources.find(source => String(source.type) === "canva");
  const metaAds = sources.find(source => String(source.type) === "meta_ads");
  const googleCalendar = sources.find(
    source => String(source.type) === "google_calendar"
  );
  const higgsfield = sources.find(
    source => String(source.type) === "higgsfield"
  );
  const elevenlabs = sources.find(
    source => String(source.type) === "elevenlabs"
  );
  const googleAI = sources.find(source => String(source.type) === "google_ai");
  const t = useTranslations("IntegrationModal");

  switch (integrationId) {
    case "google_ai":
      return (
        <GoogleAIIntegration
          key={workspaceId}
          source={googleAI}
          workspaceId={workspaceId}
          onSourceChanged={onSourcesChanged}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    case "telegram":
      return (
        <TelegramIntegration
          source={telegram}
          workspaceId={workspaceId}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    case "whatsapp":
      return (
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              integrationId="whatsapp"
              error={error}
              errorDetails={errorDetails}
            />
          )}
          <WhatsAppIntegration
            source={whatsapp}
            workspaceId={workspaceId}
            connectionActionsDisabled={connectionActionsDisabled}
          />
        </div>
      );

    case "instagram":
      return (
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              integrationId="instagram"
              error={error}
              errorDetails={errorDetails}
            />
          )}
          {warning && (
            <WarningBanner
              integrationId="instagram"
              warning={warning}
              warningDetails={warningDetails}
            />
          )}
          <InstagramIntegration
            source={instagram}
            workspaceId={workspaceId}
            connectionActionsDisabled={connectionActionsDisabled}
          />
        </div>
      );

    case "canva":
      return (
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              integrationId="canva"
              error={error}
              errorDetails={errorDetails}
            />
          )}
          <CanvaIntegration
            source={canva}
            workspaceId={workspaceId}
            connectionActionsDisabled={connectionActionsDisabled}
          />
        </div>
      );

    case "meta_ads":
      return (
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              integrationId="meta_ads"
              error={error}
              errorDetails={errorDetails}
            />
          )}
          <MetaAdsIntegration
            source={metaAds}
            workspaceId={workspaceId}
            connectionActionsDisabled={connectionActionsDisabled}
          />
        </div>
      );

    case "google_calendar":
      return (
        <div className="space-y-4">
          {error && (
            <ErrorBanner
              integrationId="google_calendar"
              error={error}
              errorDetails={errorDetails}
            />
          )}
          <GoogleCalendarIntegration
            source={googleCalendar}
            workspaceId={workspaceId}
            onSourceChanged={onSourcesChanged}
            connectionActionsDisabled={connectionActionsDisabled}
          />
        </div>
      );

    case "higgsfield":
      return (
        <HiggsfieldIntegration
          source={higgsfield}
          workspaceId={workspaceId}
          onSourceChanged={onSourcesChanged}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    case "elevenlabs":
      return (
        <ElevenLabsIntegration
          source={elevenlabs}
          workspaceId={workspaceId}
          onSourceChanged={onSourcesChanged}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    case "email":
      if (!emailIntegrationEnabled) {
        return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;
      }

      return (
        <EmailIntegrationContent
          workspaceId={workspaceId}
          emailProviderStatus={emailProviderStatus}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    case "web_widget":
      return (
        <WebWidgetIntegration
          source={webWidget}
          workspaceId={workspaceId}
          onSourceChanged={onSourcesChanged}
          connectionActionsDisabled={connectionActionsDisabled}
        />
      );

    default:
      return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;
  }
}

function ErrorBanner({
  integrationId,
  error,
  errorDetails,
}: {
  integrationId:
    | "whatsapp"
    | "instagram"
    | "canva"
    | "google_calendar"
    | "meta_ads";
  error: string;
  errorDetails: string | null;
}) {
  const t = useTranslations("IntegrationModal");
  const tCanva = useTranslations("CanvaIntegration");
  const tCalendar = useTranslations("GoogleCalendarIntegration");
  const tMetaAds = useTranslations("MetaAdsIntegration");
  const tInstagram = useTranslations("InstagramIntegration");

  // WhatsApp callback codes are internal and their details carry English or
  // Meta text, so neither is shown; unknown codes get the generic message.
  const whatsappSignupNotConfirmed = {
    title: t("errors.signup_not_confirmed.title"),
    message: t("errors.signup_not_confirmed.message"),
  };
  const channelLimit = {
    title: t("errors.channel_limit.title"),
    message: t("errors.channel_limit.message"),
  };
  const whatsappNoWaba = {
    title: t("errors.no_waba_found.title"),
    message: t("errors.no_waba_found.message"),
    action: t("errors.no_waba_found.action"),
  };
  const whatsappErrorMessages: Record<
    string,
    { title: string; message: string; action?: string }
  > = {
    oauth_failed: {
      title: t("errors.oauth_failed.title"),
      message: t("errors.oauth_failed.message"),
      action:
        errorDetails?.includes("inactive") ||
        errorDetails?.includes("not active")
          ? t("errors.oauth_failed.action")
          : undefined,
    },
    no_business_found: {
      title: t("errors.no_business_found.title"),
      message: t("errors.no_business_found.message"),
      action: t("errors.no_business_found.action"),
    },
    business_fetch_failed: {
      title: t("errors.business_fetch_failed.title"),
      message: t("errors.business_fetch_failed.message"),
      action: t("errors.business_fetch_failed.action"),
    },
    no_waba_found: whatsappNoWaba,
    waba_not_found: whatsappNoWaba,
    missing_phone: {
      title: t("errors.missing_phone.title"),
      message: t("errors.missing_phone.message"),
      action: t("errors.missing_phone.action"),
    },
    waba_fetch_failed: {
      title: t("errors.waba_fetch_failed.title"),
      message: t("errors.waba_fetch_failed.message"),
    },
    whatsapp_number_not_eligible: {
      title: t("errors.whatsapp_number_not_eligible.title"),
      message: t("errors.whatsapp_number_not_eligible.message"),
      action: t("errors.whatsapp_number_not_eligible.action"),
    },
    missing_code: {
      title: t("errors.signup_incomplete.title"),
      message: t("errors.signup_incomplete.message"),
    },
    // The code exchange or token check failed after the Meta window closed.
    token_expired: whatsappSignupNotConfirmed,
    token_invalid: whatsappSignupNotConfirmed,
    token_revoked: {
      title: t("errors.access_revoked.title"),
      message: t("errors.access_revoked.message"),
    },
    permissions_error: {
      title: t("errors.permissions_error.title"),
      message: t("errors.permissions_error.message"),
    },
    business_verification_required: {
      title: t("errors.business_verification_required.title"),
      message: t("errors.business_verification_required.message"),
    },
    phone_already_connected: {
      title: t("errors.phone_already_connected.title"),
      message: t("errors.phone_already_connected.message"),
    },
    company_channel_limit_exceeded: channelLimit,
    whatsapp_flow_source_rebind_blocked: {
      title: t("errors.flow_rebind_blocked.title"),
      message: t("errors.flow_rebind_blocked.message"),
    },
    connection_check_needed: {
      title: t("errors.connection_check_needed.title"),
      message: t("errors.connection_check_needed.message"),
    },
    legacy_oauth_removed: {
      title: t("errors.legacy_oauth_removed.title"),
      message: t("errors.legacy_oauth_removed.message"),
    },
  };

  const instagramErrorMessages: Record<
    string,
    { title: string; message: string; action?: string }
  > = {
    invalid_state: {
      title: tInstagram("errors.invalid_state.title"),
      message: tInstagram("errors.invalid_state.message"),
    },
    oauth_failed: {
      title: tInstagram("errors.oauth_failed.title"),
      message: errorDetails
        ? tInstagram("errors.oauth_failed.messageWithDetails", {
            details: errorDetails,
          })
        : tInstagram("errors.oauth_failed.message"),
    },
    no_instagram_account: {
      title: tInstagram("errors.no_instagram_account.title"),
      message: tInstagram("errors.no_instagram_account.message"),
    },
    token_exchange_failed: {
      title: tInstagram("errors.token_exchange_failed.title"),
      message: errorDetails
        ? tInstagram("errors.token_exchange_failed.messageWithDetails", {
            details: errorDetails,
          })
        : tInstagram("errors.token_exchange_failed.message"),
    },
    save_failed: {
      title: tInstagram("errors.save_failed.title"),
      message: tInstagram("errors.save_failed.message"),
    },
    missing_access_token: {
      title: tInstagram("errors.missing_access_token.title"),
      message: tInstagram("errors.missing_access_token.message"),
    },
    facebook_login_failed: {
      title: tInstagram("errors.facebook_login_failed.title"),
      message: errorDetails
        ? tInstagram("errors.facebook_login_failed.messageWithDetails", {
            details: errorDetails,
          })
        : tInstagram("errors.facebook_login_failed.message"),
    },
    company_channel_limit_exceeded: channelLimit,
    server_not_configured: {
      title: tInstagram("errors.server_not_configured.title"),
      message: errorDetails
        ? tInstagram("errors.server_not_configured.messageWithDetails", {
            details: errorDetails,
          })
        : tInstagram("errors.server_not_configured.message"),
    },
  };

  const canvaErrorMessages: Record<
    string,
    { title: string; message: string; action?: string }
  > = {
    oauth_failed: {
      title: tCanva("errors.oauth_failed.title"),
      message: tCanva("errors.oauth_failed.message"),
    },
    unauthorized: {
      title: tCanva("errors.unauthorized.title"),
      message: tCanva("errors.unauthorized.message"),
    },
    forbidden: {
      title: tCanva("errors.forbidden.title"),
      message: tCanva("errors.forbidden.message"),
    },
    token_exchange_failed: {
      title: tCanva("errors.token_exchange_failed.title"),
      message: errorDetails
        ? `${tCanva("errors.token_exchange_failed.message")} ${errorDetails}`
        : tCanva("errors.token_exchange_failed.message"),
    },
    workspace_missing: {
      title: tCanva("errors.workspace_missing.title"),
      message: tCanva("errors.workspace_missing.message"),
    },
    save_failed: {
      title: tCanva("errors.save_failed.title"),
      message: tCanva("errors.save_failed.message"),
    },
  };

  const googleCalendarErrorMessages: Record<
    string,
    { title: string; message: string; action?: string }
  > = {
    oauth_failed: {
      title: tCalendar("errors.oauth_failed.title"),
      message: tCalendar("errors.oauth_failed.message"),
    },
    unauthorized: {
      title: tCalendar("errors.unauthorized.title"),
      message: tCalendar("errors.unauthorized.message"),
    },
    forbidden: {
      title: tCalendar("errors.forbidden.title"),
      message: tCalendar("errors.forbidden.message"),
    },
    token_exchange_failed: {
      title: tCalendar("errors.token_exchange_failed.title"),
      message: errorDetails
        ? `${tCalendar("errors.token_exchange_failed.message")} ${errorDetails}`
        : tCalendar("errors.token_exchange_failed.message"),
    },
    workspace_missing: {
      title: tCalendar("errors.workspace_missing.title"),
      message: tCalendar("errors.workspace_missing.message"),
    },
    save_failed: {
      title: tCalendar("errors.save_failed.title"),
      message: tCalendar("errors.save_failed.message"),
    },
  };

  const metaAdsErrorMessages: Record<
    string,
    { title: string; message: string; action?: string }
  > = {
    oauth_failed: {
      title: tMetaAds("errors.oauth_failed.title"),
      message: tMetaAds("errors.oauth_failed.message"),
    },
    mcp_oauth_failed: {
      title: tMetaAds("errors.mcp_oauth_failed.title"),
      message: tMetaAds("errors.mcp_oauth_failed.message"),
    },
    ads_permissions_missing: {
      title: tMetaAds("errors.ads_permissions_missing.title"),
      message: tMetaAds("errors.ads_permissions_missing.message"),
    },
    token_verification_failed: {
      title: tMetaAds("errors.token_verification_failed.title"),
      message: tMetaAds("errors.token_verification_failed.message"),
    },
    ad_accounts_unavailable: {
      title: tMetaAds("errors.ad_accounts_unavailable.title"),
      message: tMetaAds("errors.ad_accounts_unavailable.message"),
    },
    no_ad_accounts: {
      title: tMetaAds("errors.no_ad_accounts.title"),
      message: tMetaAds("errors.no_ad_accounts.message"),
    },
    server_not_configured: {
      title: tMetaAds("errors.server_not_configured.title"),
      message: tMetaAds("errors.server_not_configured.message"),
    },
    unauthorized: {
      title: tMetaAds("errors.unauthorized.title"),
      message: tMetaAds("errors.unauthorized.message"),
    },
    forbidden: {
      title: tMetaAds("errors.forbidden.title"),
      message: tMetaAds("errors.forbidden.message"),
    },
    token_exchange_failed: {
      title: tMetaAds("errors.token_exchange_failed.title"),
      message: tMetaAds("errors.token_exchange_failed.message"),
    },
    mcp_token_exchange_failed: {
      title: tMetaAds("errors.mcp_token_exchange_failed.title"),
      message: tMetaAds("errors.mcp_token_exchange_failed.message"),
    },
    ad_accounts_failed: {
      title: tMetaAds("errors.ad_accounts_failed.title"),
      message: tMetaAds("errors.ad_accounts_failed.message"),
    },
    workspace_missing: {
      title: tMetaAds("errors.workspace_missing.title"),
      message: tMetaAds("errors.workspace_missing.message"),
    },
    save_failed: {
      title: tMetaAds("errors.save_failed.title"),
      message: tMetaAds("errors.save_failed.message"),
    },
    mcp_save_failed: {
      title: tMetaAds("errors.mcp_save_failed.title"),
      message: tMetaAds("errors.mcp_save_failed.message"),
    },
    mcp_source_missing: {
      title: tMetaAds("errors.mcp_source_missing.title"),
      message: tMetaAds("errors.mcp_source_missing.message"),
    },
  };

  const errorMessages =
    integrationId === "google_calendar"
      ? googleCalendarErrorMessages
      : integrationId === "meta_ads"
        ? metaAdsErrorMessages
        : integrationId === "canva"
          ? canvaErrorMessages
          : integrationId === "instagram"
            ? instagramErrorMessages
            : whatsappErrorMessages;
  const errorInfo =
    errorMessages[error] ||
    (integrationId === "google_calendar"
      ? {
          title: tCalendar("errors.connection_error.title"),
          message: errorDetails || tCalendar("errors.connection_error.message"),
        }
      : integrationId === "meta_ads"
        ? {
            title: tMetaAds("errors.connection_error.title"),
            message: tMetaAds("errors.connection_error.message"),
          }
        : integrationId === "canva"
          ? {
              title: tCanva("errors.connection_error.title"),
              message:
                errorDetails || tCanva("errors.connection_error.message"),
            }
          : integrationId === "instagram"
            ? {
                title: tInstagram("errors.connection_error.title"),
                message: errorDetails
                  ? tInstagram("errors.connection_error.messageWithDetails", {
                      details: errorDetails,
                    })
                  : tInstagram("errors.connection_error.message"),
              }
            : {
                title: t("errors.connection_error.title"),
                message: t("errors.connection_error.message"),
              });

  return (
    <div className="space-y-2 rounded-xl bg-destructive/10 p-4">
      <p className="text-sm font-semibold text-destructive">
        {errorInfo.title}
      </p>
      <p className="text-sm text-destructive">{errorInfo.message}</p>
      {errorInfo.action && (
        <p className="text-xs text-destructive/80">{errorInfo.action}</p>
      )}
    </div>
  );
}

function WarningBanner({
  integrationId,
  warning,
  warningDetails,
}: {
  integrationId: "instagram";
  warning: string;
  warningDetails: string | null;
}) {
  const tInstagram = useTranslations("InstagramIntegration");

  const warningInfo =
    integrationId === "instagram" && warning === "webhook_subscription_failed"
      ? {
          title: tInstagram("warnings.webhook_subscription_failed.title"),
          message:
            warningDetails ||
            tInstagram("warnings.webhook_subscription_failed.message"),
          action: tInstagram("warnings.webhook_subscription_failed.action"),
        }
      : {
          title: tInstagram("warnings.generic.title"),
          message: warningDetails
            ? tInstagram("warnings.generic.message", {
                details: warningDetails,
              })
            : warning,
        };

  return (
    <div className="space-y-2 rounded-xl bg-amber-50 p-4 dark:bg-amber-950/20">
      <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
        {warningInfo.title}
      </p>
      <p className="text-sm text-amber-700 dark:text-amber-200">
        {warningInfo.message}
      </p>
      {warningInfo.action && (
        <p className="text-xs text-amber-700/90 dark:text-amber-300/90">
          {warningInfo.action}
        </p>
      )}
    </div>
  );
}
