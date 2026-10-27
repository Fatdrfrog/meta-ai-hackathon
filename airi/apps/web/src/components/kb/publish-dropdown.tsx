"use client";

import { SaveStatusBadge } from "@/components/kb/save-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { KBArticlePublishMode } from "@/lib/kb/kb-editor-state";
import { companySlugAtom } from "@/lib/navigation/company-slug-state";
import { buildPublicKBArticleHref } from "@/lib/kb/kb-route-prefetch";
import { useAtomValue } from "jotai";
import { Copy, Globe, Loader2, Lock, Share2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

interface PublishDropdownProps {
  onPublish?: () => Promise<void>;
  isPublishing?: boolean;
  saveStatus?: "saved" | "saving" | "error" | "unsaved";
  publishMode?: KBArticlePublishMode;
  onPublishModeChange?: (mode: KBArticlePublishMode) => void;
  articleId?: string;
  articleStatus?: string | null;
  locale?: string | null;
  hasLocaleDraft?: boolean;
  onUnpublish?: () => Promise<void>;
  isUnpublishing?: boolean;
}

export function PublishDropdown({
  onPublish,
  isPublishing = false,
  saveStatus = "saved",
  publishMode = "public_with_auto_link",
  onPublishModeChange,
  articleId,
  articleStatus,
  locale,
  hasLocaleDraft = false,
  onUnpublish,
  isUnpublishing = false,
}: PublishDropdownProps) {
  const t = useTranslations("KnowledgeBase.articleEditor");
  const companySlug = useAtomValue(companySlugAtom);
  const [isCopying, setIsCopying] = useState(false);

  const getPublicUrl = () => {
    if (!articleId) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}${buildPublicKBArticleHref(
      companySlug ?? undefined,
      articleId,
      locale
    )}`;
  };

  const handlePublishToWeb = async () => {
    if (!onPublish) return;
    try {
      await onPublish();
    } catch (error) {
      console.error("Error publishing:", error);
      const message =
        error instanceof Error
          ? error.message
          : String(error || "Unknown error");
      toast.error(
        t("publishFailed") || "Could not publish",
        message ? { description: message } : undefined
      );
    }
  };

  const handleCopyLink = async () => {
    const url = getPublicUrl();
    if (!url) {
      toast.error("Unable to generate link. Please save first.");
      return;
    }

    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("linkCopied") || "Link copied to clipboard");
    } catch (error) {
      console.error("Failed to copy link:", error);
      toast.error("Failed to copy link");
    } finally {
      setIsCopying(false);
    }
  };

  const handleShareLink = () => {
    const url = getPublicUrl();
    if (!url) {
      toast.error("Unable to generate link. Please save first.");
      return;
    }

    if (navigator.share) {
      navigator
        .share({
          title: "Knowledge Base Article",
          url,
        })
        .catch(() => {
          handleCopyLink();
        });
    } else {
      handleCopyLink();
    }
  };

  const handleUnpublish = async () => {
    if (!onUnpublish) return;
    try {
      await onUnpublish();
    } catch (error) {
      console.error("Error unpublishing:", error);
    }
  };

  const isPublic = publishMode !== "ai_context_only";
  const autoLinkEnabled = publishMode === "public_with_auto_link";
  const isSaving = saveStatus === "saving";
  const isPublished = articleStatus === "published";
  const canSharePublicLink = isPublished && isPublic;
  const isBusy = isPublishing || isUnpublishing;
  const publishActionLabel = isPublished
    ? t("publishChanges") || "Publish changes"
    : publishMode === "ai_context_only"
      ? t("publishMode.publishToAiContext")
      : t("publishToWeb") || "Publish to web";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={isBusy} size="sm" variant="default" className="gap-2">
          {isBusy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {isUnpublishing
                ? t("unpublishing") || "Unpublishing..."
                : t("publishing") || "Publishing..."}
            </>
          ) : (
            <>
              {isPublic ? (
                <Globe className="h-4 w-4" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              {publishActionLabel}
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="p-4 pb-3 select-none shadow-2xl border-border/40 space-y-5"
      >
        <div className="space-y-3">
          <h4 className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-[0.1em] px-1">
            {t("publishMode.title")}
          </h4>
          <div className="flex items-start gap-3 px-1">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isPublic ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-muted/50 text-muted-foreground"}`}
            >
              {isPublic ? (
                <Globe className="h-5 w-5" />
              ) : (
                <Lock className="h-5 w-5" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <Select
                value={publishMode}
                onValueChange={value =>
                  onPublishModeChange?.(value as KBArticlePublishMode)
                }
              >
                <SelectTrigger className="h-auto border-none shadow-none focus:ring-0 text-[13.5px] font-semibold hover:bg-transparent text-left w-full group flex p-2">
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-1.5 leading-none group-hover:text-primary transition-colors">
                      <span className="text-xs">
                        {publishMode === "public_with_auto_link" &&
                          t("publishMode.publicWithAutoLink")}
                        {publishMode === "public_without_auto_link" &&
                          t("publishMode.publicNoAutoLink")}
                        {publishMode === "ai_context_only" &&
                          t("publishMode.aiContextOnly")}
                      </span>
                    </div>
                    <span className="text-[11px] font-normal text-muted-foreground/70 leading-none">
                      {publishMode === "public_with_auto_link" &&
                        t("publishMode.publicWithAutoLinkDesc")}
                      {publishMode === "public_without_auto_link" &&
                        t("publishMode.publicNoAutoLinkDesc")}
                      {publishMode === "ai_context_only" &&
                        t("publishMode.aiContextOnlyDesc")}
                    </span>
                  </div>
                </SelectTrigger>
                <SelectContent align="start" className="w-[308px] p-1">
                  <SelectItem
                    value="public_with_auto_link"
                    className="py-3 rounded-md transition-colors w-full"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
                        <Globe className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-[13px]">
                          {t("publishMode.publicWithAutoLinkShort")}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          {t("publishMode.publicWithAutoLinkDescShort")}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem
                    value="public_without_auto_link"
                    className="py-3 rounded-md transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        <Sparkles className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-[13px]">
                          {t("publishMode.publicNoAutoLinkShort")}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          {t("publishMode.publicNoAutoLinkDescShort")}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                  <SelectItem
                    value="ai_context_only"
                    className="py-3 rounded-md transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Lock className="h-4 w-4" />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-[13px]">
                          {t("publishMode.aiContextOnlyShort")}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          {t("publishMode.aiContextOnlyDescShort")}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DropdownMenuSeparator className="-mx-4 opacity-40" />

        <div className="space-y-3 px-1">
          <Button
            variant="default"
            className="w-full justify-center h-10 gap-2.5 text-[13px] font-semibold shadow-md hover:shadow-lg transition-[box-shadow,transform] active:scale-[0.98]"
            onClick={handlePublishToWeb}
            disabled={isBusy || isSaving}
          >
            {isPublishing || isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                {isPublic ? (
                  <Globe className="h-4 w-4" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
              </>
            )}
            {publishActionLabel}
          </Button>

          {isPublished ? (
            <Button
              variant="outline"
              className="w-full justify-center h-10 gap-2.5 text-[13px] font-semibold border-border/50 hover:bg-accent/50"
              onClick={handleUnpublish}
              disabled={isBusy || !onUnpublish}
            >
              {isUnpublishing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              {t("unpublishLanguage") || "Unpublish this language"}
            </Button>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-10 text-[12px] font-medium gap-2 border-border/50 hover:bg-accent/50 hover:border-border transition-colors active:scale-[0.98]"
              onClick={handleCopyLink}
              disabled={!canSharePublicLink || !articleId || isCopying}
            >
              {isCopying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {t("copyLink") || "Copy link"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-10 text-[12px] font-medium gap-2 border-border/50 hover:bg-accent/50 hover:border-border transition-colors active:scale-[0.98]"
              onClick={handleShareLink}
              disabled={!canSharePublicLink || !articleId}
            >
              <Share2 className="h-3.5 w-3.5" />
              {t("shareLink") || "Share"}
            </Button>
          </div>
          {!autoLinkEnabled && (
            <p className="text-[11px] text-muted-foreground text-center">
              {t("publishMode.autoLinkDisabled")}
            </p>
          )}
          {isPublished && hasLocaleDraft ? (
            <p className="text-[11px] text-muted-foreground text-center">
              {t("unpublishedChangesHint") ||
                "This language has unpublished changes."}
            </p>
          ) : null}
        </div>

        <div className="pt-2 border-t border-border/20 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <SaveStatusBadge status={saveStatus} />
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
