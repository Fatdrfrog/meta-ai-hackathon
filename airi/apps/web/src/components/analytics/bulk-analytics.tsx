"use client";

import {
  addMessageTextPhrases,
  formatMessageTextPhrases,
  parseMessageTextPhrases,
  removeMessageTextPhrase,
} from "@/components/analytics/bulk-analytics-filter-utils";
import {
  buildBulkAnalyticsWorkbook,
  collectAllBulkAnalyticsRecords,
  downloadBulkAnalyticsWorkbook,
  formatBulkAnalyticsRecipientLabel,
} from "@/components/analytics/bulk-analytics-export";
import { useBulkAnalyticsFormatters } from "@/components/analytics/bulk-analytics-formatters";
import { BulkAnalyticsRecipients } from "@/components/analytics/bulk-analytics-recipients";
import {
  BulkCampaignHealth,
  BulkRecipientHistory,
} from "@/components/analytics/bulk-campaign-health";
import { WhatsAppSpendSummary } from "@/components/analytics/whatsapp-spend-summary";
import { ConversationDetailDrawer } from "@/components/requests/conversation-detail-drawer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type BulkAnalyticsAudienceFilters,
  type BulkAnalyticsEngagement,
  type BulkAnalyticsStatus,
} from "@/lib/analytics/bulk-analytics-contract";
import { cn } from "@/lib/utils";
import { createLogger } from "@icecore/shared/lib/logger";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";

const bulkAnalyticsLogger = createLogger("bulk-analytics");

const AnalyticsBarChart = dynamic(
  () =>
    import("@/components/analytics/charts/BarChart").then(
      module => module.BarChart
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[280px] w-full" />,
  }
);

type CampaignOption = {
  id: string;
  name: string;
  templateName: string | null;
  sentAt: string | null;
  totalRecipients: number;
  successfulSends: number;
  failedSends: number;
};

type TemplateOption = {
  name: string;
  language?: string | null;
  status?: string | null;
  category?: string | null;
  count: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  available?: boolean;
};

type BulkSummary = {
  recipientConflictCount?: number;
  totalAccepted: number;
  uniqueConversations: number;
  replied: number;
  notReplied: number;
  totalReplies: number;
  replyRate: number;
  read?: number | null;
  readRate?: number | null;
  delivered?: number | null;
  deliveryRate?: number | null;
  failed?: number | null;
  failedRate?: number | null;
  estimatedCost?: number | null;
  costPerReply?: number | null;
  unknownCostCount?: number | null;
  avgReplyDelayMinutes: number | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
};

type OutcomeRow = {
  bucket: string;
  count: number;
};

type FailureRow = {
  errorCode: string;
  count: number;
};

type BulkComparePayload = {
  window: {
    startDate: string;
    endDate: string;
  };
  summary: BulkSummary;
  outcomes: OutcomeRow[];
};

type TemplateRow = {
  templateName: string;
  accepted: number;
  replied: number;
  notReplied: number;
  totalReplies: number;
  replyRate: number;
  avgReplyDelayMinutes: number | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
};

type DailyRow = {
  date: string;
  accepted: number;
  replied: number;
  replyRate: number;
};

type ReplyCategoryRow = {
  category: string;
  count: number;
};

type DetectedRunRow = {
  templateName: string;
  bucket: string;
  accepted: number;
  replied: number;
  replyRate: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
};

type ConversationRow = {
  conversationId: string;
  recipient: string;
  templateName: string;
  sentAt: string;
  firstReplyAt: string | null;
  firstReplyText: string;
  replyCount: number;
  replyDelayMinutes: number | null;
};

export type MessageRecord = ConversationRow & {
  deliveryStatus?: "accepted" | "delivered" | "read" | "failed" | "unknown";
  deliveryErrorCode?: string | null;
  deliveryErrorMessage?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  providerRecipient?: string | null;
  recipientConflict?: boolean;
  id: string;
  messageId: string;
  replied: boolean;
  replyCategory: string;
  matchedMessageCount?: number;
  firstMatchedMessageAt?: string | null;
  firstMatchedMessageText?: string | null;
  firstMatchedMessageDirection?: string | null;
  conversationStatus: string | null;
  isReadByManager: boolean | null;
  conversationSource?: "fresh" | "campaign_or_existing" | string | null;
  engagementScore?: number | null;
};

type BulkRecordsPageInfo = {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type BulkAnalyticsResponse = {
  generatedAt: string;
  snapshotToken?: string;
  dataQuality?: {
    complete: boolean;
    reasons: string[];
    observedAt: string;
    consistency?: string;
    snapshotToken?: string;
  };
  window: {
    days: number;
    startDate: string;
    endDate: string;
    replyWindowHours: number;
  };
  filters: {
    templates: TemplateOption[];
    campaigns: CampaignOption[];
  };
  overview?: {
    status: "disabled" | "ready";
    reason?: string;
  };
  summary?: BulkSummary;
  compare?: BulkComparePayload | null;
  byTemplate: TemplateRow[];
  daily: DailyRow[];
  replyCategories: ReplyCategoryRow[];
  outcomes?: OutcomeRow[];
  failures?: FailureRow[];
  detectedRuns: DetectedRunRow[];
  topConversations: ConversationRow[];
  records: MessageRecord[];
  pageInfo?: BulkRecordsPageInfo;
  note: string;
};

type BulkAnalyticsRecordsResponse = {
  generatedAt: string;
  snapshotToken?: string;
  dataQuality?: {
    complete: boolean;
    reasons: string[];
    observedAt: string;
    snapshotToken?: string;
  };
  records: MessageRecord[];
  pageInfo: BulkRecordsPageInfo;
};

interface BulkAnalyticsProps {
  workspaceId: string;
  days?: number;
  initialCampaignIds?: string[];
  onOpenCampaignHistory?: (campaignId?: string) => void;
  onSendToAudience?: (filters: BulkAnalyticsAudienceFilters) => void;
  /** Host can sync multi-campaign selection into the URL without remounting. */
  onSelectedCampaignsChange?: (campaignIds: string[]) => void;
}

type BulkFilterState = {
  selectedDays: string;
  customFromDate: string;
  customToDate: string;
  selectedTemplates: string[];
  selectedCampaigns: string[];
  deliveryStatus:
    | "all"
    | "accepted"
    | "delivered"
    | "read"
    | "failed"
    | "unknown";
  deliveryErrorCode: string;
  recipientSearch: string;
  selectedStatus: BulkAnalyticsStatus;
  selectedEngagement: BulkAnalyticsEngagement;
  conversationScope: string;
  replyWindowHours: string;
  messageContains: string;
  messageContainsMode: "contains" | "not_contains";
  excludeTemplates: boolean;
  comparePrevious: boolean;
};

type BulkFilterAction =
  | {
      type: "patch";
      value: Partial<BulkFilterState>;
    }
  | {
      type: "replace";
      value: BulkFilterState;
    };

const PERIOD_PRESET_VALUES = ["1", "7", "14", "30", "90"] as const;

type TranslationValues = Record<string, string | number>;
type TranslationFn = (key: string, values?: TranslationValues) => string;

function useBulkAnalyticsMessages() {
  const t = useTranslations("BulkAnalytics");

  return {
    t,
    categories: t.raw("categories") as Record<string, string>,
    conversationScopes: t.raw("filters.conversationScopes") as Record<
      string,
      string
    >,
    engagementOptions: t.raw("engagementOptions") as Record<
      BulkAnalyticsEngagement,
      string
    >,
    periodPresets: t.raw("periodPresets") as Record<string, string>,
    replyStatuses: t.raw("filters.replyStatuses") as Record<string, string>,
    replyWindowOptions: t.raw("filters.replyWindowOptions") as Record<
      string,
      string
    >,
  };
}

function createInitialFilterState(
  days: number,
  initialCampaignIds?: string[]
): BulkFilterState {
  const campaignIds = Array.isArray(initialCampaignIds)
    ? Array.from(
        new Set(
          initialCampaignIds.map(id => String(id || "").trim()).filter(Boolean)
        )
      )
    : [];

  return {
    selectedDays: String(days),
    customFromDate: "",
    customToDate: "",
    selectedTemplates: [],
    selectedCampaigns: campaignIds,
    deliveryStatus: "all",
    deliveryErrorCode: "",
    recipientSearch: "",
    selectedStatus: "all",
    selectedEngagement: "all",
    conversationScope: "campaign_sends",
    replyWindowHours: "168",
    messageContains: "",
    messageContainsMode: "contains",
    excludeTemplates: false,
    comparePrevious: false,
  };
}

function bulkFilterReducer(
  state: BulkFilterState,
  action: BulkFilterAction
): BulkFilterState {
  if (action.type === "patch") {
    const next = { ...state, ...action.value };
    if (next.conversationScope !== "campaign_sends") {
      next.deliveryStatus = "all";
      next.deliveryErrorCode = "";
    }
    return next;
  }
  if (action.type === "replace") {
    return action.value;
  }
  return state;
}

const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || "Failed to load bulk analytics");
  }
  return response.json();
};

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value: string): Date | undefined {
  const [year, month, day] = value.split("-").map(part => Number(part));
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date;
}

function getDefaultCustomDateRange(days: string | number): {
  from: string;
  to: string;
} {
  const parsedDays = Number.parseInt(String(days || ""), 10);
  const safeDays = Number.isFinite(parsedDays) ? Math.max(1, parsedDays) : 14;
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - safeDays);
  return {
    from: formatDateInputValue(from),
    to: formatDateInputValue(to),
  };
}

function dateInputToIso(
  value: string,
  boundary: "start" | "end"
): string | null {
  const [year, month, day] = value.split("-").map(part => Number(part));
  if (!year || !month || !day) return null;
  const date =
    boundary === "start"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function getEndOfLocalDay(date = new Date()): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

function getCustomRangeState(
  filters: Pick<
    BulkFilterState,
    "selectedDays" | "customFromDate" | "customToDate"
  >,
  t: TranslationFn
): {
  fromIso: string | null;
  toIso: string | null;
  error: string | null;
} {
  if (filters.selectedDays !== "custom") {
    return { fromIso: null, toIso: null, error: null };
  }

  const fromIso = dateInputToIso(filters.customFromDate, "start");
  const toIso = dateInputToIso(filters.customToDate, "end");
  if (!fromIso || !toIso) {
    return {
      fromIso,
      toIso,
      error: t("errors.selectBothDates"),
    };
  }
  if (new Date(fromIso).getTime() > new Date(toIso).getTime()) {
    return {
      fromIso,
      toIso,
      error: t("errors.fromBeforeTo"),
    };
  }
  const endOfToday = getEndOfLocalDay().getTime();
  if (new Date(fromIso).getTime() > endOfToday) {
    return {
      fromIso,
      toIso,
      error: t("errors.futureRange"),
    };
  }
  return { fromIso, toIso, error: null };
}

function resolveEmptyBulkReason(params: {
  conversationScope: string;
  selectedDays: string;
  customFromDate: string;
  customToDate: string;
  hasAudienceFilter: boolean;
}): "future" | "filtered" | "no_sends" | "no_conversations" {
  if (params.selectedDays === "custom") {
    const fromIso = dateInputToIso(params.customFromDate, "start");
    if (fromIso && new Date(fromIso).getTime() > getEndOfLocalDay().getTime()) {
      return "future";
    }
  }
  if (params.hasAudienceFilter) {
    return "filtered";
  }
  if (params.conversationScope === "campaign_sends") {
    return "no_sends";
  }
  return "no_conversations";
}

function formatPeriodLabel(
  selectedDays: string,
  fromDate: Date | undefined,
  toDate: Date | undefined,
  periodPresets: Record<string, string>,
  formatDatePickerLabel: (
    fromDate: Date | undefined,
    toDate: Date | undefined
  ) => string,
  t: TranslationFn
): string {
  if (selectedDays === "custom") {
    return formatDatePickerLabel(fromDate, toDate);
  }
  if (periodPresets[selectedDays]) return periodPresets[selectedDays];

  const dayCount = Number(selectedDays);
  return Number.isInteger(dayCount) && dayCount > 0
    ? t("period.lastDays", { count: dayCount })
    : selectedDays;
}

function categoryLabel(
  category: string,
  categoryLabels: Record<string, string>
): string {
  return categoryLabels[category] || category;
}

function engagementLabel(
  engagement: BulkAnalyticsEngagement,
  engagementLabels: Record<BulkAnalyticsEngagement, string>
): string {
  return engagementLabels[engagement];
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function clampPercent(value: number | null | undefined): number {
  const percent = (Number(value || 0) || 0) * 100;
  return Math.max(0, Math.min(100, percent));
}

function MetricCard({
  title,
  value,
  detail,
  active,
  onClick,
}: {
  title: string;
  value: string;
  detail?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="min-w-0">
        <p className="break-words text-xs font-medium uppercase text-muted-foreground">
          {title}
        </p>
        <div className="mt-1 break-all text-xl font-semibold tabular-nums sm:text-2xl">
          {value}
        </div>
      </div>
      {detail ? (
        <p className="mt-2 break-words text-xs text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </>
  );

  if (!onClick) {
    return (
      <div className="relative min-w-0 overflow-hidden border-r border-border/50 p-3 last:border-r-0">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={Boolean(active)}
      onClick={onClick}
      className={cn(
        "relative min-w-0 overflow-hidden border-r border-border/50 p-3 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring last:border-r-0",
        active && "bg-muted/60"
      )}
    >
      {content}
    </button>
  );
}

function ConversationOpenButton({
  conversationId,
  label,
  maxLength,
  onOpenConversation,
}: {
  conversationId: string;
  label: string;
  maxLength: number;
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center rounded-md px-1.5 py-1 text-left font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={() => onOpenConversation(conversationId)}
    >
      {shorten(
        formatBulkAnalyticsRecipientLabel(label || conversationId),
        maxLength
      )}
    </button>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function TableSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg bg-background shadow-sm ring-1 ring-border/50">
      {children}
    </div>
  );
}

function FilterField({
  label,
  children,
  className,
  htmlFor,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("block min-w-0 space-y-1.5", className)}>
      <Label
        htmlFor={htmlFor}
        className="text-xs font-medium uppercase text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

const COMPACT_FILTER_FIELD = "min-w-0 basis-[min(100%,11rem)] grow";

type MultiSelectOption = {
  value: string;
  label: string;
  detail?: string;
};

function MultiSelectFilter({
  id,
  label,
  options,
  selectedValues,
  placeholder,
  onChange,
  className,
  disabled,
  disabledTooltip,
}: {
  id: string;
  label: string;
  options: MultiSelectOption[];
  selectedValues: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
  className?: string;
  disabled?: boolean;
  /** Tooltip shown when `disabled` is true to explain why. */
  disabledTooltip?: string;
}) {
  const t = useTranslations("BulkAnalytics");
  const [search, setSearch] = useState("");
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const filteredOptions = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    if (!normalizedSearch) return options;
    return options.filter(option =>
      `${option.label} ${option.detail || ""}`
        .toLowerCase()
        .includes(normalizedSearch)
    );
  }, [options, search]);
  const selectedLabel =
    selectedValues.length === 0
      ? placeholder
      : selectedValues.length === 1
        ? options.find(option => option.value === selectedValues[0])?.label ||
          selectedValues[0]
        : t("multiSelect.selected", { count: selectedValues.length });

  const toggleValue = useCallback(
    (value: string) => {
      const nextValues = selectedSet.has(value)
        ? selectedValues.filter(item => item !== value)
        : [...selectedValues, value];
      onChange(nextValues);
    },
    [onChange, selectedSet, selectedValues]
  );

  const triggerButton = (
    <Button
      id={id}
      type="button"
      variant="outline"
      aria-label={`${label}: ${selectedLabel}`}
      aria-disabled={disabled ? true : undefined}
      disabled={disabled}
      className="h-9 w-full justify-start overflow-hidden px-3 font-normal"
    >
      <span className="truncate">{selectedLabel}</span>
    </Button>
  );

  if (disabled) {
    return (
      <FilterField label={label} htmlFor={id} className={className}>
        {disabledTooltip ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block w-full">{triggerButton}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {disabledTooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          triggerButton
        )}
      </FilterField>
    );
  }

  return (
    <FilterField label={label} htmlFor={id} className={className}>
      <Popover>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="border-b p-2">
            <Input
              value={search}
              placeholder={t("multiSelect.searchPlaceholder", { label })}
              aria-label={t("multiSelect.searchPlaceholder", { label })}
              onChange={event => setSearch(event.target.value)}
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {selectedValues.length > 0 ? (
              <button
                type="button"
                className="flex w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                onClick={() => onChange([])}
              >
                {t("multiSelect.clearSelection")}
              </button>
            ) : null}
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                {t("multiSelect.noMatches")}
              </div>
            ) : (
              filteredOptions.map(option => {
                const selected = selectedSet.has(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => toggleValue(option.value)}
                  >
                    <Checkbox
                      iconFree
                      checked={selected}
                      className="pointer-events-none"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {option.detail ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </FilterField>
  );
}

function PeriodPicker({
  filters,
  onChange,
}: {
  filters: Pick<
    BulkFilterState,
    "selectedDays" | "customFromDate" | "customToDate"
  >;
  onChange: (next: Partial<BulkFilterState>) => void;
}) {
  const { t, periodPresets } = useBulkAnalyticsMessages();
  const { formatDatePickerLabel } = useBulkAnalyticsFormatters();
  const [open, setOpen] = useState(false);
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [showTwoMonths, setShowTwoMonths] = useState(false);
  const [draft, setDraft] = useState(() => ({
    selectedDays: filters.selectedDays,
    customFromDate: filters.customFromDate,
    customToDate: filters.customToDate,
  }));
  const fromDate = useMemo(
    () => parseDateInputValue(filters.customFromDate),
    [filters.customFromDate]
  );
  const toDate = useMemo(
    () => parseDateInputValue(filters.customToDate),
    [filters.customToDate]
  );
  const label = useMemo(
    () =>
      formatPeriodLabel(
        filters.selectedDays,
        fromDate,
        toDate,
        periodPresets,
        formatDatePickerLabel,
        t
      ),
    [
      filters.selectedDays,
      fromDate,
      toDate,
      periodPresets,
      formatDatePickerLabel,
      t,
    ]
  );
  const draftFromDate = useMemo(
    () => parseDateInputValue(draft.customFromDate),
    [draft.customFromDate]
  );
  const draftToDate = useMemo(
    () => parseDateInputValue(draft.customToDate),
    [draft.customToDate]
  );
  const draftLabel = useMemo(
    () =>
      formatPeriodLabel(
        draft.selectedDays,
        draftFromDate,
        draftToDate,
        periodPresets,
        formatDatePickerLabel,
        t
      ),
    [
      draft.selectedDays,
      draftFromDate,
      draftToDate,
      periodPresets,
      formatDatePickerLabel,
      t,
    ]
  );
  const draftRangeState = useMemo(
    () => getCustomRangeState(draft, t),
    [draft, t]
  );
  const canApply = draft.selectedDays !== "custom" || !draftRangeState.error;

  React.useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 720px)");
    const update = () => setShowTwoMonths(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setDraft({
          selectedDays: filters.selectedDays,
          customFromDate: filters.customFromDate,
          customToDate: filters.customToDate,
        });
      }
      setOpen(nextOpen);
    },
    [filters.customFromDate, filters.customToDate, filters.selectedDays]
  );

  const selectPreset = useCallback((value: string) => {
    setDraft({
      selectedDays: value,
      customFromDate: "",
      customToDate: "",
    });
  }, []);

  const selectCustomPreset = useCallback(() => {
    const defaults =
      draft.customFromDate && draft.customToDate
        ? {
            from: draft.customFromDate,
            to: draft.customToDate,
          }
        : getDefaultCustomDateRange(draft.selectedDays);
    setDraft({
      selectedDays: "custom",
      customFromDate: defaults.from,
      customToDate: defaults.to,
    });
  }, [draft.customFromDate, draft.customToDate, draft.selectedDays]);

  const applyDraft = useCallback(() => {
    if (!canApply) return;
    onChange(
      draft.selectedDays === "custom"
        ? draft
        : {
            selectedDays: draft.selectedDays,
            customFromDate: "",
            customToDate: "",
          }
    );
    setOpen(false);
  }, [canApply, draft, onChange]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id="bulk-filter-period"
          type="button"
          variant="outline"
          aria-label={t("period.aria", { label })}
          className="h-9 w-full justify-start overflow-hidden px-3 text-left font-normal"
        >
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        sideOffset={8}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(calc(100vw-1rem),38rem)] overflow-y-auto p-0"
      >
        <div className="grid gap-0 sm:grid-cols-[9.25rem_minmax(0,1fr)]">
          <div className="border-b p-1.5 sm:border-b-0 sm:border-r">
            <ToggleGroup
              type="single"
              value={draft.selectedDays}
              aria-label={t("accessibility.periodPreset")}
              className="flex w-full flex-col items-stretch gap-1"
              onValueChange={value => {
                if (!value) return;
                if (value === "custom") {
                  selectCustomPreset();
                  return;
                }
                selectPreset(value);
              }}
            >
              {PERIOD_PRESET_VALUES.map(value => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className="h-7 flex-none justify-start rounded-md px-2 text-sm font-normal first:rounded-md last:rounded-md"
                >
                  {periodPresets[value]}
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem
                value="custom"
                className="h-7 flex-none justify-start rounded-md px-2 text-sm font-normal first:rounded-md last:rounded-md"
              >
                {periodPresets.custom}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="min-w-0">
            <div className="border-b px-2 py-1.5">
              <p className="text-sm font-medium">{t("period.title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("period.description")}
              </p>
            </div>
            <div className="overflow-x-auto">
              <Calendar
                iconFree
                mode="range"
                numberOfMonths={showTwoMonths ? 2 : 1}
                captionLayout="dropdown"
                timeZone={timeZone}
                className="p-2 [--cell-size:--spacing(7)] [&_.rdp-month]:gap-2 [&_.rdp-months]:gap-2 [&_.rdp-week]:mt-1"
                defaultMonth={draftFromDate || draftToDate}
                disabled={{ after: getEndOfLocalDay() }}
                selected={
                  draftFromDate
                    ? {
                        from: draftFromDate,
                        to: draftToDate,
                      }
                    : undefined
                }
                onSelect={(range: { from?: Date; to?: Date } | undefined) => {
                  const nextFrom = range?.from
                    ? formatDateInputValue(range.from)
                    : "";
                  const nextTo = range?.to
                    ? formatDateInputValue(range.to)
                    : "";
                  setDraft({
                    selectedDays: "custom",
                    customFromDate: nextFrom,
                    customToDate: nextTo,
                  });
                }}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <span
            aria-live="polite"
            className={cn(
              "min-w-0 truncate text-xs",
              draftRangeState.error
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {draftRangeState.error || draftLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => setOpen(false)}
            >
              {t("period.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3"
              disabled={!canApply}
              onClick={applyDraft}
            >
              {t("period.apply")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ReplyRateMeter({ value }: { value: number }) {
  const percent = clampPercent(value);
  const { formatPercent } = useBulkAnalyticsFormatters();

  return (
    <div className="flex items-center justify-end gap-3">
      <span className="tabular-nums">{formatPercent(value)}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-foreground"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

const MemoizedBulkFilters = React.memo(function BulkFilters({
  filters,
  dispatchFilters,
  data,
  defaultDays,
}: {
  filters: BulkFilterState;
  dispatchFilters: (action: BulkFilterAction) => void;
  data?: BulkAnalyticsResponse;
  defaultDays: number;
}) {
  const {
    t,
    conversationScopes,
    engagementOptions,
    replyStatuses,
    replyWindowOptions,
  } = useBulkAnalyticsMessages();
  const { formatDate, formatInteger } = useBulkAnalyticsFormatters();
  const [messagePhraseInput, setMessagePhraseInput] = useState("");

  const templateOptions = useMemo<MultiSelectOption[]>(
    () =>
      (data?.filters.templates || []).map(template => ({
        value: template.name,
        label: template.name,
        detail:
          template.count > 0
            ? formatInteger(template.count)
            : template.status || undefined,
      })),
    [data?.filters.templates, formatInteger]
  );
  const campaignOptions = useMemo<MultiSelectOption[]>(
    () =>
      (data?.filters.campaigns || []).map(campaign => ({
        value: campaign.id,
        label: campaign.name,
        detail: campaign.sentAt ? formatDate(campaign.sentAt) : undefined,
      })),
    [data?.filters.campaigns, formatDate]
  );
  const appliedMessagePhrases = useMemo(
    () => parseMessageTextPhrases(filters.messageContains),
    [filters.messageContains]
  );
  const localMessagePhrases = appliedMessagePhrases;
  const appliedFilterCount = [
    filters.selectedTemplates.length > 0,
    filters.selectedCampaigns.length > 0,
    filters.deliveryStatus !== "all",
    Boolean(filters.deliveryErrorCode),
    Boolean(filters.recipientSearch),
    filters.selectedStatus !== "all",
    filters.selectedEngagement !== "all",
    filters.conversationScope !== "campaign_sends",
    filters.selectedDays !== String(defaultDays),
    filters.replyWindowHours !== "168",
    appliedMessagePhrases.length > 0,
    filters.messageContainsMode !== "contains",
    filters.excludeTemplates,
  ].filter(Boolean).length;
  const hasAppliedFilters =
    filters.selectedTemplates.length > 0 ||
    filters.selectedCampaigns.length > 0 ||
    filters.deliveryStatus !== "all" ||
    Boolean(filters.deliveryErrorCode) ||
    Boolean(filters.recipientSearch) ||
    filters.selectedStatus !== "all" ||
    filters.selectedEngagement !== "all" ||
    filters.conversationScope !== "campaign_sends" ||
    filters.selectedDays !== String(defaultDays) ||
    filters.replyWindowHours !== "168" ||
    appliedMessagePhrases.length > 0 ||
    filters.messageContainsMode !== "contains" ||
    filters.excludeTemplates;

  const commitMessagePhrases = useCallback(
    (phrases: string[]) => {
      const messageContains = formatMessageTextPhrases(phrases);
      setMessagePhraseInput("");
      dispatchFilters({
        type: "replace",
        value: {
          ...filters,
          messageContains,
        },
      });
    },
    [dispatchFilters, filters]
  );

  const handleAddMessagePhrase = useCallback(() => {
    if (!messagePhraseInput.trim()) return;
    commitMessagePhrases(
      addMessageTextPhrases(localMessagePhrases, messagePhraseInput)
    );
  }, [commitMessagePhrases, localMessagePhrases, messagePhraseInput]);

  const handleRemoveMessagePhrase = useCallback(
    (phrase: string) => {
      commitMessagePhrases(
        removeMessageTextPhrase(localMessagePhrases, phrase)
      );
    },
    [commitMessagePhrases, localMessagePhrases]
  );

  const handleResetFilters = useCallback(() => {
    const nextFilters = createInitialFilterState(defaultDays);
    setMessagePhraseInput("");
    dispatchFilters({ type: "replace", value: nextFilters });
  }, [defaultDays, dispatchFilters]);

  const hasAdvancedFilters =
    filters.conversationScope !== "campaign_sends" ||
    filters.excludeTemplates ||
    filters.selectedEngagement !== "all" ||
    filters.replyWindowHours !== "168";
  const [showMoreFilters, setShowMoreFilters] = useState(hasAdvancedFilters);

  React.useEffect(() => {
    if (hasAdvancedFilters) setShowMoreFilters(true);
  }, [hasAdvancedFilters]);

  return (
    <section
      aria-labelledby="bulk-analytics-filters-title"
      className="min-w-0 space-y-2"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="bulk-analytics-filters-title" className="sr-only">
          {t("filters.title")}
        </h2>
        <span
          aria-live="polite"
          className="text-xs font-medium text-muted-foreground"
        >
          {appliedFilterCount > 0
            ? t("filters.activeCount", { count: appliedFilterCount })
            : t("filters.noActive")}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            aria-expanded={showMoreFilters}
            aria-controls={
              showMoreFilters ? "bulk-analytics-more-filters" : undefined
            }
            onClick={() => setShowMoreFilters(open => !open)}
          >
            {showMoreFilters ? t("filters.hideMore") : t("filters.more")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!hasAppliedFilters}
            onClick={handleResetFilters}
          >
            {t("filters.reset")}
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <FilterField
          label={t("filters.periodLabel")}
          htmlFor="bulk-filter-period"
          className={COMPACT_FILTER_FIELD}
        >
          <PeriodPicker
            filters={filters}
            onChange={next =>
              dispatchFilters({
                type: "patch",
                value: next,
              })
            }
          />
        </FilterField>

        <MultiSelectFilter
          id="bulk-filter-templates"
          label={t("filters.templatesLabel")}
          options={templateOptions}
          selectedValues={
            filters.excludeTemplates ? [] : filters.selectedTemplates
          }
          placeholder={t("filters.templatesPlaceholder")}
          className={COMPACT_FILTER_FIELD}
          disabled={filters.excludeTemplates}
          disabledTooltip={t("filters.excludeTemplatesDisabledTooltip")}
          onChange={values =>
            dispatchFilters({
              type: "patch",
              value: { selectedTemplates: values },
            })
          }
        />

        <MultiSelectFilter
          id="bulk-filter-campaigns"
          label={t("filters.campaignsLabel")}
          options={campaignOptions}
          selectedValues={
            filters.excludeTemplates ? [] : filters.selectedCampaigns
          }
          placeholder={t("filters.campaignsPlaceholder")}
          className={COMPACT_FILTER_FIELD}
          disabled={filters.excludeTemplates}
          disabledTooltip={t("filters.excludeTemplatesDisabledTooltip")}
          onChange={values =>
            dispatchFilters({
              type: "patch",
              value: { selectedCampaigns: values },
            })
          }
        />
      </div>

      {showMoreFilters ? (
        <div
          id="bulk-analytics-more-filters"
          className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {filters.conversationScope === "campaign_sends" ? (
            <>
              <FilterField
                label={t("operations.deliveryFilter")}
                htmlFor="bulk-delivery-status"
                className={COMPACT_FILTER_FIELD}
              >
                <Select
                  iconFree
                  value={filters.deliveryStatus}
                  onValueChange={value =>
                    dispatchFilters({
                      type: "patch",
                      value: {
                        deliveryStatus:
                          value as BulkFilterState["deliveryStatus"],
                      },
                    })
                  }
                >
                  <SelectTrigger id="bulk-delivery-status" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        "all",
                        "accepted",
                        "delivered",
                        "read",
                        "failed",
                        "unknown",
                      ] as const
                    ).map(status => (
                      <SelectItem key={status} value={status}>
                        {t(`operations.statuses.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField
                label={t("operations.errorCode")}
                htmlFor="bulk-error-code"
                className={COMPACT_FILTER_FIELD}
              >
                <Input
                  id="bulk-error-code"
                  className="h-9"
                  value={filters.deliveryErrorCode}
                  onChange={event =>
                    dispatchFilters({
                      type: "patch",
                      value: { deliveryErrorCode: event.target.value.trim() },
                    })
                  }
                  placeholder={t("operations.anyError")}
                />
              </FilterField>
            </>
          ) : null}
          <FilterField
            label={t("filters.repliesLabel")}
            htmlFor="bulk-filter-replies"
            className={COMPACT_FILTER_FIELD}
          >
            <Select
              iconFree
              value={filters.selectedStatus}
              onValueChange={value =>
                dispatchFilters({
                  type: "patch",
                  value: {
                    selectedStatus:
                      value === "replied" || value === "not_replied"
                        ? value
                        : "all",
                  },
                })
              }
            >
              <SelectTrigger
                id="bulk-filter-replies"
                className="h-9 w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{replyStatuses.all}</SelectItem>
                <SelectItem value="replied">{replyStatuses.replied}</SelectItem>
                <SelectItem value="not_replied">
                  {replyStatuses.not_replied}
                </SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField
            label={t("filters.messageTextLabel")}
            htmlFor="bulk-filter-message-contains"
            className="min-w-0 w-full sm:col-span-2 lg:col-span-3 xl:col-span-4"
          >
            <div className="space-y-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 basis-[12rem]">
                  <Input
                    id="bulk-filter-message-contains"
                    value={messagePhraseInput}
                    placeholder={t("filters.messageTextPlaceholder")}
                    autoComplete="off"
                    className="min-w-0 rounded-r-none"
                    onChange={event =>
                      setMessagePhraseInput(event.target.value)
                    }
                    onKeyDown={event => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      handleAddMessagePhrase();
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 rounded-l-none border-l-0 px-3"
                    disabled={!messagePhraseInput.trim()}
                    aria-label={t("accessibility.addMessagePhrase")}
                    onClick={handleAddMessagePhrase}
                  >
                    {t("filters.addPhrase")}
                  </Button>
                </div>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={filters.messageContainsMode}
                  aria-label={t("filters.messageTextMatchModeAria")}
                  className="w-full min-w-0 sm:w-auto"
                  onValueChange={value => {
                    if (!value) return;
                    dispatchFilters({
                      type: "patch",
                      value: {
                        messageContainsMode:
                          value === "not_contains"
                            ? "not_contains"
                            : "contains",
                      },
                    });
                  }}
                >
                  <ToggleGroupItem
                    value="contains"
                    aria-label={t("filters.contains")}
                    className="h-9 min-w-0 flex-1 px-3 sm:flex-none"
                  >
                    {t("filters.contains")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="not_contains"
                    aria-label={t("filters.doesNot")}
                    className="h-9 min-w-0 flex-1 px-3 sm:flex-none"
                  >
                    {t("filters.doesNot")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {localMessagePhrases.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {localMessagePhrases.map(phrase => (
                    <span
                      key={phrase}
                      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                    >
                      <span className="truncate">{phrase}</span>
                      <button
                        type="button"
                        className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={t("accessibility.removeMessagePhrase", {
                          phrase,
                        })}
                        onClick={() => handleRemoveMessagePhrase(phrase)}
                      >
                        {t("filters.removePhrase")}
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </FilterField>
          <FilterField
            label={t("filters.conversationsLabel")}
            htmlFor="bulk-filter-conversations"
            className="min-w-0"
          >
            <Select
              iconFree
              value={filters.conversationScope}
              onValueChange={value =>
                dispatchFilters({
                  type: "patch",
                  value: { conversationScope: value },
                })
              }
            >
              <SelectTrigger
                id="bulk-filter-conversations"
                className="h-9 w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="campaign_sends">
                  {conversationScopes.campaign_sends}
                </SelectItem>
                <SelectItem value="all">{conversationScopes.all}</SelectItem>
                <SelectItem value="fresh">
                  {conversationScopes.fresh}
                </SelectItem>
                <SelectItem value="campaign_or_fresh">
                  {conversationScopes.campaign_or_fresh}
                </SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField
            label={t("filters.excludeTemplatesLabel")}
            htmlFor="bulk-filter-exclude-templates"
            className="min-w-0"
          >
            <ToggleGroup
              id="bulk-filter-exclude-templates"
              type="single"
              variant="outline"
              value={filters.excludeTemplates ? "on" : "off"}
              aria-label={t("filters.excludeTemplatesAria")}
              className="w-full min-w-0"
              onValueChange={value => {
                if (!value) return;
                const nextOn = value === "on";
                dispatchFilters({
                  type: "patch",
                  value: {
                    excludeTemplates: nextOn,
                    ...(nextOn
                      ? { selectedTemplates: [], selectedCampaigns: [] }
                      : null),
                  },
                });
              }}
            >
              <ToggleGroupItem
                value="off"
                aria-label={t("filters.excludeTemplatesOff")}
                className="h-9 min-w-0 flex-1 px-2"
              >
                {t("filters.excludeTemplatesOff")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="on"
                aria-label={t("filters.excludeTemplatesOn")}
                className="h-9 min-w-0 flex-1 px-2"
              >
                {t("filters.excludeTemplatesOn")}
              </ToggleGroupItem>
            </ToggleGroup>
          </FilterField>

          <FilterField
            label={t("filters.engagementLabel")}
            htmlFor="bulk-filter-engagement"
            className="min-w-0"
          >
            <Select
              iconFree
              value={filters.selectedEngagement}
              onValueChange={value =>
                dispatchFilters({
                  type: "patch",
                  value: {
                    selectedEngagement:
                      value === "high" ||
                      value === "medium" ||
                      value === "low" ||
                      value === "unscored"
                        ? value
                        : "all",
                  },
                })
              }
            >
              <SelectTrigger
                id="bulk-filter-engagement"
                className="h-9 w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{engagementOptions.all}</SelectItem>
                <SelectItem value="high">{engagementOptions.high}</SelectItem>
                <SelectItem value="medium">
                  {engagementOptions.medium}
                </SelectItem>
                <SelectItem value="low">{engagementOptions.low}</SelectItem>
                <SelectItem value="unscored">
                  {engagementOptions.unscored}
                </SelectItem>
              </SelectContent>
            </Select>
          </FilterField>

          <FilterField
            label={t("filters.replyWindowLabel")}
            htmlFor="bulk-filter-reply-window"
            className="min-w-0"
          >
            <Select
              iconFree
              value={filters.replyWindowHours}
              onValueChange={value =>
                dispatchFilters({
                  type: "patch",
                  value: { replyWindowHours: value },
                })
              }
            >
              <SelectTrigger
                id="bulk-filter-reply-window"
                className="h-9 w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24">{replyWindowOptions["24"]}</SelectItem>
                <SelectItem value="72">{replyWindowOptions["72"]}</SelectItem>
                <SelectItem value="168">{replyWindowOptions["168"]}</SelectItem>
                <SelectItem value="336">{replyWindowOptions["336"]}</SelectItem>
                <SelectItem value="720">{replyWindowOptions["720"]}</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
        </div>
      ) : null}

      {!showMoreFilters && hasAdvancedFilters ? (
        <div className="flex min-w-0 flex-wrap gap-1.5 text-xs text-muted-foreground">
          {filters.conversationScope !== "campaign_sends" ? (
            <span className="rounded-md bg-muted/40 px-2 py-1">
              {t("filters.chips.conversations", {
                value:
                  conversationScopes[filters.conversationScope] ||
                  filters.conversationScope,
              })}
            </span>
          ) : null}
          {filters.comparePrevious ? (
            <span className="rounded-md bg-muted/40 px-2 py-1">
              {t("compare.previous")}
            </span>
          ) : null}
          {filters.excludeTemplates ? (
            <span className="rounded-md bg-muted/40 px-2 py-1">
              {t("filters.excludeTemplatesOn")}
            </span>
          ) : null}
          {filters.selectedEngagement !== "all" ? (
            <span className="rounded-md bg-muted/40 px-2 py-1">
              {t("filters.chips.engagement", {
                value: engagementLabel(
                  filters.selectedEngagement,
                  engagementOptions
                ),
              })}
            </span>
          ) : null}
          {filters.replyWindowHours !== "168" ? (
            <span className="rounded-md bg-muted/40 px-2 py-1">
              {t("filters.replyWindowLabel")}:{" "}
              {replyWindowOptions[filters.replyWindowHours] ||
                filters.replyWindowHours}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

function LoadingMetrics() {
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-3 2xl:grid-cols-6">
      {[1, 2, 3, 4, 5, 6].map(item => (
        <div
          key={item}
          className="min-w-0 rounded-lg bg-background p-3 shadow-sm ring-1 ring-border/50"
        >
          <Skeleton className="h-4 w-3/4" />
          <div className="mt-3">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

const MemoizedSummaryMetrics = React.memo(function SummaryMetrics({
  summary,
  compareSummary,
  conversationScope,
  selectedStatus,
  onMetricStatusChange,
}: {
  summary: BulkSummary;
  compareSummary?: BulkSummary | null;
  conversationScope: string;
  selectedStatus: BulkAnalyticsStatus;
  onMetricStatusChange: (status: BulkAnalyticsStatus) => void;
}) {
  const t = useTranslations("BulkAnalytics");
  const {
    formatInteger,
    formatMinutes,
    formatPercent,
    formatUsd,
    formatSignedDelta,
  } = useBulkAnalyticsFormatters();
  const replyDelta = formatSignedDelta(
    summary.replyRate,
    compareSummary?.replyRate,
    { percent: true }
  );
  const costDelta = formatSignedDelta(
    summary.estimatedCost,
    compareSummary?.estimatedCost,
    { currency: true }
  );
  const costPerReplyLabel =
    summary.costPerReply == null
      ? t("funnel.costPerReplyUnavailable")
      : t("funnel.costPerReplyDetail", {
          value: formatUsd(summary.costPerReply),
        });
  return (
    <div className="grid min-w-0 grid-cols-2 overflow-hidden rounded-lg border bg-background lg:grid-cols-4">
      {conversationScope !== "campaign_sends" ? (
        <MetricCard
          title={t("summary.conversations")}
          value={formatInteger(summary.totalAccepted)}
          detail={t("summary.conversationsDetail", {
            count: formatInteger(summary.uniqueConversations),
          })}
          active={selectedStatus === "all"}
          onClick={() => onMetricStatusChange("all")}
        />
      ) : null}
      <MetricCard
        title={t("summary.replied")}
        value={formatInteger(summary.replied)}
        detail={
          t("summary.replyRateDetail", {
            value: formatPercent(summary.replyRate),
          }) +
          (replyDelta
            ? ` · ${t("compare.vsPrior", { value: replyDelta })}`
            : "")
        }
        active={selectedStatus === "replied"}
        onClick={() => onMetricStatusChange("replied")}
      />
      <MetricCard
        title={t("summary.notReplied")}
        value={formatInteger(summary.notReplied)}
        detail={t("summary.inboundMessagesDetail", {
          count: formatInteger(summary.totalReplies),
        })}
        active={selectedStatus === "not_replied"}
        onClick={() => onMetricStatusChange("not_replied")}
      />
      <MetricCard
        title={t("summary.averageFirstReply")}
        value={formatMinutes(summary.avgReplyDelayMinutes)}
        detail={t("reports.replyAttribution")}
      />
      {conversationScope === "campaign_sends" ? (
        <div className="min-w-0 border-l border-border/50 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t("reports.campaignCost")}
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {summary.estimatedCost == null
              ? t("funnel.costNotPriced")
              : formatUsd(summary.estimatedCost)}
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="link"
                size="sm"
                className="mt-1 h-auto max-w-full whitespace-normal px-0 text-left text-xs"
              >
                {summary.estimatedCost == null
                  ? summary.unknownCostCount
                    ? t("funnel.costUnpricedMessages", {
                        count: summary.unknownCostCount,
                      })
                    : t("funnel.costNotPricedDetail")
                  : costPerReplyLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="max-w-[calc(100vw-2rem)] text-xs">
              {summary.estimatedCost == null
                ? t("funnel.costNotPricedNote")
                : costPerReplyLabel}
              {costDelta ? (
                <p className="mt-2">
                  {t("compare.vsPrior", { value: costDelta })}
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </div>
  );
});

function EmptyBulkState({
  reason,
  recentCampaignHints,
}: {
  reason: "future" | "filtered" | "no_sends" | "no_conversations";
  recentCampaignHints: string[];
}) {
  const t = useTranslations("BulkAnalytics");
  const titleKey =
    reason === "future"
      ? "empty.futureTitle"
      : reason === "filtered"
        ? "empty.filteredTitle"
        : reason === "no_sends"
          ? "empty.noSendsTitle"
          : "empty.title";
  const descriptionKey =
    reason === "future"
      ? "empty.futureDescription"
      : reason === "filtered"
        ? "empty.filteredDescription"
        : reason === "no_sends"
          ? "empty.noSendsDescription"
          : "empty.description";

  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center">
      <p className="text-base font-semibold">{t(titleKey)}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {t(descriptionKey)}
      </p>
      {recentCampaignHints.length > 0 ? (
        <div className="mx-auto mt-4 max-w-lg rounded-md bg-background/80 px-3 py-2 text-left text-xs text-muted-foreground ring-1 ring-border/40">
          <p className="font-medium text-foreground">
            {t("empty.recentCampaignHints")}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {recentCampaignHints.map(hint => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OverviewDisabledState() {
  const t = useTranslations("BulkAnalytics");

  return (
    <Alert>
      <AlertDescription>
        <span className="block font-medium">{t("overviewDisabled.title")}</span>
        <span className="mt-1 block">{t("overviewDisabled.description")}</span>
      </AlertDescription>
    </Alert>
  );
}

const DeliveryMetrics = React.memo(function DeliveryMetrics({
  summary,
  compareSummary,
  selectedDelivery,
  onDeliveryChange,
}: {
  summary: BulkSummary;
  compareSummary?: BulkSummary | null;
  selectedDelivery: BulkFilterState["deliveryStatus"];
  onDeliveryChange: (status: BulkFilterState["deliveryStatus"]) => void;
}) {
  const t = useTranslations("BulkAnalytics");
  const { formatInteger, formatPercent, formatSignedDelta } =
    useBulkAnalyticsFormatters();
  const counters = [
    {
      key: "accepted",
      value: summary.totalAccepted,
      prior: compareSummary?.totalAccepted,
    },
    {
      key: "delivered",
      value: summary.delivered,
      prior: compareSummary?.delivered,
    },
    { key: "read", value: summary.read, prior: compareSummary?.read },
    { key: "failed", value: summary.failed, prior: compareSummary?.failed },
    {
      key: "awaiting",
      value:
        summary.delivered == null || summary.failed == null
          ? null
          : Math.max(
              0,
              summary.totalAccepted - summary.delivered - summary.failed
            ),
      prior: undefined,
    },
  ];
  return (
    <section className="space-y-3">
      <SectionHeader
        title={t("operations.deliveryTitle")}
        description={t("operations.deliveryDescription")}
      />
      {(summary.recipientConflictCount || 0) > 0 ? (
        <Alert>
          <AlertTitle>{t("operations.identityConflict")}</AlertTitle>
          <AlertDescription>
            {t("operations.conflictingAttempts", {
              count: summary.recipientConflictCount || 0,
            })}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border bg-background lg:grid-cols-5">
        {counters.map(counter => {
          const delta = formatSignedDelta(counter.value, counter.prior);
          const detail =
            counter.key === "accepted"
              ? t("operations.attemptsGrain")
              : counter.value == null
                ? t("operations.missingProof")
                : t("operations.ofAccepted", {
                    value:
                      summary.totalAccepted > 0
                        ? formatPercent(counter.value / summary.totalAccepted)
                        : t("operations.unavailable"),
                  });
          return (
            <MetricCard
              key={counter.key}
              title={t(`operations.metrics.${counter.key}`)}
              active={
                selectedDelivery ===
                (counter.key === "accepted" ? "all" : counter.key)
              }
              onClick={
                counter.key === "awaiting"
                  ? undefined
                  : () =>
                      onDeliveryChange(
                        counter.key === "accepted"
                          ? "all"
                          : (counter.key as BulkFilterState["deliveryStatus"])
                      )
              }
              value={
                counter.value == null
                  ? t("operations.unavailable")
                  : formatInteger(counter.value)
              }
              detail={
                delta
                  ? `${detail} · ${t("compare.vsPrior", { value: delta })}`
                  : detail
              }
            />
          );
        })}
      </div>
    </section>
  );
});

const BulkCharts = React.memo(function BulkCharts({
  daily,
  replyCategories,
  outcomes,
}: {
  daily: DailyRow[];
  replyCategories: ReplyCategoryRow[];
  outcomes: OutcomeRow[];
}) {
  const { t, categories } = useBulkAnalyticsMessages();
  const { formatDailyLabel, formatInteger } = useBulkAnalyticsFormatters();
  const outcomeLabels = t.raw("outcomes") as Record<string, string>;
  const dailyChartData = useMemo(
    () =>
      daily.map(row => ({
        name: formatDailyLabel(row.date),
        tooltipLabel: formatDailyLabel(row.date),
        value: row.accepted,
        label: t("charts.dailyRepliesLabel", {
          count: formatInteger(row.replied),
        }),
      })),
    [daily, formatDailyLabel, formatInteger, t]
  );
  const replyCategoryChartData = useMemo(
    () =>
      replyCategories.map(row => ({
        name: categoryLabel(row.category, categories),
        value: row.count,
      })),
    [replyCategories, categories]
  );
  const outcomeChartData = useMemo(
    () =>
      outcomes.map(row => ({
        name: outcomeLabels[row.bucket] || row.bucket,
        value: row.count,
      })),
    [outcomes, outcomeLabels]
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="space-y-3">
          <SectionHeader
            title={t("charts.dailyVolumeTitle")}
            description={t("charts.dailyVolumeDescription")}
          />
          <div className="rounded-lg bg-background p-3 shadow-sm ring-1 ring-border/50">
            <AnalyticsBarChart
              data={dailyChartData}
              height={280}
              color="var(--chart-1)"
              emptyLabel={t("empty.filteredTitle")}
              valueLabel={t("charts.dailyValueLabel")}
              formatValue={formatInteger}
              showGrid={false}
            />
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeader
            title={t("charts.outcomesTitle")}
            description={t("charts.outcomesDescription")}
          />
          <div className="rounded-lg bg-background p-3 shadow-sm ring-1 ring-border/50">
            <AnalyticsBarChart
              data={outcomeChartData}
              height={280}
              color="var(--chart-3)"
              emptyLabel={t("empty.filteredTitle")}
              valueLabel={t("charts.outcomesValueLabel")}
              formatValue={formatInteger}
              showGrid={false}
            />
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeader
            title={t("charts.replyCategoriesTitle")}
            description={t("charts.replyCategoriesDescription")}
          />
          <div className="rounded-lg bg-background p-3 shadow-sm ring-1 ring-border/50">
            <AnalyticsBarChart
              data={replyCategoryChartData}
              height={280}
              color="var(--chart-3)"
              emptyLabel={t("empty.filteredTitle")}
              valueLabel={t("charts.replyCategoriesValueLabel")}
              formatValue={formatInteger}
              showGrid={false}
            />
          </div>
        </section>
      </div>
    </div>
  );
});

function TemplatesTable({ rows }: { rows: TemplateRow[] }) {
  const t = useTranslations("BulkAnalytics");
  const { formatInteger, formatMinutes, formatWindow } =
    useBulkAnalyticsFormatters();

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t("templatesTable.title")}
        description={t("templatesTable.description")}
      />
      <TableSurface>
        <Table aria-label={t("templatesTable.aria")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("templatesTable.columns.template")}</TableHead>
              <TableHead className="text-right">
                {t("templatesTable.columns.accepted")}
              </TableHead>
              <TableHead className="text-right">
                {t("templatesTable.columns.replied")}
              </TableHead>
              <TableHead className="text-right">
                {t("templatesTable.columns.replyRate")}
              </TableHead>
              <TableHead className="text-right">
                {t("templatesTable.columns.avgFirstReply")}
              </TableHead>
              <TableHead>{t("templatesTable.columns.window")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => (
              <TableRow key={row.templateName}>
                <TableCell className="font-medium">
                  {row.templateName}
                </TableCell>
                <TableCell className="text-right">
                  {formatInteger(row.accepted)}
                </TableCell>
                <TableCell className="text-right">
                  {formatInteger(row.replied)}
                </TableCell>
                <TableCell className="text-right">
                  <ReplyRateMeter value={row.replyRate} />
                </TableCell>
                <TableCell className="text-right">
                  {formatMinutes(row.avgReplyDelayMinutes)}
                </TableCell>
                <TableCell>
                  {formatWindow(row.firstSentAt, row.lastSentAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableSurface>
    </section>
  );
}

function DetectedRunsTable({ rows }: { rows: DetectedRunRow[] }) {
  const t = useTranslations("BulkAnalytics");
  const { formatInteger } = useBulkAnalyticsFormatters();

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t("detectedRuns.title")}
        description={t("detectedRuns.description")}
      />
      <TableSurface>
        <Table aria-label={t("detectedRuns.aria")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("detectedRuns.columns.hour")}</TableHead>
              <TableHead>{t("detectedRuns.columns.template")}</TableHead>
              <TableHead className="text-right">
                {t("detectedRuns.columns.accepted")}
              </TableHead>
              <TableHead className="text-right">
                {t("detectedRuns.columns.replyRate")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 10).map(row => (
              <TableRow key={`${row.templateName}-${row.bucket}`}>
                <TableCell>{row.bucket}</TableCell>
                <TableCell>{row.templateName}</TableCell>
                <TableCell className="text-right">
                  {formatInteger(row.accepted)}
                </TableCell>
                <TableCell className="text-right">
                  <ReplyRateMeter value={row.replyRate} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableSurface>
    </section>
  );
}

function TopConversationsTable({
  rows,
  onOpenConversation,
}: {
  rows: ConversationRow[];
  onOpenConversation: (conversationId: string) => void;
}) {
  const t = useTranslations("BulkAnalytics");
  const { formatInteger } = useBulkAnalyticsFormatters();

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t("topConversations.title")}
        description={t("topConversations.description")}
      />
      <TableSurface>
        <Table aria-label={t("topConversations.aria")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("topConversations.columns.recipient")}</TableHead>
              <TableHead>{t("topConversations.columns.template")}</TableHead>
              <TableHead className="text-right">
                {t("topConversations.columns.replies")}
              </TableHead>
              <TableHead>{t("topConversations.columns.firstReply")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 10).map(row => (
              <TableRow key={`${row.conversationId}-${row.templateName}`}>
                <TableCell>
                  <ConversationOpenButton
                    conversationId={row.conversationId}
                    label={row.recipient || row.conversationId}
                    maxLength={22}
                    onOpenConversation={onOpenConversation}
                  />
                </TableCell>
                <TableCell>{row.templateName}</TableCell>
                <TableCell className="text-right">
                  {formatInteger(row.replyCount)}
                </TableCell>
                <TableCell className="max-w-[280px] truncate text-muted-foreground">
                  {row.firstReplyText || t("topConversations.attachment")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableSurface>
    </section>
  );
}

function BulkRunAndReplyTables({
  detectedRuns,
  topConversations,
  onOpenConversation,
}: {
  detectedRuns: DetectedRunRow[];
  topConversations: ConversationRow[];
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <DetectedRunsTable rows={detectedRuns} />
      <TopConversationsTable
        rows={topConversations}
        onOpenConversation={onOpenConversation}
      />
    </div>
  );
}

function BulkAnalyticsHeader({
  data,
  selectedCampaigns,
  isLoading,
  saveFilterDisabled,
  onRefresh,
  onSaveFilter,
  onExportExcel,
  onSendToAudience,
}: {
  data?: BulkAnalyticsResponse;
  selectedCampaigns: string[];
  isLoading: boolean;
  saveFilterDisabled?: boolean;
  onRefresh: () => void;
  onSaveFilter: () => void;
  onExportExcel?: () => void;
  onSendToAudience?: () => void;
}) {
  const t = useTranslations("BulkAnalytics");
  const { formatDateTime } = useBulkAnalyticsFormatters();

  const reportName =
    selectedCampaigns.length === 1
      ? data?.filters.campaigns.find(
          campaign => campaign.id === selectedCampaigns[0]
        )?.name || t("reports.title")
      : selectedCampaigns.length > 1
        ? t("multiSelect.selected", { count: selectedCampaigns.length })
        : t("reports.allCampaigns");

  return (
    <header className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur sm:-mx-5 sm:px-5 lg:-mx-6 lg:px-6">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-base font-semibold">{reportName}</h2>
          {data ? (
            <span className="text-xs text-muted-foreground">
              {t("header.updated", {
                value: formatDateTime(
                  data.dataQuality?.observedAt || data.generatedAt
                ),
              })}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={isLoading}
            onClick={onRefresh}
          >
            {isLoading ? t("header.refreshing") : t("header.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!data || isLoading || !onExportExcel}
            onClick={onExportExcel}
          >
            {t("header.exportExcel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={saveFilterDisabled}
            onClick={onSaveFilter}
          >
            {t("header.saveFilter")}
          </Button>
          {onSendToAudience ? (
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={saveFilterDisabled}
              onClick={onSendToAudience}
            >
              {t("sendToAudience")}
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

const MemoizedBulkDetails = React.memo(function BulkDetails({
  workspaceId,
  data,
  records,
  recordsPageInfo,
  recordsPage,
  recordsLoading,
  recordsError,
  onPreviousRecordsPage,
  onNextRecordsPage,
  onOpenConversation,
  conversationScope,
  reportView,
  onReportViewChange,
  onOpenHistory,
  onFilterError,
  recipientSearch,
  onRecipientSearchChange,
  emptyState,
}: {
  workspaceId: string;
  data: BulkAnalyticsResponse;
  records: MessageRecord[];
  recordsPageInfo?: BulkRecordsPageInfo;
  recordsPage: number;
  recordsLoading: boolean;
  recordsError?: Error;
  onPreviousRecordsPage: () => void;
  onNextRecordsPage: () => void;
  onOpenConversation: (conversationId: string) => void;
  conversationScope: string;
  reportView: string;
  onReportViewChange: (value: string) => void;
  onOpenHistory: (recipient: string) => void;
  onFilterError: (code: string) => void;
  recipientSearch: string;
  onRecipientSearchChange: (value: string) => void;
  emptyState?: React.ReactNode;
}) {
  const t = useTranslations("BulkAnalytics");
  const { formatInteger } = useBulkAnalyticsFormatters();
  const showSendFacets = conversationScope === "campaign_sends";
  return (
    <Tabs
      value={reportView}
      onValueChange={onReportViewChange}
      className="min-w-0 gap-4"
    >
      <TabsList className="h-auto w-full flex-wrap justify-start gap-1 border-b bg-transparent p-0 pb-2 sm:w-auto">
        <TabsTrigger value="recipients" className="flex-none px-3 py-2">
          {t("reports.recipients")}
        </TabsTrigger>
        {showSendFacets ? (
          <>
            <TabsTrigger value="failures" className="flex-none px-3 py-2">
              {t("reports.failures")}
            </TabsTrigger>
            <TabsTrigger value="insights" className="flex-none px-3 py-2">
              {t("reports.insights")}
            </TabsTrigger>
            <TabsTrigger value="spend" className="flex-none px-3 py-2">
              {t("reports.accountSpend")}
            </TabsTrigger>
          </>
        ) : null}
      </TabsList>
      <TabsContent value="recipients">
        <BulkAnalyticsRecipients
          records={records}
          isLoading={recordsLoading}
          error={recordsError}
          page={recordsPage}
          pageInfo={recordsPageInfo}
          onPreviousPage={onPreviousRecordsPage}
          onNextPage={onNextRecordsPage}
          onOpenConversation={onOpenConversation}
          conversationScope={conversationScope}
          onOpenHistory={onOpenHistory}
          totalCount={data.summary?.totalAccepted}
          search={recipientSearch}
          onSearchChange={onRecipientSearchChange}
          emptyState={emptyState}
        />
      </TabsContent>
      {showSendFacets ? (
        <>
          <TabsContent value="failures" className="space-y-3">
            <SectionHeader
              title={t("charts.failuresTitle")}
              description={t("reports.failureScope")}
            />
            {data.failures?.length ? (
              <div className="divide-y rounded-lg border">
                {data.failures.map(failure => (
                  <div
                    key={failure.errorCode}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium">
                        {failure.errorCode === "unknown"
                          ? t("failures.unknown")
                          : t("failures.codeLabel", {
                              code: failure.errorCode,
                            })}{" "}
                        <span className="ml-2 text-muted-foreground">
                          {formatInteger(failure.count)}
                        </span>
                      </p>
                      {t.has(
                        `reports.errorDescriptions.${failure.errorCode}`
                      ) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t(`reports.errorDescriptions.${failure.errorCode}`)}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onFilterError(failure.errorCode)}
                    >
                      {t("reports.inspectRecipients")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                {t("reports.noFailures")}
              </p>
            )}
          </TabsContent>
          <TabsContent value="insights" className="space-y-6">
            <BulkCharts
              daily={data.daily || []}
              replyCategories={data.replyCategories || []}
              outcomes={data.outcomes || []}
            />
            <TemplatesTable rows={data.byTemplate || []} />
            <BulkRunAndReplyTables
              detectedRuns={data.detectedRuns || []}
              topConversations={data.topConversations || []}
              onOpenConversation={onOpenConversation}
            />
          </TabsContent>
          <TabsContent value="spend">
            {reportView === "spend" ? (
              <WhatsAppSpendSummary
                workspaceId={workspaceId}
                period={{
                  from: data.window.startDate,
                  to: data.window.endDate,
                }}
              />
            ) : null}
          </TabsContent>
        </>
      ) : null}
    </Tabs>
  );
});

export function BulkAnalytics({
  workspaceId,
  days = 14,
  initialCampaignIds,
  onSendToAudience,
  onOpenCampaignHistory,
  onSelectedCampaignsChange,
}: BulkAnalyticsProps) {
  const t = useTranslations("BulkAnalytics");
  const { formatDate } = useBulkAnalyticsFormatters();
  const [filters, dispatchFilters] = useReducer(
    bulkFilterReducer,
    { days, initialCampaignIds },
    init => createInitialFilterState(init.days, init.initialCampaignIds)
  );
  const [drawerConversationId, setDrawerConversationId] = useState<
    string | null
  >(null);
  const exportAbort = useRef<AbortController | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState(false);
  const [reportView, setReportView] = useState("recipients");
  const [healthRefreshKey, setHealthRefreshKey] = useState(0);
  const [historyRecipient, setHistoryRecipient] = useState<string | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const [saveFilterSubmitting, setSaveFilterSubmitting] = useState(false);

  const {
    selectedDays,
    customFromDate,
    customToDate,
    selectedTemplates,
    selectedCampaigns,
    deliveryStatus,
    deliveryErrorCode,
    recipientSearch,
    selectedStatus,
    selectedEngagement,
    conversationScope,
    replyWindowHours,
    messageContains,
    messageContainsMode,
    excludeTemplates,
    comparePrevious,
  } = filters;

  const notifySelectedCampaigns = useEffectEvent((campaignIds: string[]) => {
    onSelectedCampaignsChange?.(campaignIds);
  });

  useEffect(() => {
    notifySelectedCampaigns(selectedCampaigns);
  }, [selectedCampaigns]);

  const timezone = useMemo(() => {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }, []);

  const customRangeState = useMemo(
    () =>
      getCustomRangeState({ selectedDays, customFromDate, customToDate }, t),
    [customFromDate, customToDate, selectedDays, t]
  );

  const analyticsQueryString = useMemo(() => {
    if (customRangeState.error) return null;

    const params = new URLSearchParams({
      replyWindowHours,
      timezone,
    });

    if (selectedDays === "custom") {
      if (customRangeState.fromIso)
        params.set("from", customRangeState.fromIso);
      if (customRangeState.toIso) params.set("to", customRangeState.toIso);
    } else {
      params.set("days", selectedDays);
    }

    if (excludeTemplates) {
      params.set("excludeTemplates", "1");
    } else {
      for (const template of selectedTemplates) {
        params.append("template", template);
      }
      for (const campaignId of selectedCampaigns) {
        params.append("campaignId", campaignId);
      }
    }
    if (selectedStatus !== "all") {
      params.set("status", selectedStatus);
    }
    if (selectedEngagement !== "all") {
      params.set("engagement", selectedEngagement);
    }
    if (deliveryStatus !== "all") params.set("deliveryStatus", deliveryStatus);
    if (deliveryErrorCode) params.set("deliveryErrorCode", deliveryErrorCode);
    if (recipientSearch) params.set("recipientSearch", recipientSearch);
    params.set("conversationScope", conversationScope);
    params.set("compare", "off");
    if (messageContains.trim()) {
      params.set("messageContains", messageContains.trim());
      params.set("messageContainsMode", messageContainsMode);
    } else if (messageContainsMode !== "contains") {
      params.set("messageContainsMode", messageContainsMode);
    }

    return params.toString();
  }, [
    selectedDays,
    customRangeState.error,
    customRangeState.fromIso,
    customRangeState.toIso,
    selectedTemplates,
    selectedCampaigns,
    deliveryStatus,
    deliveryErrorCode,
    recipientSearch,
    selectedStatus,
    selectedEngagement,
    conversationScope,
    replyWindowHours,
    messageContains,
    messageContainsMode,
    excludeTemplates,
    timezone,
  ]);

  useEffect(() => {
    exportAbort.current?.abort();
    setExportError(false);
    setHistoryRecipient(null);
  }, [analyticsQueryString, workspaceId]);
  useEffect(() => {
    if (conversationScope !== "campaign_sends") setReportView("recipients");
  }, [conversationScope]);

  const overviewUrl = useMemo(() => {
    if (!analyticsQueryString) return null;
    const params = new URLSearchParams(analyticsQueryString);
    params.set("view", "overview");
    params.set("compare", "off");
    return `/api/workspaces/${workspaceId}/analytics/bulk?${params.toString()}`;
  }, [analyticsQueryString, workspaceId]);

  const { data, error, isLoading, isValidating, mutate } =
    useSWR<BulkAnalyticsResponse>(overviewUrl, fetcher, {
      dedupingInterval: 10_000,
      keepPreviousData: false,
      revalidateOnFocus: false,
    });
  const compareUrl = useMemo(() => {
    if (!analyticsQueryString || !comparePrevious) return null;
    const params = new URLSearchParams(analyticsQueryString);
    params.set("view", "compare");
    params.set("compare", "previous");
    return `/api/workspaces/${workspaceId}/analytics/bulk?${params.toString()}`;
  }, [analyticsQueryString, comparePrevious, workspaceId]);

  const recordsQueryIdentity = `${workspaceId}:${analyticsQueryString}`;
  const snapshotToken = data?.snapshotToken || data?.dataQuality?.snapshotToken;
  const snapshotObservedAt = data?.dataQuality?.observedAt;
  const hasSnapshotContext = Boolean(
    snapshotToken?.trim() &&
      snapshotObservedAt &&
      Number.isFinite(Date.parse(snapshotObservedAt))
  );
  const recordsContextIdentity = hasSnapshotContext
    ? JSON.stringify([recordsQueryIdentity, snapshotToken, snapshotObservedAt])
    : null;
  const [recordsPage, setRecordsPage] = useState(0);
  const [recordsCursors, setRecordsCursors] = useState<Array<string | null>>([
    null,
  ]);
  const [recordsQueryString, setRecordsQueryString] = useState(
    recordsContextIdentity
  );
  const recordsQueryChanged = recordsQueryString !== recordsContextIdentity;
  const effectiveRecordsPage = recordsQueryChanged ? 0 : recordsPage;
  const effectiveRecordsCursors = recordsQueryChanged ? [null] : recordsCursors;
  const recordsCursor = effectiveRecordsCursors[effectiveRecordsPage] || null;
  const [retainedRecords, setRetainedRecords] = useState<{
    identity: string;
    context: string | null;
    page: number;
    data: BulkAnalyticsRecordsResponse;
  } | null>(null);

  const recordsUrl = useMemo(() => {
    if (
      !analyticsQueryString ||
      !hasSnapshotContext ||
      !snapshotToken ||
      !snapshotObservedAt
    )
      return null;
    const params = new URLSearchParams(analyticsQueryString);
    params.set("view", "records");
    params.set("compare", "off");
    params.set("limit", "100");
    params.set("snapshotToken", snapshotToken);
    params.set("observedAt", snapshotObservedAt);
    if (recordsCursor) params.set("cursor", recordsCursor);
    return `/api/workspaces/${workspaceId}/analytics/bulk?${params}`;
  }, [
    analyticsQueryString,
    hasSnapshotContext,
    snapshotToken,
    snapshotObservedAt,
    recordsCursor,
    workspaceId,
  ]);
  const recordsFetcher = useCallback(
    async (url: string): Promise<BulkAnalyticsRecordsResponse> => {
      const payload = await fetcher<BulkAnalyticsRecordsResponse>(url);
      if (
        (payload.snapshotToken || payload.dataQuality?.snapshotToken) !==
          snapshotToken ||
        payload.dataQuality?.observedAt !== snapshotObservedAt
      )
        throw new Error("Records observation does not match overview");
      return payload;
    },
    [snapshotToken, snapshotObservedAt]
  );
  const {
    data: compareData,
    error: compareError,
    isLoading: compareLoading,
    mutate: mutateCompare,
  } = useSWR<{
    compare?: BulkAnalyticsResponse["compare"];
  }>(compareUrl, fetcher, {
    dedupingInterval: 10_000,
    keepPreviousData: false,
    revalidateOnFocus: false,
  });
  const dataWithCompare = useMemo(() => {
    if (!data) return data;
    return {
      ...data,
      compare: comparePrevious ? (compareData?.compare ?? null) : null,
    };
  }, [compareData?.compare, comparePrevious, data]);
  const shouldRequestRecords = Boolean(
    recordsUrl &&
      overviewUrl &&
      !customRangeState.error &&
      data &&
      data.overview?.status !== "disabled" &&
      data.summary &&
      data.summary.totalAccepted > 0
  );
  const recordsRequestUrl = shouldRequestRecords ? recordsUrl : null;
  const {
    data: recordsData,
    error: recordsError,
    isLoading: recordsLoading,
    mutate: mutateRecords,
  } = useSWR<BulkAnalyticsRecordsResponse>(recordsRequestUrl, recordsFetcher, {
    dedupingInterval: 10_000,
    keepPreviousData: false,
    revalidateOnFocus: false,
  });
  useEffect(() => {
    if (recordsData && shouldRequestRecords)
      setRetainedRecords({
        identity: recordsQueryIdentity,
        context: recordsContextIdentity,
        page: effectiveRecordsPage,
        data: recordsData,
      });
  }, [
    recordsData,
    shouldRequestRecords,
    recordsQueryIdentity,
    recordsContextIdentity,
    effectiveRecordsPage,
  ]);
  const retainedForQuery =
    retainedRecords?.identity === recordsQueryIdentity &&
    (retainedRecords.context !== recordsContextIdentity ||
      retainedRecords.page === effectiveRecordsPage)
      ? retainedRecords
      : null;
  const replacingRecords = Boolean(
    shouldRequestRecords && !recordsData && retainedForQuery
  );
  const visibleRecordsData = shouldRequestRecords
    ? recordsData || retainedForQuery?.data
    : undefined;
  const visibleRecordsError = shouldRequestRecords
    ? recordsError
    : data?.summary?.totalAccepted && !hasSnapshotContext
      ? new Error("Records observation unavailable")
      : undefined;
  const visibleRecordsLoading = shouldRequestRecords
    ? recordsLoading || replacingRecords
    : false;
  const visibleRecordsPage = replacingRecords
    ? retainedForQuery?.page || 0
    : effectiveRecordsPage;
  const exportContextReady =
    data?.dataQuality?.complete === true &&
    hasSnapshotContext &&
    !(data.dataQuality.reasons || []).includes("snapshot_cache_unavailable");

  const analyticsAudienceFilters = useMemo<BulkAnalyticsAudienceFilters>(() => {
    const baseFilters: BulkAnalyticsAudienceFilters = {
      timezone,
      templates: excludeTemplates ? [] : selectedTemplates,
      campaignIds: excludeTemplates ? [] : selectedCampaigns,
      deliveryStatus,
      deliveryErrorCode: deliveryErrorCode || undefined,
      recipientSearch: recipientSearch || undefined,
      status: selectedStatus,
      engagement: selectedEngagement,
      conversationScope:
        conversationScope === "campaign_sends" ||
        conversationScope === "all" ||
        conversationScope === "fresh" ||
        conversationScope === "campaign_or_fresh"
          ? conversationScope
          : "all",
      messageContains: messageContains.trim() || undefined,
      messageContainsMode,
      replyWindowHours,
      excludeTemplates: excludeTemplates || undefined,
    };

    if (selectedDays === "custom") {
      return {
        ...baseFilters,
        from: customRangeState.fromIso || undefined,
        to: customRangeState.toIso || undefined,
      };
    }

    return {
      ...baseFilters,
      days: selectedDays,
    };
  }, [
    selectedDays,
    customRangeState.fromIso,
    customRangeState.toIso,
    timezone,
    selectedTemplates,
    selectedCampaigns,
    deliveryStatus,
    deliveryErrorCode,
    recipientSearch,
    selectedStatus,
    selectedEngagement,
    conversationScope,
    messageContains,
    messageContainsMode,
    excludeTemplates,
    replyWindowHours,
  ]);

  const handleOpenConversation = useCallback((conversationId: string) => {
    setDrawerConversationId(conversationId);
  }, []);

  const handleConversationDrawerOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDrawerConversationId(null);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setHealthRefreshKey(key => key + 1);
    void mutate();
    void mutateCompare();
    if (shouldRequestRecords) {
      void mutateRecords();
    }
  }, [mutate, mutateCompare, mutateRecords, shouldRequestRecords]);

  const handleExportExcel = useCallback(() => {
    if (
      !dataWithCompare ||
      !recordsUrl ||
      exportAbort.current ||
      !exportContextReady
    )
      return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportProgress(0);
    setExportError(false);
    void (async () => {
      try {
        const exportUrl = new URL(recordsUrl, window.location.origin);
        exportUrl.searchParams.delete("cursor");
        exportUrl.searchParams.delete("snapshotToken");
        exportUrl.searchParams.delete("observedAt");
        const collection = await collectAllBulkAnalyticsRecords<MessageRecord>({
          url: exportUrl.pathname + exportUrl.search,
          observedAt: snapshotObservedAt,
          snapshotToken: snapshotToken,
          signal: controller.signal,
          onProgress: setExportProgress,
          expectedCount: dataWithCompare.summary?.totalAccepted,
        });
        if (controller.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        const outcomeLabels = t.raw("outcomes") as Record<string, string>;
        const bytes = await buildBulkAnalyticsWorkbook({
          generatedAt: dataWithCompare.generatedAt,
          window: dataWithCompare.window,
          summary: dataWithCompare.summary,
          compareSummary: dataWithCompare.compare?.summary ?? null,
          byTemplate: dataWithCompare.byTemplate || [],
          daily: dataWithCompare.daily || [],
          outcomes: dataWithCompare.outcomes || [],
          failures: dataWithCompare.failures || [],
          detectedRuns: dataWithCompare.detectedRuns || [],
          topConversations: dataWithCompare.topConversations || [],
          records: collection.records,
          exportContext: {
            filters: analyticsQueryString || "",
            observedAt: collection.observedAt,
            completedAt: collection.completedAt,
            complete: true,
            consistency: "bounded_observation",
          },
          deliveryStatusLabel: status => t(`operations.statuses.${status}`),
          labels: {
            sheets: {
              summary: t("export.sheets.summary"),
              templates: t("export.sheets.templates"),
              daily: t("export.sheets.daily"),
              outcomes: t("export.sheets.outcomes"),
              failures: t("export.sheets.failures"),
              runs: t("export.sheets.runs"),
              topConversations: t("export.sheets.topConversations"),
              records: t("export.sheets.records"),
            },
            columns: {
              deliveryStatus: t("operations.deliveryFilter"),
              deliveryErrorCode: t("operations.errorCode"),
              deliveredAt: t("operations.deliveredAt"),
              readAt: t("operations.readAt"),
              providerRecipient: t("operations.providerRecipient"),
              recipientConflict: t("operations.identityConflict"),
              metric: t("export.columns.metric"),
              current: t("export.columns.current"),
              previous: t("export.columns.previous"),
              template: t("templatesTable.columns.template"),
              accepted: t("templatesTable.columns.accepted"),
              replied: t("templatesTable.columns.replied"),
              replyRate: t("templatesTable.columns.replyRate"),
              date: t("detectedRuns.columns.hour"),
              outcome: t("charts.outcomesTitle"),
              count: t("charts.outcomesValueLabel"),
              error: t("charts.failuresTitle"),
              hour: t("detectedRuns.columns.hour"),
              recipient: t("recentTable.columns.recipient"),
              conversationId: t("export.columns.conversationId"),
              sentAt: t("recentTable.columns.sent"),
              status: t("recentTable.columns.status"),
              replies: t("recentTable.columns.replies"),
              firstReply: t("recentTable.columns.firstReply"),
            },
            status: {
              replied: t("statusBadge.replied"),
              noReply: t("statusBadge.noReply"),
            },
            metrics: [
              { key: "totalAccepted", label: t("funnel.accepted") },
              { key: "failed", label: t("funnel.failed") },
              { key: "delivered", label: t("funnel.delivered") },
              { key: "read", label: t("funnel.read") },
              { key: "replied", label: t("funnel.replied") },
              { key: "notReplied", label: t("summary.notReplied") },
              { key: "estimatedCost", label: t("funnel.cost") },
              {
                key: "replyRate",
                label: t("templatesTable.columns.replyRate"),
              },
            ],
          },
          outcomeLabel: bucket => outcomeLabels[bucket] || bucket,
        });
        if (controller.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        downloadBulkAnalyticsWorkbook(
          bytes,
          `bulk-analytics_${dataWithCompare.window.endDate.slice(0, 10)}.xlsx`
        );
      } catch (error) {
        bulkAnalyticsLogger.error("bulk_analytics.excel_export_failed", error, {
          workspaceId,
        });
        if (!controller.signal.aborted) {
          setExportError(true);
          toast.error(t("header.exportFailed"));
        }
      } finally {
        exportAbort.current = null;
        setExportProgress(null);
      }
    })();
  }, [
    analyticsQueryString,
    dataWithCompare,
    recordsUrl,
    exportContextReady,
    snapshotObservedAt,
    snapshotToken,
    t,
    workspaceId,
  ]);

  const handleSaveFilter = useCallback(async () => {
    const name = saveFilterName.trim();
    if (!name) return;

    setSaveFilterSubmitting(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/bulk-campaign-filters`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            filters: analyticsAudienceFilters,
          }),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t("saveFilter.error"));
      }

      toast.success(t("saveFilter.success"));
      setSaveFilterOpen(false);
      setSaveFilterName("");
    } catch (error) {
      bulkAnalyticsLogger.error("bulk_analytics.filter_save_failed", error, {
        workspaceId,
      });
      toast.error(t("saveFilter.error"));
    } finally {
      setSaveFilterSubmitting(false);
    }
  }, [analyticsAudienceFilters, saveFilterName, t, workspaceId]);

  const handlePreviousRecordsPage = useCallback(() => {
    setRecordsPage(page => Math.max(0, page - 1));
  }, []);

  const handleNextRecordsPage = useCallback(() => {
    const nextCursor = visibleRecordsData?.pageInfo.nextCursor;
    if (!nextCursor) return;

    setRecordsCursors(current => {
      const next = current.slice(0, effectiveRecordsPage + 1);
      next[effectiveRecordsPage + 1] = nextCursor;
      return next;
    });
    setRecordsPage(page => page + 1);
  }, [effectiveRecordsPage, visibleRecordsData?.pageInfo.nextCursor]);

  const handleRecipientSearchChange = useCallback((value: string) => {
    dispatchFilters({ type: "patch", value: { recipientSearch: value } });
  }, []);

  const handleFilterError = useCallback((code: string) => {
    dispatchFilters({
      type: "patch",
      value: {
        deliveryStatus: "failed",
        deliveryErrorCode: code,
        conversationScope: "campaign_sends",
      },
    });
    setReportView("recipients");
  }, []);

  const handleMetricStatusChange = useCallback(
    (status: BulkAnalyticsStatus) => {
      setReportView("recipients");
      dispatchFilters({
        type: "patch",
        value: {
          selectedStatus: selectedStatus === status ? "all" : status,
        },
      });
    },
    [selectedStatus]
  );

  const summary = dataWithCompare?.summary;
  const overviewDisabled = dataWithCompare?.overview?.status === "disabled";
  const hasData = Boolean(summary && summary.totalAccepted > 0);
  const emptyReason = resolveEmptyBulkReason({
    conversationScope,
    selectedDays,
    customFromDate,
    customToDate,
    hasAudienceFilter:
      (!excludeTemplates && selectedCampaigns.length > 0) ||
      (!excludeTemplates && selectedTemplates.length > 0) ||
      excludeTemplates ||
      Boolean(recipientSearch) ||
      deliveryStatus !== "all" ||
      Boolean(deliveryErrorCode) ||
      selectedStatus !== "all" ||
      selectedEngagement !== "all" ||
      Boolean(messageContains.trim()),
  });
  const recentCampaignHints = useMemo(() => {
    const campaigns = dataWithCompare?.filters.campaigns || [];
    return campaigns
      .filter(campaign => Boolean(campaign.sentAt))
      .slice(0, 3)
      .map(campaign => {
        const when = campaign.sentAt ? formatDate(campaign.sentAt) : "";
        return when ? `${campaign.name} · ${when}` : campaign.name;
      });
  }, [dataWithCompare?.filters.campaigns, formatDate]);

  if (recordsQueryChanged) {
    setRecordsPage(0);
    setRecordsCursors([null]);
    setRecordsQueryString(recordsContextIdentity);
  }

  return (
    <div className="flex min-w-0 w-full flex-col gap-4">
      <BulkAnalyticsHeader
        data={dataWithCompare}
        selectedCampaigns={selectedCampaigns}
        isLoading={isLoading || isValidating}
        saveFilterDisabled={
          Boolean(customRangeState.error) ||
          !dataWithCompare ||
          deliveryStatus !== "all" ||
          Boolean(deliveryErrorCode) ||
          Boolean(recipientSearch)
        }
        onRefresh={handleRefresh}
        onSaveFilter={() => setSaveFilterOpen(true)}
        onExportExcel={
          exportProgress === null && exportContextReady
            ? handleExportExcel
            : undefined
        }
        onSendToAudience={
          onSendToAudience
            ? () => onSendToAudience(analyticsAudienceFilters)
            : undefined
        }
      />

      <MemoizedBulkFilters
        filters={filters}
        dispatchFilters={dispatchFilters}
        data={dataWithCompare}
        defaultDays={days}
      />

      {deliveryStatus !== "all" ||
      deliveryErrorCode ||
      recipientSearch ||
      selectedStatus !== "all" ? (
        <div className="flex flex-wrap gap-2" aria-label={t("filters.title")}>
          {deliveryStatus !== "all" || deliveryErrorCode ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                dispatchFilters({
                  type: "patch",
                  value: { deliveryStatus: "all", deliveryErrorCode: "" },
                })
              }
              aria-label={t("reports.clearDelivery")}
            >
              {t(`operations.statuses.${deliveryStatus}`)}
              {deliveryErrorCode ? ` · ${deliveryErrorCode}` : ""} ×
            </Button>
          ) : null}
          {selectedStatus !== "all" ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                dispatchFilters({
                  type: "patch",
                  value: { selectedStatus: "all" },
                })
              }
            >
              {t(
                `statusBadge.${selectedStatus === "replied" ? "replied" : "noReply"}`
              )}{" "}
              ×
            </Button>
          ) : null}
          {recipientSearch ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                dispatchFilters({
                  type: "patch",
                  value: { recipientSearch: "" },
                })
              }
              aria-label={t("reports.clearSearch")}
            >
              {recipientSearch} ×
            </Button>
          ) : null}
        </div>
      ) : null}

      {customRangeState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{customRangeState.error}</AlertDescription>
        </Alert>
      ) : null}

      {exportProgress !== null ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className="text-sm">
            {t("operations.exportProgress", { count: exportProgress })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportAbort.current?.abort()}
          >
            {t("operations.cancelExport")}
          </Button>
        </div>
      ) : null}
      {exportError ? (
        <Alert variant="destructive">
          <AlertDescription>{t("header.exportFailed")}</AlertDescription>
        </Alert>
      ) : null}
      {deliveryStatus !== "all" || deliveryErrorCode || recipientSearch ? (
        <Alert>
          <AlertDescription>
            {t("operations.diagnosticAudience")}
            {onOpenCampaignHistory ? (
              <Button
                variant="link"
                className="h-auto whitespace-normal"
                onClick={() =>
                  onOpenCampaignHistory(
                    selectedCampaigns.length === 1
                      ? selectedCampaigns[0]
                      : undefined
                  )
                }
              >
                {t("operations.openHistory")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {!excludeTemplates && conversationScope === "campaign_sends" ? (
        <BulkCampaignHealth
          workspaceId={workspaceId}
          campaignIds={selectedCampaigns}
          onOpenCampaignHistory={onOpenCampaignHistory}
          refreshKey={healthRefreshKey}
          onFilterError={code => handleFilterError(code || "")}
        />
      ) : null}
      {dataWithCompare?.dataQuality?.complete === false ? (
        <Alert>
          <AlertTitle>{t("operations.incomplete")}</AlertTitle>
          <AlertDescription>
            {t("operations.incompleteDescription")}{" "}
          </AlertDescription>
        </Alert>
      ) : null}
      {dataWithCompare &&
      !exportContextReady &&
      dataWithCompare.dataQuality?.complete !== false ? (
        <Alert>
          <AlertDescription>
            {t("operations.exportUnavailable")}
          </AlertDescription>
        </Alert>
      ) : null}
      {isLoading && !dataWithCompare ? <LoadingMetrics /> : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t("errors.loadFailed")}</AlertDescription>
        </Alert>
      ) : null}

      {!error && dataWithCompare && overviewDisabled ? (
        <OverviewDisabledState />
      ) : null}

      {dataWithCompare && !overviewDisabled && summary ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("reports.attributionWindow", { hours: replyWindowHours })}
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={comparePrevious}
                onCheckedChange={value =>
                  dispatchFilters({
                    type: "patch",
                    value: { comparePrevious: value === true },
                  })
                }
              />
              {t("compare.previous")}
            </label>
          </div>
          {compareLoading ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("operations.comparisonLoading")}
            </p>
          ) : null}
          {compareError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t("operations.comparisonFailed")}
              </AlertDescription>
            </Alert>
          ) : null}
          {conversationScope === "campaign_sends" ? (
            <DeliveryMetrics
              summary={summary}
              compareSummary={dataWithCompare.compare?.summary}
              selectedDelivery={deliveryStatus}
              onDeliveryChange={status => {
                dispatchFilters({
                  type: "patch",
                  value: {
                    deliveryStatus: status === deliveryStatus ? "all" : status,
                    deliveryErrorCode: "",
                  },
                });
                setReportView("recipients");
              }}
            />
          ) : null}
          <MemoizedSummaryMetrics
            summary={summary}
            compareSummary={dataWithCompare.compare?.summary}
            conversationScope={conversationScope}
            selectedStatus={selectedStatus}
            onMetricStatusChange={handleMetricStatusChange}
          />

          <MemoizedBulkDetails
            emptyState={
              !hasData ? (
                <EmptyBulkState
                  reason={emptyReason}
                  recentCampaignHints={recentCampaignHints}
                />
              ) : undefined
            }
            workspaceId={workspaceId}
            data={dataWithCompare}
            records={visibleRecordsData?.records || []}
            recordsPageInfo={
              replacingRecords ? undefined : visibleRecordsData?.pageInfo
            }
            recordsPage={visibleRecordsPage}
            recordsLoading={visibleRecordsLoading}
            recordsError={visibleRecordsError}
            onPreviousRecordsPage={handlePreviousRecordsPage}
            onNextRecordsPage={handleNextRecordsPage}
            onOpenConversation={handleOpenConversation}
            conversationScope={conversationScope}
            reportView={reportView}
            onReportViewChange={setReportView}
            onFilterError={handleFilterError}
            recipientSearch={recipientSearch}
            onRecipientSearchChange={handleRecipientSearchChange}
            onOpenHistory={setHistoryRecipient}
          />
        </>
      ) : null}

      <BulkRecipientHistory
        workspaceId={workspaceId}
        recipient={historyRecipient}
        campaignId={
          selectedCampaigns.length === 1 ? selectedCampaigns[0] : undefined
        }
        onClose={() => setHistoryRecipient(null)}
      />
      <ConversationDetailDrawer
        conversationId={drawerConversationId}
        workspaceId={workspaceId}
        open={Boolean(drawerConversationId)}
        onOpenChange={handleConversationDrawerOpenChange}
      />
      <Dialog open={saveFilterOpen} onOpenChange={setSaveFilterOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("saveFilter.title")}</DialogTitle>
            <DialogDescription>{t("saveFilter.description")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault();
              void handleSaveFilter();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="bulk-save-filter-name">
                {t("saveFilter.nameLabel")}
              </Label>
              <Input
                id="bulk-save-filter-name"
                value={saveFilterName}
                maxLength={80}
                placeholder={t("saveFilter.namePlaceholder")}
                onChange={event => setSaveFilterName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSaveFilterOpen(false)}
              >
                {t("saveFilter.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={saveFilterSubmitting || !saveFilterName.trim()}
              >
                {saveFilterSubmitting
                  ? t("saveFilter.saving")
                  : t("saveFilter.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
