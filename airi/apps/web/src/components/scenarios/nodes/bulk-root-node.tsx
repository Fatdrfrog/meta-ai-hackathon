"use client";

import { BirthdayCampaignControl } from "@/components/campaigns/birthday-campaign-control";
import { BulkCampaignAudienceComposer } from "@/components/campaigns/bulk-campaign-audience-composer";
import { BulkCampaignLimitHint } from "@/components/campaigns/bulk-campaign-limit-hint";
import { BulkCampaignOutcomeSummary } from "@/components/campaigns/bulk-campaign-outcome-summary";
import {
  CampaignDispatchLiveStatus,
  type CampaignDispatchLiveStatusLabels,
} from "@/components/campaigns/campaign-dispatch-live-status";
import { type CampaignUploadedAudience } from "@/components/campaigns/campaign-recipient-picker";
import { PriorFailedRecipientExclusionControl } from "@/components/campaigns/prior-failed-recipient-exclusion-control";
import type { UploadRecipient } from "@/components/campaigns/recipient-upload-parser";
import { CampaignScheduleEditor } from "@/components/campaigns/scheduler/campaign-schedule-editor";
import { type TelegramAudienceMode } from "@/components/campaigns/telegram-audience-selector";
import { useBulkCampaignRecipientEligibilityPreview } from "@/components/campaigns/use-bulk-campaign-recipient-eligibility-preview";
import {
  CampaignReadinessNotice,
  type CampaignReadinessNoticeProps,
} from "@/components/campaigns/campaign-dispatch-plan-card";
import {
  useCampaignTimeFormatter,
  useRetryLocked,
} from "@/components/campaigns/campaign-retry-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import {
  BulkCampaignSendError,
  buildBulkCampaignAudienceIntent,
  createBulkCampaignIdempotencyKey,
} from "@/lib/campaign/bulk-campaign-client";
import {
  BULK_CAMPAIGN_PLAN_LIMIT_CODE,
  bulkCampaignReadinessErrorKey,
  resolveBulkCampaignPlanCheck,
  resolveBulkCampaignReadinessBlockedReason,
  resolveBulkCampaignReadinessFailure,
  resolveBulkCampaignSendStatus,
  resolveBulkCampaignSharedSendGate,
  type BulkCampaignReadinessBlockedReason,
} from "@/lib/campaign/bulk-campaign-send-gate";
import {
  fetchCampaignBirthdayProtection,
  fetchTelegramSubscriberTotal,
  fetchWorkspaceTelegramSources,
  importCampaignBirthdays,
  CampaignBirthdayImportError,
  resolveBulkCampaignPickerSourceIds,
  type CampaignBirthdayProtection,
  type CampaignTelegramSource,
} from "@/lib/campaign/campaign-audience-client";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";
import {
  isActiveBulkCampaignDispatchStatus,
  isTerminalBulkCampaignDispatchStatus,
} from "@/lib/campaign/campaign-operations-contracts";
import type {
  BulkCampaignAudienceOverlapInfo,
  BulkCampaignBatchPlanPreviewResponse,
  BulkCampaignDispatchStatus,
  BulkCampaignSendResponse,
} from "@/lib/campaign/bulk-campaign-contracts";
import {
  BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED,
  buildBulkCampaignOverflowQueuePlan,
  type BulkCampaignOverflowQueuePlan,
} from "@/lib/campaign/bulk-campaign-overflow-queue";
import { BulkCampaignOverflowQueueDialog } from "@/components/campaigns/bulk-campaign-overflow-queue-dialog";
import {
  BIRTHDAY_CAMPAIGN_UPLOAD_RECIPIENT_LIMIT,
  buildBirthdayRecipientPlan,
  type BirthdayRecipientDayCount,
} from "@/lib/campaign/campaign-birthday-recipient-plan";
import {
  buildBirthdayCampaignScheduleConfig,
  getBirthdayCampaignScheduleTime,
  parseBirthdayCampaignScheduleConfig,
} from "@/lib/campaign/campaign-birthday-schedule";
import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";
import { normalizeCampaignScheduleConfig } from "@/lib/campaign/campaign-schedule-config";
import { retainCampaignVariableConfigs } from "@/lib/campaign/campaign-variable-values";
import { useBulkCampaignBatchPlanPreview } from "@/lib/campaign/useBulkCampaignBatchPlan";
import { applyBulkColumnSplitTemplateCatalogState } from "@/lib/scenarios/bulk-column-split-routing";
import { cn } from "@/lib/utils";
import {
  CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
  SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
  getScenarioBulkGenerationRevision,
  normalizeBulkCampaignRecipientPolicy,
  type BulkCampaignAudienceIntent,
  type BulkCampaignEligibilityMessageIntent,
  type BulkCampaignProvenanceIntent,
  type BulkCampaignSuccessOutcome,
  type CampaignScheduleConfig,
  type CampaignVariableSourceConfig,
} from "@icecore/scenario-contracts";
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import type {
  ScenarioBulkBatchPlan,
  ScenarioBulkConnectedAction,
  ScenarioBulkRecipientLimit,
  ScenarioNodeData,
  TranslateFn,
} from "../types";
import { useScenarioGraphResources } from "../view/graph/resources-context";
import type { ScenarioBulkEditorNodeProps } from "../view/node-enrichment/types";
import { translateScenarioErrorCode } from "../view/scenario-request-error-utils";
import { bulkTemplateSendBlockReasonMessageKey } from "../view/scenario-template-utils";
import { BulkRootNodeFrame } from "./bulk-root-node-frame";
import { useLatestRef } from "../view/use-latest-ref";
import { useSyncedDraftValue } from "./draft-state";
import { areNodePropsEqual } from "./node-memo-utils";

type ScenarioBulkBatchPlanPreview = {
  batchPlan: ScenarioBulkBatchPlan;
  recipientLimit: ScenarioBulkRecipientLimit;
};

const FALLBACK_UPLOAD_RECIPIENT_LIMIT = 1000;
const NO_UPLOAD_RECIPIENTS: UploadRecipient[] = [];

type BulkSendTiming = "now" | "scheduled";
type PendingAudienceConfirmation = {
  fingerprint: string;
  overlap: BulkCampaignAudienceOverlapInfo;
  audienceRevision: number | string;
};

type GeneratedBulkSendAttempt = {
  revision: string;
  idempotencyKey: string;
  scheduledAt: string | null;
};

function shouldReleaseGeneratedBulkSendAttempt(error: unknown): boolean {
  if (!(error instanceof BulkCampaignSendError)) return false;
  const payload = asNullableRecord(
    error.payload
  ) as BulkCampaignSendResponse | null;
  return payload?.operationDisposition === "not_started";
}

/** Why a send could not turn its scenario on, or null for other failures. */
function resolveScenarioActivationSendError(
  error: unknown,
  t: TranslateFn
): string | null {
  if (!(error instanceof BulkCampaignSendError)) return null;
  switch (error.code) {
    case "scenario_activation_blocked":
      return t("bulkNodeActivationBlocked", {
        reason: translateScenarioErrorCode(
          error.reasonCode ?? "",
          t,
          "activationImpactBlockingIssueGeneric"
        ),
      });
    case "scenario_activation_required":
      return t("bulkNodeActivateScenarioFirst");
    case "whatsapp_qr_activation_requires_scenario_route":
      return t("bulkNodeActivateQrScenarioFirst");
    case "scenario_activation_conflict":
      return t("bulkNodeActivationConflict");
    default:
      return null;
  }
}

function generatedAttemptKey(
  current: GeneratedBulkSendAttempt | null,
  revision: string,
  scheduledAt: string | null
): GeneratedBulkSendAttempt {
  if (current?.revision === revision) return current;
  return {
    revision,
    idempotencyKey: createBulkCampaignIdempotencyKey(),
    scheduledAt,
  };
}

function buildDefaultOneTimeScheduleConfig(timezone: string) {
  return normalizeCampaignScheduleConfig({
    timezone,
    config: {
      version: 2,
      mode: "once",
      timezone,
      startAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  });
}

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Saved recipients until an upload replaces them; a generated send has none. */
function readSavedUploadRecipients(
  config: ScenarioBulkEditorNodeProps["data"]["bulkRootConfig"],
  isGeneratedSend: boolean
): UploadRecipient[] {
  if (isGeneratedSend) return NO_UPLOAD_RECIPIENTS;
  return (
    (config?.uploadedRecipients as UploadRecipient[] | undefined) ??
    NO_UPLOAD_RECIPIENTS
  );
}

type ScheduleConfig = ReturnType<typeof buildDefaultOneTimeScheduleConfig>;
type SavedScheduleConfig = NonNullable<
  ScenarioBulkEditorNodeProps["data"]["bulkRootConfig"]
>["scheduleConfig"];

/**
 * The one-time schedule being edited: the saved schedule whenever it
 * changes, kept as it is while none is saved, a default until then.
 */
function useOneTimeScheduleDraft(
  savedScheduleConfig: SavedScheduleConfig,
  timezone: string
) {
  const [draft, setDraft] = useState(() => ({
    saved: savedScheduleConfig,
    value: savedScheduleConfig
      ? normalizeCampaignScheduleConfig({
          config: savedScheduleConfig,
          timezone,
        })
      : buildDefaultOneTimeScheduleConfig(timezone),
  }));
  let value = draft.value;
  if (draft.saved !== savedScheduleConfig) {
    value = savedScheduleConfig
      ? normalizeCampaignScheduleConfig({
          config: savedScheduleConfig,
          timezone,
        })
      : draft.value;
    setDraft({ saved: savedScheduleConfig, value });
  }
  const setValue = useCallback(
    (next: ScheduleConfig) =>
      setDraft(current => ({ ...current, value: next })),
    []
  );
  return [value, setValue] as const;
}

type CampaignVariableConfigs = Record<string, CampaignVariableSourceConfig>;

/**
 * Each template variable's value source: kept per variable when the
 * template changes, with "auto" for new ones; none for a generated send.
 */
function useCampaignVariableConfigs(
  templateVariables: string[],
  isGeneratedSend: boolean
) {
  const retain = (previous: CampaignVariableConfigs) =>
    isGeneratedSend
      ? {}
      : retainCampaignVariableConfigs({ templateVariables, previous });
  const [state, setState] = useState(() => ({
    templateVariables,
    isGeneratedSend,
    configs: retain({}),
  }));
  let configs = state.configs;
  if (
    state.templateVariables !== templateVariables ||
    state.isGeneratedSend !== isGeneratedSend
  ) {
    configs = retain(state.configs);
    setState({ templateVariables, isGeneratedSend, configs });
  }
  const setConfigs = useCallback(
    (next: SetStateAction<CampaignVariableConfigs>) =>
      setState(current => ({
        ...current,
        configs: typeof next === "function" ? next(current.configs) : next,
      })),
    []
  );
  return [configs, setConfigs] as const;
}

function buildBatchPlanPreviewFromConfig(
  config: NonNullable<ScenarioNodeData["bulkRootConfig"]> | undefined
): ScenarioBulkBatchPlanPreview | null {
  if (!config?.batchPlan) return null;
  return {
    batchPlan: config.batchPlan,
    recipientLimit: config.recipientLimit || {
      maxRecipients: null,
      source: "unavailable",
    },
  };
}

function buildBatchPlanPreviewFromResponse(
  preview: BulkCampaignBatchPlanPreviewResponse | null
): ScenarioBulkBatchPlanPreview | null {
  if (!preview?.batchPlan || !preview.recipientLimit) return null;
  return {
    batchPlan: preview.batchPlan,
    recipientLimit: preview.recipientLimit,
  };
}

function normalizeUploadLimit(
  recipientLimit: ScenarioBulkRecipientLimit | undefined
): number {
  const maxRecipients = recipientLimit?.maxRecipients;
  if (
    typeof maxRecipients === "number" &&
    Number.isFinite(maxRecipients) &&
    maxRecipients > 0
  ) {
    return Math.floor(maxRecipients);
  }
  return FALLBACK_UPLOAD_RECIPIENT_LIMIT;
}

function formatBirthdayDay(day: BirthdayRecipientDayCount, t: TranslateFn) {
  const label = `${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  return day.nonLeapFeb28
    ? t("bulkNodeBirthdayNonLeapDay", { day: label })
    : label;
}

/**
 * The text above a disabled Send button, or null when Send is enabled or the
 * readiness notice's reason line already says why.
 */
function resolveScenarioBulkSendBlockedReason(
  input: {
    disableSend: boolean;
    isSending: boolean;
    hasCompletedGeneratedRevision: boolean;
    isGeneratedSend: boolean;
    hasBulkSendAction: boolean;
    /** Why the column split can't send, as its route summary says it. */
    columnSplitDisabledReason: string | null;
    templateSendBlockedMessage: string | null;
    usingTelegramSubscribersAudience: boolean;
    usingUploadedAudience: boolean;
    selectedTelegramSourceId: string;
    activeRecipientCount: number;
    generatedRevisionNotReady:
      | "generating"
      | "count_unavailable"
      | "no_recipients"
      | null;
    birthdayProtection: { count: number; limit: number } | null;
    sendTiming: BulkSendTiming;
    hasScheduleStart: boolean;
    livePlanBlocksSend: boolean;
    hasActiveDispatch: boolean;
    readinessBlockedReason: BulkCampaignReadinessBlockedReason | null;
  },
  t: TranslateFn,
  tPlan: TranslateFn
): string | null {
  if (
    !input.disableSend ||
    input.isSending ||
    input.hasCompletedGeneratedRevision
  ) {
    return null;
  }
  // A connected split names its own problem, such as a route to a step that
  // isn't a template; "connect an action" would be wrong.
  if (!input.isGeneratedSend && input.columnSplitDisabledReason) {
    return t(input.columnSplitDisabledReason);
  }
  if (!input.isGeneratedSend && !input.hasBulkSendAction) {
    return t("bulkNodeSendRequiresAction");
  }
  if (!input.isGeneratedSend && input.templateSendBlockedMessage) {
    return input.templateSendBlockedMessage;
  }
  if (
    !input.isGeneratedSend &&
    input.usingTelegramSubscribersAudience &&
    !input.selectedTelegramSourceId
  ) {
    return t("bulkNodeBirthdayTelegramBotRequired");
  }
  if (!input.isGeneratedSend && input.activeRecipientCount === 0) {
    return t(
      input.usingUploadedAudience
        ? "bulkNodeSendRequiresRecipients"
        : "bulkNodeSendRequiresAudience"
    );
  }
  if (input.generatedRevisionNotReady === "generating") {
    return t("bulkNodeSendWaitsForGeneration");
  }
  if (input.generatedRevisionNotReady === "count_unavailable") {
    return t("bulkNodeGeneratedRecipientCountUnavailable");
  }
  if (input.generatedRevisionNotReady === "no_recipients") {
    return t("bulkNodeNoEligibleRecipients");
  }
  if (!input.isGeneratedSend && input.birthdayProtection) {
    return t("bulkNodeBirthdayProtectedToday", input.birthdayProtection);
  }
  if (input.sendTiming === "scheduled" && !input.hasScheduleStart) {
    return t("bulkNodeScheduleRequired");
  }
  if (input.hasActiveDispatch) {
    return t("bulkNodeSendBlockedActiveDispatch");
  }
  // The send check says why the live plan is missing, so it goes first. The
  // readiness notice's reason line already says the number is unavailable.
  if (input.readinessBlockedReason === "plan_unavailable") return null;
  if (input.readinessBlockedReason) {
    return tPlan(`sendBlocked.${input.readinessBlockedReason}`);
  }
  if (input.livePlanBlocksSend) {
    return t("bulkNodeLivePlanRequired");
  }
  return null;
}

function BulkRootLastOutcomeSummary({
  outcome,
  t,
}: {
  outcome: BulkCampaignSuccessOutcome | undefined;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  if (!outcome) return null;
  return (
    <BulkCampaignOutcomeSummary
      result={{ ok: true, outcome }}
      t={t}
      className="rounded bg-muted/40 px-1.5 py-1 text-[10px]"
    />
  );
}

function formatConnectedActionLabel(
  connectedAction: ScenarioBulkConnectedAction
) {
  const templateName = connectedAction.templateName?.trim();
  const templateLanguage = connectedAction.templateLanguage?.trim();

  if (templateName && templateLanguage) {
    return `${templateName} (${templateLanguage})`;
  }

  return templateName || connectedAction.actionType || connectedAction.nodeId;
}

function getConnectedActionPreview(
  connectedAction: ScenarioBulkConnectedAction
) {
  const explicitPreview = connectedAction.previewText?.trim();
  if (explicitPreview) return explicitPreview;

  const bodyComponent = connectedAction.templateComponents?.find(component => {
    const record = component as { type?: string; text?: unknown };
    return (
      record.type === "BODY" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    );
  }) as { text?: string } | undefined;

  return bodyComponent?.text?.trim() || "";
}

export const BulkRootNode = memo(function BulkRootNode({
  id,
  data,
  selected,
}: ScenarioBulkEditorNodeProps) {
  const {
    whatsAppTemplatesLoading,
    hasLoadedWhatsAppTemplates,
    whatsAppTemplatesError,
  } = useScenarioGraphResources();
  const nodeData = data;
  const config = nodeData.bulkRootConfig;
  const generatedRevision = getScenarioBulkGenerationRevision(config) || "";
  const isGeneratedSend = Boolean(generatedRevision);
  const hasKnownGeneratedRecipientCount =
    Number.isSafeInteger(config?.generatedRecipientCount) &&
    (config?.generatedRecipientCount ?? -1) >= 0;
  const generatedRecipientCount = hasKnownGeneratedRecipientCount
    ? (config?.generatedRecipientCount ?? 0)
    : 0;
  const generatedRecipientCountUnavailable =
    isGeneratedSend && !hasKnownGeneratedRecipientCount;
  const t = useTranslations("Scenarios");
  const tPlan = useTranslations("CampaignDispatchPlanCard");
  const formatRetryTime = useCampaignTimeFormatter();
  const formatLifecycleStatus = (status: string) =>
    t("bulkNodeLifecycleStatus", {
      status: tPlan("lifecycleStatus", { status }),
    });
  const liveStatusLabels: CampaignDispatchLiveStatusLabels = {
    lifecycleStatus: formatLifecycleStatus,
    attempted: (attempted, total) =>
      t("bulkNodeLiveAttempted", { attempted, total }),
    accepted: count => t("bulkNodeLiveAccepted", { count }),
    delivered: count => t("bulkNodeLiveDelivered", { count }),
    read: count => t("bulkNodeLiveRead", { count }),
    failed: count => t("bulkNodeFailedCount", { count }),
    cancel: t("bulkNodeCancelCampaign"),
    cancelling: t("bulkNodeCancellingCampaign"),
    pause: t("bulkNodePauseCampaign"),
    pausing: t("bulkNodePausingCampaign"),
    resume: t("bulkNodeResumeCampaign"),
    resuming: t("bulkNodeResumingCampaign"),
    paused: t("bulkNodePausedCampaign"),
    statusUnavailable: message => t("bulkNodeStatusUnavailable", { message }),
    cancelFailed: message => t("bulkNodeCancelFailed", { message }),
    pauseFailed: message => t("bulkNodePauseFailed", { message }),
  };
  // Normalizing effects read the latest command, so a new one alone never
  // runs them again.
  const patchNodeDataRef = useLatestRef(nodeData.uiOnPatch);
  const [isSending, setIsSending] = useState(false);
  const [generatedSendAttempt, setGeneratedSendAttempt] =
    useState<GeneratedBulkSendAttempt | null>(null);
  const [generatedSendFeedback, setGeneratedSendFeedback] =
    useState<BulkCampaignSendResponse | null>(null);
  const [showMediaFailureAcknowledgement, setShowMediaFailureAcknowledgement] =
    useState(false);
  const [pendingAudienceConfirmation, setPendingAudienceConfirmation] =
    useState<PendingAudienceConfirmation | null>(null);
  const [pendingOverflowPlan, setPendingOverflowPlan] =
    useState<BulkCampaignOverflowQueuePlan | null>(null);
  const overflowQueueConfirmedRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recipients, setRecipients] = useSyncedDraftValue(
    readSavedUploadRecipients(config, isGeneratedSend)
  );
  const [nodeRecipientEntryMode, setNodeRecipientEntryMode] = useState<
    "upload" | "select"
  >("upload");
  const [recipientUploadParsing, setRecipientUploadParsing] = useState(false);
  const [sendTiming, setSendTiming] = useState<BulkSendTiming>("now");
  const [scheduleTimezone] = useState(getBrowserTimezone);
  const [oneTimeScheduleConfig, setOneTimeScheduleConfig] =
    useOneTimeScheduleDraft(config?.scheduleConfig, scheduleTimezone);
  const [isImportingBirthdays, setIsImportingBirthdays] = useState(false);
  const birthdayImportQueueRef = useRef<Promise<void>>(Promise.resolve());
  const birthdayImportRevisionRef = useRef(0);
  const [telegramSources, setTelegramSources] = useState<
    CampaignTelegramSource[]
  >([]);
  const [isLoadingTelegramSources, setIsLoadingTelegramSources] =
    useState(false);
  const [telegramSubscriberCount, setTelegramSubscriberCount] = useState(0);
  const [isLoadingTelegramSubscribers, setIsLoadingTelegramSubscribers] =
    useState(false);
  const [birthdayProtection, setBirthdayProtection] =
    useState<CampaignBirthdayProtection | null>(null);
  const [isLoadingBirthdayProtection, setIsLoadingBirthdayProtection] =
    useState(false);
  const { data: companyLimits, mutate: refreshCompanyLimits } =
    useCompanyLimits(nodeData.uiWorkspaceId);
  const connectedAction = nodeData.uiBulkConnectedAction;
  const rawColumnSplitPreview = nodeData.uiBulkColumnSplitPreview;
  // A column split's templates wait on the catalog like a single template:
  // missing from an unloaded or failed catalog is not "stale".
  const columnSplitCatalog = useMemo(
    () =>
      rawColumnSplitPreview
        ? applyBulkColumnSplitTemplateCatalogState(rawColumnSplitPreview, {
            loading: whatsAppTemplatesLoading,
            loaded: hasLoadedWhatsAppTemplates,
            failed: Boolean(whatsAppTemplatesError),
          })
        : null,
    [
      hasLoadedWhatsAppTemplates,
      rawColumnSplitPreview,
      whatsAppTemplatesError,
      whatsAppTemplatesLoading,
    ]
  );
  const columnSplitPreview = columnSplitCatalog?.preview ?? null;
  const hasColumnSplitRouting = Boolean(columnSplitPreview);
  // Set up but held back only by the catalog, it is a template send that
  // waits, as a single template is while the catalog loads.
  const columnSplitSendable = Boolean(
    columnSplitPreview?.ready || columnSplitCatalog?.waitsOnlyForCatalog
  );
  const hasPrimaryCampaignTemplate = Boolean(
    !hasColumnSplitRouting &&
      connectedAction?.actionType === "whatsapp_template" &&
      connectedAction.templateName?.trim()
  );
  const hasEligibleWhatsAppTemplate =
    hasPrimaryCampaignTemplate ||
    (hasColumnSplitRouting && columnSplitSendable);
  const hasTelegramFixedReplyAction = Boolean(
    connectedAction?.actionType === "reply" &&
      connectedAction.channel === "telegram" &&
      connectedAction.replyMode !== "ai" &&
      connectedAction.replyText?.trim()
  );
  const hasBulkSendAction = hasColumnSplitRouting
    ? columnSplitSendable
    : hasPrimaryCampaignTemplate || hasTelegramFixedReplyAction;
  // A failed catalog read, or a saved catalog Meta couldn't refresh that
  // lacks the template, can't tell whether the template is approved: that is
  // not "missing". A saved catalog that has it approved doesn't block Send.
  const templateCatalogUnavailable =
    Boolean(whatsAppTemplatesError) &&
    !whatsAppTemplatesLoading &&
    (!hasLoadedWhatsAppTemplates ||
      connectedAction?.templateSendBlockReason === "stale");
  // Before the catalog first loads every template looks missing.
  const templateSendBlockReason = hasPrimaryCampaignTemplate
    ? templateCatalogUnavailable
      ? ("catalog_unavailable" as const)
      : whatsAppTemplatesLoading || !hasLoadedWhatsAppTemplates
        ? ("loading" as const)
        : (connectedAction?.templateSendBlockReason ?? null)
    : (columnSplitCatalog?.templateCatalogBlockReason ?? null);
  const templateCatalogRetryAt = Date.parse(
    whatsAppTemplatesError?.retryAt ?? ""
  );
  const templateCatalogCoolingDown = useRetryLocked(
    Number.isFinite(templateCatalogRetryAt) ? templateCatalogRetryAt : null
  );
  // Only Meta's own limit reads as "limited"; a network or server failure
  // also waits before the next try, but it is just unavailable.
  const templateCatalogRateLimited =
    whatsAppTemplatesError?.code === "WHATSAPP_TEMPLATES_RATE_LIMITED";
  const templateSendBlocked = Boolean(templateSendBlockReason);
  // The catalog otherwise loads only when a node is selected, and a disabled
  // Send can't select this one, so ask for it once.
  const needsWhatsAppTemplateCatalog =
    (hasPrimaryCampaignTemplate ||
      Boolean(
        columnSplitPreview?.routes.some(
          route => route.actionNodeId && route.templateName
        )
      )) &&
    !hasLoadedWhatsAppTemplates &&
    !whatsAppTemplatesLoading;
  const loadWhatsAppTemplatesRef = useLatestRef(
    nodeData.uiOnLoadWhatsAppTemplates
  );
  const requestedWhatsAppTemplatesRef = useRef(false);
  useEffect(() => {
    if (
      !needsWhatsAppTemplateCatalog ||
      requestedWhatsAppTemplatesRef.current
    ) {
      return;
    }
    requestedWhatsAppTemplatesRef.current = true;
    loadWhatsAppTemplatesRef.current?.();
  }, [loadWhatsAppTemplatesRef, needsWhatsAppTemplateCatalog]);
  const configuredBulkChannel =
    config?.channels.includes("telegram") &&
    !config.channels.includes("whatsapp")
      ? "telegram"
      : "whatsapp";
  const bulkChannel = hasTelegramFixedReplyAction
    ? "telegram"
    : hasPrimaryCampaignTemplate
      ? "whatsapp"
      : configuredBulkChannel;
  const birthdayScheduleConfig = normalizeCampaignScheduleConfig({
    timezone: scheduleTimezone,
    config:
      config?.scheduleConfig?.mode === "recurring"
        ? config.scheduleConfig
        : buildBirthdayCampaignScheduleConfig(scheduleTimezone),
  });
  const birthdayScheduleTime = getBirthdayCampaignScheduleTime(
    birthdayScheduleConfig
  );
  const [birthdayTimeDraft, setBirthdayTimeDraft] = useSyncedDraftValue(birthdayScheduleTime);
  const [birthdayTimezoneDraft, setBirthdayTimezoneDraft] = useSyncedDraftValue(birthdayScheduleConfig.timezone);
  const batchPlanRequestKey =
    !isGeneratedSend &&
    config?.workflowKind === "bulk_campaign" &&
    config.channels.includes(bulkChannel) &&
    nodeData.uiWorkspaceId
      ? `${nodeData.uiWorkspaceId}:${bulkChannel}`
      : "";
  const connectedActionLabel = connectedAction
    ? formatConnectedActionLabel(connectedAction)
    : "";
  const connectedActionPreview = connectedAction
    ? getConnectedActionPreview(connectedAction)
    : "";
  const templateVariablesKey = (connectedAction?.templateVariables || []).join(
    "\u001f"
  );
  const templateVariables = useMemo(
    () => (templateVariablesKey ? templateVariablesKey.split("\u001f") : []),
    [templateVariablesKey]
  );
  const [variableConfigs, setVariableConfigs] = useCampaignVariableConfigs(
    templateVariables,
    isGeneratedSend
  );
  const registeredBusinessPhonesAudience =
    nodeData.uiRegisteredBusinessPhonesAudience;
  const hasRegisteredBusinessPhonesAudience = Boolean(
    config?.workflowKind === "bulk_campaign" &&
      bulkChannel === "whatsapp" &&
      registeredBusinessPhonesAudience &&
      registeredBusinessPhonesAudience.enabled !== false &&
      registeredBusinessPhonesAudience.total > 0
  );
  const selectedTelegramSourceId =
    config?.telegramSubscriberSourceId ||
    (telegramSources.length === 1 ? telegramSources[0]?.id || "" : "");
  const hasTelegramSubscribersAudience = Boolean(
    bulkChannel === "telegram" &&
      selectedTelegramSourceId &&
      telegramSubscriberCount > 0
  );
  // Column-split only works with uploaded CSV recipients.
  const recipientAudienceSource = hasColumnSplitRouting
    ? SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE
    : config?.recipientAudienceSource ===
        SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
      ? SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
      : hasTelegramSubscribersAudience &&
          config?.recipientAudienceSource ===
            SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
        ? SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
        : hasRegisteredBusinessPhonesAudience &&
            config?.recipientAudienceSource ===
              SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE
          ? SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE
          : SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE;
  const usingRegisteredBusinessPhonesAudience =
    recipientAudienceSource ===
    SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE;
  const usingTelegramSubscribersAudience =
    recipientAudienceSource ===
    SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE;
  const usingBirthdayAudience =
    recipientAudienceSource ===
    SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE;
  const canUseNodeContactsPicker =
    bulkChannel === "whatsapp" &&
    !isGeneratedSend &&
    !usingBirthdayAudience &&
    !hasColumnSplitRouting &&
    !usingRegisteredBusinessPhonesAudience &&
    !usingTelegramSubscribersAudience;
  const audienceRevision = config?.audienceRevision ?? 0;
  const sendAudienceRevision = isGeneratedSend
    ? generatedRevision
    : audienceRevision;
  const effectivePendingAudienceConfirmation =
    pendingAudienceConfirmation?.audienceRevision === sendAudienceRevision
      ? pendingAudienceConfirmation
      : null;
  const dispatchLifecycleStatus = config?.sendStatus?.lifecycleStatus;
  const hasActiveDispatch = isActiveBulkCampaignDispatchStatus(
    dispatchLifecycleStatus
  );
  const hasUnchangedTerminalDispatch =
    isTerminalBulkCampaignDispatchStatus(dispatchLifecycleStatus) &&
    config?.sendStatus?.audienceRevision === audienceRevision;
  const hasCompletedGeneratedRevision = Boolean(
    isGeneratedSend &&
      generatedRevision &&
      config?.generatedSendState?.state === "completed" &&
      config.generatedSendState.revision === generatedRevision
  );
  const isGeneratedRevisionReadyToSend =
    !isGeneratedSend ||
    (Boolean(generatedRevision) &&
      hasKnownGeneratedRecipientCount &&
      generatedRecipientCount > 0 &&
      ["complete", "failed"].includes(config?.generationStatus || ""));

  const {
    preview: liveBatchPlanPreview,
    error: batchPlanError,
    isLoading: isLoadingBatchPlanPreview,
    refresh: refreshBatchPlanPreview,
  } = useBulkCampaignBatchPlanPreview({
    workspaceId: nodeData.uiWorkspaceId,
    channel: bulkChannel,
    enabled: Boolean(batchPlanRequestKey),
  });
  const canUseResolvedContactsPicker =
    canUseNodeContactsPicker &&
    Boolean(liveBatchPlanPreview?.whatsappMeta?.sourceId?.trim());
  const recipientEntryMode = canUseResolvedContactsPicker
    ? nodeRecipientEntryMode
    : "upload";
  const effectiveBatchPlanPreview =
    buildBatchPlanPreviewFromResponse(liveBatchPlanPreview) ||
    buildBatchPlanPreviewFromConfig(config);
  const hasLivePlan = Boolean(
    buildBatchPlanPreviewFromResponse(liveBatchPlanPreview)
  );
  const dailyRecipientLimit = normalizeUploadLimit(
    effectiveBatchPlanPreview?.recipientLimit || config?.recipientLimit
  );
  const birthdayProtectedTodayCount =
    !usingBirthdayAudience && birthdayProtection?.active
      ? Math.max(0, birthdayProtection.protectedTodayCount || 0)
      : 0;
  const protectedDailyRecipientLimit =
    !usingBirthdayAudience &&
    birthdayProtection?.active &&
    typeof birthdayProtection.availableRecipientLimit === "number"
      ? Math.max(0, birthdayProtection.availableRecipientLimit)
      : dailyRecipientLimit;
  const attachRecipientLimit = usingBirthdayAudience
    ? BIRTHDAY_CAMPAIGN_UPLOAD_RECIPIENT_LIMIT
    : MAX_BULK_CAMPAIGN_RECIPIENTS;
  const effectiveRecipientLimitPreview =
    effectiveBatchPlanPreview?.recipientLimit && birthdayProtectedTodayCount > 0
      ? {
          ...effectiveBatchPlanPreview.recipientLimit,
          maxRecipients: protectedDailyRecipientLimit,
          warning: t("bulkNodeBirthdayProtectedLimit", {
            count: birthdayProtectedTodayCount,
            limit: protectedDailyRecipientLimit,
          }),
        }
      : effectiveBatchPlanPreview?.recipientLimit;
  const birthdayRecipientPlan = useMemo(
    () =>
      buildBirthdayRecipientPlan({
        recipients,
        dailyLimit: dailyRecipientLimit,
        timezone: birthdayScheduleConfig.timezone,
      }),
    [birthdayScheduleConfig.timezone, dailyRecipientLimit, recipients]
  );

  useEffect(() => {
    setGeneratedSendAttempt(current =>
      current?.revision === generatedRevision ? current : null
    );
    setGeneratedSendFeedback(null);
    setPendingAudienceConfirmation(null);
  }, [generatedRevision]);

  useEffect(() => {
    const patchNodeData = patchNodeDataRef.current;
    if (
      isGeneratedSend ||
      !hasColumnSplitRouting ||
      !config ||
      !patchNodeData
    ) {
      return;
    }
    const source = config.recipientAudienceSource;
    if (
      source !== SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE &&
      source !== SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE &&
      source !== SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
    ) {
      return;
    }
    patchNodeData({
      bulkRootConfig: {
        ...config,
        recipientAudienceSource: SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
        audienceRevision: (config.audienceRevision ?? 0) + 1,
      },
    });
    setPendingAudienceConfirmation(null);
  }, [hasColumnSplitRouting, config, isGeneratedSend, patchNodeDataRef]);

  useEffect(() => {
    overflowQueueConfirmedRef.current = false;
  }, [recipients.length, protectedDailyRecipientLimit]);

  useEffect(() => {
    if (
      isGeneratedSend ||
      bulkChannel !== "telegram" ||
      !nodeData.uiWorkspaceId
    ) {
      setTelegramSources([]);
      setIsLoadingTelegramSources(false);
      return;
    }

    let cancelled = false;
    setIsLoadingTelegramSources(true);
    void (async () => {
      try {
        const sources = await fetchWorkspaceTelegramSources(
          nodeData.uiWorkspaceId
        );
        if (!cancelled) setTelegramSources(sources);
      } catch {
        if (!cancelled) {
          setTelegramSources([]);
          toast.error(t("bulkNodeTelegramSourcesLoadFailed"));
        }
      } finally {
        if (!cancelled) setIsLoadingTelegramSources(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bulkChannel, isGeneratedSend, nodeData.uiWorkspaceId, t]);

  useEffect(() => {
    if (
      isGeneratedSend ||
      !config ||
      bulkChannel !== "telegram" ||
      config.telegramSubscriberSourceId ||
      telegramSources.length !== 1
    ) {
      return;
    }

    patchNodeDataRef.current?.({
      bulkRootConfig: {
        ...config,
        telegramSubscriberSourceId: telegramSources[0].id,
      },
    });
  }, [bulkChannel, config, isGeneratedSend, patchNodeDataRef, telegramSources]);

  useEffect(() => {
    if (
      isGeneratedSend ||
      bulkChannel !== "telegram" ||
      !nodeData.uiWorkspaceId ||
      !selectedTelegramSourceId
    ) {
      setTelegramSubscriberCount(0);
      setIsLoadingTelegramSubscribers(false);
      return;
    }

    let cancelled = false;
    setIsLoadingTelegramSubscribers(true);
    void (async () => {
      try {
        const total = await fetchTelegramSubscriberTotal({
          workspaceId: nodeData.uiWorkspaceId,
          sourceId: selectedTelegramSourceId,
        });
        if (!cancelled) setTelegramSubscriberCount(total);
      } catch {
        if (!cancelled) {
          setTelegramSubscriberCount(0);
          toast.error(t("bulkNodeTelegramSubscribersLoadFailed"));
        }
      } finally {
        if (!cancelled) setIsLoadingTelegramSubscribers(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    bulkChannel,
    isGeneratedSend,
    nodeData.uiWorkspaceId,
    selectedTelegramSourceId,
    t,
  ]);

  // The daily limit falls back to the saved one until the live plan loads.
  const waitingForLiveDailyLimit =
    Boolean(batchPlanRequestKey) && isLoadingBatchPlanPreview;
  useEffect(() => {
    if (
      isGeneratedSend ||
      usingBirthdayAudience ||
      bulkChannel !== "whatsapp" ||
      !nodeData.uiWorkspaceId ||
      dailyRecipientLimit <= 0
    ) {
      setBirthdayProtection(null);
      setIsLoadingBirthdayProtection(false);
      return;
    }
    // Check once with the live limit instead of again when it replaces the
    // saved one.
    if (waitingForLiveDailyLimit) return;

    const controller = new AbortController();
    setIsLoadingBirthdayProtection(true);
    void (async () => {
      try {
        const data = await fetchCampaignBirthdayProtection({
          workspaceId: nodeData.uiWorkspaceId,
          dailyLimit: dailyRecipientLimit,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setBirthdayProtection(data);
        }
      } catch {
        if (!controller.signal.aborted) {
          setBirthdayProtection({
            active: true,
            availableRecipientLimit: 0,
            protectedTodayCount: 0,
          });
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingBirthdayProtection(false);
        }
      }
    })();

    return () => controller.abort();
  }, [
    bulkChannel,
    nodeData.uiWorkspaceId,
    dailyRecipientLimit,
    isGeneratedSend,
    usingBirthdayAudience,
    waitingForLiveDailyLimit,
  ]);

  useEffect(() => {
    if (!hasCompletedGeneratedRevision) return;
    setGeneratedSendAttempt(null);
    setGeneratedSendFeedback(current => (current?.partial ? null : current));
    setPendingAudienceConfirmation(null);
  }, [hasCompletedGeneratedRevision]);

  const savedRecipientPolicy = config?.recipientPolicy;
  const recipientPolicy = useMemo(
    () => normalizeBulkCampaignRecipientPolicy(savedRecipientPolicy),
    [savedRecipientPolicy]
  );
  const isRecurringEligibility =
    usingBirthdayAudience || config?.scheduleConfig?.mode === "recurring";
  const eligibilityAudience = useMemo<
    BulkCampaignAudienceIntent | undefined
  >(() => {
      if (isGeneratedSend) return undefined;
      if (usingRegisteredBusinessPhonesAudience) {
        return buildBulkCampaignAudienceIntent("registered_business_phones");
      }
      if (usingTelegramSubscribersAudience) {
        const telegramAudience = buildBulkCampaignAudienceIntent(
          "telegram_subscribers",
          { telegramSourceId: selectedTelegramSourceId }
        );
        if (telegramAudience) return telegramAudience;
      }
      return buildBulkCampaignAudienceIntent("inline", {
        inlineRecipients: recipients,
      });
  }, [
      isGeneratedSend,
      recipients,
      selectedTelegramSourceId,
      usingRegisteredBusinessPhonesAudience,
      usingTelegramSubscribersAudience,
  ]);
  // Keep these stable across renders so the check's request key is not
  // rebuilt for every recipient on each render.
  const eligibilityTemplateName = hasEligibleWhatsAppTemplate
    ? connectedAction?.templateName || ""
    : "";
  const eligibilityTemplateLanguage = connectedAction?.templateLanguage || "en";
  const liveWhatsAppSourceId =
    liveBatchPlanPreview?.whatsappMeta?.sourceId || "";
  const eligibilityMessageIntent =
    useMemo<BulkCampaignEligibilityMessageIntent>(
      () =>
        eligibilityTemplateName
          ? {
              kind: "whatsapp_template",
              sourceId: liveWhatsAppSourceId,
              templateName: eligibilityTemplateName,
              language: eligibilityTemplateLanguage,
            }
          : {
              kind: "unsupported",
              messageKind: bulkChannel === "telegram" ? "telegram" : "email",
            },
      [
        bulkChannel,
        eligibilityTemplateLanguage,
        eligibilityTemplateName,
        liveWhatsAppSourceId,
      ]
    );
  const columnSplitNodeId = hasColumnSplitRouting
    ? columnSplitPreview?.splitNodeId || ""
    : "";
  const connectedActionNodeId = connectedAction?.nodeId || "";
  const eligibilityProvenance = useMemo<BulkCampaignProvenanceIntent>(
    () =>
      nodeData.uiActiveScenarioId
        ? {
            kind: "scenario_run_now",
            scenarioId: nodeData.uiActiveScenarioId,
            rootNodeId: id,
            ...(columnSplitNodeId
              ? { columnSplitNodeId }
              : connectedActionNodeId
                ? { actionNodeId: connectedActionNodeId }
                : {}),
          }
        : { kind: "ad_hoc" },
    [columnSplitNodeId, connectedActionNodeId, id, nodeData.uiActiveScenarioId]
  );
  const eligibilityPreview = useBulkCampaignRecipientEligibilityPreview({
    workspaceId: nodeData.uiWorkspaceId,
    channel: "whatsapp",
    messageIntent: eligibilityMessageIntent,
    audience: eligibilityAudience,
    recipientPolicy,
    provenance: eligibilityProvenance,
    scenarioRevision: generatedRevision || undefined,
    recurring: isRecurringEligibility,
  });

  useEffect(() => {
    const patchNodeData = patchNodeDataRef.current;
    if (
      !config ||
      !patchNodeData ||
      hasEligibleWhatsAppTemplate ||
      !recipientPolicy.excludePriorFailedBulkSends
    ) {
      return;
    }
    patchNodeData({
      bulkRootConfig: {
        ...config,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      },
    });
  }, [
    config,
    hasEligibleWhatsAppTemplate,
    patchNodeDataRef,
    recipientPolicy.excludePriorFailedBulkSends,
  ]);

  if (!config) {
    return null;
  }

  const patchConfig = (patch: Partial<typeof config>) => {
    nodeData.uiOnPatch?.({
      bulkRootConfig: {
        ...config,
        ...patch,
      },
    });
  };

  const patchAudienceConfig = (patch: Partial<typeof config>) => {
    setPendingAudienceConfirmation(null);
    patchConfig({
      ...patch,
      audienceRevision: (config.audienceRevision ?? 0) + 1,
    });
  };

  const handleDispatchLifecycleChange = (
    status: BulkCampaignDispatchStatus,
    operation: CampaignOperationStatusResponse | null
  ) => {
    const currentSendStatus = config.sendStatus;
    if (!currentSendStatus || currentSendStatus.lifecycleStatus === status) {
      return;
    }

    patchConfig({
      sendStatus: {
        ...currentSendStatus,
        lifecycleStatus: status,
        ...(operation
          ? {
              total: operation.totalRecipients,
              queued: operation.progress.notAttempted,
              sent: operation.progress.successful,
              failed: operation.progress.failed,
            }
          : {}),
      },
    });
  };

  const handleOneTimeScheduleConfigChange = (
    nextScheduleConfig: typeof oneTimeScheduleConfig
  ) => {
    setOneTimeScheduleConfig(nextScheduleConfig);
    patchConfig({ scheduleConfig: nextScheduleConfig });
  };

  const importBirthdaysFromRecipients = async (
    recipientsToImport: UploadRecipient[],
    telegramSourceIdOverride?: string
  ) => {
    if (!nodeData.uiWorkspaceId || recipientsToImport.length === 0) return;
    const revision = ++birthdayImportRevisionRef.current;
    const request: Parameters<typeof importCampaignBirthdays>[0] = {
      workspaceId: nodeData.uiWorkspaceId,
      channel: bulkChannel,
      sourceId: telegramSourceIdOverride || selectedTelegramSourceId,
      recipients: recipientsToImport,
      errorFallback: t("bulkNodeBirthdayImportFailed"),
    };
    setIsImportingBirthdays(true);
    birthdayImportQueueRef.current = birthdayImportQueueRef.current.then(async () => {
      try {
        const result = await importCampaignBirthdays(request);
        if (revision !== birthdayImportRevisionRef.current) return;
        const saved = result.imported + result.updated;
        const skipped = result.total - saved;
        if (skipped > 0) {
          toast.warning(t("bulkNodeBirthdayImportPartial", {saved, skipped, total: result.total}));
        } else {
          toast.success(t("bulkNodeBirthdayImportDone", {saved}));
        }
      } catch (error) {
        if (revision !== birthdayImportRevisionRef.current) return;
        toast.error(error instanceof CampaignBirthdayImportError && error.result
          ? t("bulkNodeBirthdayImportRejected", {total: error.result.total})
          : t("bulkNodeBirthdayImportFailed"));
      } finally {
        if (revision === birthdayImportRevisionRef.current) setIsImportingBirthdays(false);
      }
    });
    await birthdayImportQueueRef.current;
  };

  const persistUploadedAudience = (
    nextRecipients: UploadRecipient[],
    uploadEvidence: CampaignUploadedAudience["uploadEvidence"]
  ) => {
    const limitedRecipients = nextRecipients.slice(0, attachRecipientLimit);
    setRecipients(limitedRecipients);
    patchAudienceConfig({
      uploadedRecipients: limitedRecipients,
      audienceUploadEvidence: uploadEvidence ?? undefined,
    });
    if (usingBirthdayAudience) {
      void importBirthdaysFromRecipients(limitedRecipients);
    }
    if (nextRecipients.length > limitedRecipients.length) {
      toast.warning(
        t("bulkNodeRecipientsTruncated", { count: limitedRecipients.length })
      );
    }
  };

  const handleRecipientsLoaded = (nextRecipients: UploadRecipient[]) => {
    persistUploadedAudience(nextRecipients, null);
  };

  const handleUploadedAudienceChange = (
    nextAudience: CampaignUploadedAudience
  ) => {
    persistUploadedAudience(
      nextAudience.recipients as UploadRecipient[],
      nextAudience.uploadEvidence
    );
  };

  const handleRecipientAudienceSourceChange = (
    source: NonNullable<typeof config>["recipientAudienceSource"]
  ) => {
    patchAudienceConfig({ recipientAudienceSource: source });
  };

  const handleBirthdayModeChange = (enabled: boolean) => {
    const nextOneTimeScheduleConfig =
      oneTimeScheduleConfig.mode === "once"
        ? oneTimeScheduleConfig
        : buildDefaultOneTimeScheduleConfig(scheduleTimezone);
    const shouldClearUploadedRecipients =
      enabled &&
      recipients.length > 0 &&
      birthdayRecipientPlan.validBirthdayCount === 0;
    patchAudienceConfig({
      recipientAudienceSource: enabled
        ? SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
        : SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
      birthdayConfig: enabled
        ? {
            version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
            leapDayPolicy: "feb_28",
          }
        : undefined,
      scheduleConfig: enabled
        ? birthdayScheduleConfig
        : nextOneTimeScheduleConfig,
      ...(shouldClearUploadedRecipients ? { uploadedRecipients: [] } : {}),
      ...(shouldClearUploadedRecipients
        ? { audienceUploadEvidence: undefined }
        : {}),
    });
    if (shouldClearUploadedRecipients) {
      setRecipients([]);
      toast.error(
        t(
          bulkChannel === "telegram"
            ? "bulkNodeBirthdayTelegramUploadRequired"
            : "bulkNodeBirthdayUploadRequired"
        )
      );
    } else if (enabled && recipients.length > 0) {
      void importBirthdaysFromRecipients(recipients);
    }
  };

  const patchBirthdayScheduleConfig = (next: CampaignScheduleConfig) => {
    patchConfig({
      scheduleConfig: next,
      birthdayConfig: {
        version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
        leapDayPolicy: "feb_28",
      },
    });
  };

  const commitBirthdayScheduleDraft = () => {
    const next = parseBirthdayCampaignScheduleConfig({
      ...birthdayScheduleConfig,
      timezone: birthdayTimezoneDraft,
      recurrence: {kind: "daily", time: birthdayTimeDraft},
    });
    if (!next) {
      setBirthdayTimeDraft(birthdayScheduleTime);
      setBirthdayTimezoneDraft(birthdayScheduleConfig.timezone);
      toast.error(t("birthdayScheduleInvalid"));
      return;
    }
    if (birthdayTimeDraft !== birthdayScheduleTime || next.timezone !== birthdayScheduleConfig.timezone) {
      patchBirthdayScheduleConfig(next);
    }
  };

  const handleTelegramAudienceModeChange = (source: TelegramAudienceMode) => {
    patchAudienceConfig({
      recipientAudienceSource:
        source === SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
          ? SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
          : SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
    });
  };

  const handleTelegramSubscriberSourceChange = (sourceId: string) => {
    patchAudienceConfig({
      telegramSubscriberSourceId: sourceId,
      recipientAudienceSource: usingBirthdayAudience
        ? SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
        : SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
    });
    if (usingBirthdayAudience && recipients.length > 0) {
      void importBirthdaysFromRecipients(recipients, sourceId);
    }
  };

  const resolveScheduledAtIso = () => {
    if (sendTiming !== "scheduled") return null;
    const scheduledAt = oneTimeScheduleConfig.startAt
      ? new Date(oneTimeScheduleConfig.startAt)
      : null;
    if (!scheduledAt) {
      toast.error(t("bulkNodeScheduleRequired"));
      return undefined;
    }
    if (scheduledAt.getTime() <= Date.now()) {
      toast.error(t("bulkNodeScheduleFutureRequired"));
      return undefined;
    }
    return scheduledAt.toISOString();
  };

  const activeRecipientCount = usingRegisteredBusinessPhonesAudience
    ? registeredBusinessPhonesAudience?.total || 0
    : usingTelegramSubscribersAudience
      ? telegramSubscriberCount
      : usingBirthdayAudience
        ? birthdayRecipientPlan.todayBirthdayCount
        : recipients.length;
  const birthdayProtectionExhaustsDailyLimit =
    !usingBirthdayAudience &&
    birthdayProtection?.active &&
    protectedDailyRecipientLimit <= 0;
  const sharedSendGate = resolveBulkCampaignSharedSendGate({
    isSubmitting: isSending,
    hasActiveDispatch,
    recipientParsing: recipientUploadParsing,
    emptyAudience: !isGeneratedSend && activeRecipientCount === 0,
    eligibilityCanSubmit: eligibilityPreview.canSubmit,
    recurring: isRecurringEligibility,
  });
  const livePlanBlocksSend =
    recipientPolicy.excludePriorFailedBulkSends &&
    !isGeneratedSend &&
    !isRecurringEligibility &&
    !hasLivePlan;
  // Without a resolved WhatsApp number the check can't run and admission
  // would refuse the send, column-split sends included.
  const planCheck = resolveBulkCampaignPlanCheck({
    applies:
      hasEligibleWhatsAppTemplate &&
      !isGeneratedSend &&
      !isRecurringEligibility &&
      Boolean(batchPlanRequestKey),
    loading: isLoadingBatchPlanPreview,
    error: batchPlanError,
    preview: liveBatchPlanPreview,
  });
  const planBlocksSend =
    planCheck.checking || planCheck.planUnavailable || planCheck.failed;
  const readinessFailure = resolveBulkCampaignReadinessFailure({
    plan: planCheck,
    eligibility: eligibilityPreview,
  });
  const eligibilityAllExcluded =
    eligibilityPreview.state === "ready" &&
    eligibilityPreview.preview.allExcluded;
  // With recipients attached, an idle check can't apply (column split, a
  // registered-phones audience), so the notice only speaks for the number.
  const recipientCheckCannotApply =
    eligibilityPreview.state === "idle" && activeRecipientCount > 0;
  const showProviderReadinessNotice =
    hasEligibleWhatsAppTemplate &&
    !isRecurringEligibility &&
    !hasActiveDispatch &&
    (planBlocksSend || !recipientCheckCannotApply);
  const readinessNoticeChecking =
    planCheck.checking || eligibilityPreview.state === "loading";
  // Send waits for both a failed check and the template catalog, so a failed
  // check's notice says when to try again once, for the later of the two;
  // otherwise the template line says it.
  const catalogRetryAt =
    templateSendBlockReason === "catalog_unavailable" &&
    templateCatalogCoolingDown
      ? templateCatalogRetryAt
      : null;
  const noticeShowsCheckFailure =
    showProviderReadinessNotice &&
    readinessFailure.failed &&
    !readinessNoticeChecking;
  const readinessRetryAt =
    noticeShowsCheckFailure && catalogRetryAt !== null
      ? Math.max(readinessFailure.retryAt ?? 0, catalogRetryAt)
      : readinessFailure.retryAt;
  const templateCatalogMessage =
    templateSendBlockReason === "catalog_unavailable"
      ? tPlan(
          templateCatalogRateLimited
            ? "templateCatalog.rateLimited"
            : "templateCatalog.unavailable"
        )
      : null;
  const templateSendBlockedMessage =
    templateSendBlockReason === "loading"
      ? t("bulkNodeTemplateSendBlockedLoading")
      : templateSendBlockReason === "catalog_unavailable"
        ? [
            templateCatalogMessage,
            catalogRetryAt !== null && !noticeShowsCheckFailure
              ? tPlan("readiness.cooldownUntil", {
                  time: formatRetryTime(catalogRetryAt),
                })
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : templateSendBlockReason
          ? t(bulkTemplateSendBlockReasonMessageKey(templateSendBlockReason))
          : null;
  // The template card, or the split's route summary, shows the catalog line
  // with its retry time; above Send it is said without the time, once.
  const templateLineShownAbove =
    !isGeneratedSend &&
    (Boolean(connectedAction) ||
      Boolean(
        columnSplitPreview &&
          !columnSplitPreview.disabledReason &&
          columnSplitCatalog?.templateCatalogBlockReason
      ));
  const templateSendBlockedReason =
    templateLineShownAbove && templateCatalogMessage
      ? templateCatalogMessage
      : templateSendBlockedMessage;
  const readinessBlockedReason =
    planBlocksSend || sharedSendGate.eligibilityBlocksSend
      ? resolveBulkCampaignReadinessBlockedReason({
          checking:
            planCheck.checking || eligibilityPreview.state === "loading",
          planUnavailable: planCheck.planUnavailable,
          failed: readinessFailure.failed,
          allExcluded: eligibilityAllExcluded,
          readinessState:
            eligibilityPreview.state === "ready"
              ? eligibilityPreview.preview.readiness.state
              : null,
        })
      : null;
  const scenarioSendBlocked =
    sharedSendGate.blocked ||
    planBlocksSend ||
    hasCompletedGeneratedRevision ||
    !isGeneratedRevisionReadyToSend ||
    (!isGeneratedSend && usingBirthdayAudience) ||
    (!isGeneratedSend && birthdayProtectionExhaustsDailyLimit) ||
    (!isGeneratedSend && !hasBulkSendAction) ||
    (!isGeneratedSend && templateSendBlocked) ||
    (!isGeneratedSend &&
      usingTelegramSubscribersAudience &&
      !selectedTelegramSourceId) ||
    (sendTiming === "scheduled" && !oneTimeScheduleConfig.startAt) ||
    livePlanBlocksSend;
  const sendStatus = resolveBulkCampaignSendStatus({
    // A completed generated revision cannot be sent again after an upgrade.
    limit: hasCompletedGeneratedRevision ? undefined : companyLimits,
    isSubmitting: isSending,
    hasActiveDispatch,
    checkingReadiness: !isRecurringEligibility && readinessNoticeChecking,
    readinessError: !isRecurringEligibility && readinessFailure.failed,
    awaitingAudience:
      !isGeneratedSend &&
      !isRecurringEligibility &&
      hasEligibleWhatsAppTemplate &&
      eligibilityPreview.state === "idle" &&
      activeRecipientCount === 0,
    allExcluded: eligibilityAllExcluded,
    readiness:
      eligibilityPreview.state === "ready"
        ? eligibilityPreview.preview.readiness
        : undefined,
    sendBlockedElsewhere: scenarioSendBlocked,
  });
  const disableSend = sendStatus.blocked;
  const showReadinessNotice =
    !hasCompletedGeneratedRevision &&
    sendStatus.state !== "sending" &&
    sendStatus.state !== "active_dispatch" &&
    (showProviderReadinessNotice || sendStatus.state === "plan_blocked");

  const handleSend = async (acknowledgeMediaFailures = false) => {
    if (!nodeData.uiOnBulkSend || disableSend) return;
    const regularRecipientsForSend =
      usingRegisteredBusinessPhonesAudience ||
      usingTelegramSubscribersAudience ||
      usingBirthdayAudience
        ? []
        : recipients;
    if (
      isGeneratedSend &&
      config.generationStatus === "failed" &&
      !acknowledgeMediaFailures
    ) {
      setShowMediaFailureAcknowledgement(true);
      return;
    }
    const scheduledAt = resolveScheduledAtIso();
    if (scheduledAt === undefined) return;
    const overflowPlan = buildBulkCampaignOverflowQueuePlan({
      recipientCount: usingBirthdayAudience
        ? 0
        : usingRegisteredBusinessPhonesAudience
          ? registeredBusinessPhonesAudience?.total || 0
          : usingTelegramSubscribersAudience
            ? telegramSubscriberCount
            : regularRecipientsForSend.length,
      dailyLimit: protectedDailyRecipientLimit,
      startAt: scheduledAt,
    });
    if (
      !isGeneratedSend &&
      overflowPlan.exceedsDailyLimit &&
      !overflowQueueConfirmedRef.current
    ) {
      setPendingOverflowPlan(overflowPlan);
      return;
    }
    const generatedAttempt =
      isGeneratedSend && generatedRevision
        ? generatedAttemptKey(
            generatedSendAttempt,
            generatedRevision,
            scheduledAt
          )
        : null;
    if (generatedAttempt) {
      setGeneratedSendAttempt(generatedAttempt);
    }
    setIsSending(true);
    try {
      if (
        !isGeneratedSend &&
        connectedAction?.nodeId &&
        !hasColumnSplitRouting
      ) {
        nodeData.uiOnConnectedActionPatch(connectedAction.nodeId, {
          actionCampaignVariableConfigs: variableConfigs,
        });
      }
      const result = await nodeData.uiOnBulkSend({
        idempotencyKey: generatedAttempt?.idempotencyKey,
        acknowledgeMediaFailures:
          isGeneratedSend && acknowledgeMediaFailures ? true : undefined,
        recipients:
          usingRegisteredBusinessPhonesAudience ||
          usingTelegramSubscribersAudience
            ? []
            : regularRecipientsForSend,
        registeredBusinessPhonesAudience: usingRegisteredBusinessPhonesAudience
          ? {
              type: SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
              previewCount: registeredBusinessPhonesAudience?.total ?? null,
            }
          : undefined,
        telegramSubscribersAudience: usingTelegramSubscribersAudience
          ? {
              type: SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
              sourceId: selectedTelegramSourceId,
              previewCount: telegramSubscriberCount,
            }
          : undefined,
        variableConfigs,
        audienceUploadEvidence:
          regularRecipientsForSend.length > 0
            ? config.audienceUploadEvidence
            : undefined,
        audienceConfirmationFingerprint:
          effectivePendingAudienceConfirmation?.fingerprint,
        overflowQueueConfirmed: overflowPlan.exceedsDailyLimit,
        scheduledAt: generatedAttempt
          ? generatedAttempt.scheduledAt
          : scheduledAt,
        recipientPolicy,
      });
      const generatedResult = isGeneratedSend
        ? (asNullableRecord(result) as BulkCampaignSendResponse | null)
        : null;
      if (generatedResult) {
        setGeneratedSendFeedback(generatedResult);
      }
      if (
        isGeneratedSend &&
        (generatedResult?.operationDisposition === "completed" ||
          generatedResult?.operationDisposition === "not_started")
      ) {
        setGeneratedSendAttempt(null);
      }
      setPendingAudienceConfirmation(null);
      const generatedChildrenTotal =
        generatedResult?.childrenTotal ??
        generatedResult?.children?.length ??
        0;
      const generatedSkippedCount = generatedResult?.skippedRecipientCount ?? 0;
      if (
        isGeneratedSend &&
        generatedResult?.queued === false &&
        generatedChildrenTotal === 0
      ) {
        toast.warning(
          t("bulkNodeNoEligibleRecipientsToast", {
            count: generatedSkippedCount,
          })
        );
      } else {
        const scenarioActivated =
          !isGeneratedSend &&
          (result as BulkCampaignSendResponse | null | undefined)
            ?.scenarioActivated === true;
        toast.success(
          isGeneratedSend
            ? generatedResult?.scheduled === true
              ? t("bulkNodeScheduledToast")
              : t("bulkNodeQueuedToast")
            : sendTiming === "scheduled"
              ? t(
                  scenarioActivated
                    ? "bulkNodeScheduledActivatedToast"
                    : "bulkNodeScheduledToast"
                )
              : t(
                  scenarioActivated
                    ? "bulkNodeQueuedActivatedToast"
                    : "bulkNodeQueuedToast"
                )
        );
      }
    } catch (error) {
      const generatedErrorPayload =
        isGeneratedSend && error instanceof BulkCampaignSendError
          ? (asNullableRecord(error.payload) as BulkCampaignSendResponse | null)
          : null;
      if (generatedErrorPayload) {
        setGeneratedSendFeedback(generatedErrorPayload);
      }
      if (isGeneratedSend && shouldReleaseGeneratedBulkSendAttempt(error)) {
        setGeneratedSendAttempt(null);
      }
      if (
        error instanceof BulkCampaignSendError &&
        error.code === "bulk_campaign_recent_audience_confirmation_required" &&
        error.confirmationRequired &&
        error.audienceFingerprint &&
        error.overlap
      ) {
        setPendingAudienceConfirmation({
          fingerprint: error.audienceFingerprint,
          overlap: error.overlap,
          audienceRevision: sendAudienceRevision,
        });
        return;
      }
      if (
        error instanceof BulkCampaignSendError &&
        error.code === BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED &&
        error.overflowQueue
      ) {
        setPendingOverflowPlan(error.overflowQueue);
        return;
      }
      if (
        error instanceof BulkCampaignSendError &&
        error.code === BULK_CAMPAIGN_PLAN_LIMIT_CODE
      ) {
        // A generated send is refused whole when it is larger than the free
        // bulk recipients left; other sends only refuse once none are left.
        const planPayload = asNullableRecord(error.payload);
        const requested = planPayload?.requestedRecipients;
        const remaining = planPayload?.bulkRecipientsRemaining;
        toast.error(
          typeof requested === "number" && typeof remaining === "number"
            ? t("bulkLimit.generatedTooLarge", { requested, remaining })
            : t("bulkLimit.blocked")
        );
        void refreshCompanyLimits();
        return;
      }
      const activationError = resolveScenarioActivationSendError(error, t);
      if (activationError) {
        if (
          error instanceof BulkCampaignSendError &&
          error.code === "scenario_activation_blocked"
        ) {
          nodeData.uiOnScenarioActivationBlocked?.(error.nodeIds);
        }
        toast.error(activationError);
        return;
      }
      // A throttled or failed template lookup has translated copy; the
      // server's text is English.
      const readinessErrorKey =
        error instanceof BulkCampaignSendError
          ? bulkCampaignReadinessErrorKey(error.code)
          : null;
      toast.error(
        readinessErrorKey
          ? tPlan(readinessErrorKey)
          : error instanceof Error
            ? error.message
            : t("bulkNodeQueueFailed")
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleRefreshGenerationJob = async () => {
    if (!nodeData.uiOnRefreshGenerationJob || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const result = await nodeData.uiOnRefreshGenerationJob();
      if (result.status === "applied" || result.status === "no_op") {
        toast.success(t("bulkNodeGenerationRefreshed"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("bulkNodeRefreshFailed")
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  const canSend =
    config.workflowKind === "bulk_campaign" && config.sendMode === "immediate";
  const canRefreshGeneration =
    Boolean(config.generationJobId) &&
    !hasCompletedGeneratedRevision &&
    (generatedRecipientCountUnavailable ||
      ["queued", "generating_media", "failed"].includes(
        config.generationStatus
      ));
  const hasRetainedGeneratedAttempt = Boolean(
    isGeneratedSend && generatedSendAttempt?.revision === generatedRevision
  );
  const totalRecipients =
    config.cohorts?.reduce((sum, cohort) => sum + cohort.count, 0) ?? 0;
  const birthdayModeDisabledReason =
    bulkChannel === "telegram"
      ? !hasTelegramFixedReplyAction
        ? t("bulkNodeBirthdayTelegramReplyRequired")
        : !selectedTelegramSourceId
          ? t("bulkNodeBirthdayTelegramBotRequired")
          : undefined
      : !hasPrimaryCampaignTemplate
        ? t("bulkNodeBirthdayTemplateRequired")
        : undefined;
  const sendBlockedReason = resolveScenarioBulkSendBlockedReason(
    {
      disableSend: disableSend && sendStatus.state !== "plan_blocked",
      isSending,
      hasCompletedGeneratedRevision,
      isGeneratedSend,
      hasBulkSendAction,
      columnSplitDisabledReason: columnSplitPreview?.disabledReason ?? null,
      templateSendBlockedMessage: templateSendBlockedReason,
      usingTelegramSubscribersAudience,
      usingUploadedAudience:
        recipientAudienceSource === SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
      selectedTelegramSourceId,
      activeRecipientCount,
      generatedRevisionNotReady: isGeneratedRevisionReadyToSend
        ? null
        : !["complete", "failed"].includes(config.generationStatus || "")
          ? "generating"
          : generatedRecipientCountUnavailable
            ? "count_unavailable"
            : "no_recipients",
      birthdayProtection: birthdayProtectionExhaustsDailyLimit
        ? {
            count: birthdayProtectedTodayCount,
            limit: protectedDailyRecipientLimit,
          }
        : null,
      sendTiming,
      hasScheduleStart: Boolean(oneTimeScheduleConfig.startAt),
      livePlanBlocksSend: livePlanBlocksSend && !showReadinessNotice,
      hasActiveDispatch,
      readinessBlockedReason: showReadinessNotice ? null : readinessBlockedReason,
    },
    t,
    tPlan
  );
  const sendBlockedReasonId = `bulk-send-blocked-${id}`;
  const readinessReasonId = `bulk-readiness-reason-${id}`;
  // Send points at the single status that explains why it is unavailable.
  const sendDescribedBy =
    disableSend && showReadinessNotice
      ? readinessReasonId
      : sendBlockedReason
        ? sendBlockedReasonId
        : undefined;
  const campaignNameInputId = `bulk-campaign-name-${id}`;
  const sendButtonLabel = isSending
    ? t("bulkNodeSending")
    : hasCompletedGeneratedRevision
      ? t("bulkNodeGeneratedRevisionSent")
      : sendStatus.state === "plan_blocked"
        ? tPlan("sendUnavailable")
        : effectivePendingAudienceConfirmation ||
            (!isGeneratedSend && hasUnchangedTerminalDispatch)
          ? t("bulkNodeSendAgain")
          : sendTiming === "scheduled"
            ? t("bulkNodeScheduleSend")
            : t("bulkNodeSendNow");
  const refreshReadiness = planBlocksSend
    ? refreshBatchPlanPreview
    : eligibilityPreview.state === "loading" ||
        eligibilityPreview.state === "ready" ||
        eligibilityPreview.state === "error"
      ? eligibilityPreview.retry
      : undefined;
  const readinessNoticeProps: CampaignReadinessNoticeProps = {
    sendStatus,
    companyLimits,
    // Catalog errors already appear beside the template selector. Keep the
    // independent failed check and its retry deadline in the shared notice.
    blockedMessage: noticeShowsCheckFailure ? undefined : sendBlockedReason,
    readiness:
      !planCheck.checking &&
      !readinessFailure.failed &&
      eligibilityPreview.state === "ready"
        ? eligibilityPreview.preview.readiness
        : undefined,
    checkingReadiness: readinessNoticeChecking,
    readinessError: readinessFailure.failed,
    readinessErrorCode: readinessFailure.code,
    retryAt: readinessRetryAt,
    awaitingAudience:
      eligibilityPreview.state === "idle" && activeRecipientCount === 0,
    messageSelected: hasEligibleWhatsAppTemplate,
    allExcluded: eligibilityAllExcluded,
    // Keep the template-specific guard when the shared notice renders it.
    sendBlockedElsewhere: templateSendBlockReason === "catalog_unavailable",
    onRefreshReadiness: refreshReadiness
      ? templateSendBlockReason === "catalog_unavailable"
        ? () => {
            // The catalog loads once per mount; Refresh asks again. The
            // loader itself waits out Meta's cooldown.
            loadWhatsAppTemplatesRef.current?.();
            refreshReadiness();
          }
        : refreshReadiness
      : undefined,
    refreshDisabled: isSending,
    reasonId: readinessReasonId,
    workspaceId: nodeData.uiWorkspaceId,
  };
  const showsSendControls =
    canSend && (isGeneratedSend || !usingBirthdayAudience);
  // The picker counts an uploaded or picked list (file card or attached row),
  // and Send says what to do while it is empty.
  const recipientSummary = isGeneratedSend
    ? t("bulkNodeLogicalRecipients", { count: totalRecipients })
    : usingBirthdayAudience
      ? t("bulkNodeBirthdayRecipients", { count: activeRecipientCount })
      : usingRegisteredBusinessPhonesAudience
        ? t("bulkNodeRegisteredBusinessPhonesCount", {
            count: registeredBusinessPhonesAudience?.total || 0,
          })
        : usingTelegramSubscribersAudience
          ? t("bulkNodeTelegramKnownCount", { count: telegramSubscriberCount })
          : null;
  const readinessNotice = showReadinessNotice ? (
    <CampaignReadinessNotice {...readinessNoticeProps} />
  ) : null;
  const generatedFeedbackChildrenTotal =
    generatedSendFeedback?.childrenTotal ??
    generatedSendFeedback?.children?.length ??
    0;
  const generatedFeedbackSkippedCount =
    (generatedSendFeedback?.skippedRecipientCount ?? 0) +
    (generatedSendFeedback?.skippedOptIn ?? 0);
  const generatedFeedbackHasNoEligibleRecipients = Boolean(
    generatedSendFeedback?.queued === false &&
      generatedFeedbackChildrenTotal === 0
  );

  return (
    <BulkRootNodeFrame selected={selected} nodeData={nodeData}>
      <CardHeader className="space-y-2 px-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {t("bulkNodeBadge")}
            </Badge>
            <Users className="h-4 w-4 text-sky-500" />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={nodeData.uiOnRemove}
            aria-label={t("bulkNodeRemoveBlock")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <CardTitle className="text-sm leading-tight">
          {t("campaignAudienceNodeTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 text-xs">
        <div className="space-y-1">
          <label
            htmlFor={campaignNameInputId}
            className="font-medium text-muted-foreground"
          >
            {t("bulkNodeCampaignName")}
          </label>
          <Input
            id={campaignNameInputId}
            value={config.campaignName || ""}
            onChange={event =>
              patchConfig({ campaignName: event.target.value })
            }
            disabled={isSending}
            className="nodrag h-8 text-xs"
          />
        </div>

        {!isGeneratedSend && connectedAction ? (
          <div
            className={cn(
              "rounded-md border px-2 py-1.5 text-[11px] leading-snug",
              templateSendBlocked
                ? "border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                : "border-emerald-200 bg-emerald-50/60 text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
            )}
          >
            <div
              className={cn(
                "flex items-center gap-1.5 text-[10px] font-medium uppercase",
                templateSendBlocked
                  ? "text-amber-700 dark:text-amber-200"
                  : "text-emerald-700 dark:text-emerald-200"
              )}
            >
              <MessageSquare className="h-3 w-3" />
              <span>{t("bulkNodeAttachedAction")}</span>
            </div>
            <div className="mt-1 truncate font-semibold">
              {connectedActionLabel}
            </div>
            {connectedActionPreview ? (
              <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted-foreground">
                {connectedActionPreview}
              </div>
            ) : null}
            {templateSendBlockedMessage ? (
              <div className="mt-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
                {templateSendBlockedMessage}
              </div>
            ) : null}
          </div>
        ) : null}

        {!isGeneratedSend && !hasColumnSplitRouting ? (
          <BirthdayCampaignControl
            enabled={usingBirthdayAudience}
            disabled={Boolean(birthdayModeDisabledReason)}
            onEnabledChange={handleBirthdayModeChange}
            time={birthdayTimeDraft}
            timezone={birthdayTimezoneDraft}
            onTimeChange={setBirthdayTimeDraft}
            onTimezoneChange={setBirthdayTimezoneDraft}
            onTimeBlur={commitBirthdayScheduleDraft}
            onTimezoneBlur={commitBirthdayScheduleDraft}
            metrics={
              usingBirthdayAudience
                ? [
                    {
                      label: t("bulkNodeBirthdaySelected"),
                      value: birthdayRecipientPlan.selectedRecipientCount,
                    },
                    {
                      label: t("bulkNodeBirthdayValidRows"),
                      value: birthdayRecipientPlan.validBirthdayCount,
                    },
                    {
                      label: t("bulkNodeBirthdayToday"),
                      value: birthdayRecipientPlan.todayBirthdayCount,
                    },
                  ]
                : undefined
            }
            labels={{
              regular: t("bulkNodeRegularAudience"),
              birthdays: t("bulkNodeBirthdayAudience"),
              time: t("bulkNodeBirthdayTime"),
              timezone: t("bulkNodeBirthdayTimezone"),
              disabledReason: birthdayModeDisabledReason,
            }}
          />
        ) : null}

        {!isGeneratedSend && hasColumnSplitRouting ? (
          <div className="rounded-md border border-dashed bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
            {t("columnSplitRequiresUploadedRecipients")}
          </div>
        ) : null}

        {!isGeneratedSend &&
        usingBirthdayAudience &&
        birthdayRecipientPlan.overLimitDays.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
            <div className="font-medium">
              {t("bulkNodeBirthdayOverLimitTitle")}
            </div>
            <div className="mt-1 space-y-0.5">
              {birthdayRecipientPlan.overLimitDays.map(day => (
                <div key={day.key}>
                  {t("bulkNodeBirthdayOverLimitDay", {
                    day: formatBirthdayDay(day, t),
                    count: day.count,
                    limit: day.limit || dailyRecipientLimit,
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!isGeneratedSend &&
        !usingBirthdayAudience &&
        birthdayProtection?.active &&
        birthdayProtectedTodayCount > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
            {t("bulkNodeBirthdayProtectedToday", {
              count: birthdayProtectedTodayCount,
              limit: protectedDailyRecipientLimit,
            })}
          </div>
        ) : null}

        {!isGeneratedSend &&
        hasRegisteredBusinessPhonesAudience &&
        !usingBirthdayAudience &&
        !hasColumnSplitRouting ? (
          <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/10 p-1">
            <Button
              type="button"
              size="sm"
              variant={
                recipientAudienceSource ===
                SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE
                  ? "default"
                  : "outline"
              }
              aria-pressed={
                recipientAudienceSource ===
                SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE
              }
              className="h-7 justify-start px-2 text-[11px]"
              onClick={() =>
                handleRecipientAudienceSourceChange(
                  SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE
                )
              }
            >
              {t("bulkNodeUploadedAudience")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={
                usingRegisteredBusinessPhonesAudience ? "default" : "outline"
              }
              aria-pressed={usingRegisteredBusinessPhonesAudience}
              className="h-7 justify-start px-2 text-[11px]"
              onClick={() =>
                handleRecipientAudienceSourceChange(
                  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE
                )
              }
            >
              {t("bulkNodeRegisteredBusinessPhones")}
            </Button>
          </div>
        ) : canUseResolvedContactsPicker ? (
          <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/10 p-1">
            <Button
              type="button"
              size="sm"
              variant={recipientEntryMode === "upload" ? "default" : "outline"}
              aria-pressed={recipientEntryMode === "upload"}
              className="h-7 justify-start px-2 text-[11px]"
              onClick={() => setNodeRecipientEntryMode("upload")}
            >
              {t("bulkNodeFromFile")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={recipientEntryMode === "select" ? "default" : "outline"}
              aria-pressed={recipientEntryMode === "select"}
              className="h-7 justify-start px-2 text-[11px]"
              onClick={() => setNodeRecipientEntryMode("select")}
            >
              {t("bulkNodeFromContacts")}
            </Button>
          </div>
        ) : null}

        {!isGeneratedSend ? (
          <BulkCampaignAudienceComposer
            hideRecipientPicker={
              usingRegisteredBusinessPhonesAudience ||
              usingTelegramSubscribersAudience
            }
            pickerClassName="nodrag nowheel min-w-0 rounded-md border bg-muted/10 p-2"
            telegram={
              bulkChannel === "telegram"
                ? {
                    audienceMode: usingTelegramSubscribersAudience
                      ? SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE
                      : "manual",
                    manualLabel: t("bulkNodeUploadedAudience"),
                    knownLabel: t("bulkNodeTelegramKnownAudience"),
                    loadingText: t("bulkNodeTelegramLoadingAudience"),
                    onAudienceModeChange: handleTelegramAudienceModeChange,
                    onSourceChange: handleTelegramSubscriberSourceChange,
                    rateHint: t("bulkNodeTelegramRateHint"),
                    selectedSourceId: selectedTelegramSourceId,
                    selectorClassName: "nodrag",
                    showAudienceModes: !usingBirthdayAudience,
                    sourceSelectLabel: t("bulkNodeTelegramBot"),
                    sourceSelectPlaceholder: t(
                      "bulkNodeTelegramBotPlaceholder"
                    ),
                    sources: telegramSources,
                    subscriberCount: telegramSubscriberCount,
                    subscriberCountText: t("bulkNodeTelegramKnownCount", {
                      count: telegramSubscriberCount,
                    }),
                    isLoadingSources: isLoadingTelegramSources,
                    isLoadingSubscribers: isLoadingTelegramSubscribers,
                  }
                : null
            }
            picker={{
              workspaceId: nodeData.uiWorkspaceId,
              channel: bulkChannel,
              sourceIds: resolveBulkCampaignPickerSourceIds({
                channel: bulkChannel,
                whatsappSourceId: liveBatchPlanPreview?.whatsappMeta?.sourceId,
                telegramSourceId: selectedTelegramSourceId,
              }),
              recipients,
              onRecipientsChange: handleRecipientsLoaded,
              audienceUploadEvidence: config.audienceUploadEvidence ?? null,
              onUploadedAudienceChange: handleUploadedAudienceChange,
              onParsingChange: setRecipientUploadParsing,
              templateVariables:
                usingBirthdayAudience || hasColumnSplitRouting
                  ? []
                  : templateVariables,
              recipientLimit: attachRecipientLimit,
              recipientLimitMode: usingBirthdayAudience ? "override" : "cap",
              requireBirthdayColumn: usingBirthdayAudience,
              disabled:
                isImportingBirthdays ||
                birthdayProtectionExhaustsDailyLimit ||
                isSending,
              compact: true,
              mode: recipientEntryMode,
              variant: "chat",
              recipientLimitState: {
                preview: effectiveRecipientLimitPreview ?? null,
                loading:
                  isLoadingBatchPlanPreview || isLoadingBirthdayProtection,
                error: liveBatchPlanPreview?.error ?? null,
              },
              variableConfigs,
              onVariableConfigsChange: setVariableConfigs,
              showHeader: false,
              showSelectedRecipientsTable: false,
              showRecipientLimitAlerts: false,
              variableMapperTitle: t("bulkNodeVariables"),
              variableMapperAllowedModes: [
                "auto",
                "csv_variable",
                "csv_column",
                "contact_name",
                "recipient_phone",
                "custom",
              ],
              variableMapperModeLabels: {
                auto: t("bulkNodeVariableAuto"),
                csv_variable: t("bulkNodeVariableUploadedVariable"),
                csv_column: t("bulkNodeVariableUploadedColumn"),
                contact_name: t("bulkNodeVariableContactName"),
                recipient_phone: t("bulkNodeVariableRecipientPhone"),
                custom: t("bulkNodeVariableCustom"),
              },
              variableMapperSelectColumnPlaceholder: t(
                "bulkNodeColumnPlaceholder"
              ),
              variableMapperCustomValuePlaceholder: t(
                "bulkNodeValuePlaceholder"
              ),
            }}
          />
        ) : null}
        {/* The picker hides its own limit alerts; say why uploads are off. */}
        {!isGeneratedSend &&
        bulkChannel === "whatsapp" &&
        !usingRegisteredBusinessPhonesAudience &&
        !isLoadingBatchPlanPreview &&
        liveBatchPlanPreview?.error ? (
          <p
            role="status"
            className="text-[11px] font-medium text-amber-800 break-words whitespace-normal dark:text-amber-100"
          >
            {t("bulkNodeRecipientLimitUnavailable")}
          </p>
        ) : null}

        {!isGeneratedSend && hasColumnSplitRouting && columnSplitPreview ? (
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[10px] uppercase text-muted-foreground">
              {t("columnSplitRouteSummaryTitle")}
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {columnSplitPreview.routes.map(route => (
                <div
                  key={route.handleId}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="truncate">
                    {route.isElse
                      ? t("columnSplitElsePath")
                      : route.pathLabel || route.pathId}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {route.recipientCount} ·{" "}
                    {route.templateName || t("columnSplitNoTemplateConnected")}
                  </span>
                </div>
              ))}
            </div>
            {columnSplitPreview.disabledReason ? (
              <div className="mt-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
                {t(columnSplitPreview.disabledReason)}
              </div>
            ) : columnSplitCatalog?.templateCatalogBlockReason &&
              templateSendBlockedMessage ? (
              <div className="mt-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
                {templateSendBlockedMessage}
              </div>
            ) : null}
            {columnSplitPreview.routes
              .filter(
                (
                  route
                ): route is typeof route & {
                  templateSendBlockReason: NonNullable<
                    typeof route.templateSendBlockReason
                  >;
                } =>
                  // The server checks every connected route, used or not.
                  Boolean(route.actionNodeId) &&
                  Boolean(route.templateSendBlockReason)
              )
              .map(route => (
                <div
                  key={`${route.handleId}-block`}
                  className="mt-1 text-[11px] font-medium text-amber-800 dark:text-amber-100"
                >
                  {(route.pathLabel || route.pathId) +
                    ": " +
                    t(
                      bulkTemplateSendBlockReasonMessageKey(
                        route.templateSendBlockReason
                      )
                    )}
                </div>
              ))}
            {totalRecipients > 0 && recipients.length === 0 ? (
              <div className="mt-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
                {t("columnSplitUploadRecipientsFirst")}
              </div>
            ) : null}
          </div>
        ) : null}

        {recipientSummary || (hasColumnSplitRouting && totalRecipients > 0) ? (
          <div className="rounded-md border bg-muted/20 px-2 py-1.5">
            <div className="text-[10px] uppercase text-muted-foreground">
              {t("bulkNodeRecipients")}
            </div>
            {recipientSummary ? (
              <div className="font-medium">{recipientSummary}</div>
            ) : null}
            {isGeneratedSend ? (
              <div className="mt-0.5 text-muted-foreground">
                {t("bulkNodeGeneratedRecipientMessages", {
                  count: generatedRecipientCount,
                })}
              </div>
            ) : null}
            {hasColumnSplitRouting && totalRecipients > 0 ? (
              <div className="mt-0.5 text-muted-foreground">
                {t("columnSplitIgnoresGeneratedCohorts")}
              </div>
            ) : null}
          </div>
        ) : null}

        {generatedRecipientCountUnavailable ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t("bulkNodeGeneratedRecipientCountUnavailable")}
            </AlertDescription>
          </Alert>
        ) : isGeneratedSend && generatedRecipientCount === 0 ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t("bulkNodeNoEligibleRecipients")}
            </AlertDescription>
          </Alert>
        ) : null}

        {generatedSendFeedback ? (
          <div
            className="min-w-0 space-y-1.5 rounded-md border bg-muted/20 p-2"
            aria-live="polite"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[11px] font-medium">
                {generatedFeedbackHasNoEligibleRecipients
                  ? t("bulkNodeNoEligibleRecipients")
                  : generatedSendFeedback.partial
                    ? t("bulkNodePartialSendResult")
                    : generatedFeedbackChildrenTotal > 1
                      ? t("bulkNodeGroupedSendResult", {
                          count: generatedFeedbackChildrenTotal,
                        })
                      : t("bulkNodeGeneratedSendResult")}
              </div>
              {generatedSendFeedback.partial ? (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t("bulkNodeRetryAvailable")}
                </Badge>
              ) : null}
            </div>
            {generatedSendFeedback.campaignId &&
            generatedSendFeedback.status &&
            generatedFeedbackChildrenTotal === 1 ? (
              <CampaignDispatchLiveStatus
                workspaceId={nodeData.uiWorkspaceId}
                campaignId={generatedSendFeedback.campaignId}
                initialStatus={generatedSendFeedback.status}
                labels={liveStatusLabels}
                compact
                onLifecycleChange={status =>
                  setGeneratedSendFeedback(current =>
                    current
                      ? {
                          ...current,
                          status: status as BulkCampaignDispatchStatus,
                        }
                      : current
                  )
                }
              />
            ) : (
              <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                <div className="min-w-0 rounded bg-muted px-1 py-1">
                  {t("bulkNodeQueuedCount", {
                    count: generatedSendFeedback.total ?? 0,
                  })}
                </div>
                <div className="min-w-0 rounded bg-muted px-1 py-1">
                  {t("bulkNodeSkippedCount", {
                    count: generatedFeedbackSkippedCount,
                  })}
                </div>
                <div className="min-w-0 rounded bg-muted px-1 py-1">
                  {t("bulkNodeChildCampaignCount", {
                    count: generatedFeedbackChildrenTotal,
                  })}
                </div>
              </div>
            )}
            {generatedSendFeedback.error ? (
              <div className="break-words text-[11px] text-destructive">
                {generatedSendFeedback.error}
              </div>
            ) : null}
          </div>
        ) : config.sendStatus ? (
          <div className="space-y-1.5">
            {nodeData.uiWorkspaceId &&
            config.sendStatus.campaignId &&
            config.sendStatus.lifecycleStatus ? (
              <>
                <CampaignDispatchLiveStatus
                  workspaceId={nodeData.uiWorkspaceId}
                  campaignId={config.sendStatus.campaignId}
                  initialStatus={config.sendStatus.lifecycleStatus}
                  labels={liveStatusLabels}
                  compact
                  onLifecycleChange={handleDispatchLifecycleChange}
                />
                {config.sendStatus.lastOutcome ? (
                  <BulkRootLastOutcomeSummary
                    outcome={config.sendStatus.lastOutcome}
                    t={t}
                  />
                ) : config.sendStatus.skipped > 0 ? (
                  <div className="rounded bg-muted px-1 py-1 text-center text-[10px]">
                    {t("bulkNodeSkippedCount", {
                      count: config.sendStatus.skipped,
                    })}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {config.sendStatus.lifecycleStatus ? (
                  <Badge variant="outline" className="text-[10px]">
                    {formatLifecycleStatus(config.sendStatus.lifecycleStatus)}
                  </Badge>
                ) : null}
                <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
                  <div className="rounded bg-muted px-1 py-1">
                    {t("bulkNodeQueuedCount", {
                      count: config.sendStatus.queued,
                    })}
                  </div>
                  <div className="rounded bg-muted px-1 py-1">
                    {t("bulkNodeSentCount", { count: config.sendStatus.sent })}
                  </div>
                  <div className="rounded bg-muted px-1 py-1">
                    {t("bulkNodeSkippedCount", {
                      count: config.sendStatus.skipped,
                    })}
                  </div>
                  <div className="rounded bg-muted px-1 py-1">
                    {t("bulkNodeFailedCount", {
                      count: config.sendStatus.failed,
                    })}
                  </div>
                </div>
                {config.sendStatus.lastOutcome ? (
                  <BulkRootLastOutcomeSummary
                    outcome={config.sendStatus.lastOutcome}
                    t={t}
                  />
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {hasEligibleWhatsAppTemplate ? (
          <div className="nodrag space-y-2">
            <PriorFailedRecipientExclusionControl
              switchId={`exclude-prior-failed-${id}`}
              labels={{
                hint: recipientPolicy.excludePriorFailedBulkSends
                  ? isRecurringEligibility
                    ? t("eligibilityEvaluatedEachRun")
                    : sendTiming === "scheduled"
                      ? t("eligibilityFrozenAtAdmission")
                      : undefined
                  : undefined,
              }}
              value={recipientPolicy.excludePriorFailedBulkSends}
              supported
              eligibility={eligibilityPreview}
              onChange={enabled =>
                patchConfig({
                  recipientPolicy: {
                    version: 1,
                    excludePriorFailedBulkSends: enabled,
                  },
                })
              }
              t={t}
            />
          </div>
        ) : null}
        {!showsSendControls && readinessNotice ? (
          <div className="nodrag">{readinessNotice}</div>
        ) : null}

        {showsSendControls ? (
          <div className="nodrag space-y-2">
            {effectivePendingAudienceConfirmation ? (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t("bulkNodeRecentAudienceOverlap", {
                    intersection:
                      effectivePendingAudienceConfirmation.overlap
                        .intersectionCount,
                    candidate:
                      effectivePendingAudienceConfirmation.overlap
                        .candidateCount,
                    percent: Math.round(
                      effectivePendingAudienceConfirmation.overlap.ratio * 100
                    ),
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {!sendStatus.planReason &&
            !isSending &&
            !hasActiveDispatch &&
            !hasCompletedGeneratedRevision ? (
              <BulkCampaignLimitHint
                limit={companyLimits}
                t={t}
                compact
                workspaceId={nodeData.uiWorkspaceId}
                recipientCount={activeRecipientCount}
              />
            ) : null}
            <fieldset
              disabled={hasRetainedGeneratedAttempt || isSending}
              className="min-w-0 space-y-1 rounded-md border bg-muted/10 p-2 disabled:opacity-70"
            >
              <div className="text-[10px] uppercase text-muted-foreground">
                {t("bulkNodeSendTiming")}
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button
                  type="button"
                  variant={sendTiming === "now" ? "default" : "outline"}
                  aria-pressed={sendTiming === "now"}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setSendTiming("now")}
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {t("bulkNodeSendNowOption")}
                </Button>
                <Button
                  type="button"
                  variant={sendTiming === "scheduled" ? "default" : "outline"}
                  aria-pressed={sendTiming === "scheduled"}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setSendTiming("scheduled")}
                >
                  <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                  {t("bulkNodeScheduleOption")}
                </Button>
              </div>
              {sendTiming === "scheduled" ? (
                <CampaignScheduleEditor
                  value={oneTimeScheduleConfig}
                  onChange={handleOneTimeScheduleConfigChange}
                  timezone={scheduleTimezone}
                  allowedModes={["once"]}
                  idPrefix={`bulk-schedule-${id}`}
                  compact
                />
              ) : null}
            </fieldset>
            {hasRetainedGeneratedAttempt ? (
              <p className="text-[11px] text-muted-foreground">
                {t("bulkNodeGeneratedTimingLocked")}
              </p>
            ) : null}
            {readinessNotice}
            {sendBlockedReason && !showReadinessNotice ? (
              <p
                id={sendBlockedReasonId}
                data-testid="bulk-send-blocked-reason"
                role="status"
                className="text-[11px] font-medium text-amber-800 break-words whitespace-normal dark:text-amber-100"
              >
                {sendBlockedReason}
              </p>
            ) : null}
            <Button
              type="button"
              className={cn(
                "w-full",
                disableSend && "disabled:opacity-100 text-muted-foreground"
              )}
              variant={disableSend ? "secondary" : "default"}
              size="sm"
              disabled={disableSend}
              aria-busy={isSending}
              aria-describedby={sendDescribedBy}
              onClick={() => void handleSend()}
            >
              {isSending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : sendTiming === "scheduled" ? (
                <CalendarClock className="mr-2 h-4 w-4" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {sendButtonLabel}
            </Button>
          </div>
        ) : null}

        {canRefreshGeneration ? (
          <Button
            type="button"
            className="nodrag w-full"
            variant="outline"
            size="sm"
            disabled={isRefreshing}
            onClick={() => void handleRefreshGenerationJob()}
          >
            {isRefreshing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("bulkNodeRefreshMedia")}
          </Button>
        ) : null}
        <AlertDialog
          open={showMediaFailureAcknowledgement}
          onOpenChange={setShowMediaFailureAcknowledgement}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("bulkNodeMediaFailureAcknowledgeTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("bulkNodeMediaFailureAcknowledgeDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("bulkNodeMediaFailureAcknowledgeCancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setShowMediaFailureAcknowledgement(false);
                  void handleSend(true);
                }}
              >
                {t("bulkNodeMediaFailureAcknowledgeConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <BulkCampaignOverflowQueueDialog
          plan={pendingOverflowPlan}
          t={t}
          onOpenChange={open => {
            if (!open) setPendingOverflowPlan(null);
          }}
          onConfirm={() => {
            overflowQueueConfirmedRef.current = true;
            setPendingOverflowPlan(null);
            void handleSend();
          }}
        />
      </CardContent>
    </BulkRootNodeFrame>
  );
}, areNodePropsEqual);
