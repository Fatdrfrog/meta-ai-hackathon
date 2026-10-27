"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deriveEmailProviderOnboardingStatus,
  hasCompleteDomainRecords,
  type EmailProviderOnboardingStatus,
} from "@/components/integrations/email-provider-onboarding-status";
import type { EmailProviderStatus } from "@/types/integrations";
import { cn } from "@/lib/utils";
import { CheckCircle2, ChevronDown, Copy, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

type ManagedState = {
  domain: string;
  verificationStatus: "pending_dns" | "verified" | "error";
  dkimVerified: boolean;
  returnPathVerified: boolean;
  dns: {
    dkimHost: string;
    dkimValue: string;
    returnPathHost: string;
    returnPathValue: string;
    spfHost?: string;
    spfValue?: string;
  };
  lastError?: string;
  lastCheckedAt?: string;
};

type ProviderApiResponse = {
  provider: null | {
    id: string;
    workspaceId: string;
    provider: string;
    mode: "manual" | "platform_managed";
    verificationStatus: "disconnected" | "pending_dns" | "verified" | "error";
    status: "active" | "inactive";
    defaultFromAddress: string;
    webhookUrl: string;
    managedState: ManagedState | null;
    permissions?: {
      canManage: boolean;
    };
  };
  permissions?: {
    canManage: boolean;
  };
};

const fetcher = async (url: string): Promise<ProviderApiResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "Failed to load email provider");
  }
  return res.json();
};

export function EmailProviderConfigForm({
  workspaceId,
  emailProviderStatus,
  connectionActionsDisabled = false,
}: {
  workspaceId: string;
  emailProviderStatus: EmailProviderStatus;
  connectionActionsDisabled?: boolean;
}) {
  const t = useTranslations("EmailIntegration");
  const { data, isLoading, mutate } = useSWR(
    workspaceId && !connectionActionsDisabled
      ? `/api/email/provider?workspaceId=${workspaceId}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const provider = data?.provider || null;
  const canManage = connectionActionsDisabled
    ? true
    : Boolean(data?.permissions?.canManage ?? provider?.permissions?.canManage);

  const [defaultFromAddress, setDefaultFromAddress] = useState("");
  const [postmarkServerToken, setPostmarkServerToken] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [managedSaving, setManagedSaving] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setDefaultFromAddress(provider.defaultFromAddress || "");
  }, [provider]);

  const onboardingStatus = useMemo(
    () =>
      deriveEmailProviderOnboardingStatus({
        provider,
        emailProviderStatus,
        isSettingUp: managedSaving,
        isChecking: verifying,
      }),
    [provider, emailProviderStatus, managedSaving, verifying]
  );

  const domainRecordsReady = hasCompleteDomainRecords(provider?.managedState);

  const copy = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const handleManagedSetup = async () => {
    setManagedSaving(true);
    try {
      const res = await fetch("/api/email/provider/platform/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          defaultFromAddress,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || t("error.providerSaveFailed"));
      }

      await mutate();
      toast.success(t("platformSetupSuccess"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("error.providerSaveFailed")
      );
    } finally {
      setManagedSaving(false);
    }
  };

  const handleVerifyDns = async () => {
    setVerifying(true);
    try {
      const res = await fetch("/api/email/provider/platform/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || t("error.providerSaveFailed"));
      }
      await mutate();
      toast.success(t("dnsVerifySuccess"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("error.providerSaveFailed")
      );
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveManual = async () => {
    setManualSaving(true);
    try {
      const res = await fetch("/api/email/provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          mode: "manual",
          postmarkServerToken: postmarkServerToken || undefined,
          defaultFromAddress,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || t("error.providerSaveFailed"));
      }

      setPostmarkServerToken("");
      await mutate();
      toast.success(t("providerSaved"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("error.providerSaveFailed")
      );
    } finally {
      setManualSaving(false);
    }
  };

  const primaryAction =
    onboardingStatus === "add_domain_records" || onboardingStatus === "checking"
      ? {
          label: verifying ? t("verifyingDns") : t("verifyDnsNow"),
          onClick: handleVerifyDns,
          disabled:
            verifying ||
            isLoading ||
            !provider ||
            provider.mode !== "platform_managed",
          icon: RefreshCw,
        }
      : onboardingStatus === "ready"
        ? {
            label: managedSaving ? t("providerSaving") : t("saveSender"),
            onClick: handleManagedSetup,
            disabled: managedSaving || isLoading || !defaultFromAddress.trim(),
            icon: CheckCircle2,
          }
        : {
            label: managedSaving
              ? t("providerSaving")
              : t("connectWithPostmark"),
            onClick: handleManagedSetup,
            disabled: managedSaving || isLoading || !defaultFromAddress.trim(),
            icon: CheckCircle2,
          };

  const PrimaryActionIcon = primaryAction.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{t("providerTitle")}</CardTitle>
          <StatusBadge status={onboardingStatus} />
        </div>
        <CardDescription className="text-xs">
          {t("providerDescriptionPlatform")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canManage && (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {t("readOnlyHint")}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="default_from_address" className="text-xs">
            {t("defaultFromAddress")}
          </Label>
          <Input
            id="default_from_address"
            type="email"
            value={defaultFromAddress}
            onChange={event => setDefaultFromAddress(event.target.value)}
            placeholder={t("defaultFromAddressPlaceholder")}
            className="h-9 text-sm"
            disabled={
              !canManage ||
              managedSaving ||
              verifying ||
              connectionActionsDisabled
            }
            readOnly={!canManage || connectionActionsDisabled}
          />
        </div>

        {onboardingStatus !== "not_set_up" && (
          <StatusMessage
            status={onboardingStatus}
            lastCheckedAt={provider?.managedState?.lastCheckedAt}
          />
        )}

        {onboardingStatus === "add_domain_records" &&
          provider?.managedState &&
          domainRecordsReady && (
            <DomainRecords managedState={provider.managedState} onCopy={copy} />
          )}

        {canManage && (
          <div className="rounded-md border bg-muted/20">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium"
              onClick={() => setAdvancedOpen(open => !open)}
              aria-expanded={advancedOpen}
            >
              {t("advancedSetupTitle")}
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  advancedOpen && "rotate-180"
                )}
                aria-hidden="true"
              />
            </button>
            {advancedOpen && (
              <div className="space-y-4 border-t p-3">
                <div className="text-xs text-muted-foreground">
                  {t("advancedDescription")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="postmark_server_token" className="text-xs">
                    {t("postmarkServerToken")}
                  </Label>
                  <Input
                    id="postmark_server_token"
                    type="password"
                    value={postmarkServerToken}
                    onChange={event =>
                      setPostmarkServerToken(event.target.value)
                    }
                    placeholder={t("postmarkServerTokenPlaceholder")}
                    className="h-9 text-sm"
                    disabled={
                      !canManage || manualSaving || connectionActionsDisabled
                    }
                    readOnly={connectionActionsDisabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    {provider ? t("tokenUpdateHint") : t("tokenRequiredHint")}
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={handleSaveManual}
                  disabled={
                    connectionActionsDisabled ||
                    manualSaving ||
                    isLoading ||
                    !defaultFromAddress.trim() ||
                    (!provider && !postmarkServerToken.trim())
                  }
                  size="sm"
                >
                  {manualSaving ? t("providerSaving") : t("saveProvider")}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      {canManage && (
        <CardFooter className="flex gap-2 flex-wrap">
          <Button
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || connectionActionsDisabled}
            size="sm"
          >
            <PrimaryActionIcon className="mr-2 size-4" aria-hidden="true" />
            {primaryAction.label}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: EmailProviderOnboardingStatus }) {
  const t = useTranslations("EmailIntegration");

  return (
    <Badge
      variant="outline"
      className={cn(
        status === "ready" &&
          "border-green-500/40 bg-green-500/10 text-green-700",
        (status === "add_domain_records" ||
          status === "setting_up" ||
          status === "checking") &&
          "border-amber-500/40 bg-amber-500/10 text-amber-700",
        status === "error" &&
          "border-destructive/40 bg-destructive/10 text-destructive"
      )}
    >
      {status === "ready"
        ? t("statusConnected")
        : status === "add_domain_records"
          ? t("statusPendingDns")
          : status === "setting_up"
            ? t("statusSettingUp")
            : status === "checking"
              ? t("statusChecking")
              : status === "error"
                ? t("statusError")
                : t("statusDisconnected")}
    </Badge>
  );
}

function StatusMessage({
  status,
  lastCheckedAt,
}: {
  status: EmailProviderOnboardingStatus;
  lastCheckedAt?: string;
}) {
  const t = useTranslations("EmailIntegration");

  const message =
    status === "ready"
      ? t("readyDescription")
      : status === "add_domain_records"
        ? t("pendingDnsDescription")
        : status === "checking"
          ? t("checkingDescription")
          : status === "setting_up"
            ? t("settingUpDescription")
            : status === "error"
              ? t("errorDescription")
              : "";

  if (!message) return null;

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-xs",
        status === "ready" && "border-green-500/30 bg-green-500/5",
        (status === "add_domain_records" ||
          status === "setting_up" ||
          status === "checking") &&
          "border-amber-500/30 bg-amber-500/5",
        status === "error" && "border-destructive/30 bg-destructive/5"
      )}
    >
      <p>{message}</p>
      {lastCheckedAt && status !== "ready" && (
        <p className="mt-2 text-muted-foreground">
          {t("lastCheckedAt")}: {new Date(lastCheckedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function DomainRecords({
  managedState,
  onCopy,
}: {
  managedState: ManagedState;
  onCopy: (value: string, successMessage: string) => void;
}) {
  const t = useTranslations("EmailIntegration");
  const records = [
    {
      type: t("dnsTxtRecord"),
      name: managedState.dns.dkimHost,
      value: managedState.dns.dkimValue,
    },
    {
      type: t("dnsCnameRecord"),
      name: managedState.dns.returnPathHost,
      value: managedState.dns.returnPathValue,
    },
  ];

  return (
    <div
      className="space-y-2 rounded-md border bg-muted/20 p-3"
      data-testid="email-domain-records"
    >
      {records.map(record => (
        <DomainRecordRow
          key={`${record.type}-${record.name}`}
          type={record.type}
          name={record.name}
          value={record.value}
          onCopy={onCopy}
        />
      ))}
    </div>
  );
}

function DomainRecordRow({
  type,
  name,
  value,
  onCopy,
}: {
  type: string;
  name: string;
  value: string;
  onCopy: (value: string, successMessage: string) => void;
}) {
  const t = useTranslations("EmailIntegration");

  return (
    <div className="rounded-md border bg-background/80 p-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-[72px_1fr]">
        <div className="text-muted-foreground">{t("dnsRecordType")}</div>
        <div className="font-mono">{type}</div>
        <div className="text-muted-foreground">{t("dnsRecordName")}</div>
        <CopyableDomainValue value={name} onCopy={onCopy} />
        <div className="text-muted-foreground">{t("dnsRecordValue")}</div>
        <CopyableDomainValue value={value} onCopy={onCopy} />
      </div>
    </div>
  );
}

function CopyableDomainValue({
  value,
  onCopy,
}: {
  value: string;
  onCopy: (value: string, successMessage: string) => void;
}) {
  const t = useTranslations("EmailIntegration");

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 break-all font-mono">{value}</span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => onCopy(value, t("valueCopied"))}
        aria-label={t("copy")}
      >
        <Copy className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
