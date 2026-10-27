"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { IntegrationsPresentation } from "@/components/integrations/integration-presentation";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { formatMessagingLimitTier } from "@/components/messengers/messaging-limit";
import { cn } from "@/lib/utils";
import { isWhatsAppBusinessAppConnection } from "@/lib/whatsapp/connection-repair-mode";
import {
  getWhatsAppAccountHealthStatusKey,
  getWhatsAppMetaRefreshFeedback,
  humanizeWhatsAppStatus,
} from "@/lib/whatsapp/status-format";
import { readWhatsAppAccountHealth } from "@/lib/whatsapp/account/health";
import type { WhatsAppMetaRefreshResponse } from "@/lib/whatsapp/meta-read-policy";
import { isWhatsAppPhoneNumberRegistered } from "@icecore/shared/lib/whatsapp/phone-details";
import type { Source, WhatsAppCredentialFields } from "@/types/supabase";
import { isWhatsAppSource } from "@/types/supabase";
import {
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type SupportedGuideIntegration = "telegram" | "whatsapp" | "instagram";

type GuideStep = {
  title: string;
  description: string;
};

type GuideCopy = {
  badge: string;
  title: string;
  description: string;
  primaryAction: string;
  secondaryAction: string;
  tipsTitle: string;
  steps: GuideStep[];
  tips: string[];
  nextSteps?: WhatsAppNextStepsCopy;
};

type WhatsAppNextStepsCopy = {
  title: string;
  description: string;
  modes: Record<WhatsAppConnectionMode, WhatsAppModeCopy>;
  status: WhatsAppStatusCopy;
};

type WhatsAppConnectionMode = "coexistence" | "cloud_api";

type WhatsAppModeCopy = {
  label: string;
  title: string;
  description: string;
  steps: GuideStep[];
  limitationsTitle?: string;
  limitations?: string[];
};

type WhatsAppStatusCopy = {
  trigger: string;
  loading: string;
  error: string;
  refresh: string;
  unknown: string;
  yes: string;
  no: string;
  webhookReady: string;
  webhookMissing: string;
  fields: {
    phone: string;
    verifiedName: string;
    displayName: string;
    phoneRegistration: string;
    twoStepPin: string;
    quality: string;
    messagingLimit: string;
    accountReview: string;
    businessVerification: string;
    webhooks: string;
  };
};

type WhatsAppBusinessStatus = Partial<WhatsAppCredentialFields> & {
  account_review_status?: string;
  business_verification_status?: string;
  two_step_pin_enabled?: boolean;
};

type WhatsAppStatusResponse = {
  connected: boolean;
  status: WhatsAppBusinessStatus | null;
  error?: string;
  meta_refresh?: WhatsAppMetaRefreshResponse;
};

const GUIDE_LINKS: Record<SupportedGuideIntegration, string> = {
  telegram: "https://t.me/BotFather",
  whatsapp: "https://business.facebook.com",
  instagram:
    "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram",
};

export function IntegrationSetupGuide({
  integrationId,
  workspaceId,
  secondaryActionHref,
  source,
  presentation = "default",
}: {
  integrationId: string;
  workspaceId: string;
  secondaryActionHref?: string;
  source?: Source;
  presentation?: IntegrationsPresentation;
}) {
  if (
    integrationId !== "telegram" &&
    integrationId !== "whatsapp" &&
    integrationId !== "instagram"
  ) {
    return null;
  }

  return (
    <GuideContent
      integrationId={integrationId}
      workspaceId={workspaceId}
      secondaryActionHref={secondaryActionHref}
      source={source}
      presentation={presentation}
    />
  );
}

function GuideContent({
  integrationId,
  workspaceId,
  secondaryActionHref,
  source,
  presentation,
}: {
  integrationId: SupportedGuideIntegration;
  workspaceId: string;
  secondaryActionHref?: string;
  source?: Source;
  presentation: IntegrationsPresentation;
}) {
  const t = useTranslations("IntegrationDetails");
  const guide = t.raw(`guides.${integrationId}`) as GuideCopy;
  const secondaryHref =
    secondaryActionHref ?? panelWorkspaceHref(workspaceId, "requests");

  if (presentation === "landingCompact") {
    return (
      <section id="integration-guide" className="flex flex-wrap gap-2">
        <a
          href={GUIDE_LINKS[integrationId]}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center justify-center gap-1 rounded-full bg-white/75 px-3 text-xs font-black text-slate-950 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#075e54]/25"
        >
          {guide.primaryAction}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </section>
    );
  }

  if (
    integrationId === "whatsapp" &&
    source &&
    isWhatsAppSource(source) &&
    guide.nextSteps
  ) {
    return (
      <WhatsAppConnectedNextSteps
        key={JSON.stringify([
          workspaceId,
          source.id,
          source.credentials.phone_number_id,
          source.credentials.waba_id,
        ])}
        guide={guide.nextSteps}
        credentials={source.credentials}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <section id="integration-guide" className="flex flex-col gap-4">
      <Item variant="muted">
        <ItemContent>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{guide.badge}</Badge>
            <ItemTitle>{guide.title}</ItemTitle>
          </div>
          <ItemDescription className="line-clamp-none">
            {guide.description}
          </ItemDescription>
        </ItemContent>
        <ItemFooter className="flex-wrap justify-start">
          <Button asChild variant="secondary" size="sm">
            <a
              href={GUIDE_LINKS[integrationId]}
              target="_blank"
              rel="noopener noreferrer"
            >
              {guide.primaryAction}
              <ExternalLink data-icon="inline-end" />
            </a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={secondaryHref}>{guide.secondaryAction}</Link>
          </Button>
        </ItemFooter>
      </Item>

      <GuideStepList steps={guide.steps} />

      {integrationId !== "whatsapp" && guide.tips.length > 0 ? (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{guide.tipsTitle}</ItemTitle>
            <ul className="flex flex-col gap-2 pl-4 text-sm text-muted-foreground">
              {guide.tips.map(tip => (
                <li key={tip} className="list-disc">
                  {tip}
                </li>
              ))}
            </ul>
          </ItemContent>
        </Item>
      ) : null}
    </section>
  );
}

function WhatsAppConnectedNextSteps({
  guide,
  credentials,
  workspaceId,
}: {
  guide: WhatsAppNextStepsCopy;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) {
  const t = useTranslations("WhatsAppIntegrationForm");
  const mode: WhatsAppConnectionMode = isWhatsAppBusinessAppConnection(
    credentials
  )
    ? "coexistence"
    : "cloud_api";
  const modeCopy = guide.modes[mode];
  const [statusOpen, setStatusOpen] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [statusState, setStatusState] = useState<{
    data: WhatsAppStatusResponse | null;
    loading: boolean;
    error: string | null;
  }>({
    data: null,
    loading: false,
    error: null,
  });

  const loadStatus = useCallback(
    async (refresh = false) => {
      setStatusState(current => ({ ...current, loading: true, error: null }));

      try {
        const res = await fetch(
          `/api/whatsapp/onboarding?workspaceId=${encodeURIComponent(
            workspaceId
          )}${refresh ? "&refresh=1" : ""}`
        );
        const payload = (await res
          .json()
          .catch(() => null)) as WhatsAppStatusResponse | null;

        if (
          typeof payload?.connected !== "boolean" ||
          (payload.status !== null &&
            (!payload.status ||
              typeof payload.status !== "object" ||
              Array.isArray(payload.status)))
        ) {
          throw new Error(payload?.error || guide.status.error);
        }

        const feedback = getWhatsAppMetaRefreshFeedback(
          payload.meta_refresh?.outcome
        );
        const failed =
          feedback?.level === "error" ||
          ((feedback?.level ?? "success") === "success" &&
            (!res.ok || Boolean(payload.error)));
        setStatusState({
          data: payload,
          loading: false,
          error: failed ? payload.error || guide.status.error : null,
        });
      } catch (error) {
        setStatusState(current => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : guide.status.error,
        }));
      }
    },
    [guide.status.error, workspaceId]
  );

  useEffect(() => {
    if (
      !statusOpen ||
      statusState.data ||
      statusState.loading ||
      statusState.error
    )
      return;

    void loadStatus();
  }, [
    loadStatus,
    statusOpen,
    statusState.data,
    statusState.loading,
    statusState.error,
  ]);

  const cooldownUntil = statusState.data?.meta_refresh?.cooldown_until;
  useEffect(() => {
    const remaining = cooldownUntil
      ? new Date(cooldownUntil).getTime() - Date.now()
      : 0;
    setIsCoolingDown(remaining > 0);
    if (!(remaining > 0)) return;
    const timer = setTimeout(
      () => setIsCoolingDown(false),
      Math.min(remaining, 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [cooldownUntil]);

  const refreshFeedback = getWhatsAppMetaRefreshFeedback(
    statusState.data?.meta_refresh?.outcome
  );
  const refreshNotice =
    refreshFeedback?.level === "info" || refreshFeedback?.level === "warning"
      ? t(refreshFeedback.messageKey)
      : null;
  const accountHealth = readWhatsAppAccountHealth(
    statusState.data?.status?.account_health
  );
  const statusLabel = t(
    getWhatsAppAccountHealthStatusKey(
      statusState.data?.connected === false
        ? "disconnected"
        : accountHealth?.state || "unknown"
    )
  );

  const statusRows =
    statusState.data?.connected && statusState.data.status
      ? buildWhatsAppStatusRows(
          statusState.data.status,
          credentials,
          guide.status
        )
      : [];
  const showStatusLoading =
    statusState.loading ||
    (statusOpen && !statusState.data && !statusState.error);

  const LimitationsIcon = mode === "coexistence" ? CircleAlert : Info;

  return (
    <section id="integration-guide" className="flex flex-col gap-4">
      <Item variant="muted">
        <ItemContent>
          <div className="flex flex-wrap items-center gap-2">
            <ItemTitle>{guide.title}</ItemTitle>
            <Badge variant="outline">{modeCopy.label}</Badge>
          </div>
          <ItemDescription className="line-clamp-none">
            {guide.description}
          </ItemDescription>
        </ItemContent>
      </Item>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">
            {modeCopy.title}
          </h3>
          <p className="text-sm text-muted-foreground">
            {modeCopy.description}
          </p>
        </div>

        <GuideStepList steps={modeCopy.steps} />

        {modeCopy.limitations?.length ? (
          <Alert>
            <LimitationsIcon />
            <AlertTitle className="line-clamp-none text-pretty">
              {modeCopy.limitationsTitle}
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {modeCopy.limitations.map(item => (
                  <Badge
                    key={item}
                    variant="secondary"
                    className="max-w-full whitespace-normal text-left"
                  >
                    {item}
                  </Badge>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <Item variant="outline" className="flex-col items-stretch">
        <Collapsible
          className="w-full"
          open={statusOpen}
          onOpenChange={setStatusOpen}
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between px-0 text-left"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {guide.status.trigger}
                </span>
                {statusOpen ? (
                  <span className="whitespace-normal break-words text-xs text-muted-foreground">
                    {statusState.loading
                      ? guide.status.loading
                      : statusState.error
                        ? statusState.error
                        : statusState.data
                          ? statusLabel
                          : guide.status.unknown}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                data-icon="inline-end"
                className={cn(statusOpen && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            {showStatusLoading ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {guide.status.loading}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} className="h-14 rounded-xl" />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {statusState.error ? (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle className="line-clamp-none">
                      {statusState.error}
                    </AlertTitle>
                  </Alert>
                ) : null}
                {refreshNotice ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {refreshNotice}
                  </p>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  {statusRows.map(row => (
                    <Item key={row.label} size="xs" variant="muted">
                      <ItemContent className="min-w-0">
                        <ItemDescription>{row.label}</ItemDescription>
                        <ItemTitle className="line-clamp-none break-words">
                          {row.value}
                        </ItemTitle>
                      </ItemContent>
                    </Item>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={statusState.loading || isCoolingDown}
                  onClick={() => void loadStatus(true)}
                >
                  <RefreshCw data-icon="inline-start" />
                  {guide.status.refresh}
                </Button>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </Item>
    </section>
  );
}

function GuideStepList({ steps }: { steps: GuideStep[] }) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <ItemGroup className="gap-0 overflow-hidden rounded-2xl bg-muted/20">
      {steps.map((step, index) => (
        <Item
          key={step.title}
          role="listitem"
          className="items-start rounded-none border-x-0 border-t-0 border-border last:border-b-0"
        >
          <ItemMedia>
            <span className="flex size-7 items-center justify-center rounded-full bg-background text-xs font-medium text-muted-foreground">
              {index + 1}
            </span>
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="line-clamp-none">{step.title}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {step.description}
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

function buildWhatsAppStatusRows(
  apiStatus: WhatsAppBusinessStatus | null,
  credentials: WhatsAppCredentialFields,
  copy: WhatsAppStatusCopy
) {
  const status: WhatsAppBusinessStatus = {
    ...credentials,
    ...(apiStatus ?? {}),
  };
  const missingWebhookCount = status.webhook_missing_required_fields?.length;
  const webhookNeedsRepair =
    status.webhook_requires_reconnect === true ||
    Boolean(status.webhook_error || status.phone_webhook_error) ||
    status.waba_selected_app_matches_config === false ||
    status.token_app_id_matches_config === false;
  const messagingLimit =
    status.whatsapp_business_manager_messaging_limit ||
    status.phone_messaging_limit;

  return [
    {
      label: copy.fields.phone,
      value: status.display_phone_number || copy.unknown,
    },
    {
      label: copy.fields.verifiedName,
      value: status.verified_name || copy.unknown,
    },
    {
      label: copy.fields.displayName,
      value: humanizeWhatsAppStatus(status.name_status, copy.unknown),
    },
    {
      label: copy.fields.phoneRegistration,
      value:
        status.phone_registered === false
          ? copy.no
          : isWhatsAppPhoneNumberRegistered(
                {
                  is_on_biz_app: status.is_on_biz_app,
                  platform_type: status.platform_type,
                },
                status
              )
            ? copy.yes
            : humanizeWhatsAppStatus(
                status.phone_registration_status,
                copy.unknown
              ),
    },
    {
      label: copy.fields.twoStepPin,
      value:
        status.two_step_pin_enabled === true
          ? copy.yes
          : status.two_step_pin_enabled === false
            ? copy.no
            : copy.unknown,
    },
    {
      label: copy.fields.quality,
      value: humanizeWhatsAppStatus(status.quality_rating, copy.unknown),
    },
    {
      label: copy.fields.messagingLimit,
      value: messagingLimit
        ? formatMessagingLimitTier(messagingLimit)
        : copy.unknown,
    },
    {
      label: copy.fields.accountReview,
      value: humanizeWhatsAppStatus(status.account_review_status, copy.unknown),
    },
    {
      label: copy.fields.businessVerification,
      value: humanizeWhatsAppStatus(
        status.business_verification_status,
        copy.unknown
      ),
    },
    {
      label: copy.fields.webhooks,
      value: webhookNeedsRepair
        ? copy.no
        : missingWebhookCount !== undefined && missingWebhookCount > 0
          ? interpolate(copy.webhookMissing, { count: missingWebhookCount })
          : missingWebhookCount === 0 &&
              status.webhook_fields_last_checked_at &&
              status.waba_selected_app_matches_config === true
            ? copy.webhookReady
            : copy.unknown,
    },
  ];
}

function interpolate(
  template: string,
  values: Record<string, string | number>
) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    template
  );
}
