"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  TikTokDiscoveryCategory,
  TikTokDiscoveryMarket,
  TikTokDiscoveryPreferences,
  TikTokMarketingTemplateCatalogItem,
  TikTokMarketingTemplatesResponse,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  ExternalLink,
  ImageIcon,
  Info,
  RefreshCw,
} from "lucide-react";
import { memo, useId, useState } from "react";

export type MarketingTemplatesTranslationFn = (
  key: string,
  values?: Record<string, number | string>
) => string;

export type TikTokInspirationFilterOption<T extends string> = {
  value: T;
  label: string;
  searchValue: string;
};

type OkResponse = Extract<TikTokMarketingTemplatesResponse, { status: "ok" }>;

export type TikTokInspirationCatalogState =
  | {
      kind: "success";
      response: OkResponse;
      stale: boolean;
      refreshing: boolean;
    }
  | { kind: "transport_error"; retrying: boolean }
  | { kind: "loading"; skeletonCount: number }
  | { kind: "unavailable"; retrying: boolean }
  | { kind: "temporarily_unavailable"; retrying: boolean }
  | { kind: "provider_error"; retryable: boolean; retrying: boolean };

export type TikTokInspirationViewProps = {
  t: MarketingTemplatesTranslationFn;
  preferences: TikTokDiscoveryPreferences;
  markets: TikTokInspirationFilterOption<TikTokDiscoveryMarket>[];
  categories: TikTokInspirationFilterOption<TikTokDiscoveryCategory>[];
  catalogState: TikTokInspirationCatalogState;
  canResetFilters: boolean;
  onUpdatePreferences: (next: TikTokDiscoveryPreferences) => void;
  onRetry: () => void;
  onResetFilters: () => void;
  onUseReference: (item: TikTokMarketingTemplateCatalogItem) => void;
};

const TIKTOK_SHARE_ROOTS = ["tiktok.com"] as const;
const TIKTOK_THUMBNAIL_ROOTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "muscdn.com",
] as const;

function safeExternalUrl(
  value: unknown,
  roots: readonly string[]
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowed = roots.some(
      root => hostname === root || hostname.endsWith(`.${root}`)
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !allowed
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function filterOption(value: string, search: string): number {
  return value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    ? 1
    : 0;
}

function FilterCombobox<T extends string>({
  label,
  value,
  options,
  searchPlaceholder,
  emptyLabel,
  onSelect,
}: {
  label: string;
  value: T;
  options: TikTokInspirationFilterOption<T>[];
  searchPlaceholder: string;
  emptyLabel: string;
  onSelect: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const contentId = `${triggerId}-options`;
  const selected = options.find(option => option.value === value);

  return (
    <Field className="min-w-0 gap-1.5 sm:max-w-64 sm:flex-1">
      <FieldLabel htmlFor={triggerId} className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={triggerId}
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={contentId}
            className="h-10 w-full min-w-0 justify-between rounded-md px-3 text-sm"
          >
            <span className="truncate">{selected?.label || value}</span>
            <ChevronsUpDown
              data-icon="inline-end"
              className="shrink-0 opacity-50"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={contentId}
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))] p-0"
        >
          <Command filter={filterOption}>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map(option => (
                  <CommandItem
                    key={option.value}
                    value={option.searchValue}
                    onSelect={() => {
                      onSelect(option.value);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        option.value === value ? "opacity-100" : "opacity-0"
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
    </Field>
  );
}

const TikTokReferenceCard = memo(function TikTokReferenceCard({
  item,
  t,
  onUseReference,
}: {
  item: TikTokMarketingTemplateCatalogItem;
  t: MarketingTemplatesTranslationFn;
  onUseReference: (item: TikTokMarketingTemplateCatalogItem) => void;
}) {
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(
    null
  );
  const shareUrl = safeExternalUrl(item.reference.shareUrl, TIKTOK_SHARE_ROOTS);
  const thumbnailUrl = safeExternalUrl(
    item.reference.thumbnailUrl,
    TIKTOK_THUMBNAIL_ROOTS
  );
  const showThumbnail =
    thumbnailUrl && failedThumbnailUrl !== thumbnailUrl ? thumbnailUrl : null;

  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <CardContent className="relative aspect-[9/14] overflow-hidden bg-muted/40 p-0">
        {showThumbnail ? (
          <>
            {/* Direct provider thumbnail: intentionally not proxied or persisted. */}
            {/* `next/image` with `unoptimized` adds JS without changing this allowlisted provider request. */}
            {/* eslint-disable @next/next/no-img-element */}
            {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- native lazy loading is the lean provider boundary */}
            <img
              src={showThumbnail}
              alt={item.title}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailedThumbnailUrl(showThumbnail)}
              className="h-full w-full object-cover"
            />
            {/* eslint-enable @next/next/no-img-element */}
          </>
        ) : (
          <figure
            className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
            data-testid="tiktok-template-thumbnail-fallback"
            aria-label={t("marketingTemplatesTikTokImageUnavailable")}
          >
            <ImageIcon
              className="size-8 text-muted-foreground"
              aria-hidden="true"
            />
            <figcaption className="text-xs text-muted-foreground">
              {t("marketingTemplatesTikTokImageUnavailable")}
            </figcaption>
          </figure>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent p-3 pt-12">
          <h3 className="line-clamp-2 break-words text-sm font-medium">
            {item.title}
          </h3>
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
            {item.reference.creatorName
              ? `@${item.reference.creatorName} · `
              : ""}
            #{item.reference.hashtag}
          </p>
        </div>
      </CardContent>
      {shareUrl ? (
        <CardFooter className="flex-col gap-2 border-t p-3">
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={() => onUseReference(item)}
          >
            {t("referenceVideoUseIdea")}
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full">
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              aria-label={t("marketingTemplatesTikTokOpenReference", {
                title: item.title,
              })}
            >
              {t("marketingTemplatesTikTokViewReference")}
              <ExternalLink data-icon="inline-end" aria-hidden="true" />
            </a>
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
});

function TikTokSkeletons({ label, count }: { label: string; count: number }) {
  return (
    <>
      <output className="sr-only" aria-live="polite">
        {label}
      </output>
      <div
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        aria-hidden="true"
      >
        {Array.from({ length: count }, (_, index) => (
          <Card
            key={index}
            className="min-w-0 gap-0 overflow-hidden py-0"
            data-testid="tiktok-template-skeleton"
          >
            <Skeleton className="aspect-[9/14] rounded-none" />
            <CardContent className="grid gap-2 p-3">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function RetryButton({
  retrying,
  retryLabel,
  onRetry,
}: {
  retrying: boolean;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={retrying}
      aria-busy={retrying}
      onClick={onRetry}
    >
      <RefreshCw
        data-icon="inline-start"
        className={retrying ? "animate-spin" : undefined}
        aria-hidden="true"
      />
      {retryLabel}
    </Button>
  );
}

function TikTokErrorState({
  title,
  retry,
  retrying,
  retryLabel,
  onRetry,
}: {
  title: string;
  retry?: boolean;
  retrying: boolean;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant={retry ? "destructive" : "default"} aria-live="polite">
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none break-words">{title}</AlertTitle>
      {retry ? (
        <AlertDescription className="mt-2">
          <RetryButton
            retrying={retrying}
            retryLabel={retryLabel}
            onRetry={onRetry}
          />
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

export const TikTokInspirationView = memo(function TikTokInspirationView({
  t,
  preferences,
  markets,
  categories,
  catalogState,
  canResetFilters,
  onUpdatePreferences,
  onRetry,
  onResetFilters,
  onUseReference,
}: TikTokInspirationViewProps) {
  let content;
  if (
    catalogState.kind === "success" &&
    catalogState.response.items.length > 0
  ) {
    content = (
      <>
        {catalogState.stale ? (
          <Alert aria-live="polite">
            <Info aria-hidden="true" />
            <AlertTitle className="line-clamp-none break-words">
              {t("marketingTemplatesTikTokStaleWarning")}
            </AlertTitle>
            <AlertDescription className="mt-2">
              <RetryButton
                retrying={catalogState.refreshing}
                retryLabel={t("marketingTemplatesTikTokRetry")}
                onRetry={onRetry}
              />
            </AlertDescription>
          </Alert>
        ) : null}
        {catalogState.refreshing && !catalogState.stale ? (
          <output className="sr-only" aria-live="polite">
            {t("marketingTemplatesTikTokRefreshing")}
          </output>
        ) : null}
        <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {catalogState.response.items.map(item => (
            <TikTokReferenceCard
              key={item.id}
              item={item}
              t={t}
              onUseReference={onUseReference}
            />
          ))}
        </div>
      </>
    );
  } else if (catalogState.kind === "success") {
    const emptyTitle = t("marketingTemplatesTikTokEmptyTitle");
    content = (
      <output className="block" aria-live="polite">
        <EmptyState
          title={emptyTitle}
          action={
            canResetFilters ? (
              <Button type="button" variant="outline" onClick={onResetFilters}>
                {t("marketingTemplatesTikTokResetFilters")}
              </Button>
            ) : undefined
          }
        />
      </output>
    );
  } else if (catalogState.kind === "transport_error") {
    content = (
      <TikTokErrorState
        title={t("marketingTemplatesTikTokRetryableErrorTitle")}
        retry
        retrying={catalogState.retrying}
        retryLabel={t("marketingTemplatesTikTokRetry")}
        onRetry={onRetry}
      />
    );
  } else if (catalogState.kind === "loading") {
    content = (
      <TikTokSkeletons
        label={t("marketingTemplatesTikTokLoading")}
        count={catalogState.skeletonCount}
      />
    );
  } else if (catalogState.kind === "unavailable") {
    content = (
      <TikTokErrorState
        title={t("marketingTemplatesTikTokUnavailableTitle")}
        retrying={catalogState.retrying}
        retryLabel={t("marketingTemplatesTikTokRetry")}
        onRetry={onRetry}
      />
    );
  } else if (catalogState.kind === "temporarily_unavailable") {
    content = (
      <TikTokErrorState
        title={t("marketingTemplatesTikTokTemporaryTitle")}
        retry
        retrying={catalogState.retrying}
        retryLabel={t("marketingTemplatesTikTokRetry")}
        onRetry={onRetry}
      />
    );
  } else if (catalogState.kind === "provider_error") {
    content = (
      <TikTokErrorState
        title={t(
          catalogState.retryable
            ? "marketingTemplatesTikTokRetryableErrorTitle"
            : "marketingTemplatesTikTokNonretryableErrorTitle"
        )}
        retry={catalogState.retryable}
        retrying={catalogState.retrying}
        retryLabel={t("marketingTemplatesTikTokRetry")}
        onRetry={onRetry}
      />
    );
  } else {
    const emptyTitle = t("marketingTemplatesTikTokEmptyTitle");
    content = (
      <output className="block" aria-live="polite">
        <EmptyState title={emptyTitle} />
      </output>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            {t("marketingTemplatesTikTokTitle")}
          </h3>
        </div>
        {catalogState.kind === "success" ? (
          <Badge variant="secondary" className="shrink-0 rounded-md">
            {t("marketingTemplatesTikTokCount", {
              count: catalogState.response.items.length,
            })}
          </Badge>
        ) : null}
      </div>

      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertDescription>
          {t("marketingTemplatesTikTokReferenceNotice")}
        </AlertDescription>
      </Alert>

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
        <FilterCombobox
          label={t("marketingTemplatesTikTokMarketLabel")}
          value={preferences.market}
          options={markets}
          searchPlaceholder={t("marketingTemplatesTikTokSearch")}
          emptyLabel={t("marketingTemplatesTikTokNoResults")}
          onSelect={market => onUpdatePreferences({ ...preferences, market })}
        />
        <FilterCombobox
          label={t("marketingTemplatesTikTokCategoryLabel")}
          value={preferences.category}
          options={categories}
          searchPlaceholder={t("marketingTemplatesTikTokSearch")}
          emptyLabel={t("marketingTemplatesTikTokNoResults")}
          onSelect={category =>
            onUpdatePreferences({ ...preferences, category })
          }
        />
      </div>

      <div
        aria-busy={
          catalogState.kind === "success"
            ? catalogState.refreshing
            : "retrying" in catalogState
              ? catalogState.retrying
              : catalogState.kind === "loading"
        }
      >
        {content}
      </div>
    </div>
  );
});
