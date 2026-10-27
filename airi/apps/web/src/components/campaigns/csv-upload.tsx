"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Download, FileUp, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { BulkCampaignAudienceUploadEvidence } from "@icecore/scenario-contracts";
import {
  buildSkippedUploadRowsCsv,
  DEFAULT_RECIPIENT_LIMIT,
  isExcelRecipientUpload,
  parseCsvRecipientUpload,
  parseExcelRecipientUpload,
  type RecipientUploadMessages,
  type SkippedUploadRow,
  type UploadRecipient as Recipient,
} from "./recipient-upload-parser";

export type CsvUploadedAudience = {
  recipients: Recipient[];
  uploadEvidence: BulkCampaignAudienceUploadEvidence;
};

interface CsvUploadProps {
  onRecipientsLoaded?: (recipients: Recipient[]) => void;
  uploadedAudienceEvidence?: BulkCampaignAudienceUploadEvidence | null;
  uploadedRecipientCount?: number;
  /** Rows merged into an earlier row with the same recipient. */
  mergedDuplicateCount?: number;
  onUploadedAudienceChange?: (audience: CsvUploadedAudience | null) => void;
  onParsingChange?: (parsing: boolean) => void;
  channel?: "whatsapp" | "telegram" | "email";
  templateVariables?: string[];
  compact?: boolean;
  recipientLimit?: number;
  requireBirthdayColumn?: boolean;
  disabled?: boolean;
  dropzone?: boolean;
  variant?: "card" | "plain";
}

const EMPTY_TEMPLATE_VARIABLES: string[] = [];
const EMPTY_SKIPPED_ROWS: SkippedUploadRow[] = [];
/** Skipped rows listed on the card; the download has all of them. */
const SKIPPED_ROW_PREVIEW_LIMIT = 20;

export function CsvUpload({
  onRecipientsLoaded,
  uploadedAudienceEvidence,
  uploadedRecipientCount,
  mergedDuplicateCount = 0,
  onUploadedAudienceChange,
  onParsingChange,
  channel = "whatsapp",
  templateVariables = EMPTY_TEMPLATE_VARIABLES,
  compact = false,
  recipientLimit,
  requireBirthdayColumn = false,
  disabled = false,
  dropzone = false,
  variant = "card",
}: CsvUploadProps) {
  const t = useTranslations("CsvUpload");
  const inputId = useId();
  const effectiveRecipientLimit =
    recipientLimit && recipientLimit > 0
      ? Math.floor(recipientLimit)
      : DEFAULT_RECIPIENT_LIMIT;
  const parsingRequestId = useRef(0);
  const finishPendingParsing = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [internalFileName, setInternalFileName] = useState<string | null>(null);
  const [internalRecipientCount, setInternalRecipientCount] = useState(0);
  const [truncationNotice, setTruncationNotice] = useState<string | null>(null);
  const [skippedRows, setSkippedRows] =
    useState<SkippedUploadRow[]>(EMPTY_SKIPPED_ROWS);
  const [skippedFileName, setSkippedFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [variableMapping, setVariableMapping] = useState<
    Record<string, string>
  >({});
  const isDisabled = disabled || parsing;
  const isControlled = uploadedAudienceEvidence !== undefined;
  const fileName = isControlled
    ? uploadedAudienceEvidence?.originalFilename || null
    : internalFileName;
  const recipientCount = isControlled
    ? uploadedRecipientCount || 0
    : internalRecipientCount;

  const setParsingState = (nextParsing: boolean) => {
    finishPendingParsing.current = nextParsing
      ? () => onParsingChange?.(false)
      : null;
    setParsing(nextParsing);
    onParsingChange?.(nextParsing);
  };

  useEffect(() => {
    return () => {
      parsingRequestId.current += 1;
      // Notify the owner that started this read, then ignore its late result.
      finishPendingParsing.current?.();
      finishPendingParsing.current = null;
    };
  }, []);

  const getParserMessages = (): RecipientUploadMessages => ({
    emptyFile: t("errors.emptyFile"),
    whatsappMissingPhone: t("errors.whatsappMissingPhone"),
    whatsappInvalidPhone: row => t("errors.whatsappInvalidPhone", { row }),
    invalidCsv: t("errors.invalidCsv"),
    whatsappBirthdayMissingColumns: t("errors.whatsappBirthdayMissingColumns"),
    telegramMissingChatId: t("errors.telegramMissingChatId"),
    telegramBirthdayMissingColumns: t("errors.telegramBirthdayMissingColumns"),
    emailMissingAddress: t("errors.emailMissingAddress"),
    noValidRecipients: t("errors.noValidRecipients"),
    maxRecipientsExceeded: t("errors.maxRecipientsExceeded", {
      count: effectiveRecipientLimit,
    }),
  });

  const clearUploadedAudience = () => {
    if (!isControlled) {
      setInternalFileName(null);
      setInternalRecipientCount(0);
    }
    setTruncationNotice(null);
    setSkippedRows(EMPTY_SKIPPED_ROWS);
    setVariableMapping({});
    if (onUploadedAudienceChange) {
      onUploadedAudienceChange(null);
    } else {
      onRecipientsLoaded?.([]);
    }
  };

  const parseFile = async (file: File) => {
    const requestId = ++parsingRequestId.current;
    setError(null);
    setTruncationNotice(null);
    setSkippedRows(EMPTY_SKIPPED_ROWS);
    setParsingState(true);

    try {
      const parseOptions = {
        channel,
        templateVariables,
        recipientLimit,
        requireBirthdayColumn,
        messages: getParserMessages(),
      };
      const result = isExcelRecipientUpload(file)
        ? await parseExcelRecipientUpload(
            await file.arrayBuffer(),
            parseOptions
          )
        : parseCsvRecipientUpload(await file.text(), parseOptions);
      if (requestId !== parsingRequestId.current) return;

      setVariableMapping(result.variableMapping);
      setSkippedRows(result.skippedRows);
      setSkippedFileName(file.name);
      if (!isControlled) {
        setInternalFileName(file.name);
        setInternalRecipientCount(result.recipients.length);
      }
      setTruncationNotice(
        [
          result.hiddenRowCount > 0
            ? t("hiddenRowsSkipped", { count: result.hiddenRowCount })
            : null,
          result.truncated
            ? t("truncationNotice", {
                original: result.originalRecipientCount,
                count: result.recipients.length,
              })
            : null,
        ]
          .filter(Boolean)
          .join(" ") || null
      );
      const uploadEvidence = {
        originalFilename: file.name,
        selectedAt: new Date().toISOString(),
      };
      if (onUploadedAudienceChange) {
        onUploadedAudienceChange({
          recipients: result.recipients,
          uploadEvidence,
        });
      } else {
        onRecipientsLoaded?.(result.recipients);
      }
    } catch (err) {
      if (requestId !== parsingRequestId.current) return;
      clearUploadedAudience();
      setError(
        err instanceof Error ? err.message : t("errors.failedToParseCSV")
      );
    } finally {
      if (requestId === parsingRequestId.current) setParsingState(false);
    }
  };

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await parseFile(file);
    event.target.value = "";
  };

  const handleFileDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (isDisabled) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await parseFile(file);
  };

  const handleClear = () => {
    setError(null);
    clearUploadedAudience();
  };

  const skippedReasonLabels = {
    missing_recipient: t("skipped.reasons.missing_recipient"),
    invalid_phone: t("skipped.reasons.invalid_phone"),
    invalid_email: t("skipped.reasons.invalid_email"),
  };

  const handleDownloadSkipped = () => {
    const csv = buildSkippedUploadRowsCsv(skippedRows, {
      columns: {
        row: t("skipped.columns.row"),
        value: t("skipped.columns.value"),
        reason: t("skipped.columns.reason"),
      },
      reasons: skippedReasonLabels,
    });
    // The BOM lets Excel read Cyrillic reasons as UTF-8.
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${skippedFileName.replace(/\.[^.]+$/, "") || "recipients"}-skipped.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const fileInput = (
    <input
      id={inputId}
      type="file"
      accept=".csv,.xls,.xlsx"
      onChange={handleFileUpload}
      className="hidden"
      disabled={isDisabled}
    />
  );

  const content = (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {fileInput}
      {fileName ? (
        <div
          className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/10 p-2"
          onDragOver={event => event.preventDefault()}
          onDrop={event => void handleFileDrop(event)}
        >
          <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="block break-words text-sm">{fileName}</span>
            <span className="block text-xs text-muted-foreground">
              {t("recipientCount", { count: recipientCount })}
              {mergedDuplicateCount > 0
                ? ` · ${t("mergedDuplicates", { count: mergedDuplicateCount })}`
                : null}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={isDisabled}
            onClick={() => document.getElementById(inputId)?.click()}
          >
            {t("replaceFile")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="h-8 w-8 shrink-0 p-0"
            disabled={isDisabled}
            aria-label={t("clearFile")}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ) : dropzone ? (
        <div
          className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center transition-colors hover:bg-muted/30"
          onDragOver={event => event.preventDefault()}
          onDrop={event => void handleFileDrop(event)}
        >
          <FileUp className="mx-auto h-5 w-5 text-muted-foreground" />
          <div className="mt-2 text-sm font-medium">{t("dropzoneTitle")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("dropzoneDescription")}
          </div>
          <Button
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            className="relative mx-auto mt-3"
            disabled={isDisabled}
            onClick={() => document.getElementById(inputId)?.click()}
          >
            <FileUp className="mr-2 h-4 w-4" />
            {t("browseFile")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            className="relative"
            disabled={isDisabled}
            onClick={() => document.getElementById(inputId)?.click()}
          >
            <FileUp className="mr-2 h-4 w-4" />
            {t("uploadFile")}
          </Button>
        </div>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {fileName && skippedRows.length > 0 ? (
        <div
          role="status"
          data-testid="csv-upload-skipped-rows"
          className="min-w-0 space-y-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <div className="space-y-0.5">
            <p className="font-medium">
              {t("skipped.title", { count: skippedRows.length })}
            </p>
            <p>{t("skipped.description")}</p>
          </div>
          <ul className="space-y-0.5">
            {skippedRows.slice(0, SKIPPED_ROW_PREVIEW_LIMIT).map(row => (
              <li key={row.row} className="flex min-w-0 gap-2">
                <span className="shrink-0 tabular-nums">
                  {t("skipped.row", { row: row.row })}
                </span>
                {row.value ? (
                  <span className="min-w-0 truncate font-mono">{row.value}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-amber-800 dark:text-amber-200">
                  {skippedReasonLabels[row.reason]}
                </span>
              </li>
            ))}
          </ul>
          {skippedRows.length > SKIPPED_ROW_PREVIEW_LIMIT ? (
            <p>
              {t("skipped.more", {
                count: skippedRows.length - SKIPPED_ROW_PREVIEW_LIMIT,
              })}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={handleDownloadSkipped}
          >
            <Download data-icon="inline-start" />
            {t("skipped.download")}
          </Button>
        </div>
      ) : null}

      {truncationNotice ? (
        <Alert>
          <AlertDescription>{truncationNotice}</AlertDescription>
        </Alert>
      ) : null}

      {!fileName && (compact ? (
        <div className="whitespace-pre-line rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {channel === "whatsapp" && requireBirthdayColumn
            ? "phone,name,birthday\n+77001234567,Aibek,12.05"
            : channel === "telegram" && requireBirthdayColumn
              ? "chat_id,name,birthday\n123456,Samat,12.05"
              : channel === "whatsapp"
                ? "phone,name\n+77001234567,Aibek"
                : channel === "telegram"
                  ? "chat_id,name\n123456,Samat"
                  : "email,name\nsam@example.com,Samat"}
        </div>
      ) : (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-medium">{t("csvFormat")}</p>
          {channel === "whatsapp" ? (
            <div className="rounded bg-muted p-3 font-mono text-xs">
              {t("formatExample.whatsapp")}
            </div>
          ) : channel === "telegram" ? (
            <div className="rounded bg-muted p-3 font-mono text-xs">
              {t("formatExample.telegram")}
            </div>
          ) : (
            <div className="rounded bg-muted p-3 font-mono text-xs">
              {t("formatExample.email")}
            </div>
          )}
          <ul className="list-inside list-disc space-y-1 text-xs">
            <li>{t("requirements.firstRow")}</li>
            <li>
              {t("requirements.requiredColumn")}{" "}
              {channel === "whatsapp" ? (
                <code>{t("requirements.phone")}</code>
              ) : channel === "telegram" ? (
                <code>{t("requirements.chatId")}</code>
              ) : (
                <code>{t("requirements.email")}</code>
              )}{" "}
              {t("requirements.orEquivalent")}
            </li>
            {templateVariables.length > 0 && channel === "whatsapp" ? (
              <li className="font-medium text-orange-600">
                <strong>Required variables:</strong>{" "}
                {templateVariables.map(v => `var${v}`).join(", ")}
                (or var_1, variable1, {`\{1\}`}, etc.)
              </li>
            ) : null}
            {templateVariables.length > 0 &&
            channel === "whatsapp" &&
            Object.keys(variableMapping).length > 0 ? (
              <li className="text-xs">
                Auto-detected mappings:{" "}
                {Object.entries(variableMapping)
                  .map(([variable, column]) => `{{${variable}}} -> ${column}`)
                  .join(", ")}
              </li>
            ) : null}
            <li>{t("requirements.additionalColumns")}</li>
            <li>
              {t("requirements.maxRecipients", {
                count: effectiveRecipientLimit,
              })}
            </li>
          </ul>
        </div>
      ))}
    </div>
  );

  if (variant === "plain") {
    return content;
  }

  return (
    <Card className={compact ? "shadow-none" : undefined}>
      <CardContent className={compact ? "p-3" : "pt-6"}>{content}</CardContent>
    </Card>
  );
}
