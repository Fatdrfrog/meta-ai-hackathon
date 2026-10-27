"use client";

import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { EmbeddedSignupButton } from "@/components/integrations/embedded-signup-button";
import { WhatsAppConversionsSettings } from "@/components/integrations/whatsapp-conversions-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { useIntegrations } from "@/hooks/use-integrations";
import {
  evaluateChannelCapacity,
  type ChannelCapacityBlockReason,
} from "@/lib/limits/channel-capacity";
import { cn } from "@/lib/utils";
import { isRemovedWhatsAppSource } from "@icecore/shared/lib/whatsapp/source-state";
import {
  getBusinessPrefillData,
  type BusinessPrefillData,
} from "@/lib/whatsapp/prefill-helper";
import {
  getWhatsAppReconnectDefaultTab,
  isWhatsAppBusinessAppConnection,
  withoutPartnerRemovalOverrides,
} from "@/lib/whatsapp/connection-repair-mode";
import { isMarketingMessagesApiOnboarded } from "@/lib/whatsapp/marketing/messages-onboarding";
import { getWhatsAppConnectionMaintenanceStatus } from "@/lib/whatsapp/token-lifecycle";
import { Source, isWhatsAppSource } from "@/types/supabase";
import {
  AlertTriangle,
  BookOpen,
  Cloud,
  ExternalLink,
  FileText,
  Loader2,
  Megaphone,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

type ConnectionChoice = "coexistence" | "cloud_api" | null;

const EmbeddedSignupWithQR = dynamic(
  () =>
    import("@/components/integrations/embedded-signup-with-qr").then(
      module => module.EmbeddedSignupWithQR
    ),
  {
    loading: () => <IntegrationBranchFallback />,
  }
);

const WhatsAppIntegrationForm = dynamic(
  () =>
    import("@/components/integrations/whatsapp-integration-form").then(
      module => module.WhatsAppIntegrationForm
    ),
  {
    loading: () => <IntegrationBranchFallback />,
  }
);

interface AccessVerifyState {
  loading: boolean;
  verified: boolean | null;
  message?: string;
  guidance?: string;
}

// A source connected this recently is still in its first-send stretch, so
// the panel points at templates and Bulk campaigns.
const NEXT_STEP_CARD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const META_DOC_LINKS = {
  cloudApi: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  embeddedSignup:
    "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4",
  coexistence:
    "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
  coexistenceReconnect:
    "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients",
  catalog:
    "https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services",
  marketing:
    "https://developers.facebook.com/docs/whatsapp/marketing-messages-api-for-whatsapp",
} as const;

export const WhatsAppIntegration = ({
  source,
  workspaceId,
  connectionActionsDisabled = false,
}: {
  source?: Source;
  workspaceId: string;
  connectionActionsDisabled?: boolean;
}) => {
  const t = useTranslations("WhatsAppIntegration");
  const searchParams = useSearchParams();
  const { hasCompanyWhatsAppInventory, removedWhatsAppSource } =
    useIntegrations(workspaceId);
  const [choice, setChoice] = useState<ConnectionChoice>(() =>
    getConnectionChoiceFromSearchParams(searchParams)
  );
  const [prefill, setPrefill] = useState<BusinessPrefillData>({});
  const [verifyState, setVerifyState] = useState<AccessVerifyState>({
    loading: !connectionActionsDisabled,
    verified: null,
  });
  const [showRepairOptions, setShowRepairOptions] = useState(
    () => searchParams?.get("reconnect") === "1"
  );
  const reconnectRequested = searchParams?.get("reconnect") === "1";
  const [lastReconnectRequest, setLastReconnectRequest] =
    useState(reconnectRequested);
  const [referenceTime] = useState(() => Date.now());
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Banner navigation can update this URL without remounting the panel.
  if (reconnectRequested !== lastReconnectRequest) {
    setLastReconnectRequest(reconnectRequested);
    if (reconnectRequested) setShowRepairOptions(true);
  }

  // The integrations list leaves out partner-removed sources, so fall back to
  // the removed one to show the reconnect panel instead of a fresh connect.
  const whatsappSource =
    source && isWhatsAppSource(source)
      ? source
      : removedWhatsAppSource && isWhatsAppSource(removedWhatsAppSource)
        ? removedWhatsAppSource
        : null;
  const connected = Boolean(whatsappSource);
  const showExistingInventory =
    !connected && hasCompanyWhatsAppInventory && !connectionActionsDisabled;
  const connectionMaintenance = getWhatsAppConnectionMaintenanceStatus(
    whatsappSource?.credentials ?? {},
    referenceTime
  );
  const isRemoved = isRemovedWhatsAppSource(whatsappSource);
  // Only a brand-new connection is limited by the plan; reconnect and repair
  // reuse the existing source and are never blocked here.
  const { data: companyLimits } = useCompanyLimits(
    connected || connectionActionsDisabled ? null : workspaceId
  );
  const capacity = companyLimits
    ? evaluateChannelCapacity(companyLimits, "whatsapp")
    : null;
  const capacityBlockReason: ChannelCapacityBlockReason | null =
    capacity && !capacity.allowed ? capacity.reason : null;
  const needsReconnection =
    connected &&
    (isRemoved ||
      connectionMaintenance.state === "action_required" ||
      connectionMaintenance.state === "expired");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const shouldLoadPrefill =
      !connectionActionsDisabled &&
      (!connected || needsReconnection || showRepairOptions);

    if (shouldLoadPrefill) {
      getBusinessPrefillData(workspaceId)
        .then(data => {
          if (!cancelled) setPrefill(data);
        })
        .catch(() => {
          if (!cancelled) setPrefill({});
        });
    }

    if (!connected && !connectionActionsDisabled) {
      fetch("/api/whatsapp/verify-access", { signal: controller.signal })
        .then(async res => {
          if (cancelled) return;
          if (!res.ok) {
            // The route only fails on transient Meta errors or missing app
            // config. Neither is an App Review block, so signup stays open.
            console.warn("WhatsApp access check unavailable", {
              status: res.status,
            });
            setVerifyState({ loading: false, verified: null });
            return;
          }
          const data = (await res.json()) as {
            verified: boolean;
            message?: string;
            guidance?: string;
          };
          setVerifyState({
            loading: false,
            verified: data.verified,
            message: data.message,
            guidance: data.guidance,
          });
        })
        .catch(error => {
          if (cancelled || error?.name === "AbortError") return;
          setVerifyState({
            loading: false,
            verified: null,
            message: t("accessVerify.checkFailed"),
          });
        });
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    workspaceId,
    connected,
    needsReconnection,
    showRepairOptions,
    t,
    connectionActionsDisabled,
  ]);

  if (!whatsappSource) {
    if (capacityBlockReason) {
      return (
        <div className="flex flex-col gap-5">
          <Alert>
            <AlertTriangle />
            <AlertTitle className="line-clamp-none break-words">
              {t("capacity.title")}
            </AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>
                {t(`capacity.reasons.${capacityBlockReason}`, {
                  limit: companyLimits?.whatsappNumberLimit ?? 1,
                })}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => setUpgradeOpen(true)}
              >
                {t("capacity.upgrade")}
              </Button>
            </AlertDescription>
          </Alert>
          <PlanUpgradeDialog
            workspaceId={workspaceId}
            subscriptionType={companyLimits?.subscriptionType}
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            reason={
              capacityBlockReason === "trial_expired"
                ? "trial_expired"
                : "feature_limit"
            }
            featureLabel={t("capacity.featureLabel")}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-5">
        {verifyState.verified === false ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{t("accessVerify.blockedTitle")}</AlertTitle>
            <AlertDescription>
              <p>{verifyState.message || t("accessVerify.blockedBody")}</p>
              {verifyState.guidance ? <p>{verifyState.guidance}</p> : null}
            </AlertDescription>
          </Alert>
        ) : verifyState.guidance ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{t("accessVerify.guidanceTitle")}</AlertTitle>
            <AlertDescription>
              <p>{verifyState.guidance}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <ConnectionChoiceCards
          t={t}
          value={choice}
          loading={verifyState.loading}
          onValueChange={setChoice}
        />

        {showExistingInventory ? (
          <Item asChild variant="outline">
            <Link
              href={`/panel/w/${workspaceId}/settings/integrations/whatsapp/select?source=existing`}
              aria-label={t("existingInventory.button")}
            >
              <ItemMedia variant="icon">
                <Smartphone />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("existingInventory.title")}</ItemTitle>
                <ItemDescription>
                  {t("existingInventory.description")}
                </ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        ) : null}

        {choice === "coexistence" ? (
          <EmbeddedSignupWithQR
            workspaceId={workspaceId}
            businessName={prefill.businessName}
            businessEmail={prefill.businessEmail}
            businessPhone={prefill.businessPhone}
            disabled={connectionActionsDisabled}
          />
        ) : null}

        {choice === "cloud_api" ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <Cloud />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("cloudApi.title")}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {t("cloudApi.footer")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <EmbeddedSignupButton
                label={t("cloudApi.button")}
                workspaceId={workspaceId}
                flow="cloud_api"
                businessName={prefill.businessName}
                businessEmail={prefill.businessEmail}
                businessPhone={prefill.businessPhone}
                allowBusinessAppMigration={false}
                disabled={connectionActionsDisabled}
              />
            </ItemActions>
          </Item>
        ) : null}
      </div>
    );
  }

  // The summary badge, reconnect tab and settings rows all read the
  // connection-type flags, so they share one view of a removed source.
  const creds = isRemoved
    ? withoutPartnerRemovalOverrides(whatsappSource.credentials)
    : whatsappSource.credentials;
  const conversionSettings = (
    <WhatsAppConversionsSettings
      workspaceId={workspaceId}
      sourceId={whatsappSource.id}
      disabled={connectionActionsDisabled}
    />
  );
  const defaultReconnectTab = getWhatsAppReconnectDefaultTab(creds);
  const connectionMode = isWhatsAppBusinessAppConnection(creds)
    ? "coexistence"
    : "cloud_api";
  const coexistenceReonboardingStatus =
    typeof creds.coexistence_reonboarding_status === "string"
      ? creds.coexistence_reonboarding_status
      : null;
  const isCoexistenceReonboardingPaused =
    !isRemoved &&
    (creds.cloud_api_messaging_suspended === true ||
      coexistenceReonboardingStatus === "offboarded");
  const catalogIds = creds.catalog_ids || creds.catalogIds || [];
  const qualityRating = creds.quality_rating || null;
  const connectedPhone = creds.display_phone_number || creds.phone_number_id;
  const marketingCampaignsReady = isMarketingMessagesApiOnboarded(creds);
  const ConnectionModeIcon =
    connectionMode === "coexistence" ? Smartphone : Cloud;

  if (isCoexistenceReonboardingPaused) {
    return (
      <div className="flex flex-col gap-4">
        <CoexistenceReonboardingPanel t={t} />
        <WhatsAppIntegrationForm
          credentialsProps={creds}
          workspaceId={workspaceId}
        />
        {conversionSettings}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {needsReconnection ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("whatsAppReconnectTitle")}</AlertTitle>
          <AlertDescription>{t("whatsAppReconnectPrompt")}</AlertDescription>
        </Alert>
      ) : null}
      <section aria-label={t("connectedSummaryLabel")}>
        <Item variant="muted" className="items-start">
          <ItemMedia variant="icon">
            <ConnectionModeIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{connectedPhone || t("tabs.embedded")}</ItemTitle>
            {!needsReconnection &&
            connectionMaintenance.state === "maintaining" ? (
              <ItemDescription className="line-clamp-none">
                {t("connectionManaged")}
              </ItemDescription>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">
                {connectionMode === "coexistence"
                  ? t("tabs.qr")
                  : t("tabs.embedded")}
              </Badge>
              {qualityRating ? (
                <Badge variant="outline">
                  {t("summary.quality", { quality: qualityRating })}
                </Badge>
              ) : null}
              {catalogIds.length > 0 ? (
                <Badge variant="outline">{t("summary.catalog")}</Badge>
              ) : null}
              {marketingCampaignsReady ? (
                <Badge variant="outline">{t("summary.marketingReady")}</Badge>
              ) : null}
            </div>
          </ItemContent>
          <ItemActions className="w-full flex-wrap sm:w-auto">
            <MetaDocsMenu t={t} />
            <Button
              type="button"
              variant={showRepairOptions ? "secondary" : "outline"}
              size="sm"
              className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
              disabled={connectionActionsDisabled}
              aria-expanded={showRepairOptions}
              aria-controls="whatsapp-connection-repair"
              onClick={() => setShowRepairOptions(value => !value)}
            >
              <RefreshCw data-icon="inline-start" />
              {showRepairOptions
                ? t("repairHide")
                : needsReconnection
                  ? t("reconnectWhatsapp")
                  : t("repairToggle")}
            </Button>
          </ItemActions>
        </Item>
      </section>
      {!needsReconnection &&
      referenceTime - Date.parse(whatsappSource.created_at ?? "") <
        NEXT_STEP_CARD_WINDOW_MS ? (
        <WhatsAppFirstSendCard t={t} workspaceId={workspaceId} />
      ) : null}
      {showRepairOptions ? (
        <div id="whatsapp-connection-repair">
          <RepairConnectionPanel
            t={t}
            defaultTab={defaultReconnectTab}
            workspaceId={workspaceId}
            prefill={prefill}
            disabled={connectionActionsDisabled}
          />
        </div>
      ) : null}
      <WhatsAppIntegrationForm
        credentialsProps={creds}
        workspaceId={workspaceId}
      />
      {conversionSettings}
    </div>
  );
};

function WhatsAppFirstSendCard({
  t,
  workspaceId,
}: {
  t: ReturnType<typeof useTranslations<"WhatsAppIntegration">>;
  workspaceId: string;
}) {
  return (
    <section aria-label={t("nextStep.title")}>
      <Item variant="outline" className="items-start">
        <ItemMedia variant="icon">
          <Megaphone />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t("nextStep.title")}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {t("nextStep.description")}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="w-full flex-wrap sm:w-auto">
          <Button asChild size="sm">
            <Link
              href={panelWorkspaceHref(
                workspaceId,
                "messengers/whatsapp-templates?create=1"
              )}
            >
              <FileText data-icon="inline-start" />
              {t("nextStep.createTemplate")}
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={panelWorkspaceHref(workspaceId, "bulk-campaigns")}>
              {t("nextStep.openBulk")}
            </Link>
          </Button>
        </ItemActions>
      </Item>
    </section>
  );
}

function getConnectionChoiceFromSearchParams(
  searchParams: Pick<URLSearchParams, "get"> | null | undefined
): ConnectionChoice {
  const value = searchParams?.get("whatsapp_mode");
  // Default to Cloud API. Meta is rolling out Phone Number First in stable v4;
  // coexistence can be selected automatically when enabled for the flow and
  // the entered number is already on the WhatsApp Business app.
  if (value === "coexistence" || value === "cloud_api") {
    return value;
  }
  return "cloud_api";
}

function ConnectionChoiceCards({
  t,
  value,
  loading,
  onValueChange,
}: {
  t: ReturnType<typeof useTranslations<"WhatsAppIntegration">>;
  value: ConnectionChoice;
  loading: boolean;
  onValueChange: (value: ConnectionChoice) => void;
}) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend>{t("branching.question")}</FieldLegend>
      <div className="flex items-start justify-between gap-3">
        <FieldDescription>{t("branching.helper")}</FieldDescription>
        {loading ? (
          <Loader2
            className="size-4 shrink-0 animate-spin text-muted-foreground"
            aria-label={t("accessVerify.checking")}
          />
        ) : null}
      </div>
      <RadioGroup
        value={value ?? ""}
        onValueChange={next => {
          if (next === "coexistence" || next === "cloud_api") {
            onValueChange(next);
          }
        }}
        className="grid gap-3 sm:grid-cols-2"
        aria-label={t("branching.question")}
      >
        <ConnectionChoiceCard
          value="cloud_api"
          selected={value === "cloud_api"}
          icon={<Cloud />}
          title={t("tabs.embedded")}
          description={t("branching.optionNo.description")}
          recommendedLabel={t("branching.recommended")}
        />
        <ConnectionChoiceCard
          value="coexistence"
          selected={value === "coexistence"}
          icon={<Smartphone />}
          title={t("tabs.qr")}
          description={t("branching.optionYes.description")}
        />
      </RadioGroup>
    </FieldSet>
  );
}

function ConnectionChoiceCard({
  value,
  selected,
  icon,
  title,
  description,
  recommendedLabel,
}: {
  value: "cloud_api" | "coexistence";
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  recommendedLabel?: string;
}) {
  const radioId = `whatsapp-connection-${value}`;

  return (
    <Item
      asChild
      variant={selected ? "muted" : "outline"}
      className={cn(
        "h-full cursor-pointer items-start",
        selected && "ring-1 ring-ring"
      )}
    >
      <label htmlFor={radioId}>
        <ItemMedia variant="icon">{icon}</ItemMedia>
        <ItemContent>
          <div className="flex flex-wrap items-center gap-2">
            <ItemTitle>{title}</ItemTitle>
            {recommendedLabel ? (
              <Badge variant="secondary">{recommendedLabel}</Badge>
            ) : null}
          </div>
          <ItemDescription className="line-clamp-none">
            {description}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <RadioGroupItem id={radioId} value={value} aria-label={title} />
        </ItemActions>
      </label>
    </Item>
  );
}

function RepairConnectionPanel({
  t,
  defaultTab,
  workspaceId,
  prefill,
  disabled,
}: {
  t: ReturnType<typeof useTranslations<"WhatsAppIntegration">>;
  defaultTab: string;
  workspaceId: string;
  prefill: BusinessPrefillData;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-muted/20 p-4">
      <Item className="px-0 py-0">
        <ItemContent>
          <ItemTitle>{t("repairTitle")}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {t("repairDescription")}
          </ItemDescription>
        </ItemContent>
      </Item>
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="embedded">
            <Cloud />
            {t("tabs.embedded")}
          </TabsTrigger>
          <TabsTrigger value="qr">
            <Smartphone />
            {t("tabs.qr")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="embedded" className="mt-3">
          <Item variant="outline">
            <ItemContent>
              <ItemDescription className="line-clamp-none">
                {t("repairCloudDescription")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <EmbeddedSignupButton
                label={t("reconnectWhatsapp")}
                workspaceId={workspaceId}
                flow="cloud_api"
                businessName={prefill.businessName}
                businessEmail={prefill.businessEmail}
                businessPhone={prefill.businessPhone}
                allowBusinessAppMigration={false}
                variant="outline"
                disabled={disabled}
              />
            </ItemActions>
          </Item>
        </TabsContent>
        <TabsContent value="qr" className="mt-3">
          <EmbeddedSignupWithQR
            workspaceId={workspaceId}
            businessName={prefill.businessName}
            businessEmail={prefill.businessEmail}
            businessPhone={prefill.businessPhone}
            disabled={disabled}
          />
        </TabsContent>
      </Tabs>
      <div className="flex justify-end">
        <MetaDocsMenu t={t} />
      </div>
    </div>
  );
}

function CoexistenceReonboardingPanel({
  t,
}: {
  t: ReturnType<typeof useTranslations<"WhatsAppIntegration">>;
}) {
  const steps = [
    t("coexistenceReconnect.stepRegister"),
    t("coexistenceReconnect.stepKeepSelected"),
    t("coexistenceReconnect.stepWait"),
  ];

  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{t("coexistenceReconnect.title")}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-3">
          <p>{t("coexistenceReconnect.description")}</p>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            {steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              <RefreshCw data-icon="inline-start" />
              {t("coexistenceReconnect.checkStatus")}
            </Button>
            <MetaDocsMenu t={t} />
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function MetaDocsMenu({
  t,
}: {
  t: ReturnType<typeof useTranslations<"WhatsAppIntegration">>;
}) {
  const links = [
    {
      href: META_DOC_LINKS.cloudApi,
      label: t("docs.cloudApi"),
      description: t("docs.cloudApiDescription"),
    },
    {
      href: META_DOC_LINKS.coexistence,
      label: t("docs.coexistence"),
      description: t("docs.coexistenceDescription"),
    },
    {
      href: META_DOC_LINKS.coexistenceReconnect,
      label: t("docs.coexistenceReconnect"),
      description: t("docs.coexistenceReconnectDescription"),
    },
    {
      href: META_DOC_LINKS.embeddedSignup,
      label: t("docs.embeddedSignup"),
      description: t("docs.embeddedSignupDescription"),
    },
    {
      href: META_DOC_LINKS.catalog,
      label: t("docs.catalog"),
      description: t("docs.catalogDescription"),
    },
    {
      href: META_DOC_LINKS.marketing,
      label: t("docs.marketing"),
      description: t("docs.marketingDescription"),
    },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <BookOpen data-icon="inline-start" />
          {t("docs.label")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
            <span className="text-sm font-medium text-foreground">
              {t("docs.title")}
            </span>
            <span className="text-xs leading-5 text-muted-foreground">
              {t("docs.description")}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {links.map(link => (
            <DropdownMenuItem key={link.href} asChild>
              <a href={link.href} target="_blank" rel="noreferrer">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{link.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {link.description}
                  </span>
                </span>
                <ExternalLink />
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IntegrationBranchFallback() {
  return (
    <Item variant="muted">
      <ItemContent>
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </ItemContent>
    </Item>
  );
}
