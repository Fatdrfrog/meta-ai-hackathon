"use client";

import { MetaAdsMcpConnectButton } from "@/components/integrations/meta-ads-mcp-connect-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchMetaAdsMcpSession,
  getMetaAdsMcpSessionSWRKey,
  selectMetaAdsMcpAccount,
  type MetaAdsMcpSessionPayload,
  type ConnectMetaAdsMcpResult,
} from "@/lib/meta-ads/connect-meta-ads-mcp-client";
import {
  getMetaAdsReportingReadiness,
  type MetaAdsReportingReadiness,
} from "@/lib/meta-ads/meta-ads-reporting-readiness";
import { normalizeMetaAdsAdAccounts } from "@/lib/meta-ads/meta-ads-source";
import { cn } from "@/lib/utils";
import type { Source } from "@/types/supabase";
import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
  MetaAdsMcpReadinessState,
  MetaAdsMcpWarningCode,
} from "@icecore/shared/types/sources";
import {
  AlertCircle,
  CheckCircle2,
  BarChart3,
  ChevronDown,
  Loader2,
  Megaphone,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";

interface MetaAdsIntegrationProps {
  source?: Source;
  workspaceId: string;
  connectionActionsDisabled?: boolean;
}

const READINESS_STATE_COPY = {
  not_connected: "notConnected",
  checking: "checking",
  expired: "expired",
  expiry_unknown: "expiryUnknown",
  missing_scopes: "missingScopes",
  scope_unverified: "scopeUnverified",
  identity_unverified: "identityUnverified",
  asset_unavailable: "assetUnavailable",
  provider_unauthorized: "providerUnauthorized",
  provider_unreachable: "providerUnavailable",
  invalid_catalog: "invalidCatalog",
  stale: "stale",
  ready: "ready",
} as const satisfies Record<MetaAdsMcpReadinessState, string>;

const WARNING_COPY = {
  account_not_enabled: "accountNotEnabled",
  account_inventory_truncated: "accountInventoryTruncated",
  expiry_unknown: "expiryUnknown",
  graph_user_mismatch: "graphUserMismatch",
  protected_resource_metadata_unavailable: "resourceMetadataUnavailable",
  provider_capability_drift: "providerCapabilityDrift",
  provider_protocol_fallback: "providerProtocolFallback",
  provider_teardown_failed: "providerTeardownFailed",
  scope_contract_added: "scopeContractAdded",
  scope_contract_removed: "scopeContractRemoved",
  scope_challenge_added: "scopeChallengeAdded",
  scope_unverified: "scopeUnverified",
  selected_account_direct_only: "selectedAccountDirectOnly",
} as const satisfies Record<MetaAdsMcpWarningCode, string>;

const EMPTY_READINESS: MetaAdsMcpReadiness = {
  state: "not_connected",
  grantedScopes: [],
  requiredScopes: [],
  missingScopes: [],
  missingReadScopes: [],
  missingWriteScopes: [],
  accessibleAdAccountIds: [],
  accessibleAdAccountsTruncated: false,
  canRead: false,
  canWrite: false,
  reconnectRequired: false,
};

function readCredentials(source?: Source): Record<string, unknown> {
  return source?.credentials && typeof source.credentials === "object"
    ? (source.credentials as Record<string, unknown>)
    : {};
}

function readPublicReadiness(
  credentials: Record<string, unknown>
): MetaAdsMcpReadiness | null {
  const readiness = credentials.mcp_readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return null;
  }
  const candidate = readiness as Partial<MetaAdsMcpReadiness>;
  return typeof candidate.state === "string" &&
    typeof candidate.canRead === "boolean" &&
    typeof candidate.canWrite === "boolean"
    ? (candidate as MetaAdsMcpReadiness)
    : null;
}

function initialSessionPayload(params: {
  connected: boolean;
  readiness: MetaAdsMcpReadiness;
  credentials?: Record<string, unknown>;
}): MetaAdsMcpSessionPayload {
  const reporting = getMetaAdsReportingReadiness(params.credentials);
  return {
    appConfigured: false,
    configId: null,
    reportingConfigId: null,
    reporting,
    adAccounts: normalizeMetaAdsAdAccounts(params.credentials?.ad_accounts),
    selectedAdAccountId: reporting.selectedAdAccountId,
    hasMetaAdsSource: params.connected,
    canConnect: false,
    readiness: params.readiness,
  };
}

function checkingReadiness(
  readiness: MetaAdsMcpReadiness
): MetaAdsMcpReadiness {
  return {
    ...readiness,
    state: "checking",
    canRead: false,
    canWrite: false,
    reconnectRequired: false,
  };
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : null;
}

function formatAdAccount(account: MetaAdsAdAccount): string {
  const name = account.name || account.id;
  const accountId = account.account_id || account.id.replace(/^act_/i, "");
  return [name, accountId ? `(${accountId})` : "", account.business?.name]
    .filter(Boolean)
    .join(" ");
}

function normalizeMetaAdsAccountId(value: string | null | undefined): string {
  return (value || "").trim().replace(/^act_/i, "").toLowerCase();
}

function ReadinessDetails({ readiness }: { readiness: MetaAdsMcpReadiness }) {
  const t = useTranslations("MetaAdsIntegration");
  const selectedAsset = readiness.selectedAsset;
  const provider = readiness.provider;
  const supportedProtocolFallback =
    readiness.canRead &&
    provider?.protocolEra === "legacy" &&
    provider.warnings.includes("provider_protocol_fallback");
  const warnings = (provider?.warnings ?? []).filter(
    warning =>
      warning !== "provider_protocol_fallback" || !supportedProtocolFallback
  );
  const protocol = [provider?.protocolEra, provider?.protocolVersion]
    .filter(Boolean)
    .join(" / ");
  const details = [
    {
      label: t("mcp.details.user"),
      value: readiness.identity
        ? readiness.identity.name || readiness.identity.id
        : null,
    },
    {
      label: t("mcp.details.account"),
      value: selectedAsset?.adAccountId,
    },
    {
      label: t("mcp.details.business"),
      value: selectedAsset?.businessName || selectedAsset?.businessId,
    },
    { label: t("mcp.details.currency"), value: selectedAsset?.currency },
    { label: t("mcp.details.timezone"), value: selectedAsset?.timezone },
    {
      label: t("mcp.details.expiresAt"),
      value: readiness.neverExpires
        ? t("experience.noExpiry")
        : formatDate(readiness.expiresAt),
    },
    {
      label: t("mcp.details.grantedScopes"),
      value: readiness.grantedScopes.join(", ") || null,
    },
    {
      label: t("mcp.details.missingScopes"),
      value: readiness.missingScopes.join(", ") || null,
    },
    {
      label: t("mcp.details.toolCount"),
      value:
        provider?.toolCount === undefined ? null : String(provider.toolCount),
    },
    { label: t("mcp.details.protocol"), value: protocol || null },
    { label: t("mcp.details.server"), value: provider?.serverName },
    {
      label: t("mcp.details.lastChecked"),
      value: formatDate(readiness.checkedAt) || t("mcp.details.notChecked"),
    },
  ].filter(
    (detail): detail is { label: string; value: string } =>
      typeof detail.value === "string" && detail.value.length > 0
  );

  return (
    <>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {details.map(detail => (
          <div key={detail.label} className="min-w-0 space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {detail.label}
            </dt>
            <dd className="break-words text-foreground">{detail.value}</dd>
          </div>
        ))}
      </dl>
      {supportedProtocolFallback ? (
        <p className="text-xs text-muted-foreground">
          {t("mcp.details.protocolCompatibility")}
        </p>
      ) : null}
      {warnings.length ? (
        <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium">{t("mcp.details.warnings")}</p>
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            {warnings.map(warning => (
              <li key={warning}>
                {t(`mcp.warnings.${WARNING_COPY[warning]}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function useMetaAdsIntegration({
  source,
  workspaceId,
  connectionActionsDisabled = false,
}: MetaAdsIntegrationProps) {
  const t = useTranslations("MetaAdsIntegration");
  const { mutate: mutateCache } = useSWRConfig();
  const [isChecking, setIsChecking] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSelectingAccount, setIsSelectingAccount] = useState(false);
  const credentials = readCredentials(source);
  const publicReadiness = readPublicReadiness(credentials) || EMPTY_READINESS;
  const sessionKey = connectionActionsDisabled
    ? null
    : getMetaAdsMcpSessionSWRKey(workspaceId);
  const integrationsKey = `/api/workspaces/${workspaceId}/integrations`;
  const {
    data: session,
    error: sessionError,
    mutate: mutateSession,
  } = useSWR(sessionKey, () => fetchMetaAdsMcpSession({ workspaceId }), {
    fallbackData: initialSessionPayload({
      connected: Boolean(source),
      readiness: publicReadiness,
      credentials,
    }),
    revalidateOnFocus: false,
  });
  const connected = Boolean(source) || Boolean(session?.hasMetaAdsSource);
  const readiness = isChecking
    ? checkingReadiness(session?.readiness || publicReadiness)
    : session?.readiness || publicReadiness;
  const graphAccounts = normalizeMetaAdsAdAccounts(
    session?.adAccounts ?? credentials.ad_accounts
  );
  const reporting: MetaAdsReportingReadiness =
    session?.reporting || getMetaAdsReportingReadiness(credentials);
  const refreshIntegration = () => mutateCache(integrationsKey);
  const actionsDisabled =
    connectionActionsDisabled ||
    isChecking ||
    isConnecting ||
    isSelectingAccount;

  const handleCheckAgain = async () => {
    if (actionsDisabled) return;
    setIsChecking(true);
    try {
      const nextSession = await fetchMetaAdsMcpSession({
        workspaceId,
        probe: true,
      });
      await Promise.all([
        mutateSession(nextSession, { revalidate: false }),
        refreshIntegration(),
      ]);
      toast.success(t("experience.checked"));
    } catch {
      toast.error(t("experience.checkFailed"));
    } finally {
      setIsChecking(false);
    }
  };
  const handleSelectAccount = async (adAccountId: string) => {
    if (actionsDisabled) return;
    setIsSelectingAccount(true);
    try {
      const nextSession = await selectMetaAdsMcpAccount({
        workspaceId,
        adAccountId,
      });
      await Promise.all([
        mutateSession(nextSession, { revalidate: false }),
        refreshIntegration(),
      ]);
      toast.success(t("experience.accountSelected"));
    } catch {
      toast.error(t("experience.accountSelectFailed"));
    } finally {
      setIsSelectingAccount(false);
    }
  };
  const handleConnected = async (
    result: Extract<ConnectMetaAdsMcpResult, { ok: true }>
  ) => {
    await mutateSession(
      current => ({
        ...(current ||
          initialSessionPayload({
            connected: true,
            readiness: result.readiness,
          })),
        hasMetaAdsSource: true,
        readiness: result.readiness,
        adAccounts: result.adAccounts,
        selectedAdAccountId: result.selectedAdAccountId,
        reporting: result.reporting,
      }),
      { revalidate: false }
    );
    await Promise.all([mutateSession(), refreshIntegration()]);
  };

  return {
    connected,
    readiness,
    reporting,
    graphAccounts,
    sessionError,
    isChecking,
    isSelectingAccount,
    actionsDisabled,
    handleCheckAgain,
    handleSelectAccount,
    handleConnected,
    setIsConnecting,
  };
}

type MetaAdsIntegrationController = ReturnType<typeof useMetaAdsIntegration>;
function isAccountNotEnabled(readiness: MetaAdsMcpReadiness): boolean {
  return (
    readiness.state === "asset_unavailable" &&
    readiness.provider?.selectedAccountEnabled === false
  );
}
function getAiState(readiness: MetaAdsMcpReadiness) {
  if (readiness.state === "checking") return "checking";
  if (isAccountNotEnabled(readiness)) return "accountNotEnabled";
  if (readiness.canWrite) return "ready";
  if (readiness.canRead) return "readOnly";
  if (readiness.state === "not_connected") return "optional";
  if (readiness.reconnectRequired) return "reconnect";
  return "unavailable";
}
function MetaAdsAiStatus({
  workspaceId,
  connected,
  readiness,
  reportingReady,
  isChecking,
  actionsDisabled,
  handleCheckAgain,
  handleConnected,
  setIsConnecting,
}: Pick<
  MetaAdsIntegrationController,
  | "connected"
  | "readiness"
  | "isChecking"
  | "actionsDisabled"
  | "handleCheckAgain"
  | "handleConnected"
  | "setIsConnecting"
> & { workspaceId: string; reportingReady: boolean }) {
  const t = useTranslations("MetaAdsIntegration");
  const accountNotEnabled = isAccountNotEnabled(readiness);
  const aiState = getAiState(readiness);
  return (
    <div className="flex items-start gap-3 p-4">
      <Sparkles className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">{t("experience.ai.title")}</h4>
          <Badge
            variant="outline"
            className={cn(
              !accountNotEnabled &&
                readiness.canWrite &&
                "border-emerald-500/30 bg-emerald-500/5 text-emerald-700",
              !accountNotEnabled &&
                readiness.canRead &&
                !readiness.canWrite &&
                "border-sky-500/30 text-sky-700"
            )}
          >
            {t(`experience.ai.${aiState}.label`)}
          </Badge>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          {t(
            accountNotEnabled &&
              !reportingReady &&
              readiness.state !== "checking"
              ? "experience.ai.accountNotEnabled.reportingUnavailableDescription"
              : `experience.ai.${aiState}.description`
          )}
        </p>
        {connected ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {!accountNotEnabled &&
            !readiness.canWrite &&
            (readiness.reconnectRequired ||
              readiness.state === "not_connected" ||
              readiness.canRead) ? (
              <MetaAdsMcpConnectButton
                workspaceId={workspaceId}
                intent="ai_ads"
                allowCreateGraphSource
                variant="outline"
                size="sm"
                className="h-auto min-h-8 whitespace-normal text-left"
                disabled={actionsDisabled}
                onPendingChange={setIsConnecting}
                onConnected={handleConnected}
                label={
                  readiness.reconnectRequired
                    ? t("experience.ai.manage")
                    : t("experience.ai.enable")
                }
              />
            ) : null}
            {readiness.state !== "not_connected" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={actionsDisabled}
                onClick={() => void handleCheckAgain()}
              >
                {isChecking ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 size-3.5" />
                )}
                {isChecking
                  ? t("experience.checking")
                  : accountNotEnabled || readiness.canRead
                    ? t("experience.checkAgain")
                    : t("experience.checkAi")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
function MetaAdsAccountPicker({
  graphAccounts,
  selectedAdAccountId,
  selectedGraphAccount,
  selectionUnavailable,
  isSelectingAccount,
  actionsDisabled,
  handleSelectAccount,
}: Pick<
  MetaAdsIntegrationController,
  | "graphAccounts"
  | "isSelectingAccount"
  | "actionsDisabled"
  | "handleSelectAccount"
> & {
  selectedAdAccountId: string | null;
  selectedGraphAccount?: MetaAdsAdAccount;
  selectionUnavailable: boolean;
}) {
  const t = useTranslations("MetaAdsIntegration");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          className="text-sm font-medium"
          htmlFor="meta-ads-selected-account"
        >
          {t("selectedAccountLabel")}
        </label>
        <span className="text-xs text-muted-foreground">
          {t("experience.accountsAvailable", {
            count: graphAccounts.length,
          })}
        </span>
      </div>
      <Select
        value={selectedAdAccountId || ""}
        onValueChange={value => void handleSelectAccount(value)}
        disabled={actionsDisabled || graphAccounts.length === 0}
      >
        <SelectTrigger
          id="meta-ads-selected-account"
          aria-label={t("selectedAccountLabel")}
          className="min-h-10 w-full py-2 data-[size=default]:h-auto *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:whitespace-normal *:data-[slot=select-value]:break-words *:data-[slot=select-value]:text-left"
        >
          <SelectValue placeholder={t("noAccounts")}>
            {selectedGraphAccount
              ? formatAdAccount(selectedGraphAccount)
              : selectedAdAccountId || t("noAccounts")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
          {selectionUnavailable && selectedAdAccountId ? (
            <SelectItem value={selectedAdAccountId} disabled>
              {selectedAdAccountId}
            </SelectItem>
          ) : null}
          {graphAccounts.map(account => (
            <SelectItem
              key={account.id}
              value={account.id}
              className="min-w-0 whitespace-normal break-words [&>span:last-child]:min-w-0 [&>span:last-child]:break-words"
            >
              {formatAdAccount(account)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isSelectingAccount ? (
        <p
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" />
          {t("experience.selecting")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("experience.accountHelp")}
        </p>
      )}
      {selectionUnavailable ? (
        <p role="status" className="text-sm text-amber-700">
          {t("experience.accountUnavailable")}
        </p>
      ) : null}
    </div>
  );
}
function MetaAdsConnectionDetails({
  readiness,
}: {
  readiness: MetaAdsMcpReadiness;
}) {
  const t = useTranslations("MetaAdsIntegration");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stateCopy = isAccountNotEnabled(readiness)
    ? "accountNotEnabled"
    : readiness.canRead && !readiness.canWrite
      ? "readOnly"
      : READINESS_STATE_COPY[readiness.state];
  return (
    <Collapsible
      open={detailsOpen}
      onOpenChange={setDetailsOpen}
      className="border-t pt-3"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-between px-0 text-sm text-muted-foreground"
        >
          {t("experience.details")}
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              detailsOpen && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-4">
        <p className="text-sm font-medium">
          {t(`mcp.states.${stateCopy}.title`)}
        </p>
        <ReadinessDetails readiness={readiness} />
      </CollapsibleContent>
    </Collapsible>
  );
}
export function MetaAdsIntegration(props: MetaAdsIntegrationProps) {
  const t = useTranslations("MetaAdsIntegration");
  const { workspaceId } = props;
  const {
    connected,
    readiness,
    reporting,
    graphAccounts,
    sessionError,
    isChecking,
    isSelectingAccount,
    actionsDisabled,
    handleCheckAgain,
    handleSelectAccount,
    handleConnected,
    setIsConnecting,
  } = useMetaAdsIntegration(props);
  const selectedAdAccountId = reporting.selectedAdAccountId;
  const selectedGraphAccount = graphAccounts.find(
    account =>
      normalizeMetaAdsAccountId(account.id) ===
      normalizeMetaAdsAccountId(selectedAdAccountId)
  );
  const selectionUnavailable =
    Boolean(selectedAdAccountId) && !selectedGraphAccount;
  const reportingReady = reporting.canRead;
  const needsAttention = connected && (!reportingReady || selectionUnavailable);
  const reportingNeedsAuthorization = [
    "expired",
    "missing_permission",
    "not_connected",
  ].includes(reporting.reason);
  return (
    <section className="space-y-5 rounded-2xl border bg-background p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
            {needsAttention ? (
              <AlertCircle className="size-5 text-amber-600" />
            ) : connected ? (
              <CheckCircle2 className="size-5 text-emerald-600" />
            ) : (
              <Megaphone className="size-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <h3 className="text-base font-semibold">
              {needsAttention
                ? t("attentionTitle")
                : connected
                  ? t("connectedTitle")
                  : t("disconnectedTitle")}
            </h3>
            <p className="max-w-xl text-sm text-muted-foreground">
              {needsAttention
                ? t("attentionDescription")
                : connected
                  ? t("connectedDescription")
                  : t("disconnectedDescription")}
            </p>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-auto">
          <MetaAdsMcpConnectButton
            workspaceId={workspaceId}
            intent="reporting"
            allowCreateGraphSource
            disabled={actionsDisabled}
            onPendingChange={setIsConnecting}
            onConnected={handleConnected}
            label={connected ? t("experience.manageAccess") : t("connect")}
            className="w-full"
          />
        </div>
      </div>

      {connected &&
      !reportingReady &&
      reporting.reason !== "account_unavailable" ? (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertCircle className="size-4 text-amber-600" />
          <AlertTitle>
            {reportingNeedsAuthorization
              ? t("experience.reporting.accessNeeded")
              : reporting.reason === "account_check_failed"
                ? t("accountDiscoveryFailed")
                : t("accountDiscoveryEmpty")}
          </AlertTitle>
          <AlertDescription>
            {reportingNeedsAuthorization
              ? t("experience.reporting.accessNeededDescription")
              : t("accountDiscoveryAction")}
          </AlertDescription>
        </Alert>
      ) : null}
      {sessionError ? (
        <p role="status" className="text-sm text-amber-700">
          {t("experience.checkFailed")}
        </p>
      ) : null}

      <div className="divide-y rounded-xl border">
        <div className="flex items-start gap-3 p-4">
          <BarChart3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">
                {t("experience.reporting.title")}
              </h4>
              <Badge
                variant="outline"
                className={cn(
                  reportingReady &&
                    !selectionUnavailable &&
                    "border-emerald-500/30 bg-emerald-500/5 text-emerald-700"
                )}
              >
                {reportingReady && !selectionUnavailable
                  ? t("experience.available")
                  : connected
                    ? t("attentionBadge")
                    : t("experience.notConnected")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("experience.reporting.description")}
            </p>
          </div>
        </div>
        <MetaAdsAiStatus
          workspaceId={workspaceId}
          connected={connected}
          readiness={readiness}
          reportingReady={reportingReady}
          isChecking={isChecking}
          actionsDisabled={actionsDisabled}
          handleCheckAgain={handleCheckAgain}
          handleConnected={handleConnected}
          setIsConnecting={setIsConnecting}
        />
      </div>

      {connected ? (
        <>
          <MetaAdsAccountPicker
            graphAccounts={graphAccounts}
            selectedAdAccountId={selectedAdAccountId}
            selectedGraphAccount={selectedGraphAccount}
            selectionUnavailable={selectionUnavailable}
            isSelectingAccount={isSelectingAccount}
            actionsDisabled={actionsDisabled}
            handleSelectAccount={handleSelectAccount}
          />
          <MetaAdsConnectionDetails readiness={readiness} />
        </>
      ) : null}
    </section>
  );
}
