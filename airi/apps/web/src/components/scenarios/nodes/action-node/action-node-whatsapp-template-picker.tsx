"use client";

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
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import { defaultFilter } from "cmdk";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { ScenarioWhatsAppTemplate } from "../../types";
import {
  formatWhatsAppTemplateLanguage,
  resolveLanguageNamesLocales,
} from "./action-node-whatsapp-template-language";

const CREATE_TEMPLATE_VALUE = "\u0000create-template";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function subscribeToNothing() {
  return () => {};
}

/** The page language from `<html lang>`, so tests need no locale provider. */
function useDocumentLanguage(): string {
  return useSyncExternalStore(
    subscribeToNothing,
    () => document.documentElement.lang,
    () => ""
  );
}

function filterTemplates(value: string, search: string, keywords?: string[]) {
  return value === CREATE_TEMPLATE_VALUE
    ? 0
    : defaultFilter(value, search, keywords);
}

/**
 * The template field: a searchable list of approved templates with a footer
 * item that opens the create drawer.
 */
export function ActionNodeWhatsAppTemplatePicker({
  id,
  options,
  value,
  savedName,
  savedLanguage,
  open,
  onOpenChange,
  onSelect,
  loading,
  listLoading,
  loadingLabel,
  onCreateNew,
  labelAccessory,
}: {
  id: string;
  options: readonly ScenarioWhatsAppTemplate[];
  value?: string;
  /** Shown when the saved template is not in the loaded list. */
  savedName?: string;
  savedLanguage?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  /** Spinner on the field while a selection or the first load settles. */
  loading: boolean;
  /** The list itself is loading or refreshing. */
  listLoading: boolean;
  loadingLabel: string;
  /** Omitted when templates cannot be created here. */
  onCreateNew?: () => void;
  /** Rendered next to the field label, e.g. the Shared badge. */
  labelAccessory?: ReactNode;
}) {
  const t = useTranslations("Scenarios");
  const [search, setSearch] = useState("");
  const uiLanguage = useDocumentLanguage();
  const languageNames = useMemo(() => {
    try {
      return new Intl.DisplayNames(resolveLanguageNamesLocales(uiLanguage), {
        type: "language",
      });
    } catch {
      return null;
    }
  }, [uiLanguage]);
  const triggerId = `${id}-trigger`;
  const listId = `${id}-options`;
  const selectedOption = options.find(
    option => getWhatsAppTemplateOptionValue(option) === value
  );
  const displayName = selectedOption?.name || savedName?.trim() || "";
  const displayLanguage = formatWhatsAppTemplateLanguage(
    selectedOption?.language ?? savedLanguage,
    languageNames
  );
  const showNoApproved = options.length === 0 && !search.trim();

  const changeOpen = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };

  return (
    <div className="w-full min-w-0 space-y-1">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 px-0.5">
        <Label
          htmlFor={triggerId}
          className="min-w-0 text-[11px] font-medium text-muted-foreground"
        >
          {t("whatsappTemplateSelectLabel")}
        </Label>
        {labelAccessory}
      </div>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            id={triggerId}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            data-testid="whatsapp-template-picker"
            className="nodrag nopan nokey h-9 w-full min-w-0 justify-start gap-2 bg-background px-3 text-left font-normal shadow-none"
            onPointerDown={stopPropagation}
            onClick={stopPropagation}
            onKeyDown={event => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                changeOpen(true);
              }
            }}
          >
            {displayName ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-sm">{displayName}</span>
                {displayLanguage ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {displayLanguage}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {t("whatsappTemplateSelectPlaceholder")}
              </span>
            )}
            {loading ? (
              <>
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
                <span className="sr-only">{loadingLabel}</span>
              </>
            ) : null}
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={listId}
          align="start"
          aria-label={t("whatsappTemplateSelectLabel")}
          className="nodrag nopan nokey nowheel w-[var(--radix-popover-trigger-width)] min-w-64 p-0"
          onPointerDown={stopPropagation}
        >
          <Command label={t("whatsappTemplateSearch")} filter={filterTemplates}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={t("whatsappTemplateSearch")}
              aria-label={t("whatsappTemplateSearch")}
            />
            <CommandList className="max-h-[min(18rem,var(--radix-popover-content-available-height))]">
              {showNoApproved ? (
                listLoading ? (
                  <div
                    className="space-y-1.5 p-2"
                    data-testid="whatsapp-template-list-loading"
                  >
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-4/5" />
                    <span className="sr-only">{loadingLabel}</span>
                  </div>
                ) : (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    {t("whatsappTemplateNoApproved")}
                  </p>
                )
              ) : (
                <CommandEmpty className="px-3 py-3 text-xs text-muted-foreground">
                  {t("whatsappTemplateNotFound")}
                </CommandEmpty>
              )}
              {options.length > 0 ? (
                <CommandGroup>
                  {options.map(option => {
                    const optionValue = getWhatsAppTemplateOptionValue(option);
                    const language = formatWhatsAppTemplateLanguage(
                      option.language,
                      languageNames
                    );
                    return (
                      <CommandItem
                        key={optionValue}
                        value={optionValue}
                        keywords={[option.name, language, option.language]}
                        // cmdk also fires for the checked item; picking it
                        // again must not rewrite the step.
                        onSelect={() =>
                          optionValue === value
                            ? changeOpen(false)
                            : onSelect(optionValue)
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {option.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {language}
                        </span>
                        <Check
                          className={cn(
                            "size-3.5",
                            optionValue === value ? "opacity-100" : "opacity-0"
                          )}
                          aria-hidden
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              {onCreateNew ? (
                <>
                  <CommandSeparator alwaysRender />
                  <CommandGroup forceMount>
                    <CommandItem
                      value={CREATE_TEMPLATE_VALUE}
                      forceMount
                      onSelect={() => {
                        changeOpen(false);
                        onCreateNew();
                      }}
                    >
                      <Plus aria-hidden />
                      {t("whatsappTemplateCreateNew")}
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
