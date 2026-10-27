"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BulkCampaignEligibilityPreviewState } from "./use-bulk-campaign-recipient-eligibility-preview";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { ChevronDown } from "lucide-react";

export type PriorFailedRecipientExclusionControlLabels = {
  label?: string;
  hint?: string;
  excluded?: string;
};

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

export type PriorFailedRecipientExclusionControlProps = {
  value: boolean;
  supported: boolean;
  /** The send's recipient check; the excluded counts come from it. */
  eligibility: BulkCampaignEligibilityPreviewState;
  disabledReason?: string;
  onChange: (value: boolean) => void;
  /** Omit when a readiness notice already shows the failed check and its retry. */
  onRetry?: () => void;
  labels?: PriorFailedRecipientExclusionControlLabels;
  t?: Translate;
  className?: string;
  switchId?: string;
};

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US");

function formatInteger(value: number): string {
  return INTEGER_FORMATTER.format(Math.max(0, value));
}

export function PriorFailedRecipientExclusionControl({
  value,
  supported,
  eligibility,
  disabledReason,
  onChange,
  onRetry,
  labels,
  t: tProp,
  className,
  switchId: switchIdProp,
}: PriorFailedRecipientExclusionControlProps) {
  const defaultT = useTranslations("MultiChannelCampaignBuilder");
  const t = tProp || defaultT;
  const generatedSwitchId = useId();
  const switchId = switchIdProp || generatedSwitchId;
  const previewState = eligibility.state;
  const preview = eligibility.state === "ready" ? eligibility.preview : null;
  const excludedCount = preview
    ? preview.skippedByReason.prior_failure || 0
    : undefined;
  const allExcluded = Boolean(preview?.allExcluded);
  const labelText = labels?.label || t("excludePriorFailedBulkSendsLabel");
  const hintText = labels?.hint || t("excludePriorFailedBulkSendsHint");
  const filterOn = supported && value;
  const filterState = !filterOn
    ? t("recipientFiltersOff")
    : previewState === "ready" &&
        typeof excludedCount === "number" &&
        excludedCount > 0
      ? t("recipientFiltersExcluded", { count: excludedCount })
      : t("recipientFiltersActive");

  const handleCheckedChange = (checked: boolean | "indeterminate") => {
    if (!supported || checked === "indeterminate") return;
    onChange(checked);
  };

  return (
    <section
      data-testid="prior-failed-recipient-exclusion-control"
      className={cn("min-w-0 space-y-2", className)}
    >
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto w-full min-w-0 justify-start gap-2 px-0 py-1.5 text-left text-xs whitespace-normal [&[data-state=open]>svg]:rotate-180"
          >
            <ChevronDown
              className="size-3.5 shrink-0 transition-transform"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{t("recipientFilters")}</span>
            <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
              {filterState}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex min-w-0 items-start justify-between gap-3 rounded-md bg-muted/20 p-3">
            <div data-slot="exclusion-copy" className="min-w-0 flex-1 space-y-1 break-words whitespace-normal">
              <Label htmlFor={switchId} className="text-xs font-medium break-words whitespace-normal">
                {labelText}
              </Label>
              <p className="text-xs text-muted-foreground break-words whitespace-normal">
                {hintText}
              </p>
            </div>
            <Switch
              id={switchId}
              checked={supported ? value : false}
              disabled={!supported}
              onCheckedChange={handleCheckedChange}
              onKeyDown={event => {
                if (!supported || event.key !== " ") return;
                event.preventDefault();
                onChange(!value);
              }}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <div className="min-w-0 space-y-1 break-words whitespace-normal">
        {filterOn && previewState === "loading" ? (
          <p className="text-xs text-muted-foreground">
            {t("priorFailedBulkSendsLoading")}
          </p>
        ) : null}
        {previewState === "ready" &&
        !allExcluded &&
        typeof excludedCount === "number" &&
        excludedCount > 0 ? (
          <p className="text-xs font-medium text-amber-600 break-words whitespace-normal">
            {labels?.excluded
              ? labels.excluded.replace("{count}", formatInteger(excludedCount))
              : t("priorFailedBulkSendsExcludedInline", {
                  count: excludedCount,
                })}
          </p>
        ) : null}
        {filterOn && previewState === "ready" && allExcluded ? (
          <p className="text-xs font-medium text-amber-600 break-words whitespace-normal">
            {t("priorFailedBulkSendsAllExcluded")}
          </p>
        ) : null}
        {!supported && disabledReason ? (
          <p className="text-xs text-muted-foreground break-words whitespace-normal">
            {disabledReason}
          </p>
        ) : null}
        {filterOn && previewState === "error" && onRetry ? (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 break-words whitespace-normal">
                {t("priorFailedBulkSendsLookupUnavailable")}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                {t("priorFailedBulkSendsRetry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </section>
  );
}
