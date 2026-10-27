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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  MAIN_TEMPLATE_LANGUAGE_COUNT,
  SUPPORTED_LANGUAGES,
} from "@icecore/shared/constants/whatsapp-templates";
import { Check, ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type Ref } from "react";

type TemplateLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const MAIN_LANGUAGES = SUPPORTED_LANGUAGES.slice(
  0,
  MAIN_TEMPLATE_LANGUAGE_COUNT
);
const OTHER_LANGUAGES = SUPPORTED_LANGUAGES.slice(MAIN_TEMPLATE_LANGUAGE_COUNT);

function hasDistinctNativeName(language: TemplateLanguage): boolean {
  return language.nativeName !== language.name;
}

/** "ru" finds Russian by its code, "rus" by its name, "рус" by its own name. */
function filterLanguage(value: string, search: string): number {
  return value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    ? 1
    : 0;
}

/** A searchable list of the WhatsApp template languages, in picker order. */
export function TemplateLanguageSelect({
  id,
  ref,
  value,
  onChange,
  onBlur,
  disabled,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  ref?: Ref<HTMLButtonElement>;
  /** A SUPPORTED_LANGUAGES code, or "" when none is chosen. */
  value: string;
  onChange: (code: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const t = useTranslations("templates");
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = SUPPORTED_LANGUAGES.find(
    language => language.code === value
  );

  const renderLanguage = (language: TemplateLanguage) => (
    <CommandItem
      key={language.code}
      value={`${language.name} ${language.nativeName} ${language.code}`}
      onSelect={() => {
        onChange(language.code);
        setOpen(false);
        onBlur?.();
      }}
    >
      <Check
        className={cn(language.code === value ? "opacity-100" : "opacity-0")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">
        {language.name}
        {hasDistinctNativeName(language) ? (
          <span className="text-muted-foreground">
            {" · "}
            {language.nativeName}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {language.code}
      </span>
    </CommandItem>
  );

  return (
    // Modal: the list is portalled outside the template dialog, whose scroll
    // lock would otherwise swallow wheel and touch scrolling over it.
    <Popover
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen);
        if (!nextOpen) onBlur?.();
      }}
      modal
    >
      <PopoverTrigger asChild>
        <Button
          ref={ref}
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          className="h-9 w-full min-w-0 justify-between gap-2 px-3 text-sm font-normal"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              !selected && "text-muted-foreground"
            )}
          >
            {selected ? selected.name : value || t("form.langPlaceholder")}
          </span>
          {selected ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {selected.code}
            </span>
          ) : null}
          <ChevronsUpDown className="shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <Command filter={filterLanguage}>
          <CommandInput placeholder={t("form.langSearch")} />
          <CommandList>
            <CommandEmpty>{t("form.langEmpty")}</CommandEmpty>
            <CommandGroup>{MAIN_LANGUAGES.map(renderLanguage)}</CommandGroup>
            {/* cmdk hides the separator while a search is typed. */}
            <CommandSeparator />
            <CommandGroup>{OTHER_LANGUAGES.map(renderLanguage)}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
