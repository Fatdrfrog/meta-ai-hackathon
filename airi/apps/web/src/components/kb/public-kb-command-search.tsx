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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { formatDateSafe } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { ArrowRight, FileText, Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { normalizeWhitespace } from "@icecore/shared/lib/value-utils";
import { escapeRegExp } from "@/lib/regex-utils";

type PublicKBCommandSearchItem = {
  id: string;
  title: string;
  excerpt: string;
  href: string;
  updatedAt: string | null;
};

type PublicKBCommandSearchResponse = {
  items?: PublicKBCommandSearchItem[];
};

type PublicKBCommandSearchProps = {
  companySlug: string;
  locale?: string | null;
  labels: {
    placeholder: string;
    searching: string;
    startTyping: string;
    noResults: string;
    failed?: string;
    retry?: string;
  };
  className?: string;
};

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_RESULT_LIMIT = 8;

function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = useMemo(
    () =>
      Array.from(
        new Set(
          normalizeWhitespace(query)
            .split(" ")
            .map(term => term.toLowerCase())
            .filter(term => term.length >= 2)
        )
      ),
    [query]
  );

  if (terms.length === 0 || !text) {
    return <>{text}</>;
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "i");
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) =>
        terms.includes(part.toLowerCase()) ? (
          <mark
            key={`${part}-${index}`}
            className="rounded-[3px] bg-primary/12 px-0.5 text-foreground"
          >
            {part}
          </mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        )
      )}
    </>
  );
}

const fetchSearchResults = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Search failed");
  }
  return (await response.json()) as PublicKBCommandSearchResponse;
};

export function PublicKBCommandSearch({
  companySlug,
  locale,
  labels,
  className,
}: PublicKBCommandSearchProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [modifierKey, setModifierKey] = useState("Cmd");
  const normalizedQuery = normalizeWhitespace(query);
  const canSearch = debouncedQuery.length >= 2;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(normalizeWhitespace(query));
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const isApple =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
    setModifierKey(isApple ? "Cmd" : "Ctrl");
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }

      event.preventDefault();
      setOpen(current => !current);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const searchUrl = useMemo(() => {
    if (!canSearch) {
      return null;
    }

    const params = new URLSearchParams({
      q: debouncedQuery,
      limit: String(SEARCH_RESULT_LIMIT),
    });

    if (locale) {
      params.set("locale", locale);
    }

    return `/api/public-kb/${encodeURIComponent(companySlug)}/search?${params.toString()}`;
  }, [canSearch, companySlug, debouncedQuery, locale]);

  const { data, error, isLoading, isValidating, mutate } =
    useSWR<PublicKBCommandSearchResponse>(searchUrl, fetchSearchResults, {
      keepPreviousData: false,
      revalidateOnFocus: false,
    });

  const results = data?.items ?? [];
  const showLoading = canSearch && (isLoading || isValidating);
  const triggerLabel = labels.placeholder;

  function openResult(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-9 gap-2 px-2.5 sm:px-3"
        aria-label={triggerLabel}
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <KbdGroup className="hidden gap-0.5 sm:inline-flex">
          <Kbd className="h-5 min-w-5 rounded-[4px] px-1 text-[10px]">
            {modifierKey}
          </Kbd>
          <span className="text-[11px] leading-none">+</span>
          <Kbd className="h-5 min-w-5 rounded-[4px] px-1 text-[10px]">K</Kbd>
        </KbdGroup>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-2xl"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{triggerLabel}</DialogTitle>
            <DialogDescription>{triggerLabel}</DialogDescription>
          </DialogHeader>
          <Command
            shouldFilter={false}
            className="rounded-lg border-0 bg-background"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={triggerLabel}
              className="text-[15px]"
            />
            <CommandList className="max-h-[min(70svh,32rem)]">
              {showLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {labels.searching}
                </div>
              ) : null}

              {!showLoading && !canSearch ? (
                <CommandEmpty>{labels.startTyping}</CommandEmpty>
              ) : null}

              {!showLoading && canSearch && error ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-sm text-muted-foreground">
                  <p>{labels.failed || "Could not search articles"}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void mutate();
                    }}
                  >
                    {labels.retry || "Retry"}
                  </Button>
                </div>
              ) : null}

              {!showLoading && !error && canSearch && results.length === 0 ? (
                <CommandEmpty>{labels.noResults}</CommandEmpty>
              ) : null}

              {!error && results.length > 0 ? (
                <CommandGroup>
                  {results.map(item => (
                    <CommandItem
                      key={item.id}
                      value={item.href}
                      onSelect={() => openResult(item.href)}
                      className="items-start gap-3 px-3 py-3"
                    >
                      <FileText
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium leading-5">
                            <HighlightedText
                              text={item.title}
                              query={normalizedQuery}
                            />
                          </span>
                          {item.updatedAt ? (
                            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                              {formatDateSafe(item.updatedAt)}
                            </span>
                          ) : null}
                        </div>
                        {item.excerpt ? (
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                            <HighlightedText
                              text={item.excerpt}
                              query={normalizedQuery}
                            />
                          </p>
                        ) : null}
                      </div>
                      <ArrowRight
                        className="mt-0.5 h-4 w-4 shrink-0 opacity-55"
                        aria-hidden="true"
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
