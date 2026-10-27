"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { languageSwitcherLocales, type Locale } from "@/i18n/locales";
import {
  getKBLocaleLabel,
  getKBLocalizationDeleteError,
  type KBArticleLocalizationMeta,
  type KBLocalizationCreateMode,
} from "@/lib/kb/kb-localization-actions";
import { buildPublicKBArticleHref } from "@/lib/kb/kb-route-prefetch";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Check,
  ChevronDown,
  Copy,
  FilePlus2,
  Globe2,
  Languages,
  Loader2,
  MoreHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

type Props = {
  articleId?: string;
  currentLocale: Locale;
  defaultLocale: Locale;
  localizations: readonly KBArticleLocalizationMeta[];
  hasLocalization: boolean;
  saveBeforeNavigate?: () => Promise<boolean>;
  onLocalizationChanged?: () => Promise<void> | void;
  companySlug?: string | null;
};

type PendingCreate = {
  locale: Locale;
  mode?: KBLocalizationCreateMode;
};

function buildLocaleHref({
  pathname,
  searchParams,
  locale,
}: {
  pathname: string;
  searchParams: URLSearchParams;
  locale: Locale;
}) {
  const params = new URLSearchParams(searchParams.toString());
  params.set("locale", locale);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function getStatusLabel(
  meta: KBArticleLocalizationMeta | undefined,
  t: ReturnType<typeof useTranslations>
) {
  if (!meta) return t("newTranslation");
  if (meta.status === "published") {
    return meta.hasDraft ? t("publishedDraft") : t("published");
  }
  return t("draft");
}

function getStatusDotClass(meta: KBArticleLocalizationMeta | undefined) {
  if (!meta) return "bg-muted-foreground/35";
  if (meta.status === "published") {
    return meta.hasDraft ? "bg-amber-500" : "bg-emerald-500";
  }
  return "bg-slate-400";
}

export function KBArticleLanguageControl({
  articleId,
  currentLocale,
  defaultLocale,
  localizations,
  hasLocalization,
  saveBeforeNavigate,
  onLocalizationChanged,
  companySlug,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const t = useTranslations("KnowledgeBase.languageControl");

  const localizationsByLocale = useMemo(
    () =>
      new Map<Locale, KBArticleLocalizationMeta>(
        localizations.map(localization => [localization.locale, localization])
      ),
    [localizations]
  );
  const currentMeta = localizationsByLocale.get(currentLocale);
  const existingLocales = localizations.map(
    localization => localization.locale
  );
  const sourceLocales = existingLocales.filter(
    locale => locale !== currentLocale
  );
  const deleteError = getKBLocalizationDeleteError({
    targetLocale: currentLocale,
    defaultLocale,
    availableLocaleCount: localizations.length,
  });
  const canCopyPublicLink =
    Boolean(articleId) && currentMeta?.status === "published" && companySlug;

  const navigateToLocale = async (locale: Locale) => {
    if (locale === currentLocale || !pathname) return;

    const canNavigate = saveBeforeNavigate ? await saveBeforeNavigate() : true;
    if (!canNavigate) return;

    setPopoverOpen(false);
    const href = buildLocaleHref({
      pathname,
      searchParams,
      locale,
    });
    startTransition(() => router.push(href));
  };

  const runLocalizationMutation = async ({
    targetLocale,
    mode,
    sourceLocale,
    overwrite,
  }: {
    targetLocale: Locale;
    mode: KBLocalizationCreateMode;
    sourceLocale?: Locale;
    overwrite?: boolean;
  }) => {
    if (!articleId) {
      toast.error(t("saveFirst"));
      return;
    }

    const loadingKey = `${targetLocale}:${mode}:${sourceLocale ?? ""}`;
    setActionLoading(loadingKey);
    try {
      const payload: {
        targetLocale: Locale;
        mode: KBLocalizationCreateMode;
        sourceLocale?: Locale;
        overwrite?: boolean;
      } = { targetLocale, mode };
      if (sourceLocale) payload.sourceLocale = sourceLocale;
      if (overwrite) payload.overwrite = true;

      const response = await fetch(`/api/kb/${articleId}/localizations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || t("updateFailed"));
      }

      if (pathname) {
        router.push(
          buildLocaleHref({
            pathname,
            searchParams,
            locale: targetLocale,
          })
        );
      }

      toast.success(t("draftReady", { language: getKBLocaleLabel(targetLocale) }));
      setPendingCreate(null);
      setPopoverOpen(false);
      await onLocalizationChanged?.();
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("updateFailed")
      );
    } finally {
      setActionLoading(null);
    }
  };

  const createPendingLocale = (mode: KBLocalizationCreateMode) => {
    if (!pendingCreate) return;
    void runLocalizationMutation({
      targetLocale: pendingCreate.locale,
      mode,
      sourceLocale: currentLocale,
    });
  };

  const deleteCurrentLocale = async () => {
    if (!articleId) return;
    if (deleteError) {
      toast.error(deleteError);
      return;
    }

    setActionLoading("delete");
    try {
      const response = await fetch(
        `/api/kb/${articleId}/localizations/${currentLocale}`,
        {
          method: "DELETE",
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || t("deleteFailed"));
      }

      toast.success(
        t("translationDeleted", { language: getKBLocaleLabel(currentLocale) })
      );
      await onLocalizationChanged?.();
      router.refresh();

      if (pathname) {
        startTransition(() => {
          router.push(
            buildLocaleHref({
              pathname,
              searchParams,
              locale: defaultLocale,
            })
          );
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("deleteFailed")
      );
    } finally {
      setActionLoading(null);
      setDeleteOpen(false);
    }
  };

  const copyPublicLink = async () => {
    if (!articleId || !companySlug) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const url = `${origin}${buildPublicKBArticleHref(
      companySlug,
      articleId,
      currentLocale
    )}`;

    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("publicLinkCopied"));
    } catch {
      toast.error(t("copyPublicLinkFailed"));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-md border border-border/60 bg-background px-2 text-xs font-medium text-foreground shadow-none hover:bg-muted/60"
            disabled={isPending}
          >
            <Languages className="h-3.5 w-3.5 text-muted-foreground" />
            {getKBLocaleLabel(currentLocale)}
            <span
              className={cn(
                "ml-1 h-1.5 w-1.5 rounded-full",
                getStatusDotClass(currentMeta)
              )}
              aria-hidden="true"
            />
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 rounded-lg border-border/70 p-1 shadow-xl"
        >
          <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("articleLanguage")}
          </div>
          <div className="space-y-0.5">
            {languageSwitcherLocales.map(locale => {
              const meta = localizationsByLocale.get(locale);
              const isActive = locale === currentLocale;
              const label = getKBLocaleLabel(locale);
              const status = getStatusLabel(meta, t);

              return (
                <button
                  key={locale}
                  type="button"
                  disabled={isActive}
                  onClick={() => {
                    if (meta) {
                      void navigateToLocale(locale);
                    } else {
                      setPendingCreate({ locale });
                      setPopoverOpen(false);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 disabled:cursor-default disabled:opacity-100",
                    isActive && "bg-muted/60"
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      getStatusDotClass(meta)
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium leading-none">
                      {label}
                    </span>
                    <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                      {status}
                    </span>
                  </span>
                  {isActive ? <Check className="h-4 w-4" /> : null}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <span className="rounded-md px-1.5 py-1 text-xs text-muted-foreground">
        {getStatusLabel(currentMeta, t)}
      </span>
      {!hasLocalization ? (
        <span className="rounded-md bg-muted px-1.5 py-1 text-xs text-muted-foreground">
          {t("newTranslation")}
        </span>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
            disabled={!articleId || actionLoading !== null}
          >
            {actionLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MoreHorizontal className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">{t("languageActions")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {getKBLocaleLabel(currentLocale)}
          </DropdownMenuLabel>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={sourceLocales.length === 0}>
              <Copy className="h-4 w-4" />
              {t("duplicateFrom")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {sourceLocales.map(locale => (
                <DropdownMenuItem
                  key={locale}
                  onClick={() =>
                    void runLocalizationMutation({
                      targetLocale: currentLocale,
                      mode: "copy_locale",
                      sourceLocale: locale,
                      overwrite: true,
                    })
                  }
                >
                  {getKBLocaleLabel(locale)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={sourceLocales.length === 0}>
              <Sparkles className="h-4 w-4" />
              {t("translateFrom")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {sourceLocales.map(locale => (
                <DropdownMenuItem
                  key={locale}
                  onClick={() =>
                    void runLocalizationMutation({
                      targetLocale: currentLocale,
                      mode: "ai_translate",
                      sourceLocale: locale,
                      overwrite: true,
                    })
                  }
                >
                  {getKBLocaleLabel(locale)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onClick={copyPublicLink}
            disabled={!canCopyPublicLink}
          >
            <Globe2 className="h-4 w-4" />
            {t("copyPublicLink")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={Boolean(deleteError) || actionLoading !== null}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t("deleteTranslation")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pendingCreate !== null}
        onOpenChange={open => {
          if (!open) setPendingCreate(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("createVersion", {
                language: pendingCreate
                  ? getKBLocaleLabel(pendingCreate.locale)
                  : "",
              })}
            </DialogTitle>
            <DialogDescription>{t("createVersionDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Button
              type="button"
              variant="ghost"
              className="h-auto justify-start gap-3 rounded-md px-3 py-2 text-left"
              onClick={() => createPendingLocale("empty")}
              disabled={actionLoading !== null}
            >
              <FilePlus2 className="h-4 w-4 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("startEmpty")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("startEmptyDesc")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto justify-start gap-3 rounded-md px-3 py-2 text-left"
              onClick={() => createPendingLocale("copy_current")}
              disabled={actionLoading !== null}
            >
              <Copy className="h-4 w-4 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("copyFromCurrent")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("copyFromCurrentDesc")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto justify-start gap-3 rounded-md px-3 py-2 text-left"
              onClick={() => createPendingLocale("copy_default")}
              disabled={actionLoading !== null}
            >
              <Copy className="h-4 w-4 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("copyFromDefault")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("copyFromDefaultDesc", {
                    language: getKBLocaleLabel(defaultLocale),
                  })}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto justify-start gap-3 rounded-md px-3 py-2 text-left"
              onClick={() => createPendingLocale("ai_translate")}
              disabled={actionLoading !== null}
            >
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {t("translateWithAi")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("translateWithAiDesc")}
                </span>
              </span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTranslationTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteTranslationDescription", {
                language: getKBLocaleLabel(currentLocale),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteCurrentLocale}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("deleteTranslation")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
