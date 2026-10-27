"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import {
  deriveWhatsAppAccountHealth,
  type WhatsAppAccountHealth,
  type WhatsAppAccountHealthState,
} from "@/lib/whatsapp/account/health";
import {
  decodeWhatsAppOnboardingHealthResponse,
  resolveWhatsAppAccountHealth,
} from "@/lib/whatsapp/onboarding-health-response";
import { isWhatsAppHistorySyncEligible } from "@/lib/whatsapp/history-sync/eligibility";
import {
  WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS,
  WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT,
  WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT,
} from "@icecore/shared/lib/whatsapp/history-sync-state";
import {
  getWhatsAppHistoryRequestAvailability,
  type WhatsAppHistorySyncState,
} from "@icecore/whatsapp/historySyncState";
import {
  buildWhatsAppHistorySyncSummary,
  isWhatsAppHistorySyncActive,
} from "@/lib/whatsapp/history-sync/status";
import {
  buildWhatsAppManagerPortalUrl,
  buildWhatsAppMarketingMessagesPortalUrl,
  getMarketingMessagesUserFacingState,
  isMarketingMessagesApiOnboarded,
  shouldShowMarketingMessagesOnboardingNudge,
  shouldSyncMarketingMessagesOnboarding,
} from "@/lib/whatsapp/marketing/messages-onboarding";
import { cn } from "@/lib/utils";
import {
  getWhatsAppAccountHealthStatusKey,
  getWhatsAppMetaRefreshFeedback,
} from "@/lib/whatsapp/status-format";
import {
  WhatsAppCredentials,
  type WhatsAppCredentialFields,
} from "@/types/supabase";
import {
  hasWhatsAppBusinessAppConnectionSignal,
  shouldUseManualPhoneRegistrationGuidance,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { isWhatsAppPhoneNumberRegistered } from "@icecore/shared/lib/whatsapp/phone-details";
import {
  ChevronDown,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  Megaphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Upload,
  Webhook,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

type Translations = ReturnType<
  typeof useTranslations<"WhatsAppIntegrationForm">
>;

type HistorySyncStatus = {
  history_sync?: WhatsAppHistorySyncState | null;
  history_sync_can_request?: boolean;
};

type MarketingMessagesEligibilityResponse = {
  data?: {
    marketing_messages?: Pick<
      WhatsAppCredentialFields,
      | "marketing_messages_enabled"
      | "marketing_messages_onboarding_status"
      | "marketing_messages_api_status"
      | "marketing_messages_onboarding_last_checked_at"
    >;
  };
  error?: string;
  actionable?: string;
};

async function fetchMarketingMessagesStatus(workspaceId: string) {
  const res = await fetch(
    `/api/whatsapp/mm-eligibility?workspaceId=${encodeURIComponent(workspaceId)}`
  );
  const payload = (await res
    .json()
    .catch(() => null)) as MarketingMessagesEligibilityResponse | null;
  if (!res.ok || payload?.error || !payload?.data?.marketing_messages) {
    throw new Error(payload?.actionable || payload?.error);
  }
  return payload.data.marketing_messages;
}

type MaxPriceAgreementResponse = {
  data?: {
    businessId?: string;
    agreement?: {
      status?: string;
      signer_name?: string;
      signer_email?: string;
    };
  };
  error?: string;
  actionable?: string;
};

type SetupStatusTone = "secondary" | "outline" | "destructive";

function formatWebhookFieldSummary(fields: string[]) {
  const visibleFields = fields.slice(0, 3).join(", ");
  const remainingCount = fields.length - 3;
  return remainingCount > 0
    ? `${visibleFields} +${remainingCount}`
    : visibleFields;
}

const SetupItem = ({
  icon,
  title,
  status,
  statusTone = "outline",
  action,
  stackActionOnMobile = false,
  footer,
  children,
}: {
  icon: ReactNode;
  title: string;
  status?: string | null;
  statusTone?: SetupStatusTone;
  action?: ReactNode;
  stackActionOnMobile?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
}) => {
  return (
    <Item
      role="listitem"
      className="items-start rounded-none border-x-0 border-t-0 border-border last:border-b-0"
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{title}</ItemTitle>
        {status ? (
          <Badge
            variant={statusTone}
            className="max-w-full whitespace-normal break-words text-left"
          >
            {status}
          </Badge>
        ) : null}
        {children}
      </ItemContent>
      {action ? (
        <ItemActions
          className={
            stackActionOnMobile
              ? "w-full shrink-0 justify-end sm:w-auto"
              : "shrink-0"
          }
        >
          {action}
        </ItemActions>
      ) : null}
      {footer ? (
        <ItemFooter className="flex-col items-stretch gap-3">
          {footer}
        </ItemFooter>
      ) : null}
    </Item>
  );
};

function SetupStatusRows({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <ItemGroup className="gap-0 overflow-hidden rounded-2xl bg-muted/20">
        {children}
      </ItemGroup>
    </section>
  );
}

export function isPhoneRegistrationComplete(
  credentials: Pick<
    WhatsAppCredentialFields,
    | "phone_registered"
    | "phone_registration_status"
    | "platform_type"
    | "is_on_biz_app"
  >
) {
  if (credentials.phone_registered === false) return false;

  return isWhatsAppPhoneNumberRegistered(
    {
      is_on_biz_app: credentials.is_on_biz_app,
      platform_type: credentials.platform_type,
    },
    credentials
  );
}

function getPhoneRegistrationStatusLabel(
  credentials: WhatsAppCredentialFields,
  t: Translations,
  manualRepair: boolean
) {
  if (manualRepair) return t("phoneRegistrationStatusManual");

  if (isPhoneRegistrationComplete(credentials)) {
    return t("phoneRegistrationStatusReady");
  }

  if (credentials.phone_registration_error) {
    return t("phoneRegistrationStatusNeedsAttention");
  }

  const status = credentials.phone_registration_status?.trim().toUpperCase();
  if (status === "UNVERIFIED" || status === "NOT_VERIFIED") {
    return t("phoneRegistrationStatusPinRequired");
  }

  return t("phoneRegistrationStatusUnknown");
}

export function shouldShowPhoneRegistrationRepair(
  credentials: WhatsAppCredentialFields
) {
  if (isPhoneRegistrationComplete(credentials)) return false;
  return Boolean(
    credentials.phone_registration_error ||
      credentials.phone_registration_status
  );
}

export function shouldUseManualPhoneRegistrationRepair(
  credentials: WhatsAppCredentialFields
) {
  return shouldUseManualPhoneRegistrationGuidance({
    phoneRegistered: credentials.phone_registered,
    platformType: credentials.platform_type,
    storedCoexistenceFlagsIndicateSmb: hasWhatsAppBusinessAppConnectionSignal({
      embeddedSignupFlow: credentials.embedded_signup_flow,
      embeddedSignupEvent: credentials.embedded_signup_event,
      isOnBizApp: credentials.is_on_biz_app,
      coexistenceMode: credentials.coexistence_mode,
      partnerAppInstalled: credentials.partner_app_installed,
      qrRegistered: credentials.qr_registered,
      platformType: credentials.platform_type,
    }),
  });
}

const PhoneRegistrationRepairSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
    actionable?: string | null;
  } | null>(null);

  if (!shouldShowPhoneRegistrationRepair(credentials)) {
    return null;
  }

  const pinValid = /^\d{6}$/.test(pin);
  const manualRepair = shouldUseManualPhoneRegistrationRepair(credentials);
  const status = getPhoneRegistrationStatusLabel(credentials, t, manualRepair);
  const managerUrl = buildWhatsAppManagerPortalUrl(credentials);

  const handleRegister = async () => {
    if (!pinValid) {
      setFeedback({ tone: "error", message: t("phoneRegistrationPinInvalid") });
      return;
    }

    setIsRegistering(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/whatsapp/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          action: "register_phone",
          pin,
        }),
      });
      const payload = (await res.json()) as {
        success?: boolean;
        error?: string;
        actionable?: string | null;
      };

      if (!res.ok || payload.success === false) {
        const error = new Error(
          payload.error || t("phoneRegistrationFailed")
        ) as Error & { actionable?: string | null };
        error.actionable = payload.actionable;
        throw error;
      }

      setPin("");
      setFeedback({
        tone: "success",
        message: t("phoneRegistrationSuccess"),
      });
      toast.success(t("phoneRegistrationSuccess"));
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("phoneRegistrationFailed");
      const actionable =
        error instanceof Error &&
        typeof (error as Error & { actionable?: unknown }).actionable ===
          "string"
          ? (error as Error & { actionable?: string }).actionable
          : null;
      setFeedback({ tone: "error", message, actionable });
      toast.error(message);
    } finally {
      setIsRegistering(false);
    }
  };

  if (manualRepair) {
    return (
      <SetupItem
        icon={<KeyRound />}
        title={t("phoneRegistrationManualTitle")}
        status={t("phoneRegistrationStatus", { status })}
        statusTone="outline"
        action={
          <Button asChild variant="outline" size="sm">
            <a href={managerUrl} target="_blank" rel="noreferrer">
              <ExternalLink data-icon="inline-start" />
              {t("phoneRegistrationOpenMeta")}
            </a>
          </Button>
        }
      />
    );
  }

  return (
    <SetupItem
      icon={<KeyRound />}
      title={t("phoneRegistrationTitle")}
      status={t("phoneRegistrationStatus", { status })}
      statusTone="outline"
      footer={
        <div className="flex flex-col gap-3">
          {credentials.phone_registration_error ? (
            <ItemDescription className="line-clamp-none">
              {credentials.phone_registration_error}
            </ItemDescription>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Field className="sm:max-w-28">
              <FieldLabel
                htmlFor="whatsapp-registration-pin"
                className="sr-only"
              >
                {t("phoneRegistrationPinLabel")}
              </FieldLabel>
              <Input
                id="whatsapp-registration-pin"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={event =>
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRegister()}
              disabled={isRegistering || !pinValid}
            >
              {isRegistering ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              {isRegistering
                ? t("phoneRegistrationRegistering")
                : t("phoneRegistrationAction")}
            </Button>
          </div>
          {feedback ? (
            <Alert
              variant={feedback.tone === "error" ? "destructive" : "default"}
            >
              <AlertTitle>{feedback.message}</AlertTitle>
              {feedback.actionable ? (
                <AlertDescription>{feedback.actionable}</AlertDescription>
              ) : null}
            </Alert>
          ) : null}
        </div>
      }
    />
  );
};

const VoicemailAnnouncementSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const mediaId = credentials.calls_voicemail_announcement_media_id?.trim();
  const canUpload = Boolean(credentials.phone_number_id);
  const status = credentials.calls_voicemail_enabled
    ? t("voicemailStatusEnabled")
    : mediaId
      ? t("voicemailStatusUploaded")
      : t("voicemailStatusMissing");
  const statusTone: SetupStatusTone = credentials.calls_voicemail_enabled
    ? "secondary"
    : mediaId
      ? "outline"
      : "outline";

  const handleUpload = async () => {
    if (!file) {
      toast.error(t("voicemailFileRequired"));
      return;
    }
    if (file.type && file.type !== "audio/ogg") {
      toast.error(t("voicemailFileTypeInvalid"));
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set("workspaceId", workspaceId);
      formData.set("action", "upload_voicemail_announcement");
      formData.set("file", file);

      const res = await fetch("/api/whatsapp/onboarding", {
        method: "POST",
        body: formData,
      });
      const payload = (await res.json()) as {
        success?: boolean;
        error?: string;
        status?: { calls_voicemail_enabled?: boolean };
        warnings?: string[];
      };

      if (!res.ok || payload.success === false) {
        throw new Error(
          payload.error ||
            payload.warnings?.filter(Boolean).join("; ") ||
            t("voicemailUploadFailed")
        );
      }

      setFile(null);
      setFileInputKey(key => key + 1);
      toast.success(
        payload.status?.calls_voicemail_enabled
          ? t("voicemailUploadSuccess")
          : t("voicemailUploadSaved")
      );
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("voicemailUploadFailed")
      );
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <SetupItem
      icon={<Upload />}
      title={t("voicemailTitle")}
      status={status}
      statusTone={statusTone}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Field className="min-w-0 flex-1">
            <FieldLabel
              htmlFor="whatsapp-voicemail-announcement-file"
              className="sr-only"
            >
              {t("voicemailFileLabel")}
            </FieldLabel>
            <input
              key={fileInputKey}
              ref={fileInputRef}
              id="whatsapp-voicemail-announcement-file"
              type="file"
              accept="audio/ogg,.ogg"
              className="sr-only"
              onChange={event => setFile(event.target.files?.[0] || null)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-full justify-start"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload data-icon="inline-start" />
              <span className="truncate">
                {file ? file.name : t("voicemailChooseFile")}
              </span>
            </Button>
          </Field>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleUpload()}
            disabled={isUploading || !file || !canUpload}
          >
            {isUploading ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            {isUploading ? t("voicemailUploading") : t("voicemailUploadAction")}
          </Button>
        </div>
      }
    >
      <ItemDescription className="line-clamp-none">
        {t("voicemailDescription")}
      </ItemDescription>
    </SetupItem>
  );
};

const WebhookSetupSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(false);
  const missingFields = Array.isArray(
    credentials.webhook_missing_required_fields
  )
    ? credentials.webhook_missing_required_fields.filter(Boolean)
    : [];

  if (missingFields.length === 0) {
    return null;
  }

  const handleRecheck = async () => {
    setIsChecking(true);
    try {
      const res = await fetch("/api/whatsapp/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          action: "auto_enable_defaults",
          force: true,
          trigger: "onboarding_action",
        }),
      });
      const payload = (await res.json()) as {
        success?: boolean;
        error?: string;
        warnings?: string[];
      };

      if (!res.ok || payload.success === false) {
        throw new Error(
          payload.error ||
            payload.warnings?.filter(Boolean).join("; ") ||
            t("webhookRecheckFailed")
        );
      }

      toast.success(t("webhookRecheckSuccess"));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("webhookRecheckFailed")
      );
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <SetupItem
      icon={<Webhook />}
      title={t("webhookTitle")}
      status={t("webhookMissingFields", {
        fields: formatWebhookFieldSummary(missingFields),
      })}
      statusTone="destructive"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleRecheck()}
          disabled={isChecking}
        >
          {isChecking ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {isChecking ? t("webhookRechecking") : t("webhookRecheck")}
        </Button>
      }
    >
      <ItemDescription className="line-clamp-none">
        {t("webhookDescription")}
      </ItemDescription>
    </SetupItem>
  );
};

function getAccountHealthTone(
  state: WhatsAppAccountHealthState
): SetupStatusTone {
  switch (state) {
    case "healthy":
      return "secondary";
    case "warning":
    case "reconnecting":
    case "payment_required":
    case "unknown":
      return "outline";
    case "disconnected":
    case "restricted":
    case "disabled":
    case "inaccessible":
      return "destructive";
    default: {
      const exhaustiveState: never = state;
      return exhaustiveState;
    }
  }
}

function deriveAccountHealthFromCredentials(
  credentials: WhatsAppCredentialFields
) {
  return deriveWhatsAppAccountHealth(
    credentials as unknown as Record<string, unknown>
  );
}

const AccountHealthSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const router = useRouter();
  const initialHealth = deriveAccountHealthFromCredentials(credentials);
  const [health, setHealth] = useState<WhatsAppAccountHealth>(initialHealth);
  const [isChecking, setIsChecking] = useState(false);
  const visibleReasons = health.reasons.slice(0, 3);
  const isHealthy = health.state === "healthy";
  const alertVariant =
    health.state === "restricted" ||
    health.state === "disabled" ||
    health.state === "disconnected" ||
    health.state === "inaccessible"
      ? "destructive"
      : "default";

  useEffect(() => {
    setHealth(deriveAccountHealthFromCredentials(credentials));
  }, [credentials]);

  const handleCheckStatus = async () => {
    setIsChecking(true);
    try {
      const res = await fetch(
        `/api/whatsapp/onboarding?workspaceId=${encodeURIComponent(
          workspaceId
        )}&refresh=1`
      );
      const payload = decodeWhatsAppOnboardingHealthResponse(
        await res.json().catch(() => null)
      );

      const health = resolveWhatsAppAccountHealth(payload);
      if (health) {
        setHealth(health);
      }

      const refreshOutcome = payload?.meta_refresh?.outcome;
      const feedback = getWhatsAppMetaRefreshFeedback(refreshOutcome);
      if (!feedback) {
        throw new Error(`Unsupported Meta refresh outcome: ${refreshOutcome}`);
      }
      if (
        feedback.level === "error" ||
        (feedback.level === "success" && (!res.ok || payload?.error))
      ) {
        throw new Error(payload?.error || t("accountHealthCheckFailed"));
      }
      toast[feedback.level](t(feedback.messageKey));
      if (feedback.level !== "info") router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("accountHealthCheckFailed")
      );
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <SetupItem
      icon={isHealthy ? <ShieldCheck /> : <ShieldAlert />}
      title={t("accountHealthTitle")}
      status={t(getWhatsAppAccountHealthStatusKey(health.state))}
      statusTone={getAccountHealthTone(health.state)}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleCheckStatus()}
          disabled={isChecking}
        >
          {isChecking ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {isChecking ? t("accountHealthChecking") : t("accountHealthCheck")}
        </Button>
      }
      footer={
        visibleReasons.length > 0 ? (
          <Alert variant={alertVariant}>
            <AlertTitle className="line-clamp-none">
              {visibleReasons[0]?.title}
            </AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-2">
                {visibleReasons.map(reason => (
                  <li key={reason.code} className="flex flex-col gap-2">
                    {reason.title !== visibleReasons[0]?.title ? (
                      <span className="font-medium text-foreground">
                        {reason.title}
                      </span>
                    ) : null}
                    <span>{reason.message}</span>
                    {reason.actionUrl ? (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={reason.actionUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink data-icon="inline-start" />
                          {t("accountHealthOpenMeta")}
                        </a>
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      <ItemDescription className="line-clamp-none">
        {t("accountHealthDescription")}
      </ItemDescription>
    </SetupItem>
  );
};

export const HistorySyncSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const historyT = useTranslations("WhatsAppHistorySync");
  const router = useRouter();
  const eligible = isWhatsAppHistorySyncEligible(credentials);
  const [status, setStatus] = useState<HistorySyncStatus | null>(() => ({
    history_sync: credentials.history_sync || null,
  }));
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);
  const [statusError, setStatusError] = useState(false);
  const [rangeDays, setRangeDays] = useState(
    WHATSAPP_HISTORY_IMPORT_DEFAULT_RANGE_DAYS
  );
  const validRange =
    Number.isInteger(rangeDays) && rangeDays >= 1 && rangeDays <= 180;

  useEffect(() => {
    setStatus({ history_sync: credentials.history_sync || null });
  }, [credentials.history_sync]);

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    let timeoutId: number | null = null;

    const loadStatus = async () => {
      setIsLoadingStatus(true);
      try {
        const res = await fetch(
          `/api/whatsapp/smb-app-data?workspaceId=${workspaceId}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("history_status_unavailable");
        const payload = (await res.json()) as {
          data?: HistorySyncStatus;
        };
        const nextStatus = payload.data || null;
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        setStatusError(false);

        if (isWhatsAppHistorySyncActive(nextStatus?.history_sync)) {
          timeoutId = window.setTimeout(loadStatus, 5000);
        }
      } catch (error) {
        const errorName =
          error && typeof error === "object" && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";
        if (errorName !== "AbortError") {
          setStatusError(true);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingStatus(false);
        }
      }
    };

    loadStatus();

    return () => {
      controller.abort();
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [credentials.history_sync, eligible, workspaceId, statusRevision]);

  const handleConnectHistory = async () => {
    if (!validRange) return;
    if (!getWhatsAppHistoryRequestAvailability(status?.history_sync).canRequest)
      return;
    setIsRequesting(true);
    try {
      const res = await fetch("/api/whatsapp/smb-app-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          syncType: "history",
          rangeValue: rangeDays,
          rangeUnit: "days",
        }),
      });
      const payload = (await res.json()) as {
        data?: {
          history_sync?: WhatsAppHistorySyncState | null;
          history_sync_can_request?: boolean;
          request_id?: string;
          requested_at?: string;
          range_days?: number;
        };
        error?: string;
        actionable?: string;
      };

      if (payload.data?.history_sync) {
        setStatus({
          history_sync: payload.data.history_sync,
          history_sync_can_request: false,
        });
      }
      if (!res.ok) {
        throw new Error(
          payload.actionable || payload.error || t("historyFailed")
        );
      }

      const nextHistorySync = payload.data?.history_sync || {
        requested_at: payload.data?.requested_at || new Date().toISOString(),
        request_id: payload.data?.request_id,
        range_days: payload.data?.range_days || rangeDays,
        status: "requested" as const,
        processed_count_total: 0,
        skipped_count_total: 0,
        webhook_count: 0,
      };
      setStatus({
        history_sync: nextHistorySync,
        history_sync_can_request: false,
      });
      toast.success(t("historyRequested"));
      router.refresh();
    } catch (error) {
      // A transport error can hide Meta acceptance. Observe before offering any action.
      setStatus(previous => ({
        ...previous,
        history_sync_can_request: false,
        history_sync:
          previous?.history_sync?.requested_at ||
          previous?.history_sync?.request_state
            ? previous.history_sync
            : {
                ...previous?.history_sync,
                request_state: "unknown",
                request_attempted_at: new Date().toISOString(),
              },
      }));
      toast.error(error instanceof Error ? error.message : t("historyFailed"));
    } finally {
      setIsRequesting(false);
      setStatusRevision(value => value + 1);
    }
  };

  const historySync = status?.history_sync;
  const historySummary = buildWhatsAppHistorySyncSummary(historySync);
  const availability = getWhatsAppHistoryRequestAvailability(historySync);
  const progress = historySummary.providerProgress;
  const showProgress = historySummary.active && progress !== null;
  const canRequest =
    eligible &&
    availability.canRequest &&
    status?.history_sync_can_request === true &&
    !statusError;
  const inlineStatus = eligible
    ? historyT(historySummary.titleKey)
    : t("historyUnavailable");
  const statusTone: SetupStatusTone =
    historySummary.status === "completed"
      ? "secondary"
      : historySummary.status === "error" ||
          historySummary.status === "declined" ||
          historySummary.status === "stale"
        ? "destructive"
        : "outline";

  return (
    <SetupItem
      icon={<Database />}
      title={t("historyTitle")}
      stackActionOnMobile
      status={inlineStatus}
      statusTone={statusTone}
      action={
        canRequest ? (
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <Field className="w-40">
              <FieldLabel htmlFor={`history-range-${workspaceId}`}>
                {historyT("rangeDays")}
              </FieldLabel>
              <Input
                id={`history-range-${workspaceId}`}
                type="number"
                min={1}
                max={180}
                step={1}
                value={Number.isNaN(rangeDays) ? "" : rangeDays}
                onChange={event => setRangeDays(event.target.valueAsNumber)}
                disabled={isRequesting || isLoadingStatus}
                aria-invalid={!validRange}
              />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleConnectHistory()}
              disabled={isRequesting || isLoadingStatus || !validRange}
            >
              {isRequesting || isLoadingStatus ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Database data-icon="inline-start" />
              )}
              {isRequesting ? t("historyConnecting") : t("historyConnect")}
            </Button>
          </div>
        ) : eligible ? (
          <Button
            variant="outline"
            size="sm"
            disabled={isLoadingStatus || isRequesting}
            onClick={() => setStatusRevision(value => value + 1)}
          >
            <RefreshCw
              data-icon="inline-start"
              className={isLoadingStatus ? "animate-spin" : undefined}
            />
            {historyT("refreshStatus")}
          </Button>
        ) : null
      }
      footer={
        showProgress ? (
          <Field>
            <Progress
              value={progress ?? 0}
              aria-label={historyT("providerProgress", {
                progress: progress ?? 0,
              })}
            />
          </Field>
        ) : null
      }
    >
      {eligible ? (
        <ItemDescription
          className="line-clamp-none space-y-1"
          aria-live="polite"
        >
          <span className="block">
            {historyT(historySummary.descriptionKey, {
              count: historySummary.synchronizedCount ?? 0,
            })}
          </span>
          {canRequest ? (
            <span className="block">
              {historyT("standardAllowance", {
                messages: WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT,
                mib: WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT / 1024 ** 2,
              })}
            </span>
          ) : null}
          {historySummary.countsVerified ? (
            <span className="block">
              {historyT("savedCount", {
                count: historySummary.synchronizedCount ?? 0,
              })}
              {(historySummary.pendingCount ?? 0) > 0
                ? ` · ${historyT("pendingCount", { count: historySummary.pendingCount ?? 0 })}`
                : ""}
              {(historySummary.failedCount ?? 0) > 0
                ? ` · ${historyT("failedCount", { count: historySummary.failedCount ?? 0 })}`
                : ""}
              {(historySummary.planSkippedCount ?? 0) > 0
                ? ` · ${historyT("planSkippedCount", { count: historySummary.planSkippedCount ?? 0 })}`
                : ""}
            </span>
          ) : null}
          {progress !== null ? (
            <span className="block">
              {historyT("providerProgress", { progress })}
            </span>
          ) : null}
          {availability.reason === "onboarding_required" ||
          availability.reason === "request_window_expired" ? (
            <span className="block">
              {historyT(
                availability.reason === "onboarding_required"
                  ? "onboardingRequired"
                  : "windowExpired"
              )}
            </span>
          ) : null}
          {statusError ? (
            <span className="block text-destructive">
              {historyT("statusUnavailable")}
            </span>
          ) : null}
        </ItemDescription>
      ) : null}
    </SetupItem>
  );
};

const MarketingMessagesOnboardingSection = ({
  t,
  credentials,
  workspaceId,
}: {
  t: Translations;
  credentials: WhatsAppCredentialFields;
  workspaceId: string;
}) => {
  const router = useRouter();
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [agreementStatus, setAgreementStatus] = useState<string | null>(null);
  const [isEnrollingMaxPrice, setIsEnrollingMaxPrice] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [marketingStatus, setMarketingStatus] =
    useState<
      NonNullable<
        MarketingMessagesEligibilityResponse["data"]
      >["marketing_messages"]
    >();
  const autoCheckAttempted = useRef<string | null>(null);
  const assetKey = JSON.stringify([
    workspaceId,
    credentials.phone_number_id,
    credentials.waba_id,
  ]);
  const shouldAutoCheck = shouldSyncMarketingMessagesOnboarding(credentials);
  const currentCredentials = { ...credentials, ...marketingStatus };

  const userFacingState =
    getMarketingMessagesUserFacingState(currentCredentials);
  const isReady = isMarketingMessagesApiOnboarded(currentCredentials);
  const shouldNudge =
    shouldShowMarketingMessagesOnboardingNudge(currentCredentials);
  const canEnrollMaxPrice = Boolean(credentials.business_id?.trim());
  const portalUrl = buildWhatsAppMarketingMessagesPortalUrl(credentials);
  const statusLabel =
    userFacingState === "ready"
      ? t("marketingMessagesStatusReady")
      : userFacingState === "not_ready"
        ? t("marketingMessagesStatusNotReady")
        : currentCredentials.marketing_messages_onboarding_last_checked_at
          ? t("accountHealthStatusUnknown")
          : t("marketingMessagesStatusUnknown");

  useEffect(() => {
    setMarketingStatus(undefined);
  }, [
    assetKey,
    credentials.marketing_messages_enabled,
    credentials.marketing_messages_onboarding_status,
    credentials.marketing_messages_api_status,
    credentials.marketing_messages_onboarding_last_checked_at,
  ]);

  useEffect(() => {
    if (!shouldAutoCheck || autoCheckAttempted.current === assetKey) return;

    let cancelled = false;

    const run = async () => {
      // Allow Strict Mode's setup/cleanup check to finish before starting I/O.
      await Promise.resolve();
      if (cancelled) return;
      autoCheckAttempted.current = assetKey;
      setIsCheckingStatus(true);
      try {
        const status = await fetchMarketingMessagesStatus(workspaceId);
        if (!cancelled) setMarketingStatus(status);
      } catch {
        // Background sync failures stay silent; user can refresh manually.
      } finally {
        if (!cancelled) setIsCheckingStatus(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      setIsCheckingStatus(false);
    };
  }, [assetKey, shouldAutoCheck, workspaceId]);

  if (!shouldNudge && !isReady) {
    return null;
  }

  const canSubmitMaxPriceAgreement = Boolean(
    canEnrollMaxPrice && signerName.trim() && signerEmail.trim()
  );

  const syncMarketingMessagesStatus = async () => {
    setIsCheckingStatus(true);
    try {
      const status = await fetchMarketingMessagesStatus(workspaceId);
      setMarketingStatus(status);
      toast.success(t("marketingMessagesCheckSuccess"));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("marketingMessagesCheckFailed")
      );
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const handleEnrollMaxPrice = async () => {
    if (!canEnrollMaxPrice) {
      toast.error(t("marketingMessagesEnrollMaxPriceMissingBusiness"));
      return;
    }

    setIsEnrollingMaxPrice(true);
    try {
      const res = await fetch("/api/whatsapp/max-price-agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          signerName: signerName.trim(),
          signerEmail: signerEmail.trim(),
        }),
      });
      const payload = (await res.json()) as MaxPriceAgreementResponse;

      if (!res.ok) {
        throw new Error(
          payload.actionable ||
            payload.error ||
            t("marketingMessagesEnrollMaxPriceFailed")
        );
      }

      setAgreementStatus(
        typeof payload.data?.agreement?.status === "string"
          ? payload.data.agreement.status.toUpperCase()
          : "PENDING"
      );
      toast.success(t("marketingMessagesEnrollMaxPriceSuccess"));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("marketingMessagesEnrollMaxPriceFailed")
      );
    } finally {
      setIsEnrollingMaxPrice(false);
    }
  };

  return (
    <SetupItem
      icon={<Megaphone />}
      title={t("marketingMessagesTitle")}
      status={statusLabel}
      statusTone={isReady ? "secondary" : "outline"}
      footer={
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void syncMarketingMessagesStatus()}
              disabled={isCheckingStatus}
            >
              {isCheckingStatus ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              {isCheckingStatus
                ? t("marketingMessagesChecking")
                : t("marketingMessagesCheckStatus")}
            </Button>
            {!isReady ? (
              <Button asChild variant="outline" size="sm">
                <a href={portalUrl} target="_blank" rel="noreferrer">
                  <ExternalLink data-icon="inline-start" />
                  {t("marketingMessagesAction")}
                </a>
              </Button>
            ) : null}
          </div>
          {isReady && canEnrollMaxPrice ? (
            <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  <ChevronDown
                    data-icon="inline-start"
                    className={cn(showAdvanced && "rotate-180")}
                  />
                  {t("marketingMessagesAdvanced")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <FieldGroup className="gap-3 rounded-xl bg-background p-3">
                  <FieldDescription>
                    {t("marketingMessagesMaxPriceHint")}
                  </FieldDescription>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(14rem,1.2fr)_max-content] xl:items-end">
                    <Field>
                      <FieldLabel htmlFor="whatsapp-max-price-signer-name">
                        {t("marketingMessagesSignerNameLabel")}
                      </FieldLabel>
                      <Input
                        id="whatsapp-max-price-signer-name"
                        value={signerName}
                        onChange={event => setSignerName(event.target.value)}
                        placeholder={t(
                          "marketingMessagesSignerNamePlaceholder"
                        )}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="whatsapp-max-price-signer-email">
                        {t("marketingMessagesSignerEmailLabel")}
                      </FieldLabel>
                      <Input
                        id="whatsapp-max-price-signer-email"
                        value={signerEmail}
                        onChange={event => setSignerEmail(event.target.value)}
                        placeholder={t(
                          "marketingMessagesSignerEmailPlaceholder"
                        )}
                        type="email"
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleEnrollMaxPrice()}
                      disabled={
                        !canSubmitMaxPriceAgreement || isEnrollingMaxPrice
                      }
                      className="md:col-span-2 xl:col-span-1"
                    >
                      {isEnrollingMaxPrice ? (
                        <Loader2
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <Megaphone data-icon="inline-start" />
                      )}
                      {isEnrollingMaxPrice
                        ? t("marketingMessagesEnrollingMaxPrice")
                        : t("marketingMessagesEnrollMaxPrice")}
                    </Button>
                  </div>
                  {agreementStatus ? (
                    <FieldDescription>
                      {t("marketingMessagesMaxPriceStatus", {
                        status: agreementStatus,
                      })}
                    </FieldDescription>
                  ) : null}
                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      }
    >
      <ItemDescription className="line-clamp-none">
        {isReady
          ? t("marketingMessagesReadyDescription")
          : t("marketingMessagesDescription")}
      </ItemDescription>
    </SetupItem>
  );
};

const ManualUpdateSection = ({
  t,
  workspaceId,
}: {
  t: Translations;
  workspaceId: string;
}) => {
  const router = useRouter();
  const [newToken, setNewToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleUpdate = async () => {
    if (!newToken) {
      toast.error(t("newTokenRequired"));
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch("/api/sources/whatsapp", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: newToken,
          workspace_id: workspaceId,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || t("failedToUpdateToken"));
      }
      toast.success(t("tokenUpdatedSuccess"));
      setNewToken("");
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <FieldGroup className="gap-3 rounded-xl bg-background p-4">
      <Field>
        <ItemTitle>{t("manualUpdateTitle")}</ItemTitle>
        <FieldDescription>{t("manualUpdateDescription")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="new_access_token">
          {t("newAccessToken")}
        </FieldLabel>
        <Input
          id="new_access_token"
          name="new_access_token"
          type="password"
          value={newToken}
          onChange={e => setNewToken(e.target.value)}
          placeholder={t("pasteNewToken")}
        />
      </Field>
      <div>
        <Button
          type="button"
          onClick={() => void handleUpdate()}
          disabled={isLoading}
          size="sm"
        >
          {isLoading ? t("saving") : t("saveToken")}
        </Button>
      </div>
    </FieldGroup>
  );
};

const ManualUpdateCollapsible = ({
  t,
  workspaceId,
  open,
  onOpenChange,
}: {
  t: Translations;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  return (
    <Item
      role="listitem"
      className="items-start rounded-none border-x-0 border-t-0 border-border last:border-b-0"
    >
      <ItemMedia variant="icon">
        <KeyRound />
      </ItemMedia>
      <ItemContent>
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              {open ? t("cancelUpdate") : t("manualUpdate")}
              <ChevronDown
                data-icon="inline-end"
                className={cn(open && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <ManualUpdateSection t={t} workspaceId={workspaceId} />
          </CollapsibleContent>
        </Collapsible>
      </ItemContent>
    </Item>
  );
};

export function WhatsAppIntegrationForm({
  credentialsProps,
  workspaceId,
}: {
  credentialsProps: WhatsAppCredentialFields;
  workspaceId: string;
}) {
  const router = useRouter();
  const [credentials, setCredentials] = useState<WhatsAppCredentials>({
    phone_number_id: "",
    waba_id: "",
    access_token: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [showManualUpdate, setShowManualUpdate] = useState(false);
  const t = useTranslations("WhatsAppIntegrationForm");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCredentials({ ...credentials, [e.target.name]: e.target.value });
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/sources/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials, workspace_id: workspaceId }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || t("failedToSaveCredentials"));
      }
      toast.success(t("integrationSuccess"));
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  if (credentialsProps) {
    return (
      <SetupStatusRows label={t("setupStatusLabel")}>
        <AccountHealthSection
          key={JSON.stringify([
            "account-health",
            workspaceId,
            credentialsProps.phone_number_id,
            credentialsProps.waba_id,
          ])}
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <HistorySyncSection
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <WebhookSetupSection
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <PhoneRegistrationRepairSection
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <VoicemailAnnouncementSection
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <MarketingMessagesOnboardingSection
          key={JSON.stringify([
            "marketing-messages",
            workspaceId,
            credentialsProps.phone_number_id,
            credentialsProps.waba_id,
          ])}
          t={t}
          credentials={credentialsProps}
          workspaceId={workspaceId}
        />
        <ManualUpdateCollapsible
          t={t}
          workspaceId={workspaceId}
          open={showManualUpdate}
          onOpenChange={setShowManualUpdate}
        />
      </SetupStatusRows>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connectWhatsapp")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="phone_number_id">
              {t("phoneNumberId")}
            </FieldLabel>
            <Input
              id="phone_number_id"
              name="phone_number_id"
              value={credentials.phone_number_id}
              onChange={handleChange}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="waba_id">{t("wabaId")}</FieldLabel>
            <Input
              id="waba_id"
              name="waba_id"
              value={credentials.waba_id}
              onChange={handleChange}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="access_token">{t("accessToken")}</FieldLabel>
            <Input
              id="access_token"
              name="access_token"
              type="password"
              value={credentials.access_token}
              onChange={handleChange}
            />
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isLoading}
        >
          {isLoading ? t("saving") : t("saveAndConnect")}
        </Button>
      </CardFooter>
    </Card>
  );
}
