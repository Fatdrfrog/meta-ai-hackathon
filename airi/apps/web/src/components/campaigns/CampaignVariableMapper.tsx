"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  collectCampaignRecipientColumns,
  previewCampaignAutoVariableValues,
  type CampaignRecipientLike,
} from "@/lib/campaign/campaign-variable-values";
import { cn } from "@/lib/utils";
import type {
  CampaignVariableSourceConfig,
  CampaignVariableSourceMode,
} from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

export type CampaignVariableMapperProps = {
  recipients: CampaignRecipientLike[];
  templateVariables: string[];
  variableConfigs: Record<string, CampaignVariableSourceConfig>;
  onVariableConfigsChange: (
    configs: Record<string, CampaignVariableSourceConfig>
  ) => void;
  compact?: boolean;
  title?: string;
  allowedModes?: CampaignVariableSourceMode[];
  modeLabels?: Partial<Record<CampaignVariableSourceMode, string>>;
  selectColumnPlaceholder?: string;
  customValuePlaceholder?: string;
};

const DEFAULT_ALLOWED_MODES: CampaignVariableSourceMode[] = [
  "auto",
  "contact_name",
  "recipient_phone",
  "csv_column",
  "custom",
];

export function CampaignVariableMapper({
  recipients,
  templateVariables,
  variableConfigs,
  onVariableConfigsChange,
  compact = false,
  title,
  allowedModes = DEFAULT_ALLOWED_MODES,
  modeLabels,
  selectColumnPlaceholder,
  customValuePlaceholder,
}: CampaignVariableMapperProps): ReactElement | null {
  const t = useTranslations("CampaignRecipientPicker");
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
  const variableColumnOptions = useMemo(
    () =>
      Array.from(new Set(["name", ...selectedColumns])).filter(column =>
        recipients.some(recipient => {
          if (column === "name") return Boolean(recipient.name);
          return Boolean(recipient.fields?.[column]);
        })
      ),
    [recipients, selectedColumns]
  );

  // Auto mode picks a value per row, so show what it sends: the first
  // recipient's value and how many rows without a name get their phone.
  // Scanning every row is the cost, so it reruns only when the recipients or
  // the set of auto variables change, not on each keystroke in another one.
  const autoVariablesKey = templateVariables
    .filter(variable => (variableConfigs[variable]?.mode ?? "auto") === "auto")
    .join("\u0000");
  const autoPreviews = useMemo(
    () =>
      previewCampaignAutoVariableValues({
        variables: autoVariablesKey ? autoVariablesKey.split("\u0000") : [],
        recipients,
      }),
    [autoVariablesKey, recipients]
  );

  const updateVariableConfig = useCallback(
    (variable: string, update: Partial<CampaignVariableSourceConfig>) => {
      onVariableConfigsChange({
        ...variableConfigs,
        [variable]: {
          ...(variableConfigs[variable] || { mode: "auto" }),
          ...update,
        },
      });
    },
    [onVariableConfigsChange, variableConfigs]
  );

  if (templateVariables.length === 0) return null;

  const labels: Record<CampaignVariableSourceMode, string> = {
    auto: modeLabels?.auto || t("recipient.autoFill"),
    csv_variable: modeLabels?.csv_variable || t("recipient.tableColumn"),
    csv_column: modeLabels?.csv_column || t("recipient.tableColumn"),
    contact_name: modeLabels?.contact_name || t("recipient.contactName"),
    recipient_phone:
      modeLabels?.recipient_phone || t("recipient.recipientIdentifier"),
    custom: modeLabels?.custom || t("recipient.customValue"),
  };
  const visibleModes = allowedModes.filter(
    mode => mode !== "csv_column" || variableColumnOptions.length > 0
  );

  return (
    <div
      className={cn(
        compact
          ? "space-y-2 rounded-md border bg-muted/20 p-2"
          : "mt-4 rounded-lg bg-muted/20 p-3"
      )}
    >
      <div
        className={cn(
          compact
            ? "text-[10px] uppercase text-muted-foreground"
            : "mb-3 text-sm font-medium"
        )}
      >
        {title || t("recipient.variablesTitle")}
      </div>
      <div
        className={cn("flex flex-wrap", compact ? "mb-2 gap-1" : "mb-3 gap-2")}
      >
        {templateVariables.map(variable => {
          const matched = matchedTemplateVariables.has(variable);
          return (
            <div
              key={variable}
              aria-label={t("recipient.variableMatchStatus", { variable })}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs",
                compact && "px-2 py-1 text-[11px]",
                matched
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-rose-500/10 text-rose-700 dark:text-rose-300"
              )}
            >
              <span className="font-mono">{`{{${variable}}}`}</span>
              <span>
                {matched
                  ? t("recipient.variableMatched")
                  : t("recipient.variableUnmatched")}
              </span>
            </div>
          );
        })}
      </div>
      <div
        className={cn("grid gap-3", compact ? "grid-cols-1" : "md:grid-cols-2")}
      >
        {templateVariables.map(variable => {
          const config = variableConfigs[variable] || { mode: "auto" };
          const preview = autoPreviews.get(variable);
          return (
            <div key={variable} className="space-y-2">
              <Label className={cn(compact && "text-[11px] font-mono")}>
                {`{{${variable}}}`}
              </Label>
              <Select
                value={config.mode}
                onValueChange={value =>
                  updateVariableConfig(variable, {
                    mode: value as CampaignVariableSourceMode,
                  })
                }
              >
                <SelectTrigger
                  className={cn(compact ? "h-8 text-xs" : "h-9")}
                  aria-label={`{{${variable}}}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {visibleModes.map(mode => (
                    <SelectItem key={mode} value={mode}>
                      {labels[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {config.mode === "csv_column" ? (
                <Select
                  value={config.csvColumn || ""}
                  onValueChange={value =>
                    updateVariableConfig(variable, { csvColumn: value })
                  }
                >
                  <SelectTrigger
                    className={cn(compact ? "h-8 text-xs" : "h-9")}
                    aria-label={labels.csv_column}
                  >
                    <SelectValue
                      placeholder={
                        selectColumnPlaceholder ||
                        t("recipient.selectTableColumn")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {variableColumnOptions.map(column => (
                      <SelectItem key={column} value={column}>
                        {column}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              {config.mode === "custom" ? (
                <Input
                  className={cn(compact ? "h-8 text-xs" : "h-9")}
                  value={config.customValue || ""}
                  onChange={event =>
                    updateVariableConfig(variable, {
                      customValue: event.target.value,
                    })
                  }
                  placeholder={
                    customValuePlaceholder ||
                    t("recipient.customValuePlaceholder", { variable })
                  }
                />
              ) : null}

              {preview ? (
                <div
                  className={cn(
                    "min-w-0 space-y-0.5 text-muted-foreground",
                    compact ? "text-[11px]" : "text-xs"
                  )}
                  data-testid={`campaign-variable-preview-${variable}`}
                >
                  <p className="break-words">
                    {preview.firstValue
                      ? t("recipient.variablePreview", {
                          value: preview.firstValue,
                        })
                      : t("recipient.variablePreviewEmpty")}
                  </p>
                  {preview.phoneFallbackCount > 0 ? (
                    <p className="break-words text-amber-700 dark:text-amber-300">
                      {t("recipient.variablePhoneFallback", {
                        count: preview.phoneFallbackCount,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
