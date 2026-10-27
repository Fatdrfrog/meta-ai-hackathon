"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileClockIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import type { ScenarioTriggerConfig, TranslateFn } from "../../types";
import {
  EMPTY_BUSINESS_EVENT_CATALOG,
  type BusinessEventTriggerCatalog,
  type BusinessEventTriggerField,
} from "./business-event-trigger-model";

type BusinessEventConfig = NonNullable<ScenarioTriggerConfig["businessEvent"]>;
type BusinessEventFilter = NonNullable<BusinessEventConfig["filters"]>[number];
const MAX_FILTERS = 20;

function CatalogPicker({
  label,
  placeholder,
  value,
  savedLabel,
  options,
  unavailable,
  disabled,
  onSelect,
  onClear,
  t,
}: {
  label: string;
  placeholder: string;
  value?: string;
  savedLabel?: string;
  options: readonly { id: string; name: string }[];
  unavailable?: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onClear?: () => void;
  t: TranslateFn;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.id === value);
  const displayLabel = value
    ? selected?.name || savedLabel || value
    : placeholder;
  const searchLabel = t("businessEventSearch", { name: label });
  return (
    <Field className="min-w-0 gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex min-w-0 items-start gap-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-controls={`${id}-options`}
              disabled={disabled}
              className="nodrag h-auto min-h-10 min-w-0 flex-1 justify-start py-2 text-left"
              onKeyDown={event => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setOpen(true);
                }
              }}
            >
              <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
                {displayLabel}
              </span>
              {unavailable ? (
                <Badge variant="outline">{t("businessEventUnavailable")}</Badge>
              ) : null}
              <ChevronsUpDownIcon data-icon="inline-end" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={`${id}-options`}
            align="start"
            aria-label={label}
            className="nodrag nowheel w-[min(25rem,calc(100vw-2rem))] p-0"
          >
            <Command label={searchLabel}>
              <CommandInput placeholder={searchLabel} />
              <CommandList>
                <CommandEmpty>{t("businessEventNoResults")}</CommandEmpty>
                <CommandGroup>
                  {options.map(option => (
                    <CommandItem
                      key={option.id}
                      value={option.id}
                      keywords={[option.name, option.id]}
                      onSelect={() => {
                        onSelect(option.id);
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">
                        {option.name}
                      </span>
                      {value === option.id ? <CheckIcon aria-hidden /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {value && onClear ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="nodrag shrink-0"
            aria-label={t("businessEventClearSelection", { name: label })}
            onClick={onClear}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

function FilterValue({
  filter,
  field,
  onChange,
  t,
}: {
  filter: BusinessEventFilter;
  field?: BusinessEventTriggerField;
  onChange: (value: string) => void;
  t: TranslateFn;
}) {
  const id = useId();
  const options =
    field?.type === "boolean"
      ? [
          { value: "true", label: t("businessEventTrue") },
          { value: "false", label: t("businessEventFalse") },
        ]
      : field?.type === "enum"
        ? (field.options ?? [])
        : null;
  const staleValue =
    options !== null &&
    filter.value !== "" &&
    !options.some(option => option.value === filter.value);
  const invalidNumber =
    field?.type === "number" &&
    filter.value !== "" &&
    !Number.isFinite(Number(filter.value));
  return (
    <Field
      className="min-w-0 gap-1.5"
      data-invalid={invalidNumber || undefined}
      data-business-event-value
    >
      <FieldLabel htmlFor={id}>{t("businessEventFilterValue")}</FieldLabel>
      {options !== null ? (
        <Select
          value={filter.value === "" ? "" : `value:${filter.value}`}
          onValueChange={value => onChange(value.slice(6))}
        >
          <SelectTrigger id={id} className="nodrag w-full min-w-0">
            <SelectValue placeholder={t("businessEventChooseValue")} />
          </SelectTrigger>
          <SelectContent className="max-w-[calc(100vw-2rem)]">
            <SelectGroup>
              {staleValue ? (
                <SelectItem value={`value:${filter.value}`}>
                  <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
                    {filter.value} · {t("businessEventUnavailable")}
                  </span>
                </SelectItem>
              ) : null}
              {options.map(option => (
                <SelectItem key={option.value} value={`value:${option.value}`}>
                  <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
                    {option.label}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={field?.type === "number" && !invalidNumber ? "number" : "text"}
          inputMode={field?.type === "number" ? "decimal" : undefined}
          step={field?.type === "number" ? "any" : undefined}
          value={filter.value}
          aria-invalid={invalidNumber || undefined}
          disabled={!field}
          onChange={event => onChange(event.target.value)}
          className="nodrag min-w-0"
        />
      )}
    </Field>
  );
}

export function BusinessEventTriggerEditor({
  value = {},
  onChange,
  catalog = EMPTY_BUSINESS_EVENT_CATALOG,
  onRetry,
  integrationsHref,
}: {
  value?: ScenarioTriggerConfig["businessEvent"];
  onChange: (value: BusinessEventConfig) => void;
  catalog?: BusinessEventTriggerCatalog;
  onRetry?: () => void;
  integrationsHref?: string;
}) {
  const t = useTranslations("Scenarios") as TranslateFn;
  const id = useId();
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const addFilterRef = useRef<HTMLButtonElement>(null);
  const pendingFilterFocus = useRef<number | null>(null);
  const integration = catalog.integrations.find(
    item => item.id === value.integrationId
  );
  const event = integration?.events.find(item => item.id === value.eventId);
  const filters = value.filters ?? [];
  const loading = catalog.status === "loading";
  const missingIntegration =
    catalog.status === "ready" && Boolean(value.integrationId) && !integration;
  const missingEvent =
    catalog.status === "ready" && Boolean(value.eventId) && !event;
  const fields = event?.fields ?? [];
  const canAddFilter =
    fields.length > 0 && filters.length < MAX_FILTERS && !loading;

  function changeIntegration(integrationId?: string) {
    if (integrationId === value.integrationId) return;
    const next = catalog.integrations.find(item => item.id === integrationId);
    onChange({
      ...value,
      integrationId,
      integrationName: next?.name,
      eventId: undefined,
      eventName: undefined,
      filters: [],
    });
  }
  function changeEvent(eventId?: string) {
    if (eventId === value.eventId) return;
    const next = integration?.events.find(item => item.id === eventId);
    onChange({ ...value, eventId, eventName: next?.name, filters: [] });
  }
  function changeFilter(index: number, patch: Partial<BusinessEventFilter>) {
    onChange({
      ...value,
      filters: filters.map((filter, position) =>
        position === index ? { ...filter, ...patch } : filter
      ),
    });
  }

  function focusFilter(index: number) {
    const row = editorRef.current?.querySelector<HTMLElement>(
      `[data-business-event-condition="${index}"]`
    );
    const valueControl = row?.querySelector<HTMLElement>(
      '[data-business-event-value] input:not(:disabled), [data-business-event-value] [role="combobox"]:not(:disabled)'
    );
    const nextControl =
      valueControl ??
      row?.querySelector<HTMLElement>(
        '[role="combobox"]:not(:disabled), input:not(:disabled)'
      ) ??
      (addFilterRef.current?.disabled ? null : addFilterRef.current) ??
      editorRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
    (row ?? nextControl)?.scrollIntoView({ block: "nearest" });
    nextControl?.focus();
  }

  function removeFilter(index: number) {
    const next = filters.filter((_, position) => position !== index);
    onChange({ ...value, filters: next });
    requestAnimationFrame(() => focusFilter(Math.min(index, next.length - 1)));
  }

  return (
    <FieldGroup ref={editorRef} className="gap-4">
      <Alert role="status">
        <FileClockIcon aria-hidden />
        <AlertTitle>{t("businessEventDraftTitle")}</AlertTitle>
        <AlertDescription>
          {t("businessEventDraftDescription")}
        </AlertDescription>
      </Alert>
      {loading ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">
            {t("businessEventLoading")}
          </span>
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}
      {catalog.status === "error" ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden />
          <AlertDescription>
            {t("businessEventLoadError")}
            {onRetry ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                <RefreshCwIcon data-icon="inline-start" aria-hidden />
                {t("businessEventRetry")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <CatalogPicker
        label={t("businessEventIntegration")}
        placeholder={t("businessEventChooseIntegration")}
        value={value.integrationId}
        savedLabel={value.integrationName}
        options={catalog.integrations}
        unavailable={missingIntegration}
        disabled={loading || catalog.integrations.length === 0}
        onSelect={changeIntegration}
        onClear={() => changeIntegration(undefined)}
        t={t}
      />
      {value.integrationId ? (
        <CatalogPicker
          label={t("businessEventEvent")}
          placeholder={t("businessEventChooseEvent")}
          value={value.eventId}
          savedLabel={value.eventName}
          options={integration?.events ?? []}
          unavailable={missingEvent}
          disabled={loading || !integration?.events.length}
          onSelect={changeEvent}
          onClear={() => changeEvent(undefined)}
          t={t}
        />
      ) : null}
      {catalog.status === "ready" && catalog.integrations.length === 0 ? (
        <EmptyState
          title={t("businessEventNoIntegrations")}
          action={
            integrationsHref ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={integrationsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("businessEventOpenIntegrations")}
                  <ExternalLinkIcon data-icon="inline-end" aria-hidden />
                </a>
              </Button>
            ) : undefined
          }
        />
      ) : catalog.status === "ready" &&
        integration &&
        integration.events.length === 0 ? (
        <EmptyState title={t("businessEventNoEvents")} />
      ) : null}
      {filters.length > 0 ? (
        <FieldGroup className="gap-3">
          <span className="text-sm font-medium">
            {t("businessEventAllConditions")}
          </span>
          {filters.map((filter, index) => {
            const field = fields.find(item => item.key === filter.field);
            return (
              <FieldGroup
                key={`${filter.field}-${index}`}
                data-business-event-condition={index}
                className="min-w-0 gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
                    {field?.label || filter.field}
                  </span>
                  {!field ? (
                    <Badge variant="outline">
                      {t("businessEventUnavailable")}
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="nodrag shrink-0"
                    aria-label={t("businessEventRemoveFilter", {
                      index: index + 1,
                    })}
                    onClick={() => removeFilter(index)}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-2 min-[400px]:grid-cols-[minmax(7rem,0.75fr)_minmax(0,1.25fr)]">
                  <Field className="min-w-0 gap-1.5">
                    <FieldLabel htmlFor={`${id}-operator-${index}`}>
                      {t("businessEventFilterOperator")}
                    </FieldLabel>
                    <Select
                      value={filter.operator}
                      onValueChange={operator =>
                        changeFilter(index, {
                          operator: operator as BusinessEventFilter["operator"],
                        })
                      }
                    >
                      <SelectTrigger
                        id={`${id}-operator-${index}`}
                        className="nodrag w-full min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="equals">
                            {t("businessEventEquals")}
                          </SelectItem>
                          <SelectItem value="not_equals">
                            {t("businessEventNotEquals")}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <FilterValue
                    filter={filter}
                    field={field}
                    onChange={nextValue =>
                      changeFilter(index, { value: nextValue })
                    }
                    t={t}
                  />
                </div>
              </FieldGroup>
            );
          })}
        </FieldGroup>
      ) : null}
      {value.eventId ? (
        <Field className="min-w-0 gap-2">
          <Popover open={filterPickerOpen} onOpenChange={setFilterPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={addFilterRef}
                type="button"
                variant="outline"
                size="sm"
                className="nodrag w-fit"
                disabled={!canAddFilter}
              >
                <PlusIcon data-icon="inline-start" aria-hidden />
                {t("businessEventAddFilter")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              aria-label={t("businessEventFilterField")}
              className="nodrag nowheel w-[min(25rem,calc(100vw-2rem))] p-0"
              onCloseAutoFocus={event => {
                const index = pendingFilterFocus.current;
                if (index === null) return;
                event.preventDefault();
                pendingFilterFocus.current = null;
                requestAnimationFrame(() => focusFilter(index));
              }}
            >
              <Command
                label={t("businessEventSearch", {
                  name: t("businessEventFilterField"),
                })}
              >
                <CommandInput
                  placeholder={t("businessEventSearch", {
                    name: t("businessEventFilterField"),
                  })}
                />
                <CommandList>
                  <CommandEmpty>{t("businessEventNoResults")}</CommandEmpty>
                  <CommandGroup>
                    {fields.map(field => (
                      <CommandItem
                        key={field.key}
                        value={field.key}
                        keywords={[field.label, field.key]}
                        onSelect={() => {
                          if (filters.length >= MAX_FILTERS) return;
                          pendingFilterFocus.current = filters.length;
                          onChange({
                            ...value,
                            filters: [
                              ...filters,
                              {
                                field: field.key,
                                operator: "equals",
                                value: "",
                              },
                            ],
                          });
                          setFilterPickerOpen(false);
                        }}
                      >
                        {field.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {filters.length >= MAX_FILTERS ? (
            <span role="status" className="text-xs text-muted-foreground">
              {t("businessEventFilterLimit", { count: MAX_FILTERS })}
            </span>
          ) : event && fields.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("businessEventNoFields")}
            </span>
          ) : null}
        </Field>
      ) : null}
      {fields.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="nodrag w-full min-w-0 justify-start"
            >
              <DatabaseIcon data-icon="inline-start" aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                {t("businessEventDataFields")}
              </span>
              <Badge variant="secondary">{fields.length}</Badge>
              <ChevronDownIcon data-icon="inline-end" aria-hidden />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            role="region"
            aria-label={t("businessEventDataFields")}
          >
            <div className="flex min-w-0 flex-wrap gap-1.5 pt-2">
              {fields.map(field => (
                <Badge
                  key={field.key}
                  variant="outline"
                  title={field.key}
                  className="h-auto max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                >
                  {field.label}
                </Badge>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </FieldGroup>
  );
}
