"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface IndexedUrl {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  index_status: "indexed" | "failed" | "pending";
  last_indexed_at: string | null;
  error_message: string | null;
  created_at: string;
}

export function PublicUrlIndexer() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const t = useTranslations("PublicUrlIndexer");
  const [urls, setUrls] = useState<IndexedUrl[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [limit, setLimit] = useState(5);
  const [remaining, setRemaining] = useState(5);

  const fetchUrls = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!workspaceId) {
        setIsLoading(false);
        return;
      }
      try {
        if (!options?.silent) setLoadError(false);
        if (!options?.silent) setIsLoading(true);
        const response = await fetch(
          `/api/kb/indexed-urls?workspaceId=${encodeURIComponent(workspaceId)}`
        );
        if (!response.ok) {
          throw new Error(t("loadFailed"));
        }
        const data = await response.json();
        if (!Array.isArray(data.urls)) throw new Error("invalid list");
        setUrls(data.urls);
        setLimit(data.limit ?? 5);
        setRemaining(data.remaining ?? 0);
        setLoadError(false);
      } catch {
        setLoadError(true);
        if (!options?.silent) toast.error(t("loadFailed"));
      } finally {
        if (!options?.silent) setIsLoading(false);
      }
    },
    [workspaceId, t]
  );

  useEffect(() => {
    void fetchUrls();
  }, [fetchUrls]);

  useEffect(() => {
    if (!urls.some(url => url.index_status === "pending")) return;

    const timer = setInterval(() => {
      void fetchUrls({ silent: true });
    }, 3000);

    return () => clearInterval(timer);
  }, [fetchUrls, urls]);

  const handleAddUrl = async () => {
    if (isLoading || loadError || isAdding || remaining <= 0) return;
    if (!workspaceId) {
      toast.error(t("loadFailed"));
      return;
    }
    if (!newUrl.trim()) {
      toast.error(t("invalidUrl"));
      return;
    }

    try {
      const parsed = new URL(newUrl.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      toast.error(t("invalidUrl"));
      return;
    }

    try {
      setIsAdding(true);
      const response = await fetch("/api/kb/indexed-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl.trim(), workspaceId }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || t("addFailed"));
      }

      toast.success(t(result.queued ? "indexQueued" : "indexSuccess"), {
        description: result.title || newUrl,
      });
      setNewUrl("");
      await fetchUrls(); // Refresh list
    } catch (error) {
      const message = error instanceof Error ? error.message : t("addFailed");
      toast.error(message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteUrl = async (urlId: string) => {
    if (busyId) return;
    if (!confirm(t("deleteConfirm"))) {
      return;
    }
    if (!workspaceId) {
      toast.error(t("loadFailed"));
      return;
    }

    try {
      setBusyId(urlId);
      const response = await fetch(
        `/api/kb/indexed-urls?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(urlId)}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(t("deleteFailed"));
      }

      toast.success(t("deleteSuccess"));
      await fetchUrls(); // Refresh list
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const handleReindex = async (urlId: string) => {
    if (busyId) return;
    if (!workspaceId) {
      toast.error(t("loadFailed"));
      return;
    }
    try {
      setBusyId(urlId);
      const response = await fetch(`/api/kb/indexed-urls/reindex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urlId, workspaceId }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || t("reindexFailed"));
      }

      toast.success(t("reindexSuccess"), {
        description: t("reindexDesc"),
      });
      await fetchUrls(); // Refresh list
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("reindexFailed");
      toast.error(message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-5 w-5 text-muted-foreground" />
              {t("title")}
            </CardTitle>
            <CardDescription className="mt-1">
              {t("description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="@container/public-urls space-y-4">
        {/* Add URL Form */}
        <div className="space-y-2">
          <Label htmlFor="url-input">{t("addUrlLabel")}</Label>
          <div className="flex flex-col gap-2 @min-[20rem]/public-urls:flex-row">
            <Input
              id="url-input"
              type="url"
              placeholder={t("addUrlPlaceholder")}
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !isAdding) {
                  handleAddUrl();
                }
              }}
              className="min-w-0 flex-1"
              disabled={isLoading || loadError || isAdding || remaining <= 0}
            />
            <Button
              onClick={handleAddUrl}
              className="shrink-0"
              disabled={
                isLoading ||
                loadError ||
                isAdding ||
                remaining <= 0 ||
                !newUrl.trim()
              }
            >
              {isAdding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("addButton")
              )}
            </Button>
          </div>
          {!isLoading && !loadError && (
            <p className="text-xs text-muted-foreground">
              {remaining > 0
                ? t("remaining", { remaining, limit })
                : t("limitReached", { limit })}
            </p>
          )}
        </div>

        {/* URL List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <span>{t("loadFailed")}</span>
            <Button size="sm" variant="outline" onClick={() => fetchUrls()}>
              {t("retry")}
            </Button>
          </div>
        ) : urls.length === 0 ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{t("noUrls")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            {urls.map(url => (
              <div
                key={url.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex-1 space-y-1 min-w-0">
                  <div className="flex items-start gap-2">
                    <Link2 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-medium text-sm truncate">
                          {url.title || url.url}
                        </h4>
                        {url.index_status === "indexed" && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                            {t("indexed")}
                          </span>
                        )}
                        {url.index_status === "failed" && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                            {t("failed")}
                          </span>
                        )}
                        {url.index_status === "pending" && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                            {t("pending")}
                          </span>
                        )}
                      </div>
                      <a
                        href={url.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline flex items-center gap-1 truncate"
                      >
                        {url.url}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      {url.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {url.description}
                        </p>
                      )}
                      {url.error_message && (
                        <p className="break-words text-xs text-red-600 dark:text-red-400">
                          {url.error_message}
                        </p>
                      )}
                      {url.last_indexed_at && (
                        <p className="text-xs text-muted-foreground">
                          {t("lastIndexed", {
                            date: new Date(
                              url.last_indexed_at
                            ).toLocaleDateString(),
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReindex(url.id)}
                    aria-label={t("reindexUrl", { url: url.title || url.url })}
                    disabled={busyId !== null || url.index_status === "pending"}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("deleteUrl", { url: url.title || url.url })}
                    disabled={busyId !== null}
                    onClick={() => handleDeleteUrl(url.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
