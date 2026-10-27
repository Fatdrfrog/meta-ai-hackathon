"use client";

import { Button } from "@/components/ui/button";
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
import { getCountryLabel, ISO_COUNTRY_CODES } from "@/lib/geo/countries";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";

type CountryOption = { code: string; label: string; searchValue: string };

/** "Kazakhstan (KZ)" in the app locale, or the bare code when it has no name. */
export function formatCountryOption(code: string, locale: string): string {
  const name = getCountryLabel(code, locale);
  return name === code ? code : `${name} (${code})`;
}

function buildCountryOptions(locale: string): CountryOption[] {
  const collator = new Intl.Collator(locale === "kz" ? "kk" : locale);
  return ISO_COUNTRY_CODES.map(code => {
    const name = getCountryLabel(code, locale);
    return {
      code,
      label: formatCountryOption(code, locale),
      searchValue: `${name} ${code}`,
    };
  }).sort((left, right) => collator.compare(left.label, right.label));
}

function filterCountry(value: string, search: string): number {
  return value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    ? 1
    : 0;
}

/** A searchable list of every ISO country, labelled in the app locale. */
export function CountrySelect({
  id,
  value,
  onChange,
  disabled,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  /** An ISO 3166-1 alpha-2 code, or "" when none is chosen. */
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const t = useTranslations("BusinessLocationsSettings");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const options = useMemo(() => buildCountryOptions(locale), [locale]);
  const selected = value ? formatCountryOption(value, locale) : "";

  return (
    // Modal: the list is portalled outside the office dialog, whose scroll
    // lock would otherwise swallow wheel and touch scrolling over it.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          className="h-9 w-full min-w-0 justify-between px-3 text-sm font-normal"
        >
          <span
            className={cn("truncate", !selected && "text-muted-foreground")}
          >
            {selected || t("countrySelect.placeholder")}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <Command filter={filterCountry}>
          <CommandInput placeholder={t("countrySelect.search")} />
          <CommandList>
            <CommandEmpty>{t("countrySelect.empty")}</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem
                  key={option.code}
                  value={option.searchValue}
                  onSelect={() => {
                    onChange(option.code);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      option.code === value ? "opacity-100" : "opacity-0"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
