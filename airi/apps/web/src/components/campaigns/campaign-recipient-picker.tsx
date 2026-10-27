"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  collectCampaignRecipientColumns,
} from "@/lib/campaign/campaign-variable-values";
import type { BulkCampaignRecipientLimit } from "@/lib/campaign/bulk-campaign-contracts";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "@/lib/campaign/bulk-campaign-contracts";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SCENARIO_UNDO_TOAST_DURATION_MS } from "@/components/scenarios/view/graph/undo-context";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import {
  BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT,
  type BulkCampaignAudienceUploadEvidence,
  type CampaignVariableSourceConfig,
} from "@icecore/scenario-contracts";
import {
  CampaignVariableMapper,
  type CampaignVariableMapperProps,
} from "@/components/campaigns/CampaignVariableMapper";
import { CsvUpload } from "./csv-upload";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

export type CampaignRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  sourceId?: string | null;
  birthday?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

type CampaignRecipientPickerChannel = "whatsapp" | "telegram" | "email";
export type CampaignRecipientPickerMode = "upload" | "manual" | "select";
export type CampaignRecipientPickerAudienceSource =
  | "manual"
  | "registered_users";

export type CampaignUploadedAudience = {
  recipients: CampaignRecipient[];
  uploadEvidence: BulkCampaignAudienceUploadEvidence | null;
};

type RegisteredUsersEmailAudiencePreviewRow = {
  userId: string;
  email: string;
  name?: string | null;
  registeredAt?: string | null;
  locale?: string | null;
};

type RegisteredUsersEmailAudienceSummary = {
  enabled?: boolean;
  total: number;
  totalAuthUsers: number;
  skippedUnconfirmed: number;
  skippedInvalidEmail: number;
  skippedAnonymous: number;
  skippedDuplicate: number;
  preview?: RegisteredUsersEmailAudiencePreviewRow[];
};

type Contact = {
  identifier: string | number;
  name?: string;
  channel: string;
  sourceId?: string | null;
};

export function contactMatchesCampaignAudience(
  contact: Pick<Contact, "channel" | "sourceId">,
  channel: CampaignRecipientPickerChannel,
  sourceIds: readonly string[]
): boolean {
  if (contact.channel && contact.channel !== channel) return false;
  if (sourceIds.length === 0) return true;
  const sourceId = contact.sourceId?.trim() || "";
  return sourceIds.includes(sourceId);
}

function contactIsSendableOnChannel(
  contact: Contact,
  channel: CampaignRecipientPickerChannel
): boolean {
  const recipient = contactToRecipient(contact, channel);
  return getRecipientTargetStatus(
    getRecipientIdentifier(recipient, channel),
    channel
  ).valid;
}

type RecipientLimitPreview = BulkCampaignRecipientLimit;

type CampaignRecipientPickerProps = {
  workspaceId: string;
  channel: CampaignRecipientPickerChannel;
  sourceIds?: string[];
  recipients: CampaignRecipient[];
  onRecipientsChange: (recipients: CampaignRecipient[]) => void;
  audienceUploadEvidence?: BulkCampaignAudienceUploadEvidence | null;
  onUploadedAudienceChange?: (audience: CampaignUploadedAudience) => void;
  templateVariables?: string[];
  recipientLimit?: number;
  recipientLimitMode?: "cap" | "override";
  requireBirthdayColumn?: boolean;
  onParsingChange?: (parsing: boolean) => void;
  compact?: boolean;
  mode?: CampaignRecipientPickerMode | null;
  variant?: "card" | "chat";
  disabled?: boolean;
  recipientLimitState?: {
    preview?: RecipientLimitPreview | null;
    loading?: boolean;
    error?: string | null;
  };
  variableConfigs?: Record<string, CampaignVariableSourceConfig>;
  onVariableConfigsChange?: (
    configs: Record<string, CampaignVariableSourceConfig>
  ) => void;
  showHeader?: boolean;
  showSelectedRecipientsTable?: boolean;
  showRecipientLimitAlerts?: boolean;
  variableMapperTitle?: CampaignVariableMapperProps["title"];
  variableMapperAllowedModes?: CampaignVariableMapperProps["allowedModes"];
  variableMapperModeLabels?: CampaignVariableMapperProps["modeLabels"];
  variableMapperSelectColumnPlaceholder?: CampaignVariableMapperProps["selectColumnPlaceholder"];
  variableMapperCustomValuePlaceholder?: CampaignVariableMapperProps["customValuePlaceholder"];
  audienceSource?: CampaignRecipientPickerAudienceSource;
  onAudienceSourceChange?: (
    source: CampaignRecipientPickerAudienceSource
  ) => void;
  registeredUsersAudience?: RegisteredUsersEmailAudienceSummary | null;
  selectedRegisteredUserIds?: string[];
  onSelectedRegisteredUserIdsChange?: (userIds: string[]) => void;
};

const DEFAULT_RECIPIENT_LIMIT = 1000;
const RECIPIENT_TABLE_PAGE_SIZE = 10;
const EMPTY_SOURCE_IDS: string[] = [];
const EMPTY_TEMPLATE_VARIABLES: string[] = [];
const EMPTY_VARIABLE_CONFIGS: Record<string, CampaignVariableSourceConfig> = {};
const PLACEHOLDER_CONTACT_NAMES = new Set([
  "unknown",
  "customer",
  "contact",
  ".",
  "-",
  "n/a",
  "na",
  "null",
  "undefined",
]);

function cleanRecord(
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!value) return undefined;
  const cleaned = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry.trim().length > 0)
  );
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function normalizeIdentifier(
  value: string,
  channel: CampaignRecipientPickerChannel
): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (channel === "email") return `email:${trimmed.toLowerCase()}`;
  if (channel === "whatsapp") {
    const target = getRecipientTargetStatus(trimmed, channel);
    return target.valid
      ? `whatsapp:${target.display}`
      : `invalid-whatsapp:${trimmed.toLowerCase()}`;
  }
  return trimmed;
}

function isValidEmailRecipient(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

function getRecipientTargetStatus(
  identifier: string,
  channel: CampaignRecipientPickerChannel
): {
  display: string;
  raw: string;
  valid: boolean;
} {
  const raw = identifier.trim();
  if (channel === "email") {
    const display = raw.toLowerCase();
    return {
      display,
      raw,
      valid: isValidEmailRecipient(raw),
    };
  }
  if (channel === "whatsapp") {
    const display = normalizeWhatsAppPhone(raw.replace(/^wa_/i, ""));
    return {
      display: display || raw,
      raw,
      valid: Boolean(display),
    };
  }
  return {
    display: raw,
    raw,
    valid: raw.length > 0,
  };
}

function getRecipientIdentifier(
  recipient: CampaignRecipient,
  channel: CampaignRecipientPickerChannel
): string {
  if (channel === "email") return recipient.email || "";
  if (channel === "telegram") return recipient.chatId || recipient.phone || "";
  return recipient.phone || "";
}

function getRecipientKey(
  recipient: CampaignRecipient,
  channel: CampaignRecipientPickerChannel
): string {
  return normalizeIdentifier(
    getRecipientIdentifier(recipient, channel),
    channel
  );
}

function recipientFromIdentifier(
  identifier: string,
  channel: CampaignRecipientPickerChannel
): CampaignRecipient {
  const trimmed = identifier.trim();
  if (channel === "email") return { email: trimmed.toLowerCase() };
  if (channel === "telegram") return { chatId: trimmed };
  return { phone: trimmed };
}

function getContactDisplayName(contact: Contact): string {
  const name = contact.name?.trim() || "";
  if (!name) return "";
  if (PLACEHOLDER_CONTACT_NAMES.has(name.toLowerCase())) return "";
  if (!/\p{L}/u.test(name)) return "";
  return name;
}

function getContactDisplayIdentifier(
  contact: Contact,
  channel: CampaignRecipientPickerChannel
): string {
  const identifier = String(contact.identifier || "");
  return channel === "whatsapp" && identifier.startsWith("wa_")
    ? identifier.slice(3)
    : identifier;
}

function contactToRecipient(
  contact: Contact,
  channel: CampaignRecipientPickerChannel
): CampaignRecipient {
  const identifier = String(contact.identifier || "");
  const cleanIdentifier =
    channel === "whatsapp" && identifier.startsWith("wa_")
      ? identifier.slice(3)
      : identifier;
  const name = getContactDisplayName(contact);
  const sourceId = contact.sourceId?.trim() || undefined;
  const base = {
    name: name || undefined,
    sourceId,
    fields: cleanRecord(name ? { name } : undefined),
  };
  if (channel === "email") {
    return { ...base, email: cleanIdentifier.toLowerCase() };
  }
  if (channel === "telegram") {
    return { ...base, chatId: cleanIdentifier };
  }
  return { ...base, phone: cleanIdentifier };
}

function mergeRecipient(
  current: CampaignRecipient,
  incoming: CampaignRecipient
): CampaignRecipient {
  return {
    ...current,
    ...incoming,
    name: incoming.name?.trim() || current.name,
    fields: cleanRecord({
      ...(current.fields || {}),
      ...(incoming.fields || {}),
    }),
    variables: cleanRecord({
      ...(current.variables || {}),
      ...(incoming.variables || {}),
    }),
  };
}

function mergeRecipients(
  current: CampaignRecipient[],
  incoming: CampaignRecipient[],
  channel: CampaignRecipientPickerChannel,
  limit: number,
  stats?: { merged: number }
): CampaignRecipient[] {
  const rows = [...current];
  const indexByKey = new Map<string, number>();
  rows.forEach((recipient, index) => {
    const key = getRecipientKey(recipient, channel);
    if (key) indexByKey.set(key, index);
  });

  incoming.forEach(recipient => {
    const key = getRecipientKey(recipient, channel);
    if (!key) return;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      rows[existingIndex] = mergeRecipient(rows[existingIndex], recipient);
      if (stats) stats.merged += 1;
      return;
    }
    if (rows.length >= limit) return;
    indexByKey.set(key, rows.length);
    rows.push(recipient);
  });

  return rows.slice(0, limit);
}

function getDailyRecipientLimit(params: {
  preview: RecipientLimitPreview | null;
}) {
  if (
    typeof params.preview?.maxRecipients === "number" &&
    params.preview.maxRecipients >= 0
  ) {
    return params.preview.maxRecipients;
  }
  return DEFAULT_RECIPIENT_LIMIT;
}

function getAttachRecipientLimit(params: {
  preview: RecipientLimitPreview | null;
  propLimit?: number;
  propLimitMode?: "cap" | "override";
}) {
  const propLimit =
    typeof params.propLimit === "number" && Number.isFinite(params.propLimit)
      ? Math.max(0, Math.floor(params.propLimit))
      : null;
  if (params.propLimitMode === "override" && propLimit !== null) {
    return propLimit;
  }
  if (propLimit !== null) return propLimit;
  return MAX_BULK_CAMPAIGN_RECIPIENTS;
}

function getDisplayRecipientLimit(params: {
  dailyLimit: number;
  attachLimit: number;
  preview: RecipientLimitPreview | null;
  propLimit?: number;
  propLimitMode?: "cap" | "override";
}) {
  if (params.preview?.unlimited) return params.dailyLimit;
  if (params.propLimitMode === "override") return params.attachLimit;
  if (
    typeof params.propLimit === "number" &&
    Number.isFinite(params.propLimit) &&
    params.propLimit < params.dailyLimit
  ) {
    return Math.max(0, Math.floor(params.propLimit));
  }
  return params.dailyLimit;
}

function getRecipientLimit(params: {
  channel: CampaignRecipientPickerChannel;
  preview: RecipientLimitPreview | null;
  propLimit?: number;
  propLimitMode?: "cap" | "override";
}) {
  const dailyLimit = getDailyRecipientLimit({
    preview: params.preview,
  });
  const attachLimit = getAttachRecipientLimit(params);
  return getDisplayRecipientLimit({
    dailyLimit,
    attachLimit,
    preview: params.preview,
    propLimit: params.propLimit,
    propLimitMode: params.propLimitMode,
  });
}

function renameRecipientFieldKey(
  fields: Record<string, string> | undefined,
  fromColumn: string,
  toColumn: string
): Record<string, string> | undefined {
  if (!fields) return undefined;
  const next: Record<string, string> = {};

  Object.entries(fields).forEach(([key, value]) => {
    const targetKey = key === fromColumn ? toColumn : key;
    if (!targetKey) return;
    if (!next[targetKey] || !next[targetKey].trim()) {
      next[targetKey] = value;
    }
  });

  return cleanRecord(next);
}

export function CampaignRecipientPicker({
  workspaceId,
  channel,
  sourceIds = EMPTY_SOURCE_IDS,
  recipients,
  onRecipientsChange,
  audienceUploadEvidence,
  onUploadedAudienceChange,
  templateVariables = EMPTY_TEMPLATE_VARIABLES,
  recipientLimit,
  recipientLimitMode = "cap",
  requireBirthdayColumn = false,
  onParsingChange,
  compact = false,
  mode,
  variant = "card",
  disabled = false,
  recipientLimitState,
  variableConfigs = EMPTY_VARIABLE_CONFIGS,
  onVariableConfigsChange,
  showHeader = true,
  showSelectedRecipientsTable = true,
  showRecipientLimitAlerts = true,
  variableMapperTitle,
  variableMapperAllowedModes,
  variableMapperModeLabels,
  variableMapperSelectColumnPlaceholder,
  variableMapperCustomValuePlaceholder,
  audienceSource = "manual",
  onAudienceSourceChange,
  registeredUsersAudience = null,
  selectedRegisteredUserIds,
  onSelectedRegisteredUserIdsChange,
}: CampaignRecipientPickerProps) {
  const t = useTranslations("CampaignRecipientPicker");
  const [parsingUpload, setParsingUpload] = useState(false);
  const [quickRecipient, setQuickRecipient] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [loadingContacts, setLoadingContacts] = useState(false);
  const contactsRequestId = useRef(0);
  const hasLoadedContacts = useRef(false);
  const [internalRecipientLimitPreview, setInternalRecipientLimitPreview] =
    useState<RecipientLimitPreview | null>(null);
  const [internalLoadingRecipientLimit, setInternalLoadingRecipientLimit] =
    useState(false);
  const [internalRecipientLimitError, setInternalRecipientLimitError] =
    useState<string | null>(null);
  const [recipientPage, setRecipientPage] = useState(1);
  const [registeredUserQuery, setRegisteredUserQuery] = useState("");
  const [showSelectedRegisteredUsersOnly, setShowSelectedRegisteredUsersOnly] =
    useState(false);
  const [uploadMerge, setUploadMerge] = useState<{
    evidence: BulkCampaignAudienceUploadEvidence;
    merged: number;
  } | null>(null);
  const sourceIdsKey = useMemo(
    () =>
      Array.from(
        new Set(sourceIds.map(item => item.trim()).filter(Boolean))
      ).join(","),
    [sourceIds]
  );
  const normalizedSourceIds = useMemo(
    () => (sourceIdsKey ? sourceIdsKey.split(",") : []),
    [sourceIdsKey]
  );

  const isChatVariant = variant === "chat";
  const recipientLimitPreview = recipientLimitState
    ? (recipientLimitState.preview ?? null)
    : internalRecipientLimitPreview;
  const loadingRecipientLimit = recipientLimitState
    ? Boolean(recipientLimitState.loading)
    : internalLoadingRecipientLimit;
  const recipientLimitError = recipientLimitState
    ? (recipientLimitState.error ?? null)
    : internalRecipientLimitError;
  const effectiveRecipientLimit = getRecipientLimit({
    channel,
    preview: recipientLimitPreview,
    propLimit: recipientLimit,
    propLimitMode: recipientLimitMode,
  });
  const attachRecipientLimit = getAttachRecipientLimit({
    preview: recipientLimitPreview,
    propLimit: recipientLimit,
    propLimitMode: recipientLimitMode,
  });
  const dailyRecipientLimit = getDailyRecipientLimit({
    preview: recipientLimitPreview,
  });
  const recipientLimitReady =
    channel !== "whatsapp" ||
    loadingRecipientLimit ||
    (!recipientLimitError && effectiveRecipientLimit > 0);
  const canAcceptUpload = !disabled && recipientLimitReady;
  const canEditRecipients = canAcceptUpload && !parsingUpload;
  const handleParsingChange = useCallback(
    (parsing: boolean) => {
      setParsingUpload(parsing);
      onParsingChange?.(parsing);
    },
    [onParsingChange]
  );
  const hasRegisteredUsersAudience =
    channel === "email" &&
    Boolean(
      registeredUsersAudience &&
        registeredUsersAudience.enabled !== false &&
        registeredUsersAudience.total > 0
    );
  const effectiveAudienceSource = hasRegisteredUsersAudience
    ? audienceSource
    : "manual";
  const usingRegisteredUsersAudience =
    effectiveAudienceSource === "registered_users";
  const registeredUserRows = useMemo(
    () =>
      (registeredUsersAudience?.preview || []).filter(row =>
        Boolean(row.userId)
      ),
    [registeredUsersAudience?.preview]
  );
  const registeredUserRowIds = useMemo(
    () => registeredUserRows.map(row => row.userId),
    [registeredUserRows]
  );
  const registeredSelectedIds = useMemo(
    () =>
      new Set(
        (selectedRegisteredUserIds
          ? selectedRegisteredUserIds
          : registeredUserRowIds
        ).filter(Boolean)
      ),
    [registeredUserRowIds, selectedRegisteredUserIds]
  );
  const registeredUserFilter = registeredUserQuery.trim().toLowerCase();
  const filteredRegisteredUserRows = useMemo(() => {
    return registeredUserRows.filter(row => {
      if (
        showSelectedRegisteredUsersOnly &&
        !registeredSelectedIds.has(row.userId)
      ) {
        return false;
      }
      if (!registeredUserFilter) return true;
      return `${row.email} ${row.name || ""}`
        .toLowerCase()
        .includes(registeredUserFilter);
    });
  }, [
    registeredSelectedIds,
    registeredUserFilter,
    registeredUserRows,
    showSelectedRegisteredUsersOnly,
  ]);
  const selectedRegisteredUserCount = registeredSelectedIds.size;
  const filteredRegisteredUsersAllSelected =
    filteredRegisteredUserRows.length > 0 &&
    filteredRegisteredUserRows.every(row =>
      registeredSelectedIds.has(row.userId)
    );
  const filteredRegisteredUsersSomeSelected = filteredRegisteredUserRows.some(
    row => registeredSelectedIds.has(row.userId)
  );
  const selectedColumns = useMemo(
    () =>
      collectCampaignRecipientColumns(recipients).filter(
        column => !["name", "full_name", "first_name"].includes(column)
      ),
    [recipients]
  );
  const exactMatchableColumns = useMemo(() => {
    const hasName = recipients.some(recipient => Boolean(recipient.name));
    return new Set(hasName ? ["name", ...selectedColumns] : selectedColumns);
  }, [recipients, selectedColumns]);
  const matchedTemplateVariables = useMemo(
    () =>
      new Set(
        templateVariables.filter(variable =>
          exactMatchableColumns.has(variable)
        )
      ),
    [exactMatchableColumns, templateVariables]
  );
  const showQuickAdd =
    !usingRegisteredUsersAudience &&
    (mode === "manual" || (!mode && !compact));
  const showUpload =
    !usingRegisteredUsersAudience && (!mode || mode === "upload");
  const showContacts =
    !usingRegisteredUsersAudience &&
    (mode === "select" || (!mode && !compact));
  const showRecipientEntry = showQuickAdd || showUpload;
  const useSplitRecipientLayout =
    showRecipientEntry && showContacts && !compact;
  const hasControlledUpload =
    onUploadedAudienceChange !== undefined ||
    audienceUploadEvidence !== undefined;
  // The file card shows the count, so the attached row would repeat it.
  const showsUploadedFileCard =
    showUpload &&
    hasControlledUpload &&
    Boolean(audienceUploadEvidence?.originalFilename);
  const mergedDuplicateCount =
    uploadMerge &&
    audienceUploadEvidence?.originalFilename ===
      uploadMerge.evidence.originalFilename &&
    audienceUploadEvidence?.selectedAt === uploadMerge.evidence.selectedAt
      ? uploadMerge.merged
      : 0;

  const publishRecipientAudience = useCallback(
    (
      nextRecipients: CampaignRecipient[],
      uploadEvidence: BulkCampaignAudienceUploadEvidence | null
    ) => {
      const cappedRecipients =
        nextRecipients.length > attachRecipientLimit
          ? nextRecipients.slice(0, attachRecipientLimit)
          : nextRecipients;
      if (onUploadedAudienceChange) {
        onUploadedAudienceChange({
          recipients: cappedRecipients,
          uploadEvidence,
        });
        return;
      }
      onRecipientsChange(cappedRecipients);
    },
    [attachRecipientLimit, onRecipientsChange, onUploadedAudienceChange]
  );

  const clearCurrentFileEvidence = useCallback(() => {
    if (!audienceUploadEvidence?.originalFilename) {
      return audienceUploadEvidence ?? null;
    }
    const replacementHistory = [
      ...(audienceUploadEvidence.replacementHistory || []),
      {
        action: "cleared" as const,
        replacedAt: new Date().toISOString(),
        previousFilename: audienceUploadEvidence.originalFilename,
      },
    ].slice(-BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT);
    return { replacementHistory };
  }, [audienceUploadEvidence]);

  const publishManualRecipientChange = useCallback(
    (nextRecipients: CampaignRecipient[]) => {
      publishRecipientAudience(nextRecipients, clearCurrentFileEvidence());
    },
    [clearCurrentFileEvidence, publishRecipientAudience]
  );

  // Clearing wipes the whole list in one click, so offer it back. Undo puts
  // back the exact list and file record into the audience it was cleared
  // from (workspace, channel and numbers or bots), while that list is still
  // empty. The picker stays mounted when the audience changes, so the offer
  // is withdrawn as soon as it can't apply.
  const undoAudienceKey = [
    workspaceId,
    channel,
    [...normalizedSourceIds].sort().join(","),
  ].join("|");
  const undoClearRef = useLatestRef({
    recipients,
    canEditRecipients,
    publishRecipientAudience,
    audienceKey: undoAudienceKey,
  });
  const pendingUndoClearRef = useRef<{
    toastId: string | number;
    recipients: CampaignRecipient[];
    uploadEvidence: BulkCampaignAudienceUploadEvidence | null;
    audienceKey: string;
  } | null>(null);
  const withdrawUndoClear = useCallback(() => {
    const pending = pendingUndoClearRef.current;
    pendingUndoClearRef.current = null;
    if (pending) toast.dismiss(pending.toastId);
  }, []);
  useEffect(() => withdrawUndoClear, [withdrawUndoClear]);
  useEffect(() => {
    const pending = pendingUndoClearRef.current;
    if (!pending) return;
    // Before the parent applies the clear it still passes the cleared list.
    const listChanged =
      recipients.length > 0 && recipients !== pending.recipients;
    if (
      listChanged ||
      !canEditRecipients ||
      pending.audienceKey !== undoAudienceKey
    ) {
      withdrawUndoClear();
    }
  }, [canEditRecipients, recipients, undoAudienceKey, withdrawUndoClear]);
  const clearRecipientsWithUndo = useCallback(() => {
    const cleared = {
      recipients,
      uploadEvidence: audienceUploadEvidence ?? null,
      audienceKey: undoAudienceKey,
    };
    publishManualRecipientChange([]);
    if (cleared.recipients.length === 0) return;
    // Only the latest clear can be undone.
    withdrawUndoClear();
    const forget = () => {
      if (pendingUndoClearRef.current?.recipients === cleared.recipients) {
        pendingUndoClearRef.current = null;
      }
    };
    const toastId = toast(
      t("recipient.clearedToast", { count: cleared.recipients.length }),
      {
        duration: SCENARIO_UNDO_TOAST_DURATION_MS,
        onAutoClose: forget,
        onDismiss: forget,
        action: {
          label: t("recipient.undoClear"),
          onClick: () => {
            forget();
            const current = undoClearRef.current;
            if (
              !current.canEditRecipients ||
              current.recipients.length > 0 ||
              current.audienceKey !== cleared.audienceKey
            ) {
              return;
            }
            current.publishRecipientAudience(
              cleared.recipients,
              cleared.uploadEvidence
            );
          },
        },
      }
    );
    pendingUndoClearRef.current = { ...cleared, toastId };
  }, [
    audienceUploadEvidence,
    publishManualRecipientChange,
    recipients,
    t,
    undoAudienceKey,
    undoClearRef,
    withdrawUndoClear,
  ]);

  const appendRecipients = useCallback(
    (incoming: CampaignRecipient[]) => {
      if (!canEditRecipients) return;
      publishManualRecipientChange(
        mergeRecipients(recipients, incoming, channel, attachRecipientLimit)
      );
    },
    [
      canEditRecipients,
      channel,
      attachRecipientLimit,
      publishManualRecipientChange,
      recipients,
    ]
  );

  const handleUploadedAudienceChange = useCallback(
    (
      uploadedAudience: {
        recipients: CampaignRecipient[];
        uploadEvidence: BulkCampaignAudienceUploadEvidence;
      } | null
    ) => {
      if (!canAcceptUpload) return;
      if (!uploadedAudience) {
        clearRecipientsWithUndo();
        return;
      }
      const mergeStats = { merged: 0 };
      const nextRecipients = mergeRecipients(
        [],
        uploadedAudience.recipients,
        channel,
        attachRecipientLimit,
        mergeStats
      );
      setUploadMerge({
        evidence: uploadedAudience.uploadEvidence,
        merged: mergeStats.merged,
      });
      const replacementHistory = [
        ...(audienceUploadEvidence?.replacementHistory || []),
        ...(audienceUploadEvidence?.originalFilename
          ? [
              {
                action: "replaced" as const,
                replacedAt:
                  uploadedAudience.uploadEvidence.selectedAt ||
                  new Date().toISOString(),
                previousFilename: audienceUploadEvidence.originalFilename,
                nextFilename: uploadedAudience.uploadEvidence.originalFilename,
              },
            ]
          : []),
      ].slice(-BULK_CAMPAIGN_AUDIENCE_REPLACEMENT_HISTORY_LIMIT);
      publishRecipientAudience(nextRecipients, {
        ...uploadedAudience.uploadEvidence,
        ...(replacementHistory.length > 0 ? { replacementHistory } : {}),
      });
    },
    [
      audienceUploadEvidence,
      canAcceptUpload,
      channel,
      attachRecipientLimit,
      clearRecipientsWithUndo,
      publishRecipientAudience,
    ]
  );

  const handleClearRecipients = () => {
    if (!canEditRecipients) return;
    clearRecipientsWithUndo();
  };

  // An uncontrolled upload reports its cleared file as an empty list.
  const handleUploadedRecipients = (nextRecipients: CampaignRecipient[]) => {
    if (nextRecipients.length === 0) clearRecipientsWithUndo();
    else publishManualRecipientChange(nextRecipients);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadContacts = useCallback(async () => {
    if (!showContacts || !workspaceId) return;
    const requestId = contactsRequestId.current + 1;
    contactsRequestId.current = requestId;
    if (!hasLoadedContacts.current) setLoadingContacts(true);
    try {
      const params = new URLSearchParams({
        workspaceId,
        channel,
        search: debouncedQuery,
        limit: "50",
      });
      if (sourceIdsKey) {
        params.set("sourceIds", sourceIdsKey);
      }
      const response = await fetch(`/api/contacts?${params.toString()}`);
      const data = (await response.json().catch(() => null)) as {
        contacts?: Contact[];
        items?: Contact[];
        data?: Contact[];
      } | null;
      const rows = Array.isArray(data?.contacts)
        ? data.contacts
        : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.data)
            ? data.data
            : [];
      if (requestId !== contactsRequestId.current) return;
      setContacts(
        rows.filter(
          contact =>
            contactMatchesCampaignAudience(
              contact,
              channel,
              normalizedSourceIds
            ) && contactIsSendableOnChannel(contact, channel)
        )
      );
      hasLoadedContacts.current = true;
    } catch {
      if (requestId !== contactsRequestId.current) return;
      setContacts([]);
    } finally {
      if (requestId === contactsRequestId.current) {
        setLoadingContacts(false);
      }
    }
  }, [
    channel,
    debouncedQuery,
    normalizedSourceIds,
    showContacts,
    sourceIdsKey,
    workspaceId,
  ]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    if (effectiveAudienceSource === "registered_users") {
      if (recipients.length > 0) publishManualRecipientChange([]);
      return;
    }
    if (audienceSource === "registered_users" && !hasRegisteredUsersAudience) {
      onAudienceSourceChange?.("manual");
    }
  }, [
    audienceSource,
    effectiveAudienceSource,
    hasRegisteredUsersAudience,
    onAudienceSourceChange,
    publishManualRecipientChange,
    recipients.length,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadRecipientLimit() {
      if (recipientLimitState) return;
      if (!workspaceId) {
        setInternalRecipientLimitPreview({
          maxRecipients: DEFAULT_RECIPIENT_LIMIT,
          rawLimit: String(DEFAULT_RECIPIENT_LIMIT),
          source: "channel_default",
        });
        return;
      }

      setInternalLoadingRecipientLimit(channel === "whatsapp");
      setInternalRecipientLimitError(null);
      try {
        const params = new URLSearchParams({ workspaceId, channel });
        const response = await fetch(
          `/api/campaigns/batch-plan?${params.toString()}`
        );
        const data = (await response.json().catch(() => null)) as {
          configured?: boolean;
          recipientLimit?: RecipientLimitPreview;
          error?: string;
        } | null;
        if (cancelled) return;

        if (!response.ok || data?.configured === false) {
          setInternalRecipientLimitPreview(null);
          setInternalRecipientLimitError(
            data?.error || "Recipient limit is unavailable for this channel."
          );
          return;
        }

        setInternalRecipientLimitPreview(
          data?.recipientLimit || {
            maxRecipients: DEFAULT_RECIPIENT_LIMIT,
            rawLimit: String(DEFAULT_RECIPIENT_LIMIT),
            source: "channel_default",
          }
        );
      } catch (error) {
        if (cancelled) return;
        setInternalRecipientLimitPreview(null);
        setInternalRecipientLimitError(
          error instanceof Error
            ? error.message
            : "Recipient limit lookup failed."
        );
      } finally {
        if (!cancelled) setInternalLoadingRecipientLimit(false);
      }
    }

    void loadRecipientLimit();

    return () => {
      cancelled = true;
    };
  }, [channel, recipientLimitState, workspaceId]);

  const handleQuickAdd = () => {
    const identifier = quickRecipient.trim();
    if (!identifier) return;
    appendRecipients([recipientFromIdentifier(identifier, channel)]);
    setQuickRecipient("");
  };

  const handleAddVisibleContacts = () => {
    appendRecipients(
      contacts.map(contact => contactToRecipient(contact, channel))
    );
  };

  const handleRemoveRecipient = (recipient: CampaignRecipient) => {
    if (!canEditRecipients) return;
    const removeKey = getRecipientKey(recipient, channel);
    publishManualRecipientChange(
      recipients.filter(row => getRecipientKey(row, channel) !== removeKey)
    );
  };

  const commitRegisteredUserSelection = (nextIds: Set<string>) => {
    onSelectedRegisteredUserIdsChange?.(
      registeredUserRowIds.filter(id => nextIds.has(id))
    );
  };

  const selectRegisteredUserIds = (ids: string[]) => {
    const next = new Set(registeredSelectedIds);
    ids.forEach(id => next.add(id));
    commitRegisteredUserSelection(next);
  };

  const deselectRegisteredUserIds = (ids: string[]) => {
    const next = new Set(registeredSelectedIds);
    ids.forEach(id => next.delete(id));
    commitRegisteredUserSelection(next);
  };

  const toggleRegisteredUser = (userId: string, checked: boolean) => {
    if (checked) {
      selectRegisteredUserIds([userId]);
    } else {
      deselectRegisteredUserIds([userId]);
    }
  };

  const handleRenameColumn = (fromColumn: string, nextColumnValue: string) => {
    if (!canEditRecipients) return;
    const toColumn = nextColumnValue.trim();
    if (!toColumn || toColumn === fromColumn) return;

    publishManualRecipientChange(
      recipients.map(recipient => ({
        ...recipient,
        fields: renameRecipientFieldKey(recipient.fields, fromColumn, toColumn),
      }))
    );

    const updatedConfigs = Object.fromEntries(
      Object.entries(variableConfigs).map(([variable, config]) => [
        variable,
        config.csvColumn === fromColumn
          ? { ...config, csvColumn: toColumn }
          : config,
      ])
    );
    if (
      Object.values(variableConfigs).some(
        config => config.csvColumn === fromColumn
      )
    ) {
      onVariableConfigsChange?.(updatedConfigs);
    }
  };

  const recipientLimitLabel = loadingRecipientLimit
    ? "..."
    : recipientLimitPreview?.unlimited
      ? t("recipient.unlimited")
      : String(effectiveRecipientLimit);
  const recipientPageCount = Math.max(
    1,
    Math.ceil(recipients.length / RECIPIENT_TABLE_PAGE_SIZE)
  );
  const currentRecipientPage = Math.min(recipientPage, recipientPageCount);
  const pagedRecipients = recipients.slice(
    (currentRecipientPage - 1) * RECIPIENT_TABLE_PAGE_SIZE,
    currentRecipientPage * RECIPIENT_TABLE_PAGE_SIZE
  );
  const showRecipientPagination = recipients.length > RECIPIENT_TABLE_PAGE_SIZE;

  useEffect(() => {
    if (recipientPage <= recipientPageCount) return;
    setRecipientPage(recipientPageCount);
  }, [recipientPage, recipientPageCount]);

  return (
    <div
      className={
        isChatVariant
          ? "space-y-3"
          : `rounded-lg border bg-background ${compact ? "p-2.5" : "p-4"}`
      }
    >
      {showHeader ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">{t("recipient.title")}</div>
          <div className="text-xs text-muted-foreground">
            {t("recipient.selectedCount", {
              selected: usingRegisteredUsersAudience
                ? selectedRegisteredUserCount
                : recipients.length,
              limit: recipientLimitLabel,
            })}
          </div>
        </div>
      ) : null}

      {showRecipientLimitAlerts &&
      !loadingRecipientLimit &&
      !recipientLimitPreview?.unlimited &&
      dailyRecipientLimit > 0 &&
      (usingRegisteredUsersAudience
        ? selectedRegisteredUserCount
        : recipients.length) > dailyRecipientLimit ? (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {t("recipient.overflowQueueHint", {
            count: usingRegisteredUsersAudience
              ? selectedRegisteredUserCount
              : recipients.length,
            limit: dailyRecipientLimit,
          })}
        </div>
      ) : null}

      {showRecipientLimitAlerts &&
      channel === "whatsapp" &&
      !loadingRecipientLimit &&
      (recipientLimitError ||
        recipientLimitPreview?.error ||
        recipientLimitPreview?.warning) ? (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          {recipientLimitError ||
            recipientLimitPreview?.error ||
            recipientLimitPreview?.warning}
        </div>
      ) : null}

      {isChatVariant &&
      !usingRegisteredUsersAudience &&
      !showsUploadedFileCard &&
      recipients.length > 0 ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium">
            {t("recipient.attachedCount", { count: recipients.length })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={handleClearRecipients}
            disabled={!canEditRecipients}
          >
            {t("recipient.clearAll")}
          </Button>
        </div>
      ) : null}

      {hasRegisteredUsersAudience ? (
        <div className="mb-3 rounded-lg bg-muted/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant={
                effectiveAudienceSource === "manual" ? "default" : "outline"
              }
              onClick={() => onAudienceSourceChange?.("manual")}
              disabled={disabled}
              className="justify-start"
            >
              Build custom list
            </Button>
            <Button
              type="button"
              variant={
                effectiveAudienceSource === "registered_users"
                  ? "default"
                  : "outline"
              }
              onClick={() => onAudienceSourceChange?.("registered_users")}
              disabled={disabled}
              className="justify-start"
            >
              Registered app users
            </Button>
          </div>
        </div>
      ) : null}

      {usingRegisteredUsersAudience ? (
        <div className="space-y-3 rounded-lg bg-muted/10 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">
                Registered users preview
              </div>
              <p className="text-xs text-muted-foreground">
                Server resolves the full eligible audience when the campaign is
                sent.
              </p>
            </div>
            <div className="rounded-md bg-background px-3 py-2 text-sm font-medium">
              {selectedRegisteredUserCount} selected /{" "}
              {registeredUsersAudience?.total ?? 0} eligible users
            </div>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-4">
            <div className="rounded-md bg-background px-3 py-2">
              <div className="text-muted-foreground">Auth users</div>
              <div className="font-medium">
                {registeredUsersAudience?.totalAuthUsers ?? 0}
              </div>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <div className="text-muted-foreground">Unconfirmed</div>
              <div className="font-medium">
                {registeredUsersAudience?.skippedUnconfirmed ?? 0}
              </div>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <div className="text-muted-foreground">Invalid email</div>
              <div className="font-medium">
                {registeredUsersAudience?.skippedInvalidEmail ?? 0}
              </div>
            </div>
            <div className="rounded-md bg-background px-3 py-2">
              <div className="text-muted-foreground">Duplicates</div>
              <div className="font-medium">
                {registeredUsersAudience?.skippedDuplicate ?? 0}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-lg bg-background p-2 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-2.5 size-4 text-muted-foreground" />
                <Input
                  value={registeredUserQuery}
                  onChange={event => setRegisteredUserQuery(event.target.value)}
                  placeholder="Filter by name or email"
                  aria-label="Filter registered users"
                  className="h-9 pl-8"
                />
              </div>
              <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Checkbox
                  checked={showSelectedRegisteredUsersOnly}
                  onCheckedChange={checked =>
                    setShowSelectedRegisteredUsersOnly(checked === true)
                  }
                  aria-label="Show selected registered users only"
                />
                Selected only
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectRegisteredUserIds(registeredUserRowIds)}
                disabled={disabled || registeredUserRowIds.length === 0}
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  selectRegisteredUserIds(
                    filteredRegisteredUserRows.map(row => row.userId)
                  )
                }
                disabled={disabled || filteredRegisteredUserRows.length === 0}
              >
                Select shown
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  deselectRegisteredUserIds(
                    filteredRegisteredUserRows.map(row => row.userId)
                  )
                }
                disabled={disabled || filteredRegisteredUserRows.length === 0}
              >
                Deselect shown
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSelectedRegisteredUserIdsChange?.([])}
                disabled={disabled || selectedRegisteredUserCount === 0}
              >
                Deselect all
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-background">
            <Table
              aria-label="Registered users selection"
              className="min-w-[760px]"
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        filteredRegisteredUsersAllSelected
                          ? true
                          : filteredRegisteredUsersSomeSelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={checked => {
                        const ids = filteredRegisteredUserRows.map(
                          row => row.userId
                        );
                        if (checked === true) {
                          selectRegisteredUserIds(ids);
                        } else {
                          deselectRegisteredUserIds(ids);
                        }
                      }}
                      aria-label="Select visible registered users"
                      disabled={
                        disabled || filteredRegisteredUserRows.length === 0
                      }
                    />
                  </TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRegisteredUserRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      No registered users match the current filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRegisteredUserRows.map(row => (
                    <TableRow
                      key={row.userId}
                      data-state={
                        registeredSelectedIds.has(row.userId)
                          ? "selected"
                          : undefined
                      }
                    >
                      <TableCell>
                        <Checkbox
                          checked={registeredSelectedIds.has(row.userId)}
                          onCheckedChange={checked =>
                            toggleRegisteredUser(row.userId, checked === true)
                          }
                          aria-label={`Select ${row.email}`}
                          disabled={disabled}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs break-all">
                        {row.email}
                      </TableCell>
                      <TableCell>{row.name || ""}</TableCell>
                      <TableCell>
                        {row.registeredAt
                          ? new Date(row.registeredAt).toLocaleDateString()
                          : ""}
                      </TableCell>
                      <TableCell>Registered app user</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            useSplitRecipientLayout
              ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]"
              : "space-y-3"
          )}
        >
          {showRecipientEntry ? (
            <div className="space-y-3">
              {showQuickAdd ? (
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-recipient-quick-add">
                    {t("recipient.quickAddLabel")}
                  </Label>
                  <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                    <Input
                      id="campaign-recipient-quick-add"
                      value={quickRecipient}
                      onChange={event => setQuickRecipient(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleQuickAdd();
                        }
                      }}
                      disabled={!canEditRecipients}
                      placeholder={
                        channel === "email"
                          ? t("recipient.emailPlaceholder")
                          : channel === "telegram"
                            ? t("recipient.telegramPlaceholder")
                            : t("recipient.whatsappPlaceholder")
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      onClick={handleQuickAdd}
                      disabled={!canEditRecipients || !quickRecipient.trim()}
                      aria-label={t("recipient.addRecipient")}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : null}

              {showUpload ? (
                <div className="space-y-2">
                  {!isChatVariant &&
                  !showsUploadedFileCard &&
                  recipients.length > 0 ? (
                    <div className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5 text-xs">
                      <span className="font-medium">
                        {t("recipient.attachedCount", {
                          count: recipients.length,
                        })}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={handleClearRecipients}
                        disabled={!canEditRecipients}
                      >
                        {t("recipient.clearAll")}
                      </Button>
                    </div>
                  ) : null}
                  <CsvUpload
                    channel={channel}
                    onRecipientsLoaded={handleUploadedRecipients}
                    {...(hasControlledUpload
                      ? {
                          uploadedAudienceEvidence:
                            audienceUploadEvidence ?? null,
                          uploadedRecipientCount: recipients.length,
                          mergedDuplicateCount,
                          onUploadedAudienceChange:
                            handleUploadedAudienceChange,
                        }
                      : {})}
                    onParsingChange={handleParsingChange}
                    compact
                    templateVariables={templateVariables}
                    recipientLimit={attachRecipientLimit || undefined}
                    requireBirthdayColumn={requireBirthdayColumn}
                    disabled={!canEditRecipients}
                    dropzone
                    variant="plain"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {showContacts ? (
            <div
              className={cn(
                "rounded-lg border bg-muted/20",
                isChatVariant ? "nowheel p-2" : "p-3"
              )}
            >
              <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-medium">
                  {t("recipient.contactsTitle")}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAddVisibleContacts}
                  disabled={!canEditRecipients || contacts.length === 0}
                  className={cn(
                    "h-8 shrink-0 px-2.5",
                    isChatVariant && "h-7 px-2 text-[11px]"
                  )}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {t("recipient.addShownContacts")}
                </Button>
              </div>
              <div className="relative mb-2 min-w-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    setDebouncedQuery(query);
                  }}
                  placeholder={t("recipient.searchContacts")}
                  className="h-9 pl-8 pr-9"
                  aria-label={t("recipient.searchContacts")}
                />
                {loadingContacts ? (
                  <Loader2
                    className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
              <ScrollArea
                className={cn(
                  "rounded-md bg-background/60",
                  contacts.length > 0 && (isChatVariant ? "h-40" : "h-52")
                )}
              >
                {loadingContacts && contacts.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">
                    {t("recipient.loadingContacts")}
                  </div>
                ) : contacts.length === 0 ? (
                  <div
                    className={cn(
                      "p-3 text-muted-foreground",
                      channel === "telegram"
                        ? "text-xs leading-snug"
                        : "text-sm"
                    )}
                  >
                    {channel === "telegram"
                      ? t("recipient.noTelegramContacts")
                      : t("recipient.noContacts")}
                  </div>
                ) : (
                  <div className="divide-y pb-1">
                    {contacts.map(contact => {
                      const recipient = contactToRecipient(contact, channel);
                      const displayName = getContactDisplayName(contact);
                      const displayIdentifier = getContactDisplayIdentifier(
                        contact,
                        channel
                      );
                      const selected = recipients.some(
                        row =>
                          getRecipientKey(row, channel) ===
                          getRecipientKey(recipient, channel)
                      );
                      return (
                        <button
                          key={`${contact.channel}-${contact.identifier}`}
                          type="button"
                          className={cn(
                            "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50",
                            selected && "bg-primary/10"
                          )}
                          onClick={() => appendRecipients([recipient])}
                          disabled={!canEditRecipients}
                        >
                          <span className="min-w-0 truncate font-medium">
                            {displayName || displayIdentifier}
                          </span>
                          {displayName ? (
                            <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                              {displayIdentifier}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>
          ) : null}
        </div>
      )}

      {channel === "whatsapp" ? (
        <CampaignVariableMapper
          recipients={recipients}
          templateVariables={templateVariables}
          variableConfigs={variableConfigs}
          onVariableConfigsChange={configs =>
            onVariableConfigsChange?.(configs)
          }
          compact={compact}
          title={variableMapperTitle}
          allowedModes={variableMapperAllowedModes}
          modeLabels={variableMapperModeLabels}
          selectColumnPlaceholder={variableMapperSelectColumnPlaceholder}
          customValuePlaceholder={variableMapperCustomValuePlaceholder}
        />
      ) : null}

      {showSelectedRecipientsTable && recipients.length > 0 ? (
        <div className="mt-4 space-y-3">
          <div className="overflow-x-auto rounded-lg border bg-muted/10">
            <Table
              aria-label={t("recipient.selectedTable")}
              className={
                selectedColumns.length > 0 || channel === "email"
                  ? "min-w-[720px]"
                  : "min-w-full"
              }
            >
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {channel === "email"
                      ? "Email validity"
                      : t("recipient.identifier")}
                  </TableHead>
                  <TableHead>{t("recipient.name")}</TableHead>
                  {channel === "email" ? (
                    <TableHead>Source / fields</TableHead>
                  ) : null}
                  {selectedColumns.map((column, index) => (
                    <TableHead key={`${index}-${column}`}>
                      <Input
                        value={column}
                        disabled={!canEditRecipients}
                        onChange={event =>
                          handleRenameColumn(column, event.target.value)
                        }
                        aria-label={t("recipient.renameColumn", { column })}
                        className={cn(
                          "h-8 min-w-32 border-0 bg-transparent px-1 font-medium shadow-none focus-visible:ring-1",
                          matchedTemplateVariables.has(column) &&
                            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        )}
                      />
                    </TableHead>
                  ))}
                  <TableHead className="sticky right-0 z-20 w-12 bg-muted/10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRecipients.map(recipient => {
                  const identifier = getRecipientIdentifier(recipient, channel);
                  const targetStatus = getRecipientTargetStatus(
                    identifier,
                    channel
                  );
                  const displayIdentifier =
                    channel === "whatsapp" &&
                    targetStatus.raw === `+${targetStatus.display}`
                      ? targetStatus.raw
                      : targetStatus.display;
                  return (
                    <TableRow key={getRecipientKey(recipient, channel)}>
                      <TableCell
                        className={cn(
                          "font-mono text-xs",
                          targetStatus.valid
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                        )}
                      >
                        <div className="break-all">{displayIdentifier}</div>
                        {channel === "email" ? (
                          <div className="mt-0.5 text-[11px] opacity-70">
                            {targetStatus.valid
                              ? "Valid email"
                              : "Invalid email"}
                          </div>
                        ) : null}
                        {targetStatus.raw &&
                        targetStatus.raw !== displayIdentifier ? (
                          <div className="mt-0.5 break-all text-[11px] opacity-70">
                            {targetStatus.raw}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{recipient.name || ""}</TableCell>
                      {channel === "email" ? (
                        <TableCell className="text-xs text-muted-foreground">
                          {selectedColumns.length > 0
                            ? selectedColumns.join(", ")
                            : recipient.variables
                              ? Object.keys(recipient.variables).join(", ")
                              : "Manual"}
                        </TableCell>
                      ) : null}
                      {selectedColumns.map(column => (
                        <TableCell key={column}>
                          {recipient.fields?.[column] || ""}
                        </TableCell>
                      ))}
                      <TableCell className="sticky right-0 z-10 bg-muted/10">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t("recipient.removeRecipient")}
                          onClick={() => handleRemoveRecipient(recipient)}
                          disabled={!canEditRecipients}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {showRecipientPagination ? (
            <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <span>
                {t("recipient.pageStatus", {
                  page: currentRecipientPage,
                  total: recipientPageCount,
                })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={currentRecipientPage <= 1}
                aria-label={t("recipient.previousPage")}
                onClick={() => setRecipientPage(page => Math.max(1, page - 1))}
              >
                {t("recipient.previousPage")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={currentRecipientPage >= recipientPageCount}
                aria-label={t("recipient.nextPage")}
                onClick={() =>
                  setRecipientPage(page =>
                    Math.min(recipientPageCount, page + 1)
                  )
                }
              >
                {t("recipient.nextPage")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
