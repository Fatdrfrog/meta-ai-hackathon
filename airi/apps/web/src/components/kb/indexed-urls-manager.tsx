"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ExternalLink,
  Trash2,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Plus,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatRelativeTime } from "@/lib/date-utils";

interface IndexedUrl {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  index_status: "pending" | "indexed" | "failed";
  last_indexed_at: string;
  error_message: string | null;
  created_at: string;
}

interface IndexedUrlsData {
  urls: IndexedUrl[];
  count: number;
  limit: number;
  remaining: number;
}

export function IndexedUrlsManager() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const locale = useLocale();
  const t = useTranslations("IndexedUrlsManager");
  const [data, setData] = useState<IndexedUrlsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const fetchUrls = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!workspaceId) {
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(
          `/api/kb/indexed-urls?workspaceId=${encodeURIComponent(workspaceId)}`
        );
        if (!response.ok) throw new Error("Failed to fetch URLs");
        const data = await response.json();
        setData(data);
      } catch {
        if (!options?.silent) toast.error(t("toast.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, t]
  );

  useEffect(() => {
    void fetchUrls();
  }, [fetchUrls]);

  useEffect(() => {
    if (!data?.urls?.some(url => url.index_status === "pending")) return;

    const timer = setInterval(() => {
      void fetchUrls({ silent: true });
    }, 3000);

    return () => clearInterval(timer);
  }, [data?.urls, fetchUrls]);

  const handleAdd = async () => {
    if (!newUrl.trim()) {
      toast.error(t("validation.enterUrl"));
      return;
    }

    try {
      new URL(newUrl);
    } catch {
      toast.error(t("validation.invalidUrl"));
      return;
    }

    if (!workspaceId) {
      toast.error(t("toast.loadFailed"));
      return;
    }

    setAdding(true);
    try {
      const response = await fetch("/api/kb/indexed-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl, workspaceId }),
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(result.error || t("toast.addFailed"));
        return;
      }

      toast.success(
        t("toast.indexSuccess", { title: result.title || result.url })
      );
      setNewUrl("");
      await fetchUrls();
    } catch {
      toast.error(t("toast.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleReindex = async (urlId: string) => {
    if (!workspaceId) {
      toast.error(t("toast.loadFailed"));
      return;
    }
    setProcessingIds(prev => new Set(prev).add(urlId));
    try {
      const response = await fetch("/api/kb/indexed-urls/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urlId, workspaceId }),
      });

      const result = await response.json();

      if (!response.ok) {
        toast.error(result.error || t("toast.reindexFailed"));
        return;
      }

      toast.success(
        t("toast.reindexSuccess", { title: result.title || result.url })
      );
      await fetchUrls();
    } catch {
      toast.error(t("toast.reindexFailed"));
    } finally {
      setProcessingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(urlId);
        return newSet;
      });
    }
  };

  const handleDelete = async (urlId: string, url: string) => {
    if (!confirm(t("deleteConfirm", { url }))) {
      return;
    }
    if (!workspaceId) {
      toast.error(t("toast.loadFailed"));
      return;
    }

    setProcessingIds(prev => new Set(prev).add(urlId));
    try {
      const response = await fetch(
        `/api/kb/indexed-urls?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(urlId)}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const result = await response.json();
        toast.error(result.error || t("toast.deleteFailed"));
        return;
      }

      toast.success(t("toast.deleteSuccess"));
      await fetchUrls();
    } catch {
      toast.error(t("toast.deleteFailed"));
    } finally {
      setProcessingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(urlId);
        return newSet;
      });
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full mt-2" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const canAddMore = (data?.remaining || 0) > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Badge variant="outline">
            {data?.count || 0} / {data?.limit || 5}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Add new URL */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder={t("urlPlaceholder")}
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && canAddMore) handleAdd();
              }}
              disabled={!canAddMore || adding}
            />
            <Button
              onClick={handleAdd}
              disabled={!canAddMore || adding || !newUrl.trim()}
            >
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          </div>
          {!canAddMore && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{t("limitReached")}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* List of indexed URLs */}
        <div className="space-y-3">
          {data?.urls && data.urls.length > 0 ? (
            data.urls.map(url => {
              const isProcessing = processingIds.has(url.id);
              const statusIcon = {
                indexed: <CheckCircle2 className="h-4 w-4 text-green-600" />,
                pending: <Clock className="h-4 w-4 text-yellow-600" />,
                failed: <XCircle className="h-4 w-4 text-red-600" />,
              }[url.index_status];

              const statusColor = {
                indexed: "default",
                pending: "secondary",
                failed: "destructive",
              }[url.index_status] as "default" | "secondary" | "destructive";

              return (
                <Card key={url.id} className="relative">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-1">{statusIcon}</div>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-sm truncate">
                              {url.title || url.url}
                            </h4>
                            <a
                              href={url.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-muted-foreground hover:underline flex items-center gap-1 truncate"
                            >
                              {url.url}
                              <ExternalLink className="h-3 w-3 flex-shrink-0" />
                            </a>
                          </div>
                          <Badge
                            variant={statusColor}
                            className="flex-shrink-0"
                          >
                            {t(`status.${url.index_status}`)}
                          </Badge>
                        </div>

                        {url.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {url.description}
                          </p>
                        )}

                        {url.error_message && (
                          <p className="text-xs text-destructive">
                            {t("error")} {url.error_message}
                          </p>
                        )}

                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            {t("indexedAgo", {
                              time: formatRelativeTime(
                                url.last_indexed_at,
                                locale
                              ),
                            })}
                          </span>
                        </div>

                        <div className="flex gap-2 pt-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleReindex(url.id)}
                            disabled={isProcessing}
                          >
                            {isProcessing ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <RefreshCw className="h-3 w-3 mr-1" />
                            )}
                            {t("reindex")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(url.id, url.url)}
                            disabled={isProcessing}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            {t("delete")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <ExternalLink className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">{t("empty.title")}</p>
              <p className="text-xs mt-1">{t("empty.description")}</p>
            </div>
          )}
        </div>

        {/* Info */}
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>{t("info.title")}</strong> {t("info.description")}
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
