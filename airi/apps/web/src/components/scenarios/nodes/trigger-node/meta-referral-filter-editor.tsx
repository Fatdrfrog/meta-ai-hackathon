"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FilterIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { ScenarioTriggerConfig, TranslateFn } from "../../types";
import {
  metaReferralSelectionToConfigDelta,
  metaReferralSelectionToSelectValue,
  selectValueToMetaReferralSelection,
} from "./meta-referral-selection";
import type {
  MessageTriggerEditorModel,
  MessageTriggerMetaOption,
  MessageTriggerProductCatalogState,
} from "./message-trigger-editor-model";

const ANY_MESSAGE_VALUE = metaReferralSelectionToSelectValue({
  kind: "any_message",
});
const ANY_INSTAGRAM_AD_VALUE = metaReferralSelectionToSelectValue({
  kind: "any_instagram_ad",
});

function MetaOptions({
  heading,
  options,
  selectedValue,
  onSelect,
}: {
  heading: string;
  options: MessageTriggerMetaOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {options.map(option => (
        <CommandItem
          key={option.selectValue}
          value={option.selectValue}
          keywords={[option.label, option.meta, option.id]}
          title={option.title}
          onSelect={onSelect}
          className="min-w-0 items-start py-2"
        >
          <span className="min-w-0 flex-1 break-words whitespace-normal [overflow-wrap:anywhere]">
            <span className="block font-medium">{option.label}</span>
            {option.meta ? (
              <span className="block text-xs leading-snug text-muted-foreground">
                {option.meta}
              </span>
            ) : null}
          </span>
          {selectedValue === option.selectValue ? (
            <CheckIcon aria-hidden className="mt-0.5 shrink-0" />
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function MetaReferralFilterEditor({
  meta,
  catalogState,
  savedFilterSummary = [],
  onChange,
  t,
}: {
  meta: MessageTriggerEditorModel["meta"];
  catalogState?: MessageTriggerProductCatalogState;
  savedFilterSummary?: readonly string[];
  onChange: (delta: Partial<ScenarioTriggerConfig>) => void;
  t: TranslateFn;
}) {
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const selection = selectValueToMetaReferralSelection(meta.selectValue);
  const scopeLabel =
    selection?.kind === "campaign"
      ? t("triggerMetaCampaignScope")
      : selection?.kind === "ad_set"
        ? t("triggerMetaAdSetScope")
        : selection?.kind === "ad"
          ? t("triggerMetaAdScope")
          : "";
  const selectedLabel =
    meta.selectValue === ANY_MESSAGE_VALUE
      ? savedFilterSummary.length > 0
        ? t("triggerMetaSavedFilters")
        : t("triggerMetaNoFilter")
      : meta.selectedLabel;
  const loading = catalogState === "loading";
  const hasOptions =
    meta.campaignOptions.length +
      meta.adSetOptions.length +
      meta.adOptions.length >
    0;
  const warning = loading
    ? t("triggerMetaCatalogLoading")
    : meta.catalogWarning ||
      (!meta.hasConnection ? t("triggerMetaConnectMarketingApi") : "");

  function choose(value: string) {
    const selection = selectValueToMetaReferralSelection(value);
    if (!selection) return;
    onChange(metaReferralSelectionToConfigDelta(selection));
    setOpen(false);
  }

  return (
    <Field className="min-w-0 gap-2 rounded-md border bg-background p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FieldLabel
          htmlFor={pickerId}
          className="min-w-0 text-xs text-muted-foreground"
        >
          {t("triggerMetaExactFilterLabel")}
        </FieldLabel>
        {scopeLabel ? <Badge variant="secondary">{scopeLabel}</Badge> : null}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={pickerId}
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${pickerId}-options`}
            aria-describedby={warning ? `${pickerId}-status` : undefined}
            className="nodrag h-auto min-h-9 w-full min-w-0 justify-start py-2 text-left"
            title={
              meta.selectedMeta
                ? `${selectedLabel} / ${meta.selectedMeta}`
                : selectedLabel
            }
            onKeyDown={event => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <FilterIcon data-icon="inline-start" aria-hidden />
            <span className="min-w-0 flex-1 break-words whitespace-normal [overflow-wrap:anywhere]">
              {selectedLabel}
            </span>
            <ChevronsUpDownIcon data-icon="inline-end" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={`${pickerId}-options`}
          aria-label={t("triggerMetaExactFilterLabel")}
          align="start"
          className="nodrag nowheel w-[min(22rem,calc(100vw-2rem))] p-0"
        >
          <Command
            label={t("triggerMetaSearch")}
            defaultValue={meta.selectValue}
          >
            <CommandInput
              placeholder={t("triggerMetaSearch")}
              aria-label={t("triggerMetaSearch")}
            />
            <CommandList>
              <CommandEmpty>{t("triggerMetaNoResults")}</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value={ANY_MESSAGE_VALUE}
                  keywords={[t("triggerMetaNoFilter")]}
                  onSelect={choose}
                >
                  <span className="min-w-0 flex-1 break-words whitespace-normal [overflow-wrap:anywhere]">
                    {t("triggerMetaNoFilter")}
                  </span>
                  {meta.selectValue === ANY_MESSAGE_VALUE ? (
                    <CheckIcon aria-hidden />
                  ) : null}
                </CommandItem>
                <CommandItem
                  value={ANY_INSTAGRAM_AD_VALUE}
                  keywords={[t("triggerMetaAnyInstagramAd")]}
                  onSelect={choose}
                >
                  <span className="min-w-0 flex-1 break-words whitespace-normal [overflow-wrap:anywhere]">
                    {t("triggerMetaAnyInstagramAd")}
                  </span>
                  {meta.selectValue === ANY_INSTAGRAM_AD_VALUE ? (
                    <CheckIcon aria-hidden />
                  ) : null}
                </CommandItem>
              </CommandGroup>
              {hasOptions ? <CommandSeparator /> : null}
              <MetaOptions
                heading={t("triggerMetaCampaignsGroup")}
                options={meta.campaignOptions}
                selectedValue={meta.selectValue}
                onSelect={choose}
              />
              <MetaOptions
                heading={t("triggerMetaAdSetsGroup")}
                options={meta.adSetOptions}
                selectedValue={meta.selectValue}
                onSelect={choose}
              />
              <MetaOptions
                heading={t("triggerMetaAdsGroup")}
                options={meta.adOptions}
                selectedValue={meta.selectValue}
                onSelect={choose}
              />
              {loading && !hasOptions ? (
                <div aria-hidden className="flex flex-col gap-2 p-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : null}
              {!loading && !hasOptions ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {warning || t("triggerMetaNoCampaigns")}
                </div>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {savedFilterSummary.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {savedFilterSummary.map(summary => (
            <Badge
              key={summary}
              variant="outline"
              className="h-auto max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
            >
              {summary}
            </Badge>
          ))}
        </div>
      ) : null}
      {warning ? (
        <div
          id={`${pickerId}-status`}
          role="status"
          className="flex items-start gap-2 text-xs leading-snug text-muted-foreground"
        >
          {loading ? (
            <LoaderCircleIcon
              className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {warning}
          </span>
        </div>
      ) : null}
    </Field>
  );
}
