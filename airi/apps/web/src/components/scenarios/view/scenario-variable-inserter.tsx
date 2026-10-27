"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ScenarioVariableChip } from "@/components/scenarios/view/scenario-variable-chip";
import type { ScenarioTokenSource } from "@/components/scenarios/view/scenario-template-utils";
import {
  buildScenarioVariableGroups,
  type ScenarioVariableExtraField,
  type ScenarioVariableGroup,
  type ScenarioVariableRowField,
} from "@/components/scenarios/view/scenario-variable-groups";
import { cn } from "@/lib/utils";
import { Braces, Info } from "lucide-react";
import {
  useMemo,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from "react";
import type { TranslateFn } from "../types";

export type { ScenarioVariableExtraField };

export type ScenarioVariableInserterVariant = "onDark" | "onLight";

const EMPTY_EXTRA_FIELDS: ScenarioVariableExtraField[] = [];
const NO_EXCLUDED_SOURCES: readonly ScenarioTokenSource[] = [];

const TRIGGER_CLASS_BY_VARIANT: Record<
  ScenarioVariableInserterVariant,
  string
> = {
  onDark: "border-white/25 bg-black/10 text-white/90 hover:bg-white/15",
  onLight: "border-border bg-background text-foreground hover:bg-muted/60",
};

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * An insert that moved focus, such as back into a text field after the new
 * variable, keeps it there; otherwise focus returns to the Variables button.
 */
function keepFocusMovedByInsert(event: Event) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    event.preventDefault();
  }
}

/**
 * One menu row: a variable to insert, or a note about its group. Arrow keys
 * reach a note, so screen readers read it, but picking it inserts nothing.
 */
function ScenarioVariableRow({
  field,
  group,
  onSelect,
}: {
  field: ScenarioVariableRowField;
  group: ScenarioVariableGroup;
  onSelect: (token: string) => void;
}) {
  return (
    <CommandItem
      // Two forms can share a key while that is an error; the group tells them apart.
      value={`${group.id}:${field.token}`}
      keywords={[
        field.label,
        field.description,
        group.label,
        ...group.keywords,
      ]}
      className="items-start gap-2 py-1.5"
      data-testid={`service-message-variable-${field.token}`}
      data-note={field.note ? "true" : undefined}
      onSelect={field.note ? undefined : () => onSelect(field.token)}
    >
      {/* A long name keeps its line; the question then wraps below it. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-0.5">
        {field.note ? (
          <span className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            {field.label}
          </span>
        ) : (
          <ScenarioVariableChip label={field.label} className="mt-0.5" />
        )}
        {field.description ? (
          <span className="min-w-28 flex-1 text-[10px] leading-snug text-muted-foreground">
            {field.description}
          </span>
        ) : null}
      </span>
      {field.badge ? (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          {field.badge}
        </Badge>
      ) : null}
    </CommandItem>
  );
}

function ScenarioVariableCommand({
  groups,
  emptyLabel,
  onSelect,
  t,
}: {
  groups: ScenarioVariableGroup[];
  emptyLabel: string;
  onSelect: (token: string) => void;
  t: TranslateFn;
}) {
  return (
    // cmdk labels its search input with the Command label.
    <Command label={t("variablesSearchPlaceholder")}>
      <CommandInput
        placeholder={t("variablesSearchPlaceholder")}
        className="h-8 text-xs"
        data-testid="service-message-variables-search"
      />
      <CommandList
        className="max-h-80"
        data-testid="service-message-variables-menu"
      >
        <CommandEmpty className="px-2 py-4 text-center text-[11px] text-muted-foreground">
          {emptyLabel}
        </CommandEmpty>
        {groups.map(group => (
          <CommandGroup
            key={group.id}
            heading={
              <>
                <span className="line-clamp-2 break-words">{group.label}</span>
                {group.description ? (
                  <span className="block text-[10px] font-normal leading-snug">
                    {group.description}
                  </span>
                ) : null}
              </>
            }
          >
            {group.fields.map(field => (
              <ScenarioVariableRow
                key={`${group.id}:${field.token}`}
                field={field}
                group={group}
                onSelect={onSelect}
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

export function ScenarioVariableInserter({
  t,
  onInsertToken,
  variant = "onDark",
  label,
  extraFields = EMPTY_EXTRA_FIELDS,
  excludeSources = NO_EXCLUDED_SOURCES,
  answersOnly = false,
}: {
  t: TranslateFn;
  onInsertToken: (token: string) => void;
  variant?: ScenarioVariableInserterVariant;
  label?: string;
  extraFields?: ScenarioVariableExtraField[];
  /** Catalog groups this field never offers. */
  excludeSources?: readonly ScenarioTokenSource[];
  /** Offers only the answers before this step, as AI instructions fill in no other variable. */
  answersOnly?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // The list mounts on first open and stays for the close animation.
  const [listMounted, setListMounted] = useState(false);
  const triggerLabel = label ?? t("variables");
  const groups = useMemo(
    () =>
      buildScenarioVariableGroups(
        { extraFields, excludeSources, answersOnly },
        t
      ),
    [answersOnly, excludeSources, extraFields, t]
  );
  const emptyLabel =
    answersOnly && groups.length === 0
      ? t("variablesAnswersEmpty")
      : t("variablesSearchEmpty");

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) setListMounted(true);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "nodrag nopan nokey inline-flex min-h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            TRIGGER_CLASS_BY_VARIANT[variant]
          )}
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
          data-testid="whatsapp-service-message-variables"
        >
          <Braces className="h-3 w-3" aria-hidden />
          <span>{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-label={triggerLabel}
        className="nodrag nopan nokey nowheel w-[min(340px,calc(100vw-2rem))] p-0"
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
        onKeyDown={stopPropagation}
        onCloseAutoFocus={keepFocusMovedByInsert}
      >
        {listMounted ? (
          <ScenarioVariableCommand
            groups={groups}
            emptyLabel={emptyLabel}
            t={t}
            onSelect={token => {
              onInsertToken(token);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
