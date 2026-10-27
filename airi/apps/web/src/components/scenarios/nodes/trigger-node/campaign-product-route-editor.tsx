"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { normalizeMetaAdAccountId } from "@/lib/meta-ads/meta-ad-account-id";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  CornerDownRightIcon,
  PlusIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { ScenarioTriggerConfig, TranslateFn } from "../../types";
import type { MessageTriggerProductRouteModel } from "./message-trigger-editor-model";

const MAX_NAME_FALLBACKS = 20;
const MAX_NAME_LENGTH = 120;

function selectedLabels(product: MessageTriggerProductRouteModel) {
  const selected = new Set(
    product.selectedLabelIds.map(id => id.toLowerCase())
  );
  return product.labels.filter(label => selected.has(label.id.toLowerCase()));
}

function labelDelta(
  product: MessageTriggerProductRouteModel,
  nextIds: string[]
): Partial<ScenarioTriggerConfig> {
  const byId = new Map(
    product.labels.map(label => [label.id.toLowerCase(), label])
  );
  const labels = nextIds.flatMap(id => {
    const match = byId.get(id.toLowerCase());
    return match ? [{ id: match.id, name: match.name }] : [];
  });
  const accountId = normalizeMetaAdAccountId(product.selectedAccountId);
  if (labels.length === 0 || !accountId) {
    return {
      // Removing a label must not broaden an account-scoped name fallback.
      metaCampaignAdAccountId: accountId || undefined,
      metaCampaignLabels: undefined,
    };
  }
  return { metaCampaignAdAccountId: accountId, metaCampaignLabels: labels };
}

export function CampaignProductRouteEditor({
  product,
  onChange,
  t,
}: {
  product: MessageTriggerProductRouteModel;
  onChange: (delta: Partial<ScenarioTriggerConfig>) => void;
  t: TranslateFn;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState<boolean>();
  const [nameDraft, setNameDraft] = useState("");
  const chosen = selectedLabels(product);
  const canPickLabels =
    ["ready", "partial", "empty"].includes(product.state) || chosen.length > 0;
  const needsAccount =
    product.accounts.length > 1 && !product.selectedAccountId;
  const expanded = fallbackOpen ?? product.nameFallbacks.length > 0;
  const normalizedDraft = nameDraft.trim().replace(/\s+/g, " ");
  const canAddName =
    Boolean(normalizedDraft) &&
    normalizedDraft.length <= MAX_NAME_LENGTH &&
    product.nameFallbacks.length < MAX_NAME_FALLBACKS &&
    !product.nameFallbacks.some(
      name => name.toLowerCase() === normalizedDraft.toLowerCase()
    );

  function addNameFallback() {
    if (!canAddName) return;
    onChange({
      metaCampaignNameFallbacks: [...product.nameFallbacks, normalizedDraft],
    });
    setNameDraft("");
  }

  return (
    <FieldGroup className="gap-3 rounded-lg border bg-background p-3">
      {product.accounts.length > 1 ? (
        <Field className="gap-2">
          <FieldLabel htmlFor={`${fieldId}-account`}>
            {t("triggerProductRouteAccount")}
          </FieldLabel>
          <Select
            value={product.selectedAccountId}
            onValueChange={accountId =>
              onChange({
                metaCampaignAdAccountId: accountId,
                metaCampaignLabels: undefined,
              })
            }
          >
            <SelectTrigger
              id={`${fieldId}-account`}
              className="nodrag h-8 w-full min-w-0"
            >
              <SelectValue
                placeholder={t("triggerProductRouteSelectAccount")}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {product.accounts.map(account => (
                  <SelectItem key={account.id} value={account.id}>
                    <span
                      className="block max-w-[240px] truncate"
                      title={account.name}
                    >
                      {account.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <Field className="gap-2" data-disabled={!canPickLabels || needsAccount}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FieldLabel htmlFor={`${fieldId}-labels`}>
            <TagsIcon className="size-4" aria-hidden />
            {t("triggerProductRouteLabel")}
          </FieldLabel>
          {chosen.length > 1 ? (
            <Badge variant="outline">{t("triggerProductRouteMatchAny")}</Badge>
          ) : null}
        </div>
        {chosen.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {chosen.map(label => (
              <Badge
                key={label.id}
                variant={label.stale ? "outline" : "secondary"}
                className="h-auto max-w-full gap-1 whitespace-normal py-1"
                title={label.name}
              >
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {label.name}
                </span>
                {label.stale ? (
                  <span className="flex items-center gap-1">
                    <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                    <span>{t("triggerProductRouteSavedLabelUnavailable")}</span>
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="nodrag shrink-0"
                  aria-label={t("triggerProductRouteRemoveLabel", {
                    name: label.name,
                  })}
                  onClick={() =>
                    onChange(
                      labelDelta(
                        product,
                        product.selectedLabelIds.filter(
                          id => id.toLowerCase() !== label.id.toLowerCase()
                        )
                      )
                    )
                  }
                >
                  <XIcon aria-hidden />
                </Button>
              </Badge>
            ))}
          </div>
        ) : null}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={`${fieldId}-labels`}
              type="button"
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              aria-label={t("triggerProductRouteAddLabels")}
              disabled={!canPickLabels || needsAccount}
              className="nodrag h-9 w-full min-w-0 justify-between"
            >
              <span className="truncate">
                {t("triggerProductRouteAddLabels")}
              </span>
              <ChevronsUpDownIcon data-icon="inline-end" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label={t("triggerProductRouteLabel")}
            align="start"
            className="nodrag nowheel w-[min(22rem,calc(100vw-2rem))] p-0"
          >
            <Command label={t("triggerProductRouteSearchLabels")}>
              <CommandInput
                placeholder={t("triggerProductRouteSearchLabels")}
                aria-label={t("triggerProductRouteSearchLabels")}
              />
              <CommandList aria-multiselectable="true" className="max-h-56">
                <CommandEmpty>
                  {t("triggerProductRouteNoSearchResults")}
                </CommandEmpty>
                <CommandGroup>
                  {product.labels.map(label => {
                    const checked = product.selectedLabelIds.some(
                      id => id.toLowerCase() === label.id.toLowerCase()
                    );
                    return (
                      <CommandItem
                        key={label.id}
                        value={label.id}
                        keywords={[label.name]}
                        aria-checked={checked}
                        className="items-start"
                        onSelect={() =>
                          onChange(
                            labelDelta(
                              product,
                              checked
                                ? product.selectedLabelIds.filter(
                                    id =>
                                      id.toLowerCase() !==
                                      label.id.toLowerCase()
                                  )
                                : [...product.selectedLabelIds, label.id]
                            )
                          )
                        }
                      >
                        <Checkbox
                          checked={checked}
                          tabIndex={-1}
                          aria-hidden
                          className="pointer-events-none mt-0.5"
                        />
                        <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
                          {label.name}
                        </span>
                        {label.stale ? (
                          <AlertCircleIcon
                            aria-label={t(
                              "triggerProductRouteSavedLabelUnavailable"
                            )}
                          />
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </Field>

      {product.warning ? (
        product.state === "loading" ? (
          <div
            role="status"
            aria-label={product.warning}
            className="flex flex-col gap-2"
          >
            <span className="sr-only">{product.warning}</span>
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : (
          <Alert
            role="status"
            variant={product.state === "error" ? "destructive" : "default"}
            className="px-3 py-2"
          >
            <AlertCircleIcon aria-hidden />
            <AlertDescription>{product.warning}</AlertDescription>
          </Alert>
        )
      ) : null}

      <Separator />
      <Collapsible
        open={expanded}
        onOpenChange={setFallbackOpen}
        className="flex flex-col gap-2"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nodrag h-auto min-h-8 w-full min-w-0 justify-start whitespace-normal text-left"
          >
            <CornerDownRightIcon data-icon="inline-start" aria-hidden />
            <span className="min-w-0 flex-1">
              {t("triggerProductRouteNameFallbackLabel")}
            </span>
            {product.nameFallbacks.length > 0 ? (
              <Badge variant="secondary">{product.nameFallbacks.length}</Badge>
            ) : null}
            <ChevronDownIcon
              data-icon="inline-end"
              aria-hidden
              className={cn("transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <FieldGroup className="gap-2">
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline" className="max-w-full whitespace-normal">
                {t("triggerProductRouteFallbackCondition")}
              </Badge>
              <Badge variant="outline" className="max-w-full whitespace-normal">
                {t("triggerProductRouteVerifiedMeta")}
              </Badge>
            </div>
            <Field className="gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <FieldLabel htmlFor={`${fieldId}-name`}>
                  {t("triggerProductRouteCampaignName")}
                </FieldLabel>
                <Badge variant="secondary">
                  {t("triggerProductRouteContainsAny")}
                </Badge>
              </div>
              {product.nameFallbacks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {product.nameFallbacks.map(name => (
                    <Badge
                      key={name.toLowerCase()}
                      variant="secondary"
                      className="h-auto max-w-full gap-1 whitespace-normal py-1"
                      title={name}
                    >
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="nodrag shrink-0"
                        aria-label={t("triggerProductRouteNameFallbackRemove", {
                          name,
                        })}
                        onClick={() =>
                          onChange({
                            metaCampaignNameFallbacks:
                              product.nameFallbacks.filter(
                                item =>
                                  item.toLowerCase() !== name.toLowerCase()
                              ),
                          })
                        }
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </Badge>
                  ))}
                </div>
              ) : null}
              <form
                className="flex min-w-0 gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  addNameFallback();
                }}
              >
                <Input
                  id={`${fieldId}-name`}
                  value={nameDraft}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder={t("triggerProductRouteNameFallbackPlaceholder")}
                  aria-label={t("triggerProductRouteNameFallbackLabel")}
                  disabled={product.nameFallbacks.length >= MAX_NAME_FALLBACKS}
                  className="nodrag h-8 min-w-0 flex-1"
                  onChange={event => setNameDraft(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="icon-sm"
                  className="nodrag"
                  aria-label={t("triggerProductRouteNameFallbackAdd")}
                  disabled={!canAddName}
                >
                  <PlusIcon aria-hidden />
                </Button>
              </form>
              {product.nameFallbacks.length >= MAX_NAME_FALLBACKS ? (
                <span role="status" className="text-xs text-muted-foreground">
                  {t("triggerProductRouteNameLimit", {
                    count: MAX_NAME_FALLBACKS,
                  })}
                </span>
              ) : null}
            </Field>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </FieldGroup>
  );
}
