"use client";

import { EmbeddedSignupButton } from "@/components/integrations/embedded-signup-button";
import { formatMessagingLimitTier } from "@/components/messengers/messaging-limit";
import { isCallsSetupReady } from "@/components/messengers/upgrade-messenger-calls";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  buildWhatsAppHistorySyncSummary,
  isWhatsAppHistorySyncActive,
} from "@/lib/whatsapp/history-sync/status";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";
import { useTranslations } from "next-intl";
import {
  formatWhatsAppStatusDate,
  humanizeWhatsAppStatus,
} from "@/lib/whatsapp/status-format";
import type { WhatsAppOnboardingStatus } from "@/lib/whatsapp/onboarding-status";
import {
  isSmbPlatformType,
  shouldUseManualPhoneRegistrationGuidance,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";

const WHATSAPP_MANAGER_URL = "https://business.facebook.com/wa/manage/home/";
const SECURITY_CENTER_URL =
  "https://business.facebook.com/settings/security_center";
const BUSINESS_VERIFICATION_DOCS_URL =
  "https://www.facebook.com/help/243868559497297/";
const COEXISTENCE_DOC_URL =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users";
const OBA_DOC_URL =
  "https://developers.facebook.com/docs/whatsapp/solution-providers";

type BusinessStatus = {
  status?: string;
  time?: string;
};

type EligibilityData = {
  waba: {
    id: string;
    name?: string;
    account_review_status?: string;
    marketing_messages_onboarding_status?: string | BusinessStatus;
    owner_business_info?: {
      id?: string;
      name?: string;
      marketing_messages_onboarding_status?: string | BusinessStatus;
    };
  };
  business?: {
    id: string;
    name?: string;
    marketing_messages_onboarding_status?: string | BusinessStatus;
  } | null;
  business_error?: string;
  business_actionable?: string;
};

type SyncStatus = {
  history_sync?: WhatsAppHistorySyncState | null;
  contact_sync?: {
    requested_at?: string;
    request_id?: string;
  } | null;
};

type OnboardingResponse = {
  connected: boolean;
  status: WhatsAppOnboardingStatus | null;
};

type CallsAutoSetupStepStatus = "success" | "failed" | "skipped";

type CallsAutoSetupStepResult = {
  status: CallsAutoSetupStepStatus;
  message: string;
};

type CallsAutoSetupStepResults = {
  step3_subscribe_waba?: CallsAutoSetupStepResult;
  step4_verify_waba_subscription?: CallsAutoSetupStepResult;
  step8_enable_calling_defaults?: CallsAutoSetupStepResult;
  step9_verify_calling_settings?: CallsAutoSetupStepResult;
};

type ReadinessTone = "ready" | "blocked" | "attention" | "manual" | "unknown";

type CheckItem = {
  id: string;
  label: string;
  value: string;
  note: string;
  tone: ReadinessTone;
  required?: boolean;
};

type InlineFeedback = {
  tone: "success" | "error" | "info";
  title?: string;
  message: string;
  actionable?: string | null;
  docs?: string[];
};

type TabValue = "badge" | "setup" | "technical";

type OnboardingAction = "register_phone" | "auto_enable_defaults";

async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : "Failed to fetch data."
    );
  }

  return data as T;
}

function readDocs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
}

function humanizeStatus(value?: string | null) {
  return humanizeWhatsAppStatus(value);
}

function formatDateTime(value?: string | null) {
  return formatWhatsAppStatusDate(value);
}

function formatStatusValue(value?: string | BusinessStatus | null) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.status;
}

function formatStatusTime(value?: string | BusinessStatus | null) {
  if (!value || typeof value === "string") return undefined;
  return value.time;
}

function getToneUi(tone: ReadinessTone) {
  switch (tone) {
    case "ready":
      return {
        badgeClassName:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        panelClassName:
          "border-emerald-500/20 bg-emerald-500/5 text-emerald-950 dark:text-emerald-100",
        label: "Ready",
      };
    case "blocked":
      return {
        badgeClassName:
          "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        panelClassName:
          "border-red-500/20 bg-red-500/5 text-red-950 dark:text-red-100",
        label: "Blocked",
      };
    case "attention":
      return {
        badgeClassName:
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        panelClassName:
          "border-amber-500/20 bg-amber-500/5 text-amber-950 dark:text-amber-100",
        label: "Attention",
      };
    case "manual":
      return {
        badgeClassName:
          "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        panelClassName:
          "border-sky-500/20 bg-sky-500/5 text-sky-950 dark:text-sky-100",
        label: "Manual",
      };
    default:
      return {
        badgeClassName:
          "border-border bg-muted text-muted-foreground dark:bg-muted/60",
        panelClassName: "border-border bg-muted/40 text-foreground",
        label: "Unknown",
      };
  }
}

function buildBusinessVerificationCheck(
  status?: string,
  updatedAt?: string
): CheckItem {
  const normalized = status?.toUpperCase();

  if (normalized === "VERIFIED") {
    return {
      id: "business-verification",
      label: "Meta business verification",
      value: "Verified",
      note: updatedAt
        ? `Last webhook update: ${formatDateTime(updatedAt)}.`
        : "Meta has marked the business as verified.",
      tone: "ready",
    };
  }

  if (normalized === "PENDING" || normalized === "IN_REVIEW") {
    return {
      id: "business-verification",
      label: "Meta business verification",
      value: humanizeStatus(status),
      note: "Finish the verification flow in Meta Security Center before expecting the badge.",
      tone: "attention",
    };
  }

  if (normalized === "REJECTED" || normalized === "UNVERIFIED") {
    return {
      id: "business-verification",
      label: "Meta business verification",
      value: humanizeStatus(status),
      note: "This is a hard blocker for OBA. Resolve it in Meta first.",
      tone: "blocked",
    };
  }

  return {
    id: "business-verification",
    label: "Meta business verification",
    value: "Check in Meta",
    note: "We have not received a verification status webhook yet, so confirm this directly in Meta.",
    tone: "unknown",
  };
}

function buildAccountReviewCheck(status?: string): CheckItem {
  const normalized = status?.toUpperCase();

  if (normalized === "APPROVED") {
    return {
      id: "account-review",
      label: "WhatsApp account review",
      value: "Approved",
      note: "Your WhatsApp business account review is not currently blocking the request.",
      tone: "ready",
    };
  }

  if (normalized === "PENDING" || normalized === "IN_REVIEW") {
    return {
      id: "account-review",
      label: "WhatsApp account review",
      value: humanizeStatus(status),
      note: "Wait for Meta to finish reviewing the account before treating the badge request as ready.",
      tone: "attention",
    };
  }

  if (normalized === "REJECTED" || normalized === "DISABLED") {
    return {
      id: "account-review",
      label: "WhatsApp account review",
      value: humanizeStatus(status),
      note: "This must be resolved in WhatsApp Manager before asking for OBA.",
      tone: "blocked",
    };
  }

  return {
    id: "account-review",
    label: "WhatsApp account review",
    value: "Unknown",
    note: "Refresh the live status and confirm the review state in WhatsApp Manager.",
    tone: "unknown",
  };
}

function buildDisplayNameCheck(status?: string): CheckItem {
  const normalized = status?.toUpperCase();

  if (normalized === "APPROVED") {
    return {
      id: "display-name",
      label: "Display name approval",
      value: "Approved",
      note: "The public business name attached to the phone number is approved.",
      tone: "ready",
    };
  }

  if (normalized === "PENDING" || normalized === "IN_REVIEW") {
    return {
      id: "display-name",
      label: "Display name approval",
      value: humanizeStatus(status),
      note: "Let Meta finish reviewing the display name before requesting the badge.",
      tone: "attention",
    };
  }

  if (normalized === "REJECTED") {
    return {
      id: "display-name",
      label: "Display name approval",
      value: "Rejected",
      note: "Use a real, customer-facing business name and re-submit in Meta.",
      tone: "blocked",
    };
  }

  return {
    id: "display-name",
    label: "Display name approval",
    value: "Unknown",
    note: "We cannot confirm display name approval yet.",
    tone: "unknown",
  };
}

function buildPhoneRegistrationCheck(
  registered?: boolean,
  status?: string,
  manualSetup?: boolean
): CheckItem {
  if (registered) {
    return {
      id: "phone-registration",
      label: "Phone registration",
      value: humanizeStatus(status || "VERIFIED"),
      note: "The business number is registered and ready for platform use.",
      tone: "ready",
    };
  }

  if (manualSetup) {
    return {
      id: "phone-registration",
      label: "Coexistence phone setup",
      value: humanizeStatus(status || "MANAGED_BY_META"),
      note: "Meta manages this in WhatsApp Business app or WhatsApp Manager. There is no Cloud API PIN step here.",
      tone: "attention",
    };
  }

  return {
    id: "phone-registration",
    label: "Phone registration",
    value: humanizeStatus(status || "NOT_REGISTERED"),
    note: "Finish phone setup before thinking about an OBA request.",
    tone: "blocked",
  };
}

function buildTwoStepCheck(
  enabled?: boolean,
  manualSetup?: boolean
): CheckItem {
  if (enabled === true) {
    return {
      id: "two-step",
      label: "Two-step verification",
      value: "Enabled",
      note: "The business number already has a PIN configured.",
      tone: "ready",
    };
  }

  if (enabled === false) {
    if (manualSetup) {
      return {
        id: "two-step",
        label: "Two-step verification",
        value: "Confirm in Meta",
        note: "For coexistence, set or confirm the PIN in WhatsApp Business app or WhatsApp Manager.",
        tone: "attention",
      };
    }

    return {
      id: "two-step",
      label: "Two-step verification",
      value: "Missing",
      note: "Set a PIN first. Meta expects stronger account protection here.",
      tone: "blocked",
    };
  }

  return {
    id: "two-step",
    label: "Two-step verification",
    value: "Unknown",
    note: manualSetup
      ? "Refresh after the customer confirms setup in Meta."
      : "Refresh the number status to confirm whether a PIN is active.",
    tone: manualSetup ? "attention" : "unknown",
  };
}

function buildQualityCheck(quality?: string): CheckItem {
  const normalized = quality?.toUpperCase();

  if (normalized === "GREEN") {
    return {
      id: "quality",
      label: "Messaging quality",
      value: "Green",
      note: "Healthy quality helps avoid avoidable trust and policy issues.",
      tone: "ready",
      required: false,
    };
  }

  if (normalized === "YELLOW") {
    return {
      id: "quality",
      label: "Messaging quality",
      value: "Yellow",
      note: "Not a formal OBA blocker, but fix quality issues before you rush a request.",
      tone: "attention",
      required: false,
    };
  }

  if (normalized === "RED") {
    return {
      id: "quality",
      label: "Messaging quality",
      value: "Red",
      note: "Resolve user feedback or policy issues before asking Meta for extra trust signals.",
      tone: "attention",
      required: false,
    };
  }

  return {
    id: "quality",
    label: "Messaging quality",
    value: "Unknown",
    note: "Quality is a health signal, not a direct badge switch.",
    tone: "unknown",
    required: false,
  };
}

function FeedbackPanel({ feedback }: { feedback: InlineFeedback | null }) {
  if (!feedback) return null;

  const toneClassName =
    feedback.tone === "success"
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-950 dark:text-emerald-100"
      : feedback.tone === "error"
        ? "border-red-500/20 bg-red-500/5 text-red-950 dark:text-red-100"
        : "border-sky-500/20 bg-sky-500/5 text-sky-950 dark:text-sky-100";

  return (
    <div
      className={cn("grid gap-2 rounded-xl border p-4 text-sm", toneClassName)}
    >
      {feedback.title ? (
        <div className="font-medium">{feedback.title}</div>
      ) : null}
      <p>{feedback.message}</p>
      {feedback.actionable ? (
        <p className="text-sm/6 text-current/80">{feedback.actionable}</p>
      ) : null}
      {feedback.docs?.length ? (
        <div className="flex flex-wrap gap-2">
          {feedback.docs.map(doc => (
            <Button key={doc} asChild size="sm" variant="outline">
              <a href={doc} target="_blank" rel="noopener noreferrer">
                Open guide
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusRow({ item }: { item: CheckItem }) {
  const ui = getToneUi(item.tone);

  return (
    <div className="grid gap-2 rounded-xl border border-border/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">
            {item.label}
          </div>
          <div className="text-sm text-muted-foreground">{item.note}</div>
        </div>
        <Badge className={ui.badgeClassName}>{ui.label}</Badge>
      </div>
      <div className="text-sm font-medium text-foreground">{item.value}</div>
    </div>
  );
}

export function UpgradeMessengerView({ workspaceId }: { workspaceId: string }) {
  const historyT = useTranslations("WhatsAppHistorySync");
  const [activeTab, setActiveTab] = useState<TabValue>("badge");
  const [pinMode, setPinMode] = useState<"generate" | "custom">("generate");
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [customPin, setCustomPin] = useState("");
  const [pinSaved, setPinSaved] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);
  const [setupBusy, setSetupBusy] = useState<
    OnboardingAction | "refresh" | null
  >(null);
  const [callsStepResults, setCallsStepResults] =
    useState<CallsAutoSetupStepResults | null>(null);
  const [setupFeedback, setSetupFeedback] = useState<InlineFeedback | null>(
    null
  );
  const [callsFeedback, setCallsFeedback] = useState<InlineFeedback | null>(
    null
  );
  const [syncFeedback, setSyncFeedback] = useState<InlineFeedback | null>(null);
  const [syncBusy, setSyncBusy] = useState<"smb_app_state_sync" | null>(null);

  const {
    data: onboardingData,
    error: onboardingError,
    isLoading: onboardingLoading,
    mutate: mutateOnboarding,
  } = useSWR<OnboardingResponse>(
    workspaceId ? `/api/whatsapp/onboarding?workspaceId=${workspaceId}` : null,
    jsonFetcher,
    { revalidateOnFocus: false }
  );

  const connected = onboardingData?.connected ?? false;
  const onboardingStatus = onboardingData?.status ?? null;

  const {
    data: eligibilityResponse,
    error: eligibilityError,
    isLoading: eligibilityLoading,
    mutate: mutateEligibility,
  } = useSWR<{ data: EligibilityData }>(
    activeTab === "technical" && connected
      ? `/api/whatsapp/mm-eligibility?workspaceId=${workspaceId}`
      : null,
    jsonFetcher,
    { revalidateOnFocus: false }
  );

  const { data: syncResponse, mutate: mutateSyncStatus } = useSWR<{
    data: SyncStatus;
  }>(
    activeTab === "technical" && connected
      ? `/api/whatsapp/smb-app-data?workspaceId=${workspaceId}`
      : null,
    jsonFetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: response =>
        isWhatsAppHistorySyncActive(response?.data?.history_sync) ? 5_000 : 0,
    }
  );

  const eligibility = eligibilityResponse?.data ?? null;
  const syncStatus = syncResponse?.data ?? null;
  const historySummary = buildWhatsAppHistorySyncSummary(
    syncStatus?.history_sync
  );
  const messagingLimit =
    onboardingStatus?.whatsapp_business_manager_messaging_limit ||
    onboardingStatus?.phone_messaging_limit;

  const generatedPinValue = generatedPin || "";
  const pinToSubmit =
    pinMode === "custom" ? customPin.trim() : generatedPinValue;
  const pinValid = /^\d{6}$/.test(pinToSubmit);
  const canRegister = pinMode === "custom" ? pinValid : pinValid && pinSaved;

  const isExistingCoexistenceAccount = Boolean(
    onboardingStatus?.coexistence_mode ||
      onboardingStatus?.partner_app_installed ||
      onboardingStatus?.embedded_signup ||
      onboardingStatus?.onboarding_completed
  );
  const requiresManualPhoneSetup =
    onboardingStatus &&
    shouldUseManualPhoneRegistrationGuidance({
      phoneRegistered: onboardingStatus.phone_registered,
      platformType: onboardingStatus.platform_type,
      storedCoexistenceFlagsIndicateSmb: isExistingCoexistenceAccount,
    });
  const showApiPhoneRegistration =
    connected &&
    onboardingStatus &&
    !onboardingStatus.phone_registered &&
    !requiresManualPhoneSetup;

  const businessVerificationCheck = useMemo(
    () =>
      buildBusinessVerificationCheck(
        onboardingStatus?.business_verification_status,
        onboardingStatus?.verification_updated_at
      ),
    [
      onboardingStatus?.business_verification_status,
      onboardingStatus?.verification_updated_at,
    ]
  );

  const accountReviewCheck = useMemo(
    () => buildAccountReviewCheck(onboardingStatus?.account_review_status),
    [onboardingStatus?.account_review_status]
  );

  const displayNameCheck = useMemo(
    () => buildDisplayNameCheck(onboardingStatus?.name_status),
    [onboardingStatus?.name_status]
  );

  const phoneRegistrationCheck = useMemo(
    () =>
      buildPhoneRegistrationCheck(
        onboardingStatus?.phone_registered,
        onboardingStatus?.phone_registration_status,
        Boolean(requiresManualPhoneSetup)
      ),
    [
      onboardingStatus?.phone_registered,
      onboardingStatus?.phone_registration_status,
      requiresManualPhoneSetup,
    ]
  );

  const twoStepCheck = useMemo(
    () =>
      buildTwoStepCheck(
        onboardingStatus?.two_step_pin_enabled,
        Boolean(requiresManualPhoneSetup)
      ),
    [onboardingStatus?.two_step_pin_enabled, requiresManualPhoneSetup]
  );

  const qualityCheck = useMemo(
    () => buildQualityCheck(onboardingStatus?.quality_rating),
    [onboardingStatus?.quality_rating]
  );

  const readinessChecks = useMemo(
    () => [
      businessVerificationCheck,
      accountReviewCheck,
      displayNameCheck,
      phoneRegistrationCheck,
      twoStepCheck,
      qualityCheck,
    ],
    [
      accountReviewCheck,
      businessVerificationCheck,
      displayNameCheck,
      phoneRegistrationCheck,
      qualityCheck,
      twoStepCheck,
    ]
  );

  const blockerCount = readinessChecks.filter(
    item => item.required !== false && item.tone === "blocked"
  ).length;
  const attentionCount = readinessChecks.filter(
    item => item.required !== false && item.tone === "attention"
  ).length;
  const unknownCount = readinessChecks.filter(
    item => item.required !== false && item.tone === "unknown"
  ).length;

  const readinessTone: ReadinessTone = !connected
    ? "blocked"
    : blockerCount > 0
      ? "blocked"
      : attentionCount > 0 || unknownCount > 0
        ? "attention"
        : "ready";
  const readinessUi = getToneUi(readinessTone);

  const readinessTitle = !connected
    ? "Connect WhatsApp first"
    : blockerCount > 0
      ? `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} before you should ask Meta for the badge`
      : attentionCount > 0 || unknownCount > 0
        ? "You are close, but Meta still shows pending or unknown items"
        : "Technically ready. The final decision is still Meta's";

  const readinessBody = !connected
    ? "We cannot assess badge readiness until this workspace has a connected WhatsApp business account."
    : blockerCount > 0
      ? "Fix the blocked items below before you spend time preparing an OBA request."
      : attentionCount > 0 || unknownCount > 0
        ? "There are no hard blockers yet, but you still need confirmation from Meta before this feels request-ready."
        : "Your core technical checks are green. The remaining part is manual: make sure the brand is notable enough and request the review from Meta.";

  const nextSteps = useMemo(() => {
    if (!connected) {
      return [
        "Connect the WhatsApp business account to this workspace before using this checklist.",
      ];
    }

    const items = new Set<string>();

    if (businessVerificationCheck.tone !== "ready") {
      items.add(
        "Finish Meta business verification in Security Center. Use the exact legal business name, address, website, and a matching contact method."
      );
    }

    if (accountReviewCheck.tone !== "ready") {
      items.add(
        "Open WhatsApp Manager and check the account review state. Resolve any rejected or pending review before expecting the badge."
      );
    }

    if (displayNameCheck.tone !== "ready") {
      items.add(
        "Get the phone number display name approved. Meta will not treat a weak or unapproved display name as badge-ready."
      );
    }

    if (
      phoneRegistrationCheck.tone !== "ready" ||
      twoStepCheck.tone !== "ready"
    ) {
      items.add(
        requiresManualPhoneSetup
          ? "Confirm coexistence phone setup and two-step verification in WhatsApp Business app or WhatsApp Manager."
          : "Complete phone registration and two-step verification from the Setup tab."
      );
    }

    if (qualityCheck.tone === "attention") {
      items.add(
        "Improve messaging quality before requesting OBA. Bad user feedback makes the request weaker and can trigger restrictions."
      );
    }

    items.add(
      "Prepare your notability evidence. The badge is not granted for technical setup alone, and this app cannot submit or guarantee the approval."
    );

    if (blockerCount === 0 && attentionCount === 0 && unknownCount === 0) {
      items.add(
        "When everything above is green, open WhatsApp Manager and request the official review from Meta."
      );
    }

    return [...items];
  }, [
    accountReviewCheck.tone,
    attentionCount,
    blockerCount,
    businessVerificationCheck.tone,
    connected,
    displayNameCheck.tone,
    phoneRegistrationCheck.tone,
    qualityCheck.tone,
    requiresManualPhoneSetup,
    twoStepCheck.tone,
    unknownCount,
  ]);

  const marketingWabaStatus = formatStatusValue(
    eligibility?.waba.marketing_messages_onboarding_status
  );
  const marketingBusinessStatus =
    formatStatusValue(
      eligibility?.business?.marketing_messages_onboarding_status
    ) ||
    formatStatusValue(
      eligibility?.waba.owner_business_info
        ?.marketing_messages_onboarding_status
    );
  const marketingBusinessStatusTime =
    formatStatusTime(
      eligibility?.business?.marketing_messages_onboarding_status
    ) ||
    formatStatusTime(
      eligibility?.waba.owner_business_info
        ?.marketing_messages_onboarding_status
    );

  const generatePin = () => {
    const pin = Math.floor(100000 + Math.random() * 900000)
      .toString()
      .padStart(6, "0");

    setGeneratedPin(pin);
    setPinSaved(false);
    setPinCopied(false);
    setSetupFeedback({
      tone: "info",
      title: "PIN generated",
      message: "Save this PIN now. We do not store it for the customer.",
    });
  };

  const copyGeneratedPin = async () => {
    if (!generatedPinValue) return;

    try {
      await navigator.clipboard.writeText(generatedPinValue);
      setPinCopied(true);
      setSetupFeedback({
        tone: "success",
        title: "PIN copied",
        message:
          "The PIN is in your clipboard. Store it in a safe place before you continue.",
      });
    } catch {
      setSetupFeedback({
        tone: "error",
        title: "Copy failed",
        message:
          "Clipboard access failed. Copy the PIN manually before continuing.",
      });
    }
  };

  const refreshOnboardingStatus = async () => {
    setSetupBusy("refresh");
    setSetupFeedback(null);

    try {
      await mutateOnboarding();
    } finally {
      setSetupBusy(null);
    }
  };

  const runOnboardingAction = async (
    action: OnboardingAction,
    payload?: Record<string, unknown>
  ) => {
    const setFeedback =
      action === "register_phone" ? setSetupFeedback : setCallsFeedback;

    if (action === "register_phone") {
      setSetupBusy(action);
      setSetupFeedback(null);
    } else {
      setCallsFeedback(null);
      setCallsStepResults(null);
    }

    try {
      const res = await fetch("/api/whatsapp/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          action,
          ...payload,
        }),
      });

      const data = await res.json();

      if (action === "auto_enable_defaults") {
        setCallsStepResults(
          (data?.step_results as CallsAutoSetupStepResults | undefined) || null
        );
      }

      if (!res.ok || data?.success === false) {
        setFeedback({
          tone: "error",
          title:
            action === "register_phone"
              ? "Setup not finished"
              : "Calling API setup could not finish",
          message:
            typeof data?.error === "string"
              ? data.error
              : "The action could not be completed.",
          actionable:
            typeof data?.actionable === "string" ? data.actionable : null,
          docs: readDocs(data?.docs),
        });

        await mutateOnboarding();
        return;
      }

      if (action === "register_phone") {
        setGeneratedPin(null);
        setPinSaved(false);
        setPinCopied(false);
      }

      setFeedback({
        tone: "success",
        title:
          action === "register_phone"
            ? "Phone setup updated"
            : "Calling API check finished",
        message:
          action === "register_phone"
            ? "The phone registration step completed. Refreshing live readiness now."
            : "Calling API defaults were checked. This does not affect OBA approval.",
      });

      await mutateOnboarding();
    } catch (error) {
      setFeedback({
        tone: "error",
        title: "Action failed",
        message:
          error instanceof Error
            ? error.message
            : "The action could not be completed.",
      });
    } finally {
      if (action === "register_phone") {
        setSetupBusy(null);
      }
    }
  };

  const handleSync = async (syncType: "smb_app_state_sync") => {
    setSyncBusy(syncType);
    setSyncFeedback(null);

    try {
      const res = await fetch("/api/whatsapp/smb-app-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          syncType,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSyncFeedback({
          tone: "error",
          title: "Sync request failed",
          message:
            typeof data?.error === "string"
              ? data.error
              : "The sync request failed.",
          actionable:
            typeof data?.actionable === "string" ? data.actionable : null,
          docs: readDocs(data?.docs),
        });
        return;
      }

      setSyncFeedback({
        tone: "success",
        title: "Sync requested",
        message: "Contact sync requested.",
      });

      await mutateSyncStatus();
    } catch (error) {
      setSyncFeedback({
        tone: "error",
        title: "Sync request failed",
        message:
          error instanceof Error ? error.message : "The sync request failed.",
      });
    } finally {
      setSyncBusy(null);
    }
  };

  const callsReady = isCallsSetupReady(onboardingStatus);
  const callOperationalChecks =
    onboardingStatus?.calls_operational_readiness?.checks || [];
  const callsRestrictions = onboardingStatus?.calls_restrictions || [];
  const voicemailTriggers =
    onboardingStatus?.calls_voicemail_triggers?.filter(Boolean) || [];
  const voicemailStatus = onboardingStatus?.calls_voicemail_enabled
    ? "Enabled"
    : humanizeStatus(onboardingStatus?.calls_voicemail_status);
  const businessUsername = onboardingStatus?.business_username;
  const businessUsernameLabel =
    businessUsername?.username ||
    businessUsername?.requested_username ||
    "Not observed";
  const businessUsernameStatus = businessUsername?.status || "Unknown";

  return (
    <Tabs
      value={activeTab}
      onValueChange={value => setActiveTab(value as TabValue)}
      className="gap-6"
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="badge">Official badge</TabsTrigger>
        <TabsTrigger value="setup">Setup</TabsTrigger>
        <TabsTrigger value="technical">Technical</TabsTrigger>
      </TabsList>

      <TabsContent value="badge" className="space-y-6">
        {!connected && !onboardingLoading ? (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>WhatsApp is not connected</AlertTitle>
            <AlertDescription className="gap-3">
              <p>
                Connect the customer&apos;s WhatsApp business account first.
                Then this page can show live badge readiness.
              </p>
              <Button asChild size="sm" className="mt-1">
                <Link href={`/panel/w/${workspaceId}/settings/integrations`}>
                  Connect WhatsApp
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {onboardingError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not load live readiness</AlertTitle>
            <AlertDescription>{onboardingError.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="grid gap-5 rounded-2xl border bg-background p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BadgeCheck className="h-4 w-4" />
              Official Business Account
            </div>

            <div className="grid gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">
                A practical OBA workspace, not a sales page
              </h2>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                This page is for the WhatsApp blue badge. It focuses on what
                Meta actually checks, what we can verify by API, and what still
                depends on the customer&apos;s public brand reputation.
              </p>
            </div>

            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Reality check</AlertTitle>
              <AlertDescription>
                We can help customers get technically ready and point them to
                the right Meta screens. We cannot grant, buy, or guarantee the
                badge from inside this app.
              </AlertDescription>
            </Alert>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2 rounded-2xl border border-border/70 p-5">
                <div className="text-sm font-medium text-foreground">
                  What Meta cares about
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>Business verification in Meta must be complete.</li>
                  <li>
                    The phone and two-step verification should be properly set
                    up.
                  </li>
                  <li>
                    The display name should be approved and look legitimate.
                  </li>
                  <li>
                    Meta still decides based on authenticity and notability.
                  </li>
                </ul>
              </div>

              <div className="grid gap-2 rounded-2xl border border-border/70 p-5">
                <div className="text-sm font-medium text-foreground">
                  What this page cannot do
                </div>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>
                    It cannot auto-submit the badge request on the
                    customer&apos;s behalf.
                  </li>
                  <li>
                    It cannot turn Meta Verified into OBA or skip notability
                    review.
                  </li>
                  <li>
                    It cannot compensate for weak public presence or poor
                    quality signals.
                  </li>
                </ul>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={refreshOnboardingStatus}
                disabled={setupBusy === "refresh"}
              >
                {setupBusy === "refresh" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Refreshing
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh live checks
                  </>
                )}
              </Button>
              <Button asChild variant="outline">
                <a
                  href={WHATSAPP_MANAGER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open WhatsApp Manager
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href={SECURITY_CENTER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Security Center
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </div>
          </section>

          <section
            className={cn(
              "grid gap-4 rounded-2xl border p-6",
              readinessUi.panelClassName
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <div className="text-sm font-medium">Live readiness</div>
                <div className="text-lg font-semibold">{readinessTitle}</div>
              </div>
              <Badge className={readinessUi.badgeClassName}>
                {readinessUi.label}
              </Badge>
            </div>

            <p className="text-sm/6 text-current/80">{readinessBody}</p>

            <div className="grid gap-3">
              {readinessChecks.map(item => (
                <StatusRow key={item.id} item={item} />
              ))}
            </div>

            {onboardingStatus?.verification_updated_at ? (
              <div className="text-xs text-current/70">
                Last verification webhook:{" "}
                {formatDateTime(onboardingStatus.verification_updated_at)}
              </div>
            ) : null}
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <section className="grid gap-4 rounded-2xl border bg-background p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4" />
              What to do next
            </div>

            <ol className="space-y-3 text-sm text-muted-foreground">
              {nextSteps.map((step, index) => (
                <li
                  key={step}
                  className="flex gap-3 rounded-xl border border-border/70 p-4"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
                    {index + 1}
                  </span>
                  <span className="leading-6">{step}</span>
                </li>
              ))}
            </ol>

            <div className="grid gap-3 rounded-2xl border border-dashed p-4">
              <div className="text-sm font-medium text-foreground">
                Manual evidence to prepare
              </div>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  A public website with the same business name, domain, and
                  contact details used in Meta.
                </li>
                <li>
                  A display name that clearly matches the real brand customers
                  know.
                </li>
                <li>
                  Public proof that the brand is genuine and notable enough for
                  Meta to recognize it.
                </li>
              </ul>
            </div>
          </section>

          <section className="grid gap-4 rounded-2xl border bg-background p-6">
            <div className="text-sm font-medium text-foreground">
              Plain-language FAQ
            </div>

            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="what-is-oba">
                <AccordionTrigger>
                  Is OBA the same thing as Meta Verified?
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  No. On the WhatsApp Business Platform, treat Official Business
                  Account as the blue-badge path that Meta decides manually.
                  Meta Verified is a different product and should not be treated
                  as a guaranteed shortcut here.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="can-we-submit">
                <AccordionTrigger>
                  Can we submit the badge request from this app?
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  No. This workspace is for readiness and guidance. The customer
                  still needs to request or manage the official review in Meta.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="press">
                <AccordionTrigger>
                  Why is notability still mentioned if the API checks are green?
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  Because OBA is not awarded for technical setup alone. A
                  business can be authentic and fully configured, and still not
                  be notable enough for Meta to approve the badge.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="docs">
                <AccordionTrigger>
                  Where should the customer go in Meta?
                </AccordionTrigger>
                <AccordionContent className="grid gap-2 text-sm text-muted-foreground">
                  <a
                    href={WHATSAPP_MANAGER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    WhatsApp Manager
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href={SECURITY_CENTER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    Meta Security Center
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href={BUSINESS_VERIFICATION_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    Accepted verification documents
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href={OBA_DOC_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    Meta solution provider reference
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>
        </div>
      </TabsContent>

      <TabsContent value="setup" className="space-y-6">
        {!connected && !onboardingLoading ? (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>WhatsApp is not connected</AlertTitle>
            <AlertDescription className="gap-3">
              <p>Finish the integration first, then return here for setup.</p>
              <Button asChild size="sm">
                <Link href={`/panel/w/${workspaceId}/settings/integrations`}>
                  Connect WhatsApp
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <section className="grid gap-4 rounded-2xl border bg-background p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <div className="text-sm font-medium text-foreground">
                  Customer-facing setup
                </div>
                <p className="text-sm text-muted-foreground">
                  Keep this tab focused on the minimum setup work a business
                  owner actually understands and needs.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={refreshOnboardingStatus}
                disabled={setupBusy === "refresh"}
              >
                {setupBusy === "refresh" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Refreshing
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh status
                  </>
                )}
              </Button>
            </div>

            <div className="grid gap-3 rounded-2xl border border-border/70 p-5">
              <div className="text-sm font-medium text-foreground">
                Current account details
              </div>
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>Display phone</span>
                  <span className="text-right text-foreground">
                    {onboardingStatus?.display_phone_number || "Unknown"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Verified name</span>
                  <span className="text-right text-foreground">
                    {onboardingStatus?.verified_name || "Unknown"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Display name status</span>
                  <span className="text-right text-foreground">
                    {humanizeStatus(onboardingStatus?.name_status)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Phone registration</span>
                  <span className="text-right text-foreground">
                    {humanizeStatus(
                      onboardingStatus?.phone_registration_status
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Two-step PIN</span>
                  <span className="text-right text-foreground">
                    {onboardingStatus?.two_step_pin_enabled === true
                      ? "Enabled"
                      : onboardingStatus?.two_step_pin_enabled === false
                        ? "Missing"
                        : "Unknown"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Messaging limit</span>
                  <span className="text-right text-foreground">
                    {formatMessagingLimitTier(messagingLimit)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>WABA ID</span>
                  <span className="text-right font-mono text-xs text-foreground">
                    {onboardingStatus?.waba_id || "Unknown"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Phone number ID</span>
                  <span className="text-right font-mono text-xs text-foreground">
                    {onboardingStatus?.phone_number_id || "Unknown"}
                  </span>
                </div>
              </div>
              {onboardingStatus?.messaging_limit_last_checked_at ? (
                <div className="text-xs text-muted-foreground">
                  Limit checked from Meta:{" "}
                  {formatDateTime(
                    onboardingStatus.messaging_limit_last_checked_at
                  )}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 rounded-2xl border border-border/70 p-5">
              <div className="text-sm font-medium text-foreground">
                Meta shortcuts
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <a
                    href={WHATSAPP_MANAGER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open WhatsApp Manager
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a
                    href={SECURITY_CENTER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Security Center
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a
                    href={COEXISTENCE_DOC_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open coexistence guide
                    <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          </section>

          <section className="grid gap-4 rounded-2xl border bg-background p-6">
            <div className="grid gap-1">
              <div className="text-sm font-medium text-foreground">
                {requiresManualPhoneSetup
                  ? "Coexistence phone setup"
                  : "Phone registration and two-step PIN"}
              </div>
              <p className="text-sm text-muted-foreground">
                {requiresManualPhoneSetup
                  ? "This number is managed through Meta's WhatsApp Business app coexistence flow. Do not use Cloud API phone registration here."
                  : "This is useful only for setup. It does not request the blue badge by itself."}
              </p>
            </div>

            <FeedbackPanel feedback={setupFeedback} />

            {showApiPhoneRegistration ? (
              <div className="grid gap-4 rounded-2xl border border-border/70 p-5">
                <div className="grid gap-2">
                  <Label htmlFor="oba-pin-mode">PIN method</Label>
                  <Select
                    value={pinMode}
                    onValueChange={value =>
                      setPinMode(value as "generate" | "custom")
                    }
                  >
                    <SelectTrigger id="oba-pin-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="generate">Generate a PIN</SelectItem>
                      <SelectItem value="custom">Use my own PIN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {pinMode === "generate" ? (
                  <div className="grid gap-3 rounded-xl border border-dashed p-4">
                    {!generatedPinValue ? (
                      <Button variant="outline" onClick={generatePin}>
                        Generate PIN
                      </Button>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm text-muted-foreground">
                            Generated PIN
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={generatePin}
                          >
                            Generate new PIN
                          </Button>
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 p-3">
                          <code className="text-lg font-semibold tracking-[0.3em]">
                            {generatedPinValue}
                          </code>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={copyGeneratedPin}
                          >
                            {pinCopied ? "Copied" : "Copy"}
                          </Button>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox
                            id="oba-pin-saved"
                            checked={pinSaved}
                            onCheckedChange={value =>
                              setPinSaved(Boolean(value))
                            }
                          />
                          <Label
                            htmlFor="oba-pin-saved"
                            className="text-sm text-muted-foreground"
                          >
                            I saved this PIN in a secure place.
                          </Label>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="oba-pin-custom">6-digit PIN</Label>
                    <Input
                      id="oba-pin-custom"
                      inputMode="numeric"
                      maxLength={6}
                      value={customPin}
                      onChange={event => setCustomPin(event.target.value)}
                      placeholder="Enter 6 digits"
                    />
                    <p className="text-sm text-muted-foreground">
                      Use a PIN the customer can store safely. We do not store
                      it.
                    </p>
                  </div>
                )}

                <Button
                  onClick={() =>
                    runOnboardingAction("register_phone", {
                      pin: pinToSubmit || undefined,
                    })
                  }
                  disabled={setupBusy === "register_phone" || !canRegister}
                >
                  {setupBusy === "register_phone" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Registering
                    </>
                  ) : (
                    "Register phone number"
                  )}
                </Button>
              </div>
            ) : requiresManualPhoneSetup ? (
              <div className="grid gap-4 rounded-2xl border border-border/70 p-5">
                <div className="text-sm text-muted-foreground">
                  Finish or confirm the PIN and phone setup in WhatsApp Business
                  app or WhatsApp Manager. The Cloud API phone registration
                  endpoint is not used for coexistence numbers.
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <a
                      href={WHATSAPP_MANAGER_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open WhatsApp Manager
                      <ExternalLink className="ml-2 h-4 w-4" />
                    </a>
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      href={COEXISTENCE_DOC_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open coexistence guide
                      <ExternalLink className="ml-2 h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ) : onboardingStatus?.phone_registered ? (
              <div className="grid gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm text-emerald-800 dark:text-emerald-200">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  Phone setup is already complete
                </div>
                <p>
                  The number is already registered, so there is no extra PIN
                  step to run here.
                </p>
              </div>
            ) : (
              <div className="grid gap-2 rounded-2xl border border-border/70 p-5 text-sm text-muted-foreground">
                Refresh the live status first to see whether phone setup still
                needs work.
              </div>
            )}
          </section>
        </div>
      </TabsContent>

      <TabsContent value="technical" className="space-y-6">
        {!connected && !onboardingLoading ? (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Connect WhatsApp first</AlertTitle>
            <AlertDescription>
              This tab contains technical and operator tools that only make
              sense after the account is connected.
            </AlertDescription>
          </Alert>
        ) : null}

        <Alert>
          <Wrench className="h-4 w-4" />
          <AlertTitle>Technical tools only</AlertTitle>
          <AlertDescription>
            Everything below is implementation or messaging-ops work. None of it
            directly grants the blue badge, so keep it out of the main
            owner-facing story.
          </AlertDescription>
        </Alert>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Calling API readiness</CardTitle>
              <CardDescription>
                Useful for integrations and calling features. Not part of OBA
                approval.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <FeedbackPanel feedback={callsFeedback} />

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 p-4">
                <div className="grid gap-1">
                  <div className="text-sm font-medium text-foreground">
                    Current calling status
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Use this only if the customer needs calling inside WhatsApp.
                  </p>
                </div>
                <Badge
                  className={
                    callsReady
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  }
                >
                  {callsReady ? "Ready" : "Needs setup"}
                </Badge>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Calls webhook field
                    </span>
                    <span className="font-medium text-foreground">
                      {onboardingStatus?.calls_webhook_subscribed
                        ? "Subscribed"
                        : "Missing"}
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Calling enabled
                    </span>
                    <span className="font-medium text-foreground">
                      {onboardingStatus?.calls_enabled ? "Yes" : "No"}
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Calling status
                    </span>
                    <span className="font-medium text-foreground">
                      {humanizeStatus(onboardingStatus?.calls_status)}
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Callback permission
                    </span>
                    <span className="font-medium text-foreground">
                      {humanizeStatus(
                        onboardingStatus?.calls_callback_permission_status
                      )}
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Voicemail</span>
                    <span className="font-medium text-foreground">
                      {voicemailStatus}
                    </span>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      Voicemail triggers
                    </span>
                    <span className="font-medium text-foreground">
                      {voicemailTriggers.length > 0
                        ? voicemailTriggers.join(", ")
                        : "Not configured"}
                    </span>
                  </div>
                </div>
              </div>

              {onboardingStatus?.calls_voicemail_enabled ? (
                <div className="grid gap-2 rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="font-medium text-foreground">
                    Voicemail settings
                  </div>
                  <div className="grid gap-2 text-muted-foreground md:grid-cols-2">
                    <div>
                      Announcement media:{" "}
                      <span className="font-medium text-foreground">
                        {onboardingStatus.calls_voicemail_announcement_media_id ||
                          "Unknown"}
                      </span>
                    </div>
                    <div>
                      Timeout:{" "}
                      <span className="font-medium text-foreground">
                        {typeof onboardingStatus.calls_voicemail_timeout_seconds ===
                        "number"
                          ? `${onboardingStatus.calls_voicemail_timeout_seconds}s`
                          : "Not configured"}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}

              {callOperationalChecks.length > 0 ? (
                <div className="grid gap-3 rounded-2xl border border-border/70 p-4">
                  <div className="text-sm font-medium text-foreground">
                    Platform readiness
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {callOperationalChecks.map(check => (
                      <div
                        key={check.id}
                        className="grid gap-2 rounded-xl border border-border/70 p-3 text-sm"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-foreground">
                            {check.label}
                          </span>
                          <Badge
                            className={
                              check.ready
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            }
                          >
                            {check.ready ? "Ready" : "Missing"}
                          </Badge>
                        </div>
                        <div className="font-medium text-foreground">
                          {check.value}
                        </div>
                        {!check.ready ? (
                          <p className="text-muted-foreground">
                            {check.actionable}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    runOnboardingAction("auto_enable_defaults", {
                      force: true,
                      trigger: "upgrade_retry",
                    })
                  }
                >
                  Run calling API setup
                </Button>
                <Button variant="outline" onClick={refreshOnboardingStatus}>
                  Refresh calling status
                </Button>
              </div>

              {callsStepResults ? (
                <div className="grid gap-3 rounded-2xl border border-border/70 p-4">
                  <div className="text-sm font-medium text-foreground">
                    Last calling API run
                  </div>
                  {[
                    {
                      id: "step3_subscribe_waba",
                      label: "Step 3: subscribe WABA",
                      result: callsStepResults.step3_subscribe_waba,
                    },
                    {
                      id: "step4_verify_waba_subscription",
                      label: "Step 4: verify subscription",
                      result: callsStepResults.step4_verify_waba_subscription,
                    },
                    {
                      id: "step8_enable_calling_defaults",
                      label: "Step 8: enable calling defaults",
                      result: callsStepResults.step8_enable_calling_defaults,
                    },
                    {
                      id: "step9_verify_calling_settings",
                      label: "Step 9: verify phone settings",
                      result: callsStepResults.step9_verify_calling_settings,
                    },
                  ].map(step => {
                    const tone: ReadinessTone =
                      step.result?.status === "success"
                        ? "ready"
                        : step.result?.status === "failed"
                          ? "blocked"
                          : "unknown";
                    const ui = getToneUi(tone);

                    return (
                      <div
                        key={step.id}
                        className="grid gap-2 rounded-xl border border-border/70 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-foreground">
                            {step.label}
                          </span>
                          <Badge className={ui.badgeClassName}>
                            {step.result?.status
                              ? humanizeStatus(step.result.status)
                              : "Unknown"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {step.result?.message || "No message returned."}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {callsRestrictions.length > 0 ? (
                <div className="grid gap-2 rounded-2xl border border-border/70 p-4">
                  <div className="text-sm font-medium text-foreground">
                    Calling restrictions
                  </div>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {callsRestrictions.map((restriction, index) => (
                      <li key={`${restriction.type}-${index}`}>
                        {restriction.type}
                        {restriction.reason ? `: ${restriction.reason}` : ""}
                        {typeof restriction.expiration === "number"
                          ? ` until ${new Date(
                              restriction.expiration * 1000
                            ).toLocaleString()}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {onboardingStatus?.calls_enablement_error ||
              onboardingStatus?.calls_enablement_actionable ||
              onboardingStatus?.auto_defaults_last_error ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Calling setup issue</AlertTitle>
                  <AlertDescription>
                    {onboardingStatus.calls_enablement_error ||
                      onboardingStatus.auto_defaults_last_error}
                    {onboardingStatus.calls_enablement_actionable ? (
                      <span className="block pt-2">
                        {onboardingStatus.calls_enablement_actionable}
                      </span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Marketing messages status</CardTitle>
              <CardDescription>
                This affects marketing-message onboarding, not OBA approval.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {eligibilityError ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Could not load marketing status</AlertTitle>
                  <AlertDescription>
                    {eligibilityError.message}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    void mutateEligibility();
                  }}
                >
                  {eligibilityLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Refreshing
                    </>
                  ) : (
                    "Refresh marketing status"
                  )}
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">WABA</div>
                  <div className="pt-1 font-medium text-foreground">
                    {eligibility?.waba.name ||
                      eligibility?.waba.id ||
                      "Unknown"}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">WABA review</div>
                  <div className="pt-1 font-medium text-foreground">
                    {humanizeStatus(
                      eligibility?.waba.account_review_status ||
                        onboardingStatus?.account_review_status
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">
                    Portfolio messaging limit
                  </div>
                  <div className="pt-1 font-medium text-foreground">
                    {formatMessagingLimitTier(messagingLimit)}
                  </div>
                  <div className="pt-1 text-muted-foreground">
                    Shared by all WhatsApp phone numbers in this Meta business
                    portfolio.
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">
                    WABA marketing status
                  </div>
                  <div className="pt-1 font-medium text-foreground">
                    {humanizeStatus(marketingWabaStatus)}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">
                    Business terms status
                  </div>
                  <div className="pt-1 font-medium text-foreground">
                    {humanizeStatus(marketingBusinessStatus)}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm md:col-span-2">
                  <div className="text-muted-foreground">
                    WhatsApp business username
                  </div>
                  <div className="pt-1 font-medium text-foreground">
                    {businessUsernameLabel}
                  </div>
                  <div className="pt-1 text-muted-foreground">
                    Status: {humanizeStatus(businessUsernameStatus)}
                    {businessUsername?.last_webhook_at
                      ? ` - Last webhook update: ${formatDateTime(
                          businessUsername.last_webhook_at
                        )}`
                      : ""}
                  </div>
                  {businessUsername?.rejection_reason ? (
                    <div className="pt-1 text-red-600 dark:text-red-300">
                      Rejection: {businessUsername.rejection_reason}
                    </div>
                  ) : null}
                  <div className="pt-2 text-xs text-muted-foreground">
                    Meta exposes adopt/change in WhatsApp Manager now and API
                    support later in 2026. This username is for brand discovery;
                    the phone number remains the onboarding and registration
                    identity.
                  </div>
                </div>
              </div>

              {marketingBusinessStatusTime ? (
                <div className="text-xs text-muted-foreground">
                  Last business status update:{" "}
                  {formatDateTime(marketingBusinessStatusTime)}
                </div>
              ) : null}

              {eligibility?.business_error ? (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Business terms status note</AlertTitle>
                  <AlertDescription>
                    {eligibility.business_error}
                    {eligibility.business_actionable ? (
                      <span className="block pt-2">
                        {eligibility.business_actionable}
                      </span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Webhook field coverage</CardTitle>
              <CardDescription>
                Fields subscribed at the Meta App level. Missing ones silently
                drop messages, history sync, or echoes.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {(() => {
                const missing =
                  onboardingStatus?.webhook_missing_required_fields ?? [];
                const subscribed =
                  onboardingStatus?.waba_subscribed_fields ?? [];
                const required =
                  onboardingStatus?.webhook_required_fields ?? [];
                const isCoexistence = Boolean(
                  onboardingStatus?.coexistence_mode ||
                    onboardingStatus?.partner_app_installed ||
                    isSmbPlatformType(onboardingStatus?.platform_type)
                );
                const coverageOk = missing.length === 0 && required.length > 0;

                return (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 p-4">
                      <div className="grid gap-1">
                        <div className="text-sm font-medium text-foreground">
                          {isCoexistence
                            ? "Coexistence profile"
                            : "Cloud API profile"}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {isCoexistence
                            ? "Core Cloud API fields + history, smb_app_state_sync, smb_message_echoes."
                            : "Core Cloud API fields (messages, account_update, calls, templates, quality)."}
                        </p>
                      </div>
                      <Badge
                        className={
                          coverageOk
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : missing.length > 0
                              ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                              : "border-border bg-muted text-muted-foreground"
                        }
                      >
                        {coverageOk
                          ? "Complete"
                          : missing.length > 0
                            ? `${missing.length} missing`
                            : "Unknown"}
                      </Badge>
                    </div>

                    {missing.length > 0 ? (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>
                          Missing {missing.length} required{" "}
                          {missing.length === 1 ? "field" : "fields"}
                        </AlertTitle>
                        <AlertDescription>
                          <p className="mb-2">
                            Meta App Dashboard → WhatsApp → Configuration →
                            Webhooks, then re-run WABA subscribe above.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {missing.map(field => (
                              <code
                                key={field}
                                className="rounded bg-background/60 px-1.5 py-0.5 text-xs"
                              >
                                {field}
                              </code>
                            ))}
                          </div>
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    {subscribed.length > 0 ? (
                      <div className="grid gap-2 rounded-2xl border border-border/70 p-4">
                        <div className="text-sm font-medium text-foreground">
                          Currently subscribed ({subscribed.length})
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {subscribed.map(field => (
                            <code
                              key={field}
                              className="rounded bg-muted/60 px-1.5 py-0.5 text-xs"
                            >
                              {field}
                            </code>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {onboardingStatus?.webhook_fields_last_checked_at ? (
                      <div className="text-xs text-muted-foreground">
                        Last checked:{" "}
                        {formatDateTime(
                          onboardingStatus.webhook_fields_last_checked_at
                        )}
                        {onboardingStatus.webhook_profile_version
                          ? ` (profile ${onboardingStatus.webhook_profile_version})`
                          : null}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </CardContent>
          </Card>

          {(() => {
            const isCoexistence = Boolean(
              onboardingStatus?.coexistence_mode ||
                onboardingStatus?.partner_app_installed ||
                isSmbPlatformType(onboardingStatus?.platform_type)
            );
            if (!isCoexistence) return null;

            return (
              <Card>
                <CardHeader>
                  <CardTitle>Upgrade to full Cloud API</CardTitle>
                  <CardDescription>
                    Coexistence today. Migrate to unlock Calling API, groups/
                    labels (as Meta rolls them out), and OBA eligibility. The WA
                    Business app stops working on this number afterwards.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>One-way migration — preflight</AlertTitle>
                    <AlertDescription>
                      <ul className="ml-4 list-disc space-y-1 text-sm">
                        <li>
                          Agents on the mobile WA Business app must switch to
                          airi.chat or another Cloud API client.
                        </li>
                        <li>
                          Meta App needs Advanced Access for
                          whatsapp_business_management.
                        </li>
                        <li>
                          If Meta rejects the upgrade, your coexistence
                          connection stays intact.
                        </li>
                      </ul>
                    </AlertDescription>
                  </Alert>

                  <div className="flex flex-wrap items-center gap-3">
                    <EmbeddedSignupButton
                      label="Upgrade to Cloud API"
                      workspaceId={workspaceId}
                      intent="upgrade"
                    />
                    <Link
                      href={COEXISTENCE_DOC_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Meta migration docs
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          <Card>
            <CardHeader>
              <CardTitle>WA Business app sync</CardTitle>
              <CardDescription>
                Pull chat history and contacts from the phone. Does not affect
                OBA eligibility.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <FeedbackPanel feedback={syncFeedback} />

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleSync("smb_app_state_sync")}
                  disabled={syncBusy === "smb_app_state_sync"}
                >
                  {syncBusy === "smb_app_state_sync" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Syncing
                    </>
                  ) : (
                    "Sync contacts"
                  )}
                </Button>
                <Button variant="outline" asChild>
                  <Link
                    href={`/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`}
                  >
                    {historyT("manageHistory")}
                  </Link>
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="font-medium text-foreground">
                    {historyT(historySummary.titleKey)}
                  </div>
                  <p className="pt-1 text-muted-foreground">
                    {historyT(historySummary.descriptionKey)}
                  </p>
                  {syncStatus?.history_sync?.counts_verified ? (
                    <p className="pt-1 text-muted-foreground">
                      {historyT("savedCount", {
                        count:
                          syncStatus.history_sync.synchronized_count_total ?? 0,
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">Last contact sync</div>
                  <div className="pt-1 font-medium text-foreground">
                    {formatDateTime(syncStatus?.contact_sync?.requested_at)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  );
}
