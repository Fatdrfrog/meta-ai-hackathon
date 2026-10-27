"use client";

import {
  EmailContentEditor,
  type EmailContentValue,
} from "@/components/email/email-content-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import type { AiriBulkCampaignDraft } from "@/lib/airi-chats/bulk-campaign-draft";
import {
  appendBulkAnalyticsAudienceFiltersToSearchParams,
  type BulkAnalyticsAudienceSource,
} from "@/lib/analytics/bulk-analytics-contract";
import {
  buildBulkAnalyticsVariableConfigs,
  buildBulkCampaignAudienceIntent,
  buildBulkCampaignSendRequest,
  bulkCampaignJsonFetcher,
  BulkCampaignSendError,
  createBulkCampaignIdempotencyKey,
  formatMissingCampaignVariablesMessage,
  postBulkCampaignSend,
  prepareCampaignRecipientsForTemplate,
  type BuildBulkCampaignAudienceIntentParams,
  type BulkCampaignAdHocAudienceMode,
} from "@/lib/campaign/bulk-campaign-client";
import {
  BULK_CAMPAIGN_PLAN_LIMIT_CODE,
  bulkCampaignReadinessErrorKey,
  bulkCampaignWhatsAppSettingsHref,
  resolveBulkCampaignPlanCheck,
  resolveBulkCampaignSendStatus,
  resolveBulkCampaignReadinessFailure,
  resolveBulkCampaignSharedSendGate,
} from "@/lib/campaign/bulk-campaign-send-gate";
import {
  buildBulkCampaignOverflowQueuePlan,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED,
  type BulkCampaignOverflowQueuePlan,
} from "@/lib/campaign/bulk-campaign-overflow-queue";
import { isActiveBulkCampaignDispatchStatus } from "@/lib/campaign/campaign-operations-contracts";
import {
  MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
  TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
  WHATSAPP_SERVICE_MESSAGE_TEXT_LIMIT,
  type BulkCampaignAudienceOverlapInfo,
  type BulkCampaignAudienceUploadEvidence,
  type BulkCampaignDispatchStatus,
} from "@/lib/campaign/bulk-campaign-contracts";
import {
  mergeCampaignRecipientsWithFillUp,
  resolveCampaignFillUpCapacity,
} from "@/lib/campaign/campaign-recipient-fill-up";
import {
  resolveCampaignVariablesForRecipient,
  retainCampaignVariableConfigs,
} from "@/lib/campaign/campaign-variable-values";
import {
  fetchTelegramSubscriberTotal,
  formatCampaignConnectedSourceLabel,
  resolveBulkCampaignPickerSourceIds,
} from "@/lib/campaign/campaign-audience-client";
import { useBulkCampaignBatchPlanPreview } from "@/lib/campaign/useBulkCampaignBatchPlan";
import {
  DEFAULT_EMAIL_CAMPAIGN_LOCALE,
  EMAIL_CAMPAIGN_LOCALE_LABELS,
  EMAIL_CAMPAIGN_LOCALES,
  type EmailCampaignLocale,
} from "@/lib/email/email-campaign-locales";
import {
  fetchWhatsAppOnboardingHealth,
  resolveWhatsAppAccountHealth,
  type WhatsAppOnboardingHealthResponse,
} from "@/lib/whatsapp/onboarding-health-response";
import {
  fetchWhatsAppTemplateCatalog,
  invalidateWhatsAppTemplateCatalog,
  shouldRetryWhatsAppTemplateCatalogError,
  subscribeWhatsAppTemplateCatalogInvalidation,
  type WhatsAppTemplateCatalogResult,
} from "@/lib/whatsapp/templates/catalog-client";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
  normalizeBulkCampaignRecipientPolicy,
  isBulkCampaignReadiness,
  type BulkCampaignCommandResult,
  type BulkCampaignEligibilityMessageIntent,
  type BulkCampaignProvenanceIntent,
  type BulkCampaignReadiness,
  type BulkCampaignRecipientPolicy,
  type CampaignVariableSourceConfig as VariableSourceConfig,
} from "@icecore/scenario-contracts";
import { getTemplateVariables } from "@icecore/shared/types/whatsapp";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  FileText,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import { BulkCampaignAudienceComposer } from "./bulk-campaign-audience-composer";
import { CampaignFlowStep } from "./campaign-flow-step";
import {
  BulkCampaignLimitHint,
  BulkCampaignUpgradeButton,
} from "./bulk-campaign-limit-hint";
import { BulkCampaignOutcomeSummary } from "./bulk-campaign-outcome-summary";
import { BulkCampaignOverflowQueueDialog } from "./bulk-campaign-overflow-queue-dialog";
import {
  BulkCampaignSendSummaryDialog,
  type BulkCampaignSendSummary,
} from "./bulk-campaign-send-summary-dialog";
import {
  CampaignDispatchPlanCard,
  type QueuedCampaignDispatchInfo,
} from "./campaign-dispatch-plan-card";
import { CampaignRecipientPicker } from "./campaign-recipient-picker";
import { CampaignTestSendDialog } from "./campaign-test-send-dialog";
import { PriorFailedRecipientExclusionControl } from "./prior-failed-recipient-exclusion-control";
import { type TelegramAudienceMode } from "./telegram-audience-selector";
import { useBulkCampaignRecipientEligibilityPreview } from "./use-bulk-campaign-recipient-eligibility-preview";

// --- Types & Interfaces ---

interface Recipient {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
}

type PendingAudienceConfirmation = {
  ownerKey: string;
  fingerprint: string;
  overlap: BulkCampaignAudienceOverlapInfo;
};

type OwnedRecipientSelection = {
  ownerKey: string;
  recipients: Recipient[];
  uploadEvidence: BulkCampaignAudienceUploadEvidence | null;
  parsing: boolean;
};

/**
 * Audience editor handlers that only write while their owner key is current.
 * Recipient and upload changes invalidate the selection; parsing does not.
 */
function useOwnedAudienceHandlers(
  ownerKey: string,
  ownerKeyRef: { readonly current: string },
  setSelection: Dispatch<SetStateAction<OwnedRecipientSelection>>,
  invalidate: () => void
) {
  const handleUploadedAudienceChange = useCallback(
    (next: {
      recipients: Recipient[];
      uploadEvidence: BulkCampaignAudienceUploadEvidence | null;
    }) => {
      if (ownerKeyRef.current !== ownerKey) {
        return;
      }
      setSelection(current => ({
        ownerKey,
        recipients: next.recipients,
        uploadEvidence: next.uploadEvidence,
        parsing: current.ownerKey === ownerKey ? current.parsing : false,
      }));
      invalidate();
    },
    [invalidate, ownerKey, ownerKeyRef, setSelection]
  );
  const handleRecipientsChange = useCallback(
    (next: Recipient[]) =>
      handleUploadedAudienceChange({ recipients: next, uploadEvidence: null }),
    [handleUploadedAudienceChange]
  );
  const handleParsingChange = useCallback(
    (parsing: boolean) => {
      if (ownerKeyRef.current !== ownerKey) {
        return;
      }
      setSelection(current => ({
        ownerKey,
        recipients: current.ownerKey === ownerKey ? current.recipients : [],
        uploadEvidence:
          current.ownerKey === ownerKey ? current.uploadEvidence : null,
        parsing,
      }));
    },
    [ownerKey, ownerKeyRef, setSelection]
  );
  return {
    handleRecipientsChange,
    handleUploadedAudienceChange,
    handleParsingChange,
  };
}

type OwnedApiError = {
  ownerKey: string;
  message: string;
  /** The plan's campaign allowance refused the send. */
  planLimit?: boolean;
};

const EMPTY_RECIPIENTS: Recipient[] = [];
const DEFAULT_RECIPIENT_POLICY =
  normalizeBulkCampaignRecipientPolicy(undefined);
const AD_HOC_PROVENANCE: BulkCampaignProvenanceIntent = { kind: "ad_hoc" };

function buildCampaignBuilderAudienceIntent(
  mode: BulkCampaignAdHocAudienceMode,
  shared: Pick<
    BuildBulkCampaignAudienceIntentParams,
    | "analyticsSource"
    | "selectedRegisteredUserIds"
    | "telegramSourceId"
    | "uploadEvidence"
  >,
  recipients: Pick<
    BuildBulkCampaignAudienceIntentParams,
    "fillUpRecipients" | "inlineRecipients" | "analyticsVariableConfigs"
  > = {}
) {
  return buildBulkCampaignAudienceIntent(mode, { ...shared, ...recipients });
}

interface MultiChannelCampaignBuilderProps {
  workspaceId: string;
  emailEnabled: boolean;
  lockedChannel?: "whatsapp" | "telegram" | "email";
  onChannelChange?: (channel: "whatsapp" | "telegram" | "email") => void;
  recipientSource?: "manual" | BulkAnalyticsAudienceSource;
  initialDraft?: AiriBulkCampaignDraft | null;
  registeredUsersAudience?: RegisteredUsersEmailAudienceClientSummary | null;
  audienceSourceSlot?: ReactNode;
}

type RegisteredUsersEmailAudienceClientSummary = {
  enabled?: boolean;
  total: number;
  totalAuthUsers: number;
  skippedUnconfirmed: number;
  skippedInvalidEmail: number;
  skippedAnonymous: number;
  skippedDuplicate: number;
  preview?: Array<{
    userId: string;
    email: string;
    name: string;
    registeredAt: string;
    locale?: string;
  }>;
};

type BulkAnalyticsAudiencePreviewResponse = {
  available?: boolean;
  reason?: string;
  message?: string;
  total: number;
  eligibleTotal: number;
  excludedOptIn: number;
  skippedPriorFailed?: number;
  marketingOptInWarningCount?: number;
  capped: boolean;
  recipientLimitTruncated?: boolean;
  maxRecipients: number;
};

type IntegrationSourceSummary = {
  id: string;
  name?: string | null;
  type?: string | null;
  credentials?: {
    bot_username?: string | null;
    display_phone_number?: string | null;
    verified_name?: string | null;
  } | null;
};

type IntegrationEmailSourceSummary = {
  id: string;
  full_address?: string | null;
  local_part?: string | null;
};

type IntegrationsResponse = {
  sources?: IntegrationSourceSummary[];
  emailSources?: IntegrationEmailSourceSummary[];
};

type WorkspaceFeatureFlagsResponse = {
  flags?: {
    whatsapp_service_bulk?: boolean;
  };
};

// --- Constants ---

const DEFAULT_EMAIL_CONTENT: EmailContentValue = {
  subject: "Update from {{company}}",
  markdown:
    "Hi {{recipientName}},\n\nWe wanted to share an update with you.\n\nThe team",
};

function createInitialEmailContentByLocale(): Record<
  EmailCampaignLocale,
  EmailContentValue
> {
  return {
    en: DEFAULT_EMAIL_CONTENT,
    ru: { subject: "", markdown: "" },
    kz: { subject: "", markdown: "" },
    uz: { subject: "", markdown: "" },
  };
}

function hasAnyEmailContent(value: EmailContentValue): boolean {
  return Boolean(value.subject.trim() || value.markdown.trim());
}

function hasCompleteEmailContent(value: EmailContentValue): boolean {
  return Boolean(value.subject.trim() && value.markdown.trim());
}

function toEmailCampaignContent(value: EmailContentValue) {
  return {
    format: "markdown" as const,
    subject: value.subject.trim(),
    markdown: value.markdown,
  };
}

function buildLocalizedEmailContentPayload(
  contents: Record<EmailCampaignLocale, EmailContentValue>
) {
  const localized: Partial<
    Record<EmailCampaignLocale, ReturnType<typeof toEmailCampaignContent>>
  > = {};

  EMAIL_CAMPAIGN_LOCALES.forEach(locale => {
    if (locale === DEFAULT_EMAIL_CAMPAIGN_LOCALE) return;
    const content = contents[locale];
    if (hasCompleteEmailContent(content)) {
      localized[locale] = toEmailCampaignContent(content);
    }
  });

  return Object.keys(localized).length > 0 ? localized : undefined;
}

const EMAIL_STARTER_TEMPLATES: Array<{
  key: string;
  label: string;
  subject: string;
  markdown: string;
}> = [
  {
    key: "announcement",
    label: "Announcement",
    subject: "{{company}} announcement",
    markdown:
      "Hi {{recipientName}},\n\n## Product update\n\nWe wanted to share an update with you.\n\n- New improvements are live\n- Your workspace is ready to use them\n\nThe team",
  },
  {
    key: "product_update",
    label: "Product Update",
    subject: "New in {{company}}",
    markdown:
      "Hi {{recipientName}},\n\nWe shipped a product update that may help your team move faster.\n\n[Open your workspace]({{workspaceUrl}})\n\nThe team",
  },
  {
    key: "event_reminder",
    label: "Event Reminder",
    subject: "Reminder from {{company}}",
    markdown:
      "Hi {{recipientName}},\n\nThis is a quick reminder about the upcoming event.\n\n- Date: {{eventDate}}\n- Time: {{eventTime}}\n\nSee you there.",
  },
];

const MESSAGE_TEXT_PLACEHOLDER_VALUES = {
  exampleName: "{{name}}",
  exampleCompany: "{{company}}",
} as const;

const MESSAGE_TEXT_CHARACTER_LIMIT_VALUES = {
  exampleVariable: "{{ variable }}",
} as const;

// --- Form Validation Schema (Zod) ---

type CampaignValidationTranslate = (
  key: string,
  values?: Record<string, string | number>
) => string;

// Built per render language: messages are `validationMessages.*`.
const buildCampaignSchema = (t: CampaignValidationTranslate) =>
  z
    .object({
      channel: z.enum(["whatsapp", "telegram", "email"]),
      whatsappMessageType: z.enum(["template", "service_text"]),
      campaignName: z
        .string()
        .min(1, t("validationMessages.campaignNameRequired")),
      selectedTemplateValue: z.string().optional(),
      messageText: z
        .string()
        .max(
          TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
          t("validationMessages.messageLimit", {
            limit: TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
          })
        )
        .optional(),
      emailSubject: z.string().optional(),
      emailMarkdown: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (
        data.channel === "whatsapp" &&
        data.whatsappMessageType === "template" &&
        !data.selectedTemplateValue
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selectedTemplateValue"],
          message: t("validationMessages.templateRequired"),
        });
      }
      if (
        ((data.channel === "whatsapp" &&
          data.whatsappMessageType === "service_text") ||
          data.channel === "telegram") &&
        (!data.messageText || !data.messageText.trim())
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messageText"],
          message: t("validationMessages.messageTextRequired"),
        });
      }
      if (data.channel === "email") {
        if (!data.emailSubject?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["emailSubject"],
            message: t("validationMessages.emailSubjectRequired"),
          });
        }
        if (!data.emailMarkdown?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["emailMarkdown"],
            message: t("validationMessages.emailBodyRequired"),
          });
        }
      }
    });

type CampaignFormValues = z.infer<ReturnType<typeof buildCampaignSchema>>;

// --- Utility Functions ---

const isBulkAnalyticsRecipientSource = (
  value: "manual" | BulkAnalyticsAudienceSource
): value is BulkAnalyticsAudienceSource =>
  Boolean(
    value && typeof value === "object" && value.type === "bulk_analytics"
  );

const formatInteger = (
  value: number | null | undefined,
  locale: string
): string =>
  new Intl.NumberFormat(locale).format(Math.max(0, Number(value || 0)));

// --- Custom Hooks ---

function useCampaignData(
  workspaceId: string,
  channel: "whatsapp" | "telegram" | "email",
  analyticsRecipientSource: BulkAnalyticsAudienceSource | null,
  selectedTemplateValue?: string,
  selectedWhatsAppSourceId?: string
) {
  const {
    data: templatesData,
    error: templatesError,
    isLoading: loadingTemplates,
    mutate: refreshTemplates,
  } = useSWR<WhatsAppTemplateCatalogResult>(
    channel === "whatsapp" && workspaceId
      ? [
          "whatsapp-template-catalog",
          workspaceId,
          selectedWhatsAppSourceId || "",
          "APPROVED",
        ]
      : null,
    () =>
      fetchWhatsAppTemplateCatalog({
        workspaceId,
        sourceId: selectedWhatsAppSourceId,
        status: "APPROVED",
        includeUnified: false,
      }),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: shouldRetryWhatsAppTemplateCatalogError,
      errorRetryCount: 2,
    }
  );
  // Templates still in Meta review, shown so a new template isn't
  // mistaken for a missing one. A failed read only hides the hint.
  const { data: pendingTemplatesData, mutate: refreshPendingTemplates } =
    useSWR<WhatsAppTemplateCatalogResult>(
      channel === "whatsapp" && workspaceId
        ? [
            "whatsapp-template-catalog",
            workspaceId,
            selectedWhatsAppSourceId || "",
            "PENDING",
          ]
        : null,
      () =>
        fetchWhatsAppTemplateCatalog({
          workspaceId,
          sourceId: selectedWhatsAppSourceId,
          status: "PENDING",
          includeUnified: false,
        }),
      { revalidateOnFocus: false, shouldRetryOnError: false }
    );
  useEffect(
    () =>
      subscribeWhatsAppTemplateCatalogInvalidation(changedWorkspaceId => {
        if (
          (!changedWorkspaceId || changedWorkspaceId === workspaceId) &&
          channel === "whatsapp"
        ) {
          void refreshTemplates();
          void refreshPendingTemplates();
        }
      }),
    [channel, refreshPendingTemplates, refreshTemplates, workspaceId]
  );

  const templates = useMemo(
    () => templatesData?.metaTemplates ?? [],
    [templatesData?.metaTemplates]
  );
  const pendingTemplates = useMemo(() => {
    const approved = new Set(templates.map(getWhatsAppTemplateOptionValue));
    return (pendingTemplatesData?.metaTemplates ?? []).filter(
      template =>
        template.status === "PENDING" &&
        !approved.has(getWhatsAppTemplateOptionValue(template))
    );
  }, [pendingTemplatesData?.metaTemplates, templates]);
  const [recheckingTemplates, setRecheckingTemplates] = useState(false);
  // One forced Meta read refreshes the server's catalog; the invalidation
  // then rereads every status view from it.
  const recheckTemplates = useCallback(async (): Promise<boolean> => {
    setRecheckingTemplates(true);
    try {
      await fetchWhatsAppTemplateCatalog({
        workspaceId,
        sourceId: selectedWhatsAppSourceId,
        status: "APPROVED",
        includeUnified: false,
        force: true,
      });
      return true;
    } catch {
      return false;
    } finally {
      invalidateWhatsAppTemplateCatalog(workspaceId);
      setRecheckingTemplates(false);
    }
  }, [selectedWhatsAppSourceId, workspaceId]);

  const {
    preview: batchPlanPreview,
    isLoading: loadingBatchPlanPreview,
    isRefreshing: refreshingBatchPlanPreview,
    error: batchPlanError,
    refresh: refreshBatchPlanPreview,
  } = useBulkCampaignBatchPlanPreview({
    workspaceId,
    channel,
    sourceId: selectedWhatsAppSourceId,
  });

  const analyticsUrl = useMemo(() => {
    if (!analyticsRecipientSource) return null;
    const params = new URLSearchParams();
    appendBulkAnalyticsAudienceFiltersToSearchParams(
      params,
      analyticsRecipientSource.filters
    );

    const selectedTemplate = templates.find(
      t => getWhatsAppTemplateOptionValue(t) === selectedTemplateValue
    );
    const observedSourceId = batchPlanPreview?.whatsappMeta?.sourceId?.trim();
    if (selectedTemplate && observedSourceId) {
      params.set("sourceId", observedSourceId);
      params.set("templateName", selectedTemplate.name);
      params.set("language", selectedTemplate.language);
      params.set("templateCategory", selectedTemplate.category);
    }
    const maxRecipients = batchPlanPreview?.recipientLimit?.maxRecipients;
    if (maxRecipients && maxRecipients > 0) {
      params.set(
        "maxRecipients",
        String(Math.min(maxRecipients, MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS))
      );
    }

    return `/api/workspaces/${workspaceId}/analytics/bulk/audience-preview?${params.toString()}`;
  }, [
    analyticsRecipientSource,
    batchPlanPreview?.recipientLimit?.maxRecipients,
    batchPlanPreview?.whatsappMeta?.sourceId,
    templates,
    selectedTemplateValue,
    workspaceId,
  ]);

  const {
    data: analyticsPreview,
    error: analyticsError,
    isLoading: loadingAnalytics,
  } = useSWR<BulkAnalyticsAudiencePreviewResponse>(
    analyticsUrl,
    bulkCampaignJsonFetcher,
    {
      revalidateOnFocus: false,
    }
  );

  return {
    templates,
    pendingTemplates,
    recheckTemplates,
    recheckingTemplates,
    requiresWhatsAppConnection:
      templatesData?.requiresWhatsAppConnection === true,
    loadingTemplates,
    templatesError,
    templatesCatalog: templatesData?.catalog,
    batchPlanPreview,
    loadingBatchPlanPreview,
    refreshingBatchPlanPreview,
    batchPlanError,
    refreshBatchPlanPreview,
    analyticsPreview,
    analyticsError,
    loadingAnalytics,
  };
}

// --- Main Component ---

export function MultiChannelCampaignBuilder({
  workspaceId,
  emailEnabled,
  lockedChannel,
  onChannelChange,
  recipientSource = "manual",
  initialDraft = null,
  registeredUsersAudience = null,
  audienceSourceSlot = null,
}: MultiChannelCampaignBuilderProps) {
  const t = useTranslations("MultiChannelCampaignBuilder");
  const tPlan = useTranslations("CampaignDispatchPlanCard");
  // The notice's reason line alone explains a missing WhatsApp number.
  const readinessReasonId = useId();
  const locale = useLocale();
  const router = useRouter();
  const { data: companyLimits, mutate: refreshCompanyLimits } =
    useCompanyLimits(workspaceId);
  const campaignSchema = useMemo(() => buildCampaignSchema(t), [t]);
  const effectiveInitialDraft =
    initialDraft?.workspaceId === workspaceId ? initialDraft : null;

  const analyticsSource = isBulkAnalyticsRecipientSource(recipientSource)
    ? recipientSource
    : null;
  const isAnalyticsMode = Boolean(analyticsSource);
  const [emailAudienceSource, setEmailAudienceSource] = useState<
    "manual" | "registered_users"
  >("manual");
  const [telegramAudienceSource, setTelegramAudienceSource] =
    useState<TelegramAudienceMode>("manual");
  const [selectedTelegramSourceId, setSelectedTelegramSourceId] = useState("");
  const [selectedWhatsAppSourceId, setSelectedWhatsAppSourceId] = useState("");
  const [selectedEmailSourceId, setSelectedEmailSourceId] = useState("");
  const [selectedRegisteredUserIds, setSelectedRegisteredUserIds] = useState<
    string[]
  >([]);
  const analyticsSourceFiltersKey = useMemo(() => {
    if (!analyticsSource) return null;

    const params = new URLSearchParams();
    appendBulkAnalyticsAudienceFiltersToSearchParams(
      params,
      analyticsSource.filters
    );

    return params.toString();
  }, [analyticsSource]);
  const analyticsSourceExcludeRecent = Boolean(
    analyticsSource?.filters.excludeRecentClientMessageWithin24h
  );
  const [
    excludeRecentClientMessageWithin24h,
    setExcludeRecentClientMessageWithin24h,
  ] = useState(analyticsSourceExcludeRecent);
  const [analyticsSourceStateKey, setAnalyticsSourceStateKey] = useState(
    analyticsSourceFiltersKey
  );
  const analyticsSourceNeedsReset =
    analyticsSourceStateKey !== analyticsSourceFiltersKey;
  const effectiveExcludeRecentClientMessageWithin24h = analyticsSourceNeedsReset
    ? analyticsSourceExcludeRecent
    : excludeRecentClientMessageWithin24h;
  const effectiveAnalyticsSource = useMemo(
    () =>
      analyticsSource
        ? {
            ...analyticsSource,
            filters: {
              ...analyticsSource.filters,
              excludeRecentClientMessageWithin24h:
                effectiveExcludeRecentClientMessageWithin24h,
            },
          }
        : null,
    [analyticsSource, effectiveExcludeRecentClientMessageWithin24h]
  );

  // Form Setup
  const form = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignSchema),
    defaultValues: {
      channel: lockedChannel || effectiveInitialDraft?.channel || "whatsapp",
      whatsappMessageType: "template",
      campaignName: effectiveInitialDraft?.campaignName || "",
      selectedTemplateValue: "",
      messageText: "",
      emailSubject: DEFAULT_EMAIL_CONTENT.subject,
      emailMarkdown: DEFAULT_EMAIL_CONTENT.markdown,
    },
  });

  const {
    watch,
    control,
    setValue,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;
  const selectedChannel = watch("channel");
  const channel =
    lockedChannel ||
    (!emailEnabled && selectedChannel === "email"
      ? "whatsapp"
      : selectedChannel);
  const selectedTemplateValue = watch("selectedTemplateValue");
  const whatsappMessageType = watch("whatsappMessageType");
  const isWhatsAppServiceText =
    channel === "whatsapp" && whatsappMessageType === "service_text";
  const [recipientPolicy, setRecipientPolicy] =
    useState<BulkCampaignRecipientPolicy>(() =>
      normalizeBulkCampaignRecipientPolicy(undefined)
    );
  const isPriorFailurePolicySupported =
    channel === "whatsapp" && !isWhatsAppServiceText;
  const effectiveRecipientPolicy = isPriorFailurePolicySupported
    ? recipientPolicy
    : DEFAULT_RECIPIENT_POLICY;
  const effectiveExcludePriorFailedBulkSends =
    effectiveRecipientPolicy.excludePriorFailedBulkSends;
  const setExcludePriorFailedBulkSends = (
    enabled: boolean | "indeterminate"
  ) => {
    if (enabled === "indeterminate") return;
    setRecipientPolicy({
      version: 1,
      excludePriorFailedBulkSends: enabled,
    });
  };
  const [lastCommandResult, setLastCommandResult] =
    useState<BulkCampaignCommandResult | null>(null);
  const [activeEmailLocale, setActiveEmailLocale] =
    useState<EmailCampaignLocale>(DEFAULT_EMAIL_CAMPAIGN_LOCALE);
  const [emailContentByLocale, setEmailContentByLocale] = useState(() =>
    createInitialEmailContentByLocale()
  );
  const appliedInitialDraftIdRef = useRef<string | null>(
    effectiveInitialDraft?.id ?? null
  );
  const appliedInitialDraftTemplateIdRef = useRef<string | null>(null);
  const emailRegisteredUsersAvailable =
    channel === "email" &&
    emailEnabled &&
    Boolean(
      registeredUsersAudience &&
        registeredUsersAudience.enabled !== false &&
        registeredUsersAudience.total > 0
    );
  const registeredUserPreviewIds = useMemo(
    () =>
      (registeredUsersAudience?.preview || [])
        .map(row => row.userId)
        .filter(Boolean),
    [registeredUsersAudience?.preview]
  );
  const registeredUserPreviewIdsKey = registeredUserPreviewIds.join("\n");
  const registeredUserSelectionTargetKey = emailRegisteredUsersAvailable
    ? registeredUserPreviewIdsKey
    : "";
  const [registeredUserSelectionKey, setRegisteredUserSelectionKey] = useState(
    registeredUserSelectionTargetKey
  );
  const registeredUserSelectionNeedsReset =
    registeredUserSelectionKey !== registeredUserSelectionTargetKey;
  const effectiveEmailAudienceSource = emailRegisteredUsersAvailable
    ? emailAudienceSource
    : "manual";
  const effectiveIsRegisteredUsersMode =
    emailRegisteredUsersAvailable &&
    effectiveEmailAudienceSource === "registered_users";
  const isRegisteredUsersMode = effectiveIsRegisteredUsersMode;
  const effectiveSelectedRegisteredUserIds = useMemo(
    () =>
      registeredUserSelectionNeedsReset
        ? emailRegisteredUsersAvailable
          ? registeredUserPreviewIds
          : []
        : selectedRegisteredUserIds,
    [
      emailRegisteredUsersAvailable,
      registeredUserPreviewIds,
      registeredUserSelectionNeedsReset,
      selectedRegisteredUserIds,
    ]
  );

  const { data: integrationsData } = useSWR<IntegrationsResponse>(
    workspaceId
      ? `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations`
      : null,
    bulkCampaignJsonFetcher,
    { revalidateOnFocus: false }
  );
  const telegramSources = useMemo(
    () =>
      (integrationsData?.sources || []).filter(
        source => source.type === "telegram" && source.id
      ),
    [integrationsData?.sources]
  );
  const whatsappIntegrationSources = useMemo(
    () =>
      (integrationsData?.sources || []).filter(
        source => source.type === "whatsapp" && source.id
      ),
    [integrationsData?.sources]
  );
  const emailSources = useMemo(
    () =>
      (integrationsData?.emailSources || []).filter(source =>
        Boolean(source.id)
      ),
    [integrationsData?.emailSources]
  );
  const selectedTelegramSourceIsAvailable = telegramSources.some(
    source => source.id === selectedTelegramSourceId
  );
  const effectiveTelegramSourceId = selectedTelegramSourceIsAvailable
    ? selectedTelegramSourceId
    : telegramSources[0]?.id || "";
  const selectedEmailSourceIsAvailable = emailSources.some(
    source => source.id === selectedEmailSourceId
  );
  const effectiveEmailSourceId = selectedEmailSourceIsAvailable
    ? selectedEmailSourceId
    : emailSources[0]?.id || "";
  // Only the total is shown, so read one row like the scenario bulk node.
  const { data: telegramSubscriberTotal } = useSWR(
    channel === "telegram" && effectiveTelegramSourceId
      ? ([
          "telegram-subscriber-total",
          workspaceId,
          effectiveTelegramSourceId,
        ] as const)
      : null,
    ([, keyWorkspaceId, sourceId]) =>
      fetchTelegramSubscriberTotal({ workspaceId: keyWorkspaceId, sourceId }),
    { revalidateOnFocus: false }
  );
  const telegramSubscriberCount = telegramSubscriberTotal ?? 0;
  const telegramSubscribersAvailable =
    channel === "telegram" &&
    Boolean(effectiveTelegramSourceId) &&
    telegramSubscriberCount > 0;
  const effectiveTelegramAudienceSource = telegramSubscribersAvailable
    ? telegramAudienceSource
    : "manual";
  const isTelegramSubscribersMode =
    telegramSubscribersAvailable &&
    effectiveTelegramAudienceSource ===
      SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE;
  const audienceMode = isAnalyticsMode
    ? ("analytics" as const)
    : isRegisteredUsersMode
      ? ("registered_users" as const)
      : isTelegramSubscribersMode
        ? ("telegram_subscribers" as const)
        : ("inline" as const);

  // State
  const selectedAudienceOwnerKey = useTransitionOwnerKey(
    [
      workspaceId,
      channel,
      channel === "telegram" ? effectiveTelegramSourceId : "",
      channel === "telegram" ? effectiveTelegramAudienceSource : "",
      channel === "whatsapp" ? selectedWhatsAppSourceId : "",
      channel === "email" ? effectiveEmailSourceId : "",
    ].join("\u0000")
  );
  const analyticsFillUpValueKey = [
    workspaceId,
    channel,
    isAnalyticsMode ? (analyticsSourceFiltersKey ?? "") : "manual",
  ].join(":");
  const analyticsFillUpResetTargetKey = useTransitionOwnerKey(
    analyticsFillUpValueKey
  );
  const selectedAudienceOwnerKeyRef = useRef(selectedAudienceOwnerKey);
  selectedAudienceOwnerKeyRef.current = selectedAudienceOwnerKey;
  const analyticsFillUpOwnerKeyRef = useRef(analyticsFillUpResetTargetKey);
  analyticsFillUpOwnerKeyRef.current = analyticsFillUpResetTargetKey;
  const [selectedAudienceState, setSelectedAudienceState] =
    useState<OwnedRecipientSelection>(() => ({
      ownerKey: selectedAudienceOwnerKey,
      recipients: [],
      uploadEvidence: null,
      parsing: false,
    }));
  const [analyticsFillUpState, setAnalyticsFillUpState] =
    useState<OwnedRecipientSelection>(() => ({
      ownerKey: analyticsFillUpResetTargetKey,
      recipients: [],
      uploadEvidence: null,
      parsing: false,
    }));
  const selectedAudienceStateApplies =
    selectedAudienceState.ownerKey === selectedAudienceOwnerKey;
  const analyticsFillUpStateApplies =
    analyticsFillUpState.ownerKey === analyticsFillUpResetTargetKey;
  const effectiveSelectedRecipients = selectedAudienceStateApplies
    ? selectedAudienceState.recipients
    : EMPTY_RECIPIENTS;
  const effectiveAnalyticsFillUpRecipients = analyticsFillUpStateApplies
    ? analyticsFillUpState.recipients
    : EMPTY_RECIPIENTS;
  const [variableConfigs, setVariableConfigs] = useState<
    Record<string, VariableSourceConfig>
  >({});
  const [variableConfigSourceKey, setVariableConfigSourceKey] = useState("");
  const [lastQueuedDispatch, setLastQueuedDispatch] =
    useState<QueuedCampaignDispatchInfo | null>(null);
  const [pendingAudienceConfirmation, setPendingAudienceConfirmation] =
    useState<PendingAudienceConfirmation | null>(null);
  const [pendingOverflowPlan, setPendingOverflowPlan] =
    useState<BulkCampaignOverflowQueuePlan | null>(null);
  const [pendingSendSummary, setPendingSendSummary] =
    useState<BulkCampaignSendSummary | null>(null);
  // Set by the summary's confirm, and read once by the resubmit it starts.
  const sendSummaryConfirmedRef = useRef(false);
  const sendPanelRef = useRef<HTMLDivElement>(null);
  const sendActionRef = useRef<HTMLDivElement>(null);
  const [apiErrorState, setApiErrorState] = useState<OwnedApiError | null>(
    null
  );
  const [submissionReadiness, setSubmissionReadiness] = useState<{
    ownerKey: string;
    value: BulkCampaignReadiness;
    evaluatedAt: string | null;
  } | null>(null);
  const [audienceSelectionRevision, setAudienceSelectionRevision] = useState(0);
  const handleDispatchLifecycleChange = useCallback(
    (status: BulkCampaignDispatchStatus) => {
      setLastQueuedDispatch(current =>
        current && current.status !== status ? { ...current, status } : current
      );
    },
    []
  );
  const effectiveSelectedAudienceUploadEvidence = selectedAudienceStateApplies
    ? selectedAudienceState.uploadEvidence
    : null;
  const effectiveAnalyticsFillUpAudienceUploadEvidence =
    analyticsFillUpStateApplies ? analyticsFillUpState.uploadEvidence : null;
  const hasActiveDispatch = isActiveBulkCampaignDispatchStatus(
    lastQueuedDispatch?.status
  );

  const invalidateAudienceSelection = useCallback(() => {
    setAudienceSelectionRevision(current => current + 1);
    setPendingAudienceConfirmation(null);
    setApiErrorState(null);
  }, []);

  const {
    handleRecipientsChange: handleSelectedRecipientsChange,
    handleUploadedAudienceChange: handleSelectedUploadedAudienceChange,
    handleParsingChange: handleSelectedRecipientParsingChange,
  } = useOwnedAudienceHandlers(
    selectedAudienceOwnerKey,
    selectedAudienceOwnerKeyRef,
    setSelectedAudienceState,
    invalidateAudienceSelection
  );
  const {
    handleRecipientsChange: handleAnalyticsFillUpRecipientsChange,
    handleUploadedAudienceChange: handleAnalyticsFillUpUploadedAudienceChange,
    handleParsingChange: handleAnalyticsFillUpParsingChange,
  } = useOwnedAudienceHandlers(
    analyticsFillUpResetTargetKey,
    analyticsFillUpOwnerKeyRef,
    setAnalyticsFillUpState,
    invalidateAudienceSelection
  );

  // Hooks
  const {
    templates,
    pendingTemplates,
    recheckTemplates,
    recheckingTemplates,
    requiresWhatsAppConnection,
    loadingTemplates,
    templatesError,
    templatesCatalog,
    batchPlanPreview,
    loadingBatchPlanPreview,
    refreshingBatchPlanPreview,
    batchPlanError,
    refreshBatchPlanPreview,
    analyticsPreview,
    analyticsError,
    loadingAnalytics,
  } = useCampaignData(
    workspaceId,
    channel,
    effectiveAnalyticsSource,
    selectedTemplateValue,
    selectedWhatsAppSourceId
  );
  const { data: workspaceFeatureFlags } = useSWR<WorkspaceFeatureFlagsResponse>(
    channel === "whatsapp" && workspaceId
      ? `/api/workspaces/${encodeURIComponent(
          workspaceId
        )}/feature-flags?keys=whatsapp_service_bulk`
      : null,
    bulkCampaignJsonFetcher,
    { revalidateOnFocus: false }
  );
  const whatsappServiceBulkEnabled =
    workspaceFeatureFlags?.flags?.whatsapp_service_bulk === true &&
    !isAnalyticsMode;
  const { data: whatsappOnboardingHealth } =
    useSWR<WhatsAppOnboardingHealthResponse>(
      channel === "whatsapp" && workspaceId
        ? `/api/whatsapp/onboarding?workspaceId=${encodeURIComponent(
            workspaceId
          )}`
        : null,
      fetchWhatsAppOnboardingHealth,
      { revalidateOnFocus: false }
    );
  const batchPlanWhatsAppSourceId =
    batchPlanPreview?.whatsappMeta?.sourceId?.trim() || "";
  const whatsappSources = useMemo(() => {
    if (
      !batchPlanWhatsAppSourceId ||
      whatsappIntegrationSources.some(
        source => source.id === batchPlanWhatsAppSourceId
      )
    ) {
      return whatsappIntegrationSources;
    }
    return [
      {
        id: batchPlanWhatsAppSourceId,
        type: "whatsapp",
        name:
          batchPlanPreview?.whatsappMeta?.displayPhoneNumber ||
          batchPlanPreview?.whatsappMeta?.verifiedName ||
          batchPlanWhatsAppSourceId,
        credentials: {
          display_phone_number:
            batchPlanPreview?.whatsappMeta?.displayPhoneNumber || null,
          verified_name: batchPlanPreview?.whatsappMeta?.verifiedName || null,
        },
      },
      ...whatsappIntegrationSources,
    ];
  }, [
    batchPlanPreview?.whatsappMeta?.displayPhoneNumber,
    batchPlanPreview?.whatsappMeta?.verifiedName,
    batchPlanWhatsAppSourceId,
    whatsappIntegrationSources,
  ]);
  const selectedWhatsAppSourceIsAvailable = whatsappSources.some(
    source => source.id === selectedWhatsAppSourceId
  );
  const effectiveWhatsAppSourceId = selectedWhatsAppSourceIsAvailable
    ? selectedWhatsAppSourceId
    : whatsappSources[0]?.id ||
      // A source-specific plan has a new SWR key. Keep the selected identity
      // while that plan has no metadata instead of reopening the cached default
      // plan and repeatedly selecting/clearing the same source.
      selectedWhatsAppSourceId ||
      batchPlanWhatsAppSourceId;
  const pickerSourceIds = useMemo(
    () =>
      resolveBulkCampaignPickerSourceIds({
        channel,
        whatsappSourceId: effectiveWhatsAppSourceId,
        telegramSourceId: effectiveTelegramSourceId,
        emailSourceId: effectiveEmailSourceId,
      }),
    [
      channel,
      effectiveEmailSourceId,
      effectiveTelegramSourceId,
      effectiveWhatsAppSourceId,
    ]
  );
  const channelSourceOptions =
    channel === "whatsapp"
      ? whatsappSources
      : channel === "email"
        ? emailSources.map(source => ({
            id: source.id,
            name: source.full_address || source.local_part || source.id,
            full_address: source.full_address,
          }))
        : [];
  const effectiveChannelSourceId =
    channel === "whatsapp"
      ? effectiveWhatsAppSourceId
      : channel === "email"
        ? effectiveEmailSourceId
        : "";
  const audienceDefinitionValueKey = JSON.stringify([
    workspaceId,
    channel,
    analyticsSourceFiltersKey,
    effectiveExcludeRecentClientMessageWithin24h,
    effectiveExcludePriorFailedBulkSends,
    effectiveEmailAudienceSource,
    effectiveSelectedRegisteredUserIds,
    effectiveTelegramSourceId,
    effectiveTelegramAudienceSource,
    effectiveWhatsAppSourceId,
    effectiveEmailSourceId,
    audienceSelectionRevision,
  ]);
  const audienceDefinitionKey = useTransitionOwnerKey(
    audienceDefinitionValueKey
  );
  const audienceDefinitionKeyRef = useRef(audienceDefinitionKey);
  audienceDefinitionKeyRef.current = audienceDefinitionKey;
  const readinessOwnerKey = JSON.stringify([
    audienceDefinitionKey,
    selectedTemplateValue,
    isWhatsAppServiceText,
  ]);
  const readinessOwnerKeyRef = useRef(readinessOwnerKey);
  readinessOwnerKeyRef.current = readinessOwnerKey;
  const effectivePendingAudienceConfirmation =
    pendingAudienceConfirmation?.ownerKey === audienceDefinitionKey
      ? pendingAudienceConfirmation
      : null;
  useEffect(() => {
    if (!effectivePendingAudienceConfirmation) return;
    sendPanelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [effectivePendingAudienceConfirmation]);
  const currentApiError =
    apiErrorState?.ownerKey === audienceDefinitionKey ? apiErrorState : null;
  const apiError = currentApiError?.message ?? null;
  // The error shows next to Send, which can be far below the field in view.
  useEffect(() => {
    if (!apiError) return;
    sendPanelRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [apiError]);
  useEffect(() => {
    if (channel !== "telegram") return;
    if (selectedTelegramSourceId !== effectiveTelegramSourceId) {
      setSelectedTelegramSourceId(effectiveTelegramSourceId);
    }
  }, [channel, effectiveTelegramSourceId, selectedTelegramSourceId]);
  useEffect(() => {
    if (channel !== "whatsapp") return;
    if (selectedWhatsAppSourceId !== effectiveWhatsAppSourceId) {
      setSelectedWhatsAppSourceId(effectiveWhatsAppSourceId);
    }
  }, [channel, effectiveWhatsAppSourceId, selectedWhatsAppSourceId]);
  useEffect(() => {
    if (channel !== "email") return;
    if (selectedEmailSourceId !== effectiveEmailSourceId) {
      setSelectedEmailSourceId(effectiveEmailSourceId);
    }
  }, [channel, effectiveEmailSourceId, selectedEmailSourceId]);
  const whatsappAccountHealth = resolveWhatsAppAccountHealth(
    whatsappOnboardingHealth
  );
  const showWhatsAppAccountHealthWarning =
    channel === "whatsapp" &&
    Boolean(whatsappAccountHealth) &&
    whatsappAccountHealth?.state !== "healthy" &&
    whatsappAccountHealth?.state !== "unknown";
  const visibleWhatsAppAccountHealthReasons =
    whatsappAccountHealth?.reasons.slice(0, 2) || [];
  const recipientLimitMax =
    typeof batchPlanPreview?.recipientLimit?.maxRecipients === "number" &&
    batchPlanPreview.recipientLimit.maxRecipients > 0
      ? batchPlanPreview.recipientLimit.maxRecipients
      : channel === "whatsapp"
        ? 0
        : 1000;
  const recipientLimitReady = channel !== "whatsapp" || recipientLimitMax > 0;
  // One "Connect WhatsApp" panel speaks for the template, recipient and send
  // checks, which all fail without a number.
  const whatsappNotConnected =
    channel === "whatsapp" &&
    (requiresWhatsAppConnection ||
      batchPlanPreview?.code === "whatsapp_not_connected");
  const handleRecheckTemplates = async () => {
    if (!(await recheckTemplates())) toast.error(t("templatesUnavailable"));
  };
  // The template options map shadows `t`.
  const pendingTemplatesTitle = t("pendingTemplates.title");

  const template = useMemo(
    () =>
      templates.find(
        t => getWhatsAppTemplateOptionValue(t) === selectedTemplateValue
      ),
    [templates, selectedTemplateValue]
  );
  const initialDraftTemplate = useMemo(() => {
    const selection = effectiveInitialDraft?.templateSelection;
    if (!selection) return null;
    return (
      templates.find(
        t =>
          t.name === selection.name &&
          (!selection.language || t.language === selection.language)
      ) || null
    );
  }, [
    effectiveInitialDraft?.templateSelection?.language,
    effectiveInitialDraft?.templateSelection?.name,
    templates,
  ]);
  // A failed catalog read, or a saved catalog Meta couldn't refresh, can't
  // say the draft's template needs approval.
  const templateCatalogUnverified = Boolean(
    templatesError || templatesCatalog?.stale
  );
  const initialDraftTemplateMissing =
    Boolean(effectiveInitialDraft?.templateSelection) &&
    !loadingTemplates &&
    !initialDraftTemplate;
  const templateVariables = useMemo(
    () =>
      !isWhatsAppServiceText && template ? getTemplateVariables(template) : [],
    [isWhatsAppServiceText, template]
  );
  const templateVariablesKey = templateVariables.join("\n");
  const variableConfigTargetKey =
    channel === "whatsapp" && templateVariables.length > 0
      ? `${channel}:${templateVariablesKey}`
      : `${channel}:none`;
  const variableConfigsNeedReset =
    variableConfigSourceKey !== variableConfigTargetKey;
  const effectiveVariableConfigs = variableConfigsNeedReset
    ? channel !== "whatsapp" || templateVariables.length === 0
      ? {}
      : retainCampaignVariableConfigs({
          templateVariables,
          previous: variableConfigs,
        })
    : variableConfigs;
  // A test uses the first recipient's values; the server fills the rest
  // from Meta's samples.
  const testSendRecipient: Recipient | null =
    effectiveSelectedRecipients[0] ??
    effectiveAnalyticsFillUpRecipients[0] ??
    null;
  const testSendVariables =
    templateVariables.length > 0
      ? (resolveCampaignVariablesForRecipient({
          recipient: testSendRecipient ?? {},
          templateVariables,
          variableConfigs: effectiveVariableConfigs,
        }).recipient.variables ?? {})
      : {};
  const emailVariables = useMemo(() => {
    const variables = new Set([
      "recipientName",
      "recipientEmail",
      "name",
      "email",
      "company",
      "workspaceUrl",
      "locale",
      "language",
      "lang",
      "airi_language",
    ]);
    if (isRegisteredUsersMode) {
      variables.add("userName");
      variables.add("registeredAt");
    }
    effectiveSelectedRecipients.forEach(recipient => {
      Object.keys(recipient.fields || {}).forEach(key => variables.add(key));
      Object.keys(recipient.variables || {}).forEach(key => variables.add(key));
    });
    return Array.from(variables);
  }, [isRegisteredUsersMode, effectiveSelectedRecipients]);
  const emailPreviewVariables = useMemo(
    () => ({
      recipientName: "Aibek",
      recipientEmail: "aibek@example.com",
      name: "Aibek",
      userName: "Aibek",
      email: "aibek@example.com",
      company: "Your team",
      workspaceUrl: "https://app.airi.chat",
      locale: activeEmailLocale,
      language: activeEmailLocale,
      lang: activeEmailLocale,
      airi_language: activeEmailLocale,
      registeredAt: "2026-01-01",
      eventDate: "May 30",
      eventTime: "10:00",
    }),
    [activeEmailLocale]
  );

  const finalRecipients = useMemo<Recipient[]>(() => {
    if (isAnalyticsMode || isRegisteredUsersMode || isTelegramSubscribersMode) {
      return EMPTY_RECIPIENTS;
    }
    if (!recipientLimitReady) return EMPTY_RECIPIENTS;
    return effectiveSelectedRecipients;
  }, [
    isAnalyticsMode,
    isRegisteredUsersMode,
    isTelegramSubscribersMode,
    effectiveSelectedRecipients,
    recipientLimitReady,
  ]);

  const analyticsPreviewUnavailable =
    isAnalyticsMode && analyticsPreview?.available === false;
  const hasResolvedAnalyticsPreview = Boolean(
    analyticsPreview && !analyticsPreviewUnavailable
  );
  const showAnalyticsPreviewSkeleton =
    isAnalyticsMode && loadingAnalytics && !analyticsPreview && !analyticsError;
  const analyticsBaseRecipientCount = isAnalyticsMode
    ? analyticsPreviewUnavailable
      ? 0
      : (analyticsPreview?.eligibleTotal ?? 0)
    : 0;
  const analyticsFillUpCapacity = useMemo(
    () =>
      resolveCampaignFillUpCapacity({
        baseRecipientCount: analyticsBaseRecipientCount,
        fillUpRecipientCount: effectiveAnalyticsFillUpRecipients.length,
        maxRecipients: recipientLimitReady
          ? MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS
          : 0,
      }),
    [
      analyticsBaseRecipientCount,
      effectiveAnalyticsFillUpRecipients.length,
      recipientLimitReady,
    ]
  );
  const analyticsFillUpPreview = useMemo(
    () =>
      mergeCampaignRecipientsWithFillUp({
        channel,
        baseRecipients: [],
        fillUpRecipients: effectiveAnalyticsFillUpRecipients,
        maxRecipients: analyticsFillUpCapacity.remainingCapacity,
      }),
    [
      analyticsFillUpCapacity.remainingCapacity,
      effectiveAnalyticsFillUpRecipients,
      channel,
    ]
  );
  const registeredUsersRecipientCount = isRegisteredUsersMode
    ? effectiveSelectedRegisteredUserIds.length
    : 0;
  const listingRecipientCount = isAnalyticsMode
    ? analyticsBaseRecipientCount + analyticsFillUpPreview.acceptedFillUpCount
    : isRegisteredUsersMode
      ? registeredUsersRecipientCount
      : isTelegramSubscribersMode
        ? telegramSubscriberCount
        : finalRecipients.length;

  const sharedAudienceIntentParams = useMemo(
    () => ({
      analyticsSource: effectiveAnalyticsSource,
      selectedRegisteredUserIds: effectiveSelectedRegisteredUserIds,
      telegramSourceId: effectiveTelegramSourceId,
      uploadEvidence: effectiveSelectedAudienceUploadEvidence,
    }),
    [
      effectiveAnalyticsSource,
      effectiveSelectedAudienceUploadEvidence,
      effectiveSelectedRegisteredUserIds,
      effectiveTelegramSourceId,
    ]
  );
  const canonicalPreviewAudience = useMemo(
    () =>
      buildCampaignBuilderAudienceIntent(
        audienceMode,
        sharedAudienceIntentParams,
        {
        fillUpRecipients: analyticsFillUpPreview.recipients,
        inlineRecipients: finalRecipients,
        }
      ),
    [
      analyticsFillUpPreview.recipients,
      audienceMode,
      finalRecipients,
      sharedAudienceIntentParams,
    ]
  );
  // Stable across renders so the check's request key is not rebuilt for
  // every recipient on each render.
  const eligibilityTemplateName = template?.name || "";
  const eligibilityTemplateLanguage = template?.language || "";
  const eligibilityMessageIntent =
    useMemo<BulkCampaignEligibilityMessageIntent>(
      () =>
        eligibilityTemplateName && effectiveWhatsAppSourceId
          ? {
              kind: "whatsapp_template",
              sourceId: effectiveWhatsAppSourceId,
              templateName: eligibilityTemplateName,
              language: eligibilityTemplateLanguage,
            }
          : {
              kind: "unsupported",
              messageKind: isWhatsAppServiceText
                ? "whatsapp_service_text"
                : channel === "telegram"
                  ? "telegram"
                  : "email",
            },
      [
        channel,
        effectiveWhatsAppSourceId,
        eligibilityTemplateLanguage,
        eligibilityTemplateName,
        isWhatsAppServiceText,
      ]
    );
  const eligibilityPreview = useBulkCampaignRecipientEligibilityPreview({
    workspaceId,
    channel: "whatsapp",
    messageIntent: eligibilityMessageIntent,
    audience: canonicalPreviewAudience,
    recipientPolicy: effectiveRecipientPolicy,
    provenance: AD_HOC_PROVENANCE,
    recurring: false,
  });
  const eligibilityPreviewReady = eligibilityPreview.state === "ready";
  const checkingRecipientEligibility = eligibilityPreview.state === "loading";
  const effectiveRecipientCount = eligibilityPreviewReady
    ? eligibilityPreview.preview.acceptedTotal
    : listingRecipientCount;
  const marketingOptInWarningCount = eligibilityPreviewReady
    ? eligibilityPreview.preview.warnings.missingMarketingConsent
    : 0;
  const marketingEligibilityRequestedTotal = eligibilityPreviewReady
    ? eligibilityPreview.preview.requestedTotal
    : 0;
  const needsAudienceReadiness =
    channel === "whatsapp" && !isWhatsAppServiceText;
  // Classified like the scenario bulk node: a failed lookup is a failed
  // check, and only an unconfigured number is "unavailable".
  const planCheck = resolveBulkCampaignPlanCheck({
    applies: channel === "whatsapp",
    loading: Boolean(loadingBatchPlanPreview || refreshingBatchPlanPreview),
    error: batchPlanError,
    preview: batchPlanPreview,
  });
  const readinessFailure = resolveBulkCampaignReadinessFailure({
    plan: planCheck,
    eligibility: needsAudienceReadiness ? eligibilityPreview : null,
  });
  const checkingReadiness =
    planCheck.checking ||
    (channel === "whatsapp" && checkingRecipientEligibility);
  const readinessError = readinessFailure.failed;
  const currentSubmissionReadiness =
    submissionReadiness?.ownerKey === readinessOwnerKey
      ? submissionReadiness.value
      : null;
  const submissionContactCheck =
    currentSubmissionReadiness &&
    currentSubmissionReadiness.reasons.length > 0 &&
    currentSubmissionReadiness.reasons.every(
      reason => reason.code === "contact_frequency_limit"
    );
  const submissionCheckedAt = submissionContactCheck
    ? submissionReadiness?.evaluatedAt
    : currentSubmissionReadiness?.checkedAt;
  const previewCheckedAt = eligibilityPreviewReady
    ? submissionContactCheck
      // A provider timestamp cannot prove a fresh local contact check.
      ? eligibilityPreview.preview.evaluatedAt
      : eligibilityPreview.preview.readiness.checkedAt
    : null;
  const previewSupersedesSubmissionReadiness =
    currentSubmissionReadiness &&
    submissionCheckedAt &&
    previewCheckedAt &&
    Number.isFinite(Date.parse(previewCheckedAt)) &&
    Date.parse(previewCheckedAt) > Date.parse(submissionCheckedAt);
  const campaignReadiness =
    currentSubmissionReadiness && !previewSupersedesSubmissionReadiness
      ? currentSubmissionReadiness
      : !isBulkCampaignReadiness(batchPlanPreview?.readiness) || batchPlanPreview.readiness.state !== "ready"
        ? batchPlanPreview?.readiness
        : eligibilityPreviewReady
          ? eligibilityPreview.preview.readiness
          : batchPlanPreview.readiness;
  const readinessBlocksSend =
    channel === "whatsapp" &&
    (checkingReadiness ||
      readinessError ||
      !batchPlanPreview?.configured ||
      (needsAudienceReadiness && (
        !isBulkCampaignReadiness(campaignReadiness) ||
        campaignReadiness.state !== "ready" ||
        !eligibilityPreviewReady
      )));
  const refreshReadiness = () => {
    setSubmissionReadiness(null);
    refreshBatchPlanPreview();
    if (
      eligibilityPreview.state === "ready" ||
      eligibilityPreview.state === "error"
    ) {
      eligibilityPreview.retry();
    }
  };
  const activeEmailContent = emailContentByLocale[activeEmailLocale];
  const recipientImportParsing = isAnalyticsMode
    ? analyticsFillUpStateApplies && analyticsFillUpState.parsing
    : isRegisteredUsersMode
      ? false
      : isTelegramSubscribersMode
        ? false
        : selectedAudienceStateApplies && selectedAudienceState.parsing;
  const sharedSendGate = resolveBulkCampaignSharedSendGate({
    isSubmitting,
    hasActiveDispatch,
    recipientParsing: recipientImportParsing,
    emptyAudience: effectiveRecipientCount === 0,
    eligibilityCanSubmit: eligibilityPreview.canSubmit && !readinessBlocksSend,
  });
  const eligibilityAllExcluded =
    eligibilityPreviewReady && eligibilityPreview.preview.allExcluded;
  const sendStatus = resolveBulkCampaignSendStatus({
    limit: companyLimits,
    isSubmitting,
    hasActiveDispatch,
    checkingReadiness,
    readinessError,
    awaitingAudience:
      needsAudienceReadiness && eligibilityPreview.state === "idle",
    allExcluded: eligibilityAllExcluded,
    readiness:
      needsAudienceReadiness && isBulkCampaignReadiness(campaignReadiness)
        ? campaignReadiness
        : null,
    sendBlockedElsewhere:
      sharedSendGate.blocked ||
      !!analyticsPreview?.capped ||
      analyticsPreviewUnavailable ||
      !!analyticsError ||
      (isAnalyticsMode && !hasResolvedAnalyticsPreview),
  });
  const sendDisabled = sendStatus.blocked;
  const planLimitBlocksSend = sendStatus.state === "plan_blocked";

  useEffect(() => {
    if (isWhatsAppServiceText && !whatsappServiceBulkEnabled) {
      setValue("whatsappMessageType", "template", {
        shouldValidate: true,
      });
    }
  }, [isWhatsAppServiceText, setValue, whatsappServiceBulkEnabled]);

  useEffect(() => {
    setEmailAudienceSource(current =>
      current === effectiveEmailAudienceSource
        ? current
        : effectiveEmailAudienceSource
    );
  }, [effectiveEmailAudienceSource]);

  useEffect(() => {
    if (!registeredUserSelectionNeedsReset) return;
    setSelectedRegisteredUserIds(effectiveSelectedRegisteredUserIds);
    setRegisteredUserSelectionKey(registeredUserSelectionTargetKey);
  }, [
    effectiveSelectedRegisteredUserIds,
    registeredUserSelectionNeedsReset,
    registeredUserSelectionTargetKey,
  ]);

  useEffect(() => {
    if (!analyticsSourceNeedsReset) return;
    setExcludeRecentClientMessageWithin24h(analyticsSourceExcludeRecent);
    setAnalyticsSourceStateKey(analyticsSourceFiltersKey);
  }, [
    analyticsSourceExcludeRecent,
    analyticsSourceFiltersKey,
    analyticsSourceNeedsReset,
  ]);

  useEffect(() => {
    if (!variableConfigsNeedReset) return;
    setVariableConfigs(effectiveVariableConfigs);
    setVariableConfigSourceKey(variableConfigTargetKey);
  }, [
    effectiveVariableConfigs,
    variableConfigsNeedReset,
    variableConfigTargetKey,
  ]);

  useEffect(() => {
    if (!effectiveInitialDraft) {
      setExcludePriorFailedBulkSends(false);
      appliedInitialDraftIdRef.current = null;
      return;
    }
    if (appliedInitialDraftIdRef.current === effectiveInitialDraft.id) return;

    setExcludePriorFailedBulkSends(false);
    setValue("campaignName", effectiveInitialDraft.campaignName, {
      shouldDirty: false,
      shouldValidate: true,
    });
    if (!lockedChannel) {
      setValue("channel", effectiveInitialDraft.channel, {
        shouldDirty: false,
        shouldValidate: true,
      });
      onChannelChange?.(effectiveInitialDraft.channel);
    }
    appliedInitialDraftIdRef.current = effectiveInitialDraft.id;
  }, [effectiveInitialDraft, lockedChannel, onChannelChange, setValue]);

  useEffect(() => {
    if (!effectiveInitialDraft || !initialDraftTemplate) return;
    if (appliedInitialDraftTemplateIdRef.current === effectiveInitialDraft.id) {
      return;
    }
    setValue(
      "selectedTemplateValue",
      getWhatsAppTemplateOptionValue(initialDraftTemplate),
      {
        shouldDirty: false,
        shouldValidate: true,
      }
    );
    appliedInitialDraftTemplateIdRef.current = effectiveInitialDraft.id;
  }, [effectiveInitialDraft, initialDraftTemplate, setValue]);

  // Form Submission Handler
  const onSubmit = async (data: CampaignFormValues) => {
    if (sendStatus.blocked) return;
    const submissionAudienceOwnerKey = audienceDefinitionKey;
    const submissionReadinessOwnerKey = readinessOwnerKey;
    const currentAnalyticsFillUpPreview = analyticsFillUpPreview;
    const currentFinalRecipients =
      !isAnalyticsMode && !isRegisteredUsersMode && !isTelegramSubscribersMode
        ? effectiveSelectedRecipients
        : finalRecipients;
    const currentRegisteredUsersRecipientCount = isRegisteredUsersMode
      ? effectiveSelectedRegisteredUserIds.length
      : 0;
    const currentListingRecipientCount = isAnalyticsMode
      ? analyticsBaseRecipientCount +
        currentAnalyticsFillUpPreview.acceptedFillUpCount
      : isRegisteredUsersMode
        ? currentRegisteredUsersRecipientCount
        : isTelegramSubscribersMode
          ? telegramSubscriberCount
          : currentFinalRecipients.length;

    if (recipientImportParsing) {
      return toast.error(t("toast.recipientFileImporting"));
    }
    if (analyticsPreviewUnavailable) {
      return toast.error(
        analyticsPreview?.message || t("analyticsAudienceUnavailable")
      );
    }
    if (isAnalyticsMode && !hasResolvedAnalyticsPreview) {
      return;
    }
    if (channel === "whatsapp" && !recipientLimitReady) {
      return toast.error(t("analyticsFillUpLimitUnavailable"));
    }
    if (isAnalyticsMode && currentListingRecipientCount === 0)
      return toast.error(t("analyticsNoRecipients"));
    if (isRegisteredUsersMode && currentListingRecipientCount === 0)
      return toast.error(t("toast.noRegisteredUsers"));
    if (isTelegramSubscribersMode && currentListingRecipientCount === 0)
      return toast.error(t("toast.noTelegramChats"));
    if (
      !isAnalyticsMode &&
      !isRegisteredUsersMode &&
      !isTelegramSubscribersMode &&
      currentFinalRecipients.length === 0
    )
      return toast.error(t("validation.uploadRecipients"));

    if (
      channel === "email" &&
      !isAnalyticsMode &&
      !isRegisteredUsersMode &&
      !isTelegramSubscribersMode
    ) {
      const invalidEmails = currentFinalRecipients.filter(
        r => !r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(r.email.trim())
      );
      if (invalidEmails.length > 0)
        return toast.error(t("validation.invalidRecipientEmails"));
    }

    if (channel === "email") {
      const incompleteLocales = EMAIL_CAMPAIGN_LOCALES.filter(locale => {
        if (locale === DEFAULT_EMAIL_CAMPAIGN_LOCALE) return false;
        const content = emailContentByLocale[locale];
        return hasAnyEmailContent(content) && !hasCompleteEmailContent(content);
      });

      if (incompleteLocales.length > 0) {
        return toast.error(
          t("toast.finishEmailContent", {
            locales: incompleteLocales
              .map(locale => EMAIL_CAMPAIGN_LOCALE_LABELS[locale])
              .join(", "),
          })
        );
      }
    }

    // The send summary says when the list runs over the daily limit.
    const overflowPlan = buildBulkCampaignOverflowQueuePlan({
      recipientCount: currentListingRecipientCount,
      dailyLimit: recipientLimitMax,
    });

    let recipientsPayload = currentFinalRecipients;
    let fillUpRecipientsPayload = isAnalyticsMode
      ? currentAnalyticsFillUpPreview.recipients
      : [];
    let analyticsVariableConfigs:
      | ReturnType<typeof buildBulkAnalyticsVariableConfigs>["variableConfigs"]
      | undefined;

    // Validate WhatsApp Variables
    if (
      channel === "whatsapp" &&
      !isWhatsAppServiceText &&
      templateVariables.length > 0
    ) {
      if (isAnalyticsMode) {
        const analyticsVariableResult = buildBulkAnalyticsVariableConfigs({
          templateVariables,
          variableConfigs: effectiveVariableConfigs,
        });
        analyticsVariableConfigs = analyticsVariableResult.variableConfigs;
        if (analyticsVariableResult.missingCustomVariables.length > 0)
          return toast.error(
            t("toast.customValuesMissing", {
              variables: analyticsVariableResult.missingCustomVariables
                .map(v => `{{${v}}}`)
                .join(", "),
            })
          );

        if (fillUpRecipientsPayload.length > 0) {
          const prepared = prepareCampaignRecipientsForTemplate({
            recipients: fillUpRecipientsPayload,
            templateVariables,
            variableConfigs: effectiveVariableConfigs,
          });
          fillUpRecipientsPayload = prepared.recipients;

          if (prepared.unresolved.length > 0) {
            return toast.error(
              formatMissingCampaignVariablesMessage(prepared.unresolved, {
                summary: count =>
                  t("toast.fillUpTemplateVariablesMissing", { count }),
                more: count =>
                  t("toast.templateVariablesMissingMore", { count }),
              })
            );
          }
        }
      } else {
        const prepared = prepareCampaignRecipientsForTemplate({
          recipients: currentFinalRecipients,
          templateVariables,
          variableConfigs: effectiveVariableConfigs,
        });
        recipientsPayload = prepared.recipients;

        if (prepared.unresolved.length > 0) {
          return toast.error(
            formatMissingCampaignVariablesMessage(prepared.unresolved, {
              summary: count => t("toast.templateVariablesMissing", { count }),
              more: count => t("toast.templateVariablesMissingMore", { count }),
            })
          );
        }
      }
    }

    // Every send gets one last look at who receives it. A repeat-audience
    // resend was already confirmed on the alert above Send.
    if (
      !sendSummaryConfirmedRef.current &&
      !effectivePendingAudienceConfirmation
    ) {
      const senderSource = channelSourceOptions.find(
        source => source.id === effectiveChannelSourceId
      );
      const sender =
        channel === "telegram"
          ? telegramSources.find(
              source => source.id === effectiveTelegramSourceId
            )?.name
          : senderSource
            ? formatCampaignConnectedSourceLabel(senderSource)
            : null;
      setPendingSendSummary({
        message:
          channel === "email"
            ? emailContentByLocale[DEFAULT_EMAIL_CAMPAIGN_LOCALE].subject ||
              t("sendSummary.emailMessage")
            : channel === "whatsapp" && !isWhatsAppServiceText && template
              ? template.name
              : t("sendSummary.textMessage"),
        sender: sender || null,
        recipientCount: eligibilityPreviewReady
          ? eligibilityPreview.preview.acceptedTotal
          : currentListingRecipientCount,
        skippedByReason: eligibilityPreviewReady
          ? eligibilityPreview.preview.skippedByReason
          : undefined,
        overflowPlan,
      });
      return;
    }
    sendSummaryConfirmedRef.current = false;

    setApiErrorState(null);

    const sendAudience = buildCampaignBuilderAudienceIntent(
      audienceMode,
      sharedAudienceIntentParams,
      {
        fillUpRecipients: fillUpRecipientsPayload,
        inlineRecipients: recipientsPayload,
        analyticsVariableConfigs,
      }
    );
    if (!sendAudience) {
      return toast.error(
        isAnalyticsMode
          ? t("analyticsNoRecipients")
          : isRegisteredUsersMode
            ? t("toast.noRegisteredUsers")
            : isTelegramSubscribersMode
              ? t("toast.noTelegramChats")
              : t("validation.uploadRecipients")
      );
    }

    try {
      const channelFields =
        channel === "whatsapp"
          ? isWhatsAppServiceText
            ? {
                whatsappMessageType: "service_text" as const,
                messageText: data.messageText,
              }
            : {
                whatsappMessageType: "template" as const,
                whatsappTemplate: template
                  ? {
                      name: template.name,
                      language: template.language,
                      category: template.category,
                      components: template.components,
                    }
                  : undefined,
              }
          : channel === "telegram"
            ? { messageText: data.messageText }
            : {
                email: {
                  content: toEmailCampaignContent({
                    subject:
                      emailContentByLocale[DEFAULT_EMAIL_CAMPAIGN_LOCALE]
                        .subject ||
                      data.emailSubject ||
                      "Update",
                    markdown:
                      emailContentByLocale[DEFAULT_EMAIL_CAMPAIGN_LOCALE]
                        .markdown ||
                      data.emailMarkdown ||
                      "",
                  }),
                  contentByLocale:
                    buildLocalizedEmailContentPayload(emailContentByLocale),
                },
              };
      const sendRequest = buildBulkCampaignSendRequest({
              workspaceId,
              channel,
              campaignName: data.campaignName,
              idempotencyKey: createBulkCampaignIdempotencyKey(),
              audience: sendAudience,
              recipientPolicy: effectiveRecipientPolicy,
              provenance: { kind: "ad_hoc" },
              audienceConfirmationFingerprint:
                effectivePendingAudienceConfirmation?.fingerprint,
              overflowQueueConfirmed: overflowPlan.exceedsDailyLimit,
              ...channelFields,
              ...(channel === "whatsapp" && effectiveWhatsAppSourceId
                ? { whatsappSourceId: effectiveWhatsAppSourceId }
                : {}),
            });
      const result = await postBulkCampaignSend(sendRequest);
      const submissionStillOwnsDraft =
        submissionAudienceOwnerKey === audienceDefinitionKeyRef.current;
      setLastCommandResult(result);
      const resultTotal =
        result.outcome.queuedTotal ??
        result.total ??
        currentListingRecipientCount;
      const resultSuccessful =
        result.outcome.acceptedTotal ?? result.successful ?? 0;
      const skippedByReason = result.outcome.skippedByReason;
      const skippedRecipientCount = Object.values(skippedByReason).reduce(
        (total, count) => total + (count || 0),
        0
      );
      const skippedOptIn = skippedByReason.marketing_opt_out ?? 0;
      const skippedPriorFailed = skippedByReason.prior_failure ?? 0;
      const skippedServiceWindow = skippedByReason.service_window ?? 0;
      const marketingOptInWarningCount =
        result.outcome.warnings.missingMarketingConsent ?? 0;
      const shouldResetPolicy =
        result.ok &&
        (result.outcome.disposition === "queued" ||
          result.outcome.disposition === "scheduled" ||
          result.outcome.disposition === "no_op");
      if (result.outcome.disposition !== "no_op")
        setLastQueuedDispatch({
          total: resultTotal,
          campaignId: result.outcome.campaignId ?? result.campaignId,
          dispatchId: result.outcome.dispatchId ?? result.dispatchId,
          workflowId: result.outcome.workflowId ?? result.workflowId,
          status: result.outcome.lifecycleStatus,
          audienceFingerprint: result.audience?.fingerprint,
          overlap: result.audience?.overlap,
          temporalDispatchStaging: result.temporalDispatchStaging,
          batchPlan: result.batchPlan,
        });
      if (result.idempotentReplay)
        toast.message(t("toast.duplicateRequestIgnored"));
      if (skippedRecipientCount > 0)
        toast.warning(
          t("toast.recipientsSkipped", { count: skippedRecipientCount })
        );
      if (skippedOptIn > 0)
        toast.warning(t("toast.optInExcluded", { count: skippedOptIn }));
      if (skippedPriorFailed > 0)
        toast.warning(
          t("toast.priorFailedExcluded", { count: skippedPriorFailed })
        );
      if (skippedServiceWindow > 0)
        toast.warning(
          t("toast.serviceWindowExcluded", {
            count: skippedServiceWindow,
          })
        );
      if (marketingOptInWarningCount > 0)
        toast.warning(
          t("marketingOptInWarningToast", {
            count: marketingOptInWarningCount,
          })
        );

      toast.success(
        result.outcome.disposition === "queued" ||
          result.outcome.disposition === "scheduled"
          ? t("toast.campaignQueued", { total: resultTotal })
          : t("toast.campaignSent", {
              successful: resultSuccessful,
              total: resultTotal,
            })
      );
      if (submissionStillOwnsDraft) {
        setPendingAudienceConfirmation(null);
        form.reset();
        handleSelectedRecipientsChange([]);
        handleAnalyticsFillUpRecipientsChange([]);
        if (shouldResetPolicy) {
          setExcludePriorFailedBulkSends(false);
        }
      }
      setTimeout(() => router.refresh(), 2000);
    } catch (err) {
      if (err instanceof BulkCampaignSendError && err.result) {
        setLastCommandResult(err.result);
      }
      if (submissionAudienceOwnerKey !== audienceDefinitionKeyRef.current) {
        return;
      }
      if (
        err instanceof BulkCampaignSendError &&
        err.payload &&
        typeof err.payload === "object" &&
        "readiness" in err.payload &&
        isBulkCampaignReadiness(err.payload.readiness)
      ) {
        if (submissionReadinessOwnerKey !== readinessOwnerKeyRef.current)
          return;
        setSubmissionReadiness({
          ownerKey: submissionReadinessOwnerKey,
          value: err.payload.readiness,
          evaluatedAt:
            "evaluatedAt" in err.payload &&
            typeof err.payload.evaluatedAt === "string" &&
            Number.isFinite(Date.parse(err.payload.evaluatedAt))
              ? err.payload.evaluatedAt
              : null,
        });
        if (
          eligibilityPreview.state === "ready" ||
          eligibilityPreview.state === "error"
        ) {
          eligibilityPreview.retry();
        }
        setApiErrorState(null);
        return;
      }
      if (
        err instanceof BulkCampaignSendError &&
        err.code === "bulk_campaign_recent_audience_confirmation_required" &&
        err.confirmationRequired &&
        err.audienceFingerprint &&
        err.overlap
      ) {
        setApiErrorState(null);
        setPendingAudienceConfirmation({
          ownerKey: submissionAudienceOwnerKey,
          fingerprint: err.audienceFingerprint,
          overlap: err.overlap,
        });
        return;
      }
      if (
        err instanceof BulkCampaignSendError &&
        err.code === BULK_CAMPAIGN_OVERFLOW_QUEUE_CONFIRMATION_REQUIRED &&
        err.overflowQueue
      ) {
        setApiErrorState(null);
        setPendingOverflowPlan(err.overflowQueue);
        return;
      }
      if (
        err instanceof BulkCampaignSendError &&
        err.payload &&
        typeof err.payload === "object" &&
        "notOptedIn" in err.payload &&
        Array.isArray(err.payload.notOptedIn)
      ) {
        setApiErrorState({
          ownerKey: submissionAudienceOwnerKey,
          message: t("toast.sendFailedOptInList", {
            message: err.message,
            phones: err.payload.notOptedIn.slice(0, 10).join(", "),
          }),
        });
        return;
      }
      if (
        err instanceof BulkCampaignSendError &&
        err.code === BULK_CAMPAIGN_PLAN_LIMIT_CODE
      ) {
        setApiErrorState({
          ownerKey: submissionAudienceOwnerKey,
          message: t("bulkLimit.blocked"),
          planLimit: true,
        });
        void refreshCompanyLimits();
        return;
      }
      // A throttled or failed template lookup has translated copy; the
      // server's text is English.
      const readinessErrorKey =
        err instanceof BulkCampaignSendError
          ? bulkCampaignReadinessErrorKey(err.code)
          : null;
      setApiErrorState({
        ownerKey: submissionAudienceOwnerKey,
        message: readinessErrorKey
          ? tPlan(readinessErrorKey)
          : err instanceof Error
            ? err.message
            : t("toast.sendFailed"),
      });
    }
  };

  // The WhatsApp service-text and Telegram steps share one message editor.
  const renderMessageTextField = (
    placeholder: string,
    maxLength: number,
    counterText: (count: number) => string
  ) => (
    <Controller
      control={control}
      name="messageText"
      render={({ field }) => (
        <>
          <Textarea
            id="messageText"
            {...field}
            aria-label={t("messageText")}
            placeholder={placeholder}
            rows={6}
            maxLength={maxLength}
          />
          <p
            className={`text-xs ${
              errors.messageText ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {errors.messageText
              ? errors.messageText.message
              : counterText(field.value?.length || 0)}
          </p>
        </>
      )}
    />
  );

  // Asks Meta again for templates; shown with the empty and pending lists.
  const renderRecheckTemplatesButton = (variant: "outline" | "ghost") => (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className={variant === "ghost" ? "h-7 px-2 text-xs" : undefined}
      disabled={recheckingTemplates}
      onClick={() => void handleRecheckTemplates()}
    >
      {recheckingTemplates ? (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      ) : (
        <RefreshCw data-icon="inline-start" />
      )}
      {t("refreshTemplates")}
    </Button>
  );

  const dispatchPlanCard = (
    <CampaignDispatchPlanCard
      sendStatus={sendStatus}
      companyLimits={companyLimits}
      embedded
      workspaceId={workspaceId}
      loading={
        loadingBatchPlanPreview && !batchPlanPreview && !lastQueuedDispatch
      }
      preview={batchPlanPreview}
      previewError={Boolean(batchPlanError)}
      onRefreshPreview={refreshBatchPlanPreview}
      queuedDispatch={lastQueuedDispatch}
      showReadiness={!hasActiveDispatch && needsAudienceReadiness}
      readiness={campaignReadiness}
      checkingReadiness={checkingReadiness}
      readinessError={readinessError}
      readinessErrorCode={readinessFailure.code}
      retryAt={readinessFailure.retryAt}
      awaitingAudience={
        needsAudienceReadiness && eligibilityPreview.state === "idle"
      }
      messageSelected={Boolean(template)}
      allExcluded={eligibilityAllExcluded}
      onRefreshReadiness={needsAudienceReadiness ? refreshReadiness : undefined}
      refreshDisabled={isSubmitting}
      reasonId={readinessReasonId}
      onDispatchLifecycleChange={handleDispatchLifecycleChange}
    />
  );

  return (
    <>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="min-w-0 space-y-6 sm:space-y-8"
      >
      {planLimitBlocksSend ? dispatchPlanCard : null}
      {whatsappNotConnected && !planLimitBlocksSend ? (
        <Alert data-testid="bulk-campaign-connect-whatsapp">
          <MessageCircle className="h-4 w-4" />
          <AlertTitle className="line-clamp-none break-words">
            {t("connectWhatsApp.title")}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{t("connectWhatsApp.description")}</p>
            <Button asChild size="sm">
              <Link href={bulkCampaignWhatsAppSettingsHref(workspaceId)}>
                {t("connectWhatsApp.action")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {effectiveInitialDraft ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="space-y-1">
            <div className="font-medium">{t("airiDraft.title")}</div>
            <div>
              <span className="text-muted-foreground">
                {t("airiDraft.audience")}
              </span>{" "}
              {effectiveInitialDraft.recipientSourceSummary}
            </div>
            {initialDraftTemplate ? (
              <div>
                {t("airiDraft.approvedTemplateMatched", {
                  template: initialDraftTemplate.name,
                })}
              </div>
            ) : initialDraftTemplateMissing ? (
              templateCatalogUnverified ? (
                // The draft's template isn't selected, so name it rather than
                // repeat the template step's warning. With no saved templates
                // the template step says why.
                templates.length > 0 ? (
                  <div>
                    {effectiveInitialDraft.templateSelection?.name
                      ? t("airiDraft.templateUnverified", {
                          template:
                            effectiveInitialDraft.templateSelection.name,
                        })
                      : t("airiDraft.selectApprovedTemplate")}
                  </div>
                ) : null
              ) : (
                <div>
                  {effectiveInitialDraft.templateSelection?.name
                    ? t("airiDraft.templateNeedsApproval", {
                        template: effectiveInitialDraft.templateSelection.name,
                      })
                    : t("airiDraft.selectApprovedTemplate")}
                </div>
              )
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <CampaignFlowStep step={1} title={t("stepSetup")}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label
                htmlFor="channel"
                className="text-xs text-muted-foreground"
              >
                {t("channel")}
              </Label>
              {lockedChannel ? (
                <div className="flex h-9 items-center rounded-md bg-muted/30 px-3 text-sm font-medium">
                  {lockedChannel === "telegram"
                    ? t("telegramChannel")
                    : lockedChannel === "email"
                      ? t("emailCampaigns")
                      : t("whatsappChannel")}
                </div>
              ) : (
                <Controller
                  control={control}
                  name="channel"
                  render={({ field }) => (
                    <Select
                      value={channel}
                      onValueChange={nextValue => {
                        field.onChange(nextValue);
                        onChannelChange?.(
                          nextValue as "whatsapp" | "telegram" | "email"
                        );
                        if (nextValue !== "whatsapp") {
                          setExcludePriorFailedBulkSends(false);
                        }
                      }}
                    >
                      <SelectTrigger
                        id="channel"
                        className="h-9 w-full min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="whatsapp">
                          {t("whatsappTemplates")}
                        </SelectItem>
                        <SelectItem value="telegram">
                          {t("telegramMessages")}
                        </SelectItem>
                        {emailEnabled && (
                          <SelectItem value="email">
                            {t("emailCampaigns")}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
              {channel !== "telegram" &&
              channelSourceOptions.length > 0 &&
              effectiveChannelSourceId ? (
                <div className="space-y-1.5 pt-1">
                  <Label
                    htmlFor="campaign-source"
                    className="text-xs text-muted-foreground"
                  >
                    {channel === "email"
                      ? t("emailSender")
                      : t("whatsappNumber")}
                  </Label>
                  <Select
                    value={effectiveChannelSourceId}
                    onValueChange={value => {
                      if (channel === "whatsapp") {
                        setSelectedWhatsAppSourceId(value);
                        return;
                      }
                      if (channel === "email") {
                        setSelectedEmailSourceId(value);
                      }
                    }}
                    disabled={isSubmitting || channelSourceOptions.length <= 1}
                  >
                    <SelectTrigger
                      id="campaign-source"
                      className="h-9 w-full min-w-0"
                    >
                      <SelectValue placeholder={t("selectSource")} />
                    </SelectTrigger>
                    <SelectContent>
                      {channelSourceOptions.map(source => (
                        <SelectItem key={source.id} value={source.id}>
                          {formatCampaignConnectedSourceLabel(source)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="campaignName"
                className="text-xs text-muted-foreground"
              >
                {t("campaignName")}
              </Label>
              <Controller
                control={control}
                name="campaignName"
                render={({ field }) => (
                  <>
                    <Input
                      id="campaignName"
                      {...field}
                      className="h-9"
                      placeholder={t("campaignNamePlaceholder")}
                    />
                    {errors.campaignName && (
                      <span className="text-xs text-destructive">
                        {errors.campaignName.message}
                      </span>
                    )}
                  </>
                )}
              />
            </div>
          </div>
      </CampaignFlowStep>

      {channel === "whatsapp" ? (
        <CampaignFlowStep step={2} title={t("stepMessage")}>
          <div className="min-w-0 space-y-3">
              {whatsappServiceBulkEnabled ? (
                <div
                  className="flex w-full rounded-md border bg-muted/20 p-1"
                  role="group"
                  aria-label={t("whatsappMessageType")}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={isWhatsAppServiceText ? "ghost" : "secondary"}
                    className="h-8 min-w-0 flex-1 rounded px-2 text-xs sm:h-7 sm:px-3 sm:text-sm"
                    aria-label={t("whatsappTemplateMode")}
                    aria-pressed={!isWhatsAppServiceText}
                    onClick={() =>
                      setValue("whatsappMessageType", "template", {
                        shouldValidate: true,
                      })
                    }
                  >
                    {t("whatsappTemplateMode")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={isWhatsAppServiceText ? "secondary" : "ghost"}
                    className="h-8 min-w-0 flex-1 rounded px-2 text-xs sm:h-7 sm:px-3 sm:text-sm"
                    aria-label={t("whatsappServiceText")}
                    aria-pressed={isWhatsAppServiceText}
                    onClick={() => {
                      setValue("whatsappMessageType", "service_text", {
                        shouldValidate: true,
                      });
                      setExcludePriorFailedBulkSends(false);
                    }}
                  >
                    {t("whatsappServiceText")}
                  </Button>
                </div>
              ) : null}

              {isWhatsAppServiceText ? (
                <div className="max-w-2xl space-y-2">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      {t("whatsappServiceWindowHelp")}
                    </AlertDescription>
                  </Alert>
                  {renderMessageTextField(
                    t("whatsappServiceTextPlaceholder"),
                    WHATSAPP_SERVICE_MESSAGE_TEXT_LIMIT,
                    count => t("serviceCharactersLimit", { count })
                  )}
                </div>
              ) : loadingTemplates ? (
                <Skeleton className="h-9 w-full max-w-md" />
              ) : whatsappNotConnected ? (
                <p className="rounded-md bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {t("templatesAfterConnect")}
                </p>
              ) : templates.length === 0 ? (
                <div
                  data-testid="bulk-campaign-no-templates"
                  className="space-y-3 rounded-md bg-muted/30 px-3 py-3 text-sm"
                >
                  <div className="flex items-start gap-2 text-muted-foreground">
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-words">
                      {templateCatalogUnverified
                        ? t("templatesUnavailable")
                        : t("noTemplates")}
                    </span>
                  </div>
                  {pendingTemplates.length > 0 ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium">
                        {t("pendingTemplates.title")}
                      </div>
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        {pendingTemplates.map(pending => (
                          <li
                            key={getWhatsAppTemplateOptionValue(pending)}
                            className="break-words"
                          >
                            {pending.name} ({pending.language})
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        {t("pendingTemplates.hint")}
                      </p>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {templateCatalogUnverified ? null : (
                      <Button asChild size="sm">
                        <Link
                          href={panelWorkspaceHref(
                            workspaceId,
                            "messengers/whatsapp-templates?create=1"
                          )}
                        >
                          <FileText data-icon="inline-start" />
                          {t("createTemplate")}
                        </Link>
                      </Button>
                    )}
                    {renderRecheckTemplatesButton("outline")}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-[minmax(240px,420px)_minmax(0,1fr)]">
                  {templateCatalogUnverified && (
                    <Alert className="lg:col-span-2">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="break-words">{t("savedTemplatesWarning")}</AlertDescription>
                    </Alert>
                  )}
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="template"
                      className="text-xs text-muted-foreground"
                    >
                      {t("template")}
                    </Label>
                    <Controller
                      control={control}
                      name="selectedTemplateValue"
                      render={({ field }) => (
                        <>
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <SelectTrigger
                              id="template"
                              className="h-9 w-full min-w-0"
                            >
                              <SelectValue placeholder={t("chooseTemplate")} />
                            </SelectTrigger>
                            <SelectContent className="max-w-[min(calc(100vw-2rem),var(--radix-select-trigger-width))]">
                              {templates.map(t => (
                                <SelectItem
                                  key={getWhatsAppTemplateOptionValue(t)}
                                  value={getWhatsAppTemplateOptionValue(t)}
                                >
                                  {t.name} ({t.language}) - {t.category}
                                </SelectItem>
                              ))}
                              {pendingTemplates.length > 0 ? (
                                <SelectGroup>
                                  <SelectLabel>
                                    {pendingTemplatesTitle}
                                  </SelectLabel>
                                  {pendingTemplates.map(pending => (
                                    <SelectItem
                                      key={getWhatsAppTemplateOptionValue(
                                        pending
                                      )}
                                      value={`pending:${getWhatsAppTemplateOptionValue(pending)}`}
                                      disabled
                                    >
                                      {pending.name} ({pending.language})
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ) : null}
                            </SelectContent>
                          </Select>
                          {pendingTemplates.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span className="min-w-0 break-words">
                                {t("pendingTemplates.hint")}
                              </span>
                              {renderRecheckTemplatesButton("ghost")}
                            </div>
                          ) : null}
                          {errors.selectedTemplateValue && (
                            <span className="text-xs text-destructive">
                              {errors.selectedTemplateValue.message}
                            </span>
                          )}
                        </>
                      )}
                    />
                  </div>

                  {template && (
                    <div className="space-y-2">
                      <div className="space-y-2 rounded-md bg-muted/30 px-3 py-2 text-sm">
                        {template.components?.map((comp, idx) => {
                          const text =
                            comp.type === "BODY" ||
                            comp.type === "FOOTER" ||
                            (comp.type === "HEADER" && comp.format === "TEXT")
                              ? comp.text
                              : "";
                          return text ? (
                            <div
                              key={idx}
                              className={
                                comp.type === "HEADER"
                                  ? "whitespace-pre-wrap font-medium"
                                  : comp.type === "FOOTER"
                                    ? "whitespace-pre-wrap text-xs text-muted-foreground"
                                    : "whitespace-pre-wrap leading-relaxed"
                              }
                            >
                              {text}
                            </div>
                          ) : null;
                        })}
                      </div>
                      <CampaignTestSendDialog
                        workspaceId={workspaceId}
                        sourceId={effectiveWhatsAppSourceId || undefined}
                        template={template}
                        variables={testSendVariables}
                        recipientName={testSendRecipient?.name}
                        valuesFrom={testSendRecipient ? "recipient" : "sample"}
                        disabled={isSubmitting}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
        </CampaignFlowStep>
      ) : channel === "telegram" ? (
        <CampaignFlowStep step={2} title={t("stepMessage")}>
            <div className="min-w-0 space-y-2">
              {renderMessageTextField(
                t("messageTextPlaceholder", MESSAGE_TEXT_PLACEHOLDER_VALUES),
                TELEGRAM_SEND_MESSAGE_TEXT_LIMIT,
                count =>
                  t("charactersLimit", {
                    count,
                    ...MESSAGE_TEXT_CHARACTER_LIMIT_VALUES,
                  })
              )}
            </div>
        </CampaignFlowStep>
      ) : (
        <CampaignFlowStep step={2} title={t("stepMessage")}>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("emailUsesDefaultSender")}
          </p>
          <div
            className="mb-4 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Email language"
          >
            {EMAIL_CAMPAIGN_LOCALES.map(locale => {
              const selected = activeEmailLocale === locale;
              const complete = hasCompleteEmailContent(
                emailContentByLocale[locale]
              );
              return (
                <Button
                  key={locale}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  role="tab"
                  aria-selected={selected}
                  aria-label={`${locale.toUpperCase()} ${
                    EMAIL_CAMPAIGN_LOCALE_LABELS[locale]
                  }${complete ? " ready" : ""}`}
                  className="h-8 gap-2 px-3"
                  disabled={isSubmitting}
                  onClick={() => setActiveEmailLocale(locale)}
                >
                    <span className="font-mono text-xs uppercase">
                      {locale}
                    </span>
                  <span className="hidden sm:inline">
                    {EMAIL_CAMPAIGN_LOCALE_LABELS[locale]}
                  </span>
                  {locale !== DEFAULT_EMAIL_CAMPAIGN_LOCALE && complete ? (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-current"
                      aria-hidden="true"
                    />
                  ) : null}
                </Button>
              );
            })}
          </div>
          <EmailContentEditor
            idPrefix={`bulk-campaign-email-${activeEmailLocale}`}
            workspaceId={workspaceId}
            draftStorageKey={`bulk-campaign-email-draft:${workspaceId}:${activeEmailLocale}`}
            value={activeEmailContent}
            onChange={next => {
              setEmailContentByLocale(current => ({
                ...current,
                [activeEmailLocale]: next,
              }));
              if (activeEmailLocale === DEFAULT_EMAIL_CAMPAIGN_LOCALE) {
                setValue("emailSubject", next.subject, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
                setValue("emailMarkdown", next.markdown, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }
            }}
            disabled={isSubmitting}
            variables={emailVariables}
            previewVariables={emailPreviewVariables}
            starterTemplates={EMAIL_STARTER_TEMPLATES}
          />
          {errors.emailSubject || errors.emailMarkdown ? (
            <div className="mt-3 text-xs text-destructive">
              {errors.emailSubject?.message || errors.emailMarkdown?.message}
            </div>
          ) : null}
        </CampaignFlowStep>
      )}

      <CampaignFlowStep step={3} title={t("stepRecipients")}>
        {audienceSourceSlot}
        {isAnalyticsMode ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {loadingAnalytics
              ? t("analyticsAudienceChecking")
              : t("analyticsAudienceSummary", {
                  count: analyticsBaseRecipientCount,
                })}
          </p>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label
                  htmlFor="excludeRecentClientMessageWithin24h"
                  className="text-sm font-medium"
                >
                  {t("excludeRecentClientWindowLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("excludeRecentClientWindowHint")}
                </p>
              </div>
              <Switch
                id="excludeRecentClientMessageWithin24h"
                checked={effectiveExcludeRecentClientMessageWithin24h}
                onCheckedChange={setExcludeRecentClientMessageWithin24h}
              />
            </div>
            {analyticsPreview?.marketingOptInWarningCount ? (
              <Alert>
                <AlertDescription>
                  {t("marketingOptInWarningAlert", {
                    count: analyticsPreview.marketingOptInWarningCount,
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {analyticsPreview?.capped ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t("analyticsAudienceCapped", {
                    count: formatInteger(analyticsPreview.maxRecipients, locale),
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {analyticsPreviewUnavailable ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {analyticsPreview?.message ||
                    t("analyticsAudienceUnavailable")}
                </AlertDescription>
              </Alert>
            ) : null}
            {analyticsError ? (
              <Alert variant="destructive">
                <AlertDescription>{analyticsError.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-md bg-muted/30 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("analyticsAudienceMatched")}
                </div>
                {showAnalyticsPreviewSkeleton ? (
                  <Skeleton className="mt-2 h-6 w-20" />
                ) : (
                  <div className="font-medium">
                    {formatInteger(analyticsPreview?.total ?? 0, locale)}
                  </div>
                )}
              </div>
              <div className="rounded-md bg-muted/30 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("analyticsAudienceEligible")}
                </div>
                {showAnalyticsPreviewSkeleton ? (
                  <Skeleton className="mt-2 h-6 w-20" />
                ) : (
                  <div className="font-medium">
                    {formatInteger(analyticsBaseRecipientCount, locale)}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3 pt-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-semibold">
                    {t("analyticsFillUpTitle")}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("analyticsFillUpDescription")}
                  </p>
                </div>
                <div className="shrink-0 rounded-md bg-muted/30 px-3 py-2 text-right text-xs">
                  <div className="uppercase tracking-wide text-muted-foreground">
                    {t("analyticsFillUpRemaining")}
                  </div>
                  <div className="mt-1 font-medium">
                    {formatInteger(
                      analyticsFillUpCapacity.remainingCapacity,
                      locale
                    )}
                  </div>
                </div>
              </div>

              {loadingBatchPlanPreview ? (
                <Skeleton className="h-28 w-full" />
              ) : !recipientLimitReady ? (
                // The server's limit error is English; a missing number has
                // its own panel above.
                !batchPlanError &&
                !whatsappNotConnected && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("analyticsFillUpLimitUnavailable")}
                    </AlertDescription>
                  </Alert>
                )
              ) : analyticsFillUpCapacity.remainingCapacity <= 0 ? (
                <Alert>
                  <AlertDescription>
                    {t("analyticsFillUpNoCapacity")}
                  </AlertDescription>
                </Alert>
              ) : (
                <CampaignRecipientPicker
                  workspaceId={workspaceId}
                  channel="whatsapp"
                  sourceIds={pickerSourceIds}
                  recipients={effectiveAnalyticsFillUpRecipients}
                  onRecipientsChange={handleAnalyticsFillUpRecipientsChange}
                  audienceUploadEvidence={
                    effectiveAnalyticsFillUpAudienceUploadEvidence
                  }
                  onUploadedAudienceChange={
                    handleAnalyticsFillUpUploadedAudienceChange
                  }
                  onParsingChange={handleAnalyticsFillUpParsingChange}
                  templateVariables={templateVariables}
                  recipientLimit={analyticsFillUpCapacity.remainingCapacity}
                  showRecipientLimitAlerts={!batchPlanError}
                  recipientLimitState={{
                    preview: batchPlanPreview?.recipientLimit ?? null,
                    loading: loadingBatchPlanPreview,
                    // The send check explains a number without credentials.
                    error: null,
                  }}
                  compact
                  variant="chat"
                  showHeader={false}
                  variableConfigs={effectiveVariableConfigs}
                  onVariableConfigsChange={setVariableConfigs}
                />
              )}

              {analyticsFillUpPreview.acceptedFillUpCount > 0 ? (
                <div className="text-xs font-medium text-green-600">
                  {t("analyticsFillUpAccepted", {
                    count: analyticsFillUpPreview.acceptedFillUpCount,
                  })}
                </div>
              ) : null}
              {analyticsFillUpPreview.duplicateFillUpCount +
                analyticsFillUpPreview.invalidFillUpCount >
              0 ? (
                <Alert>
                  <AlertDescription>
                    {t("analyticsFillUpIgnored", {
                      count:
                        analyticsFillUpPreview.duplicateFillUpCount +
                        analyticsFillUpPreview.invalidFillUpCount,
                    })}
                  </AlertDescription>
                </Alert>
              ) : null}
              {analyticsFillUpPreview.truncatedFillUpCount > 0 ? (
                <Alert>
                  <AlertDescription>
                    {t("analyticsFillUpTruncated", {
                      count: analyticsFillUpPreview.truncatedFillUpCount,
                    })}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
        </div>
        ) : (
          <BulkCampaignAudienceComposer
            knownAudienceNote={
              isTelegramSubscribersMode ? (
                <div className="rounded-md border bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                  {t("telegramAudience.serverResolves")}
                </div>
              ) : null
            }
            telegram={
              channel === "telegram"
                ? {
                    audienceMode: effectiveTelegramAudienceSource,
                    className: "bg-muted/20",
                    disabled: isSubmitting,
                    knownLabel: t("telegramAudience.known"),
                    loadingText: t("telegramAudience.loading"),
                    manualLabel: t("telegramAudience.manual"),
                    onAudienceModeChange: setTelegramAudienceSource,
                    onSourceChange: value => {
                      setSelectedTelegramSourceId(value);
                      setTelegramAudienceSource("manual");
                    },
                    rateHint: t("telegramAudience.rateHint"),
                    selectedSourceId: effectiveTelegramSourceId,
                    sourceSelectLabel: t("telegramAudience.bot"),
                    sourceSelectPlaceholder: t("telegramAudience.selectBot"),
                    sources: telegramSources,
                    subscriberCount: telegramSubscriberCount,
                      subscriberCountText: t(
                        "telegramAudience.subscriberCount",
                        {
                      count: telegramSubscriberCount,
                  }
                      ),
                    }
                : null
            }
            picker={{
              workspaceId,
              channel,
              sourceIds: pickerSourceIds,
              recipients:
                isRegisteredUsersMode || isTelegramSubscribersMode
                  ? []
                  : effectiveSelectedRecipients,
              onRecipientsChange: handleSelectedRecipientsChange,
              audienceUploadEvidence: effectiveSelectedAudienceUploadEvidence,
              onUploadedAudienceChange: handleSelectedUploadedAudienceChange,
              onParsingChange: handleSelectedRecipientParsingChange,
              templateVariables,
              recipientLimit: MAX_INLINE_BULK_CAMPAIGN_RECIPIENTS,
              showRecipientLimitAlerts: !batchPlanError,
              recipientLimitState: {
                preview: batchPlanPreview?.recipientLimit ?? null,
                loading: loadingBatchPlanPreview,
                // The send check explains a number without credentials.
                error: null,
              },
              disabled: loadingBatchPlanPreview || !recipientLimitReady,
              variant: "chat",
              showHeader: false,
              variableConfigs: effectiveVariableConfigs,
              onVariableConfigsChange: setVariableConfigs,
              audienceSource:
                channel === "email" ? effectiveEmailAudienceSource : "manual",
              onAudienceSourceChange: setEmailAudienceSource,
              registeredUsersAudience:
                channel === "email" ? registeredUsersAudience : null,
              selectedRegisteredUserIds: effectiveSelectedRegisteredUserIds,
              onSelectedRegisteredUserIdsChange: setSelectedRegisteredUserIds,
            }}
          />
        )}

        {channel === "whatsapp" && !isWhatsAppServiceText ? (
          <div className="mt-4">
            <PriorFailedRecipientExclusionControl
              value={effectiveExcludePriorFailedBulkSends}
              supported={isPriorFailurePolicySupported}
              eligibility={eligibilityPreview}
              onChange={enabled => setExcludePriorFailedBulkSends(enabled)}
              t={t}
            />
          </div>
        ) : null}
      </CampaignFlowStep>

      <CampaignFlowStep step={4} title={t("stepSend")} flush>
      {!planLimitBlocksSend ? dispatchPlanCard : null}

          <div
            ref={sendPanelRef}
            data-testid="bulk-campaign-send-panel"
            className="min-w-0 space-y-3"
          >
            {!sendStatus.planReason && !hasActiveDispatch && !isSubmitting ? <BulkCampaignLimitHint
              limit={companyLimits}
              t={t}
              workspaceId={workspaceId}
              recipientCount={listingRecipientCount}
            /> : null}
            {marketingOptInWarningCount > 0 && (
              <Alert className="border-amber-200 bg-amber-50 text-amber-950">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-xs">
                  {t("marketingOptInWarningInline", {
                    count: marketingOptInWarningCount,
                    total: Math.max(
                      marketingEligibilityRequestedTotal,
                      effectiveRecipientCount
                    ),
                  })}
                </AlertDescription>
              </Alert>
            )}
            {showWhatsAppAccountHealthWarning &&
            whatsappAccountHealth ? (
              <Collapsible key={whatsappAccountHealth.state} defaultOpen={whatsappAccountHealth.state !== "warning"}>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="max-w-full px-0 text-xs text-muted-foreground">
                    {tPlan("connectionDetails")}
                    <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 text-xs text-muted-foreground">
                  {visibleWhatsAppAccountHealthReasons.map(reason => (
                    <p key={reason.code} className="break-words">
                      {reason.code === "inbound_silent"
                        ? tPlan("inboundActivityDescription")
                        : `${reason.title}: ${reason.message}`}
                    </p>
                  ))}
                  <Link className="inline-block underline underline-offset-2" href={bulkCampaignWhatsAppSettingsHref(workspaceId)}>
                    {tPlan("readiness.fix.integrations")}
                  </Link>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {lastCommandResult ? (
              <BulkCampaignOutcomeSummary result={lastCommandResult} t={t} />
            ) : null}
            {effectivePendingAudienceConfirmation ? (
              <Alert data-testid="bulk-campaign-recent-audience-alert">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t("recentAudienceOverlap", {
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
            {/* Once the refreshed limits say so, the hint above explains it. */}
            {apiError &&
            !(currentApiError?.planLimit && planLimitBlocksSend) ? (
              <Alert variant="destructive" data-testid="bulk-campaign-send-error">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="flex flex-col items-start gap-2">
                  <p className="min-w-0 break-words">{apiError}</p>
                  {currentApiError?.planLimit ? (
                    <BulkCampaignUpgradeButton
                      workspaceId={workspaceId}
                      limit={companyLimits}
                      t={t}
                    />
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          <div
            ref={sendActionRef}
            data-testid="bulk-campaign-send-action"
            className={`mt-3 min-w-0 ${needsAudienceReadiness && readinessBlocksSend ? "" : "max-xl:sticky max-xl:bottom-0 max-xl:z-30 max-xl:-mx-3 max-xl:border-t max-xl:bg-background/95 max-xl:px-3 max-xl:py-3 max-xl:shadow-[0_-8px_24px_rgba(15,23,42,0.08)] max-xl:backdrop-blur max-xl:pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:max-xl:-mx-4 sm:max-xl:px-4 lg:max-xl:-mx-6 lg:max-xl:px-6"}`}
          >
            {sendDisabled && !hasActiveDispatch && !isSubmitting ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {tPlan("selectedRecipients", { count: listingRecipientCount })}
                {planLimitBlocksSend ? (
                  <> · <a href={`#${readinessReasonId}`} className="underline underline-offset-2">{tPlan("viewSendingStatus")}</a></>
                ) : null}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={sendDisabled}
              variant={sendDisabled ? "secondary" : "default"}
              aria-describedby={
                sendDisabled && !hasActiveDispatch && !isSubmitting && (needsAudienceReadiness || planLimitBlocksSend)
                  ? readinessReasonId : undefined
              }
              className="w-full max-w-full text-center disabled:opacity-100 disabled:text-muted-foreground [&_.btn-push-front]:min-w-0 [&_.btn-push-front]:break-words [&_.btn-push-front]:px-4 [&_.btn-push-front]:text-center [&_.btn-push-front]:whitespace-normal"
              size="default"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span className="min-w-0 text-center leading-tight">
                    {t("sendingCampaign")}
                  </span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 text-center leading-tight">
                    {planLimitBlocksSend ? tPlan("sendUnavailable") : effectivePendingAudienceConfirmation
                      ? t("sendAgain")
                      : t("sendToRecipients", {
                          count: effectiveRecipientCount,
                          channel,
                        })}
                  </span>
                </>
              )}
            </Button>
          </div>
      </CampaignFlowStep>
    </form>
    <BulkCampaignOverflowQueueDialog
      plan={pendingOverflowPlan}
      t={t}
      onOpenChange={open => {
        if (!open) setPendingOverflowPlan(null);
      }}
      onConfirm={() => {
        // The server asked for this confirmation after the summary.
        sendSummaryConfirmedRef.current = true;
        setPendingOverflowPlan(null);
        void handleSubmit(onSubmit)();
      }}
    />
    <BulkCampaignSendSummaryDialog
      summary={pendingSendSummary}
      t={t}
      returnFocusTo={() =>
        sendActionRef.current?.querySelector<HTMLElement>(
          'button[type="submit"]'
        ) ?? null
      }
      onOpenChange={open => {
        if (!open) setPendingSendSummary(null);
      }}
      onConfirm={() => {
        sendSummaryConfirmedRef.current = true;
        setPendingSendSummary(null);
        void handleSubmit(onSubmit)();
      }}
    />
    </>
  );
}
