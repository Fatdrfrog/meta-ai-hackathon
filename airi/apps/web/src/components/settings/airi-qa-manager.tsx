"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FileQuestion, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import useSWR from "swr";

type QAItem = {
  question: string;
  answer: string;
  category?: string;
  tags?: string[];
};

type TaxonomyResponse = {
  items?: Array<{ labels?: string[] }>;
};

type InternalLabelsResponse = {
  labels?: Array<{ id: string; name: string }>;
};

const NO_OPTION_VALUE = "__none__";

export function AiriQAManager({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("AiriQAManager");
  const [rows, setRows] = React.useState<QAItem[]>([
    { question: "", answer: "", tags: [] },
  ]);
  const [loading, setLoading] = React.useState(false);
  const [initialLoading, setInitialLoading] = React.useState(true);
  const [listError, setListError] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [list, setList] = React.useState<
    Array<{ id: string; question: string; answer: string; updatedAt?: string }>
  >([]);

  const fetcher = React.useCallback(async (url: string) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  }, []);

  const { data: taxonomyData } = useSWR<TaxonomyResponse>(
    workspaceId ? `/api/taxonomies?workspaceId=${workspaceId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const { data: internalLabelsData } = useSWR<InternalLabelsResponse>(
    workspaceId
      ? `/api/internal-labels?workspaceId=${workspaceId}&activeOnly=true`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const categoryOptions = React.useMemo(() => {
    const labels =
      Array.isArray(taxonomyData?.items) && taxonomyData.items.length > 0
        ? taxonomyData.items[0]?.labels
        : [];
    if (!Array.isArray(labels)) return [];
    return Array.from(
      new Set(labels.map(label => String(label).trim()).filter(Boolean))
    );
  }, [taxonomyData]);

  const labelOptions = React.useMemo(() => {
    const labels = Array.isArray(internalLabelsData?.labels)
      ? internalLabelsData.labels
      : [];
    return Array.from(
      new Set(
        labels.map(item => String(item.name || "").trim()).filter(Boolean)
      )
    );
  }, [internalLabelsData]);

  const fetchList = React.useCallback(async () => {
    setListError(false);
    try {
      const res = await fetch(
        `/api/answer-snippets?workspaceId=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      if (!Array.isArray(data.items)) throw new Error("invalid list");
      setList(
        (data.items || []).map(
          (d: {
            id: string;
            question: string;
            answer: string;
            updatedAt?: string;
          }) => ({
            id: d.id,
            question: d.question,
            answer: d.answer,
            updatedAt: d.updatedAt,
          })
        )
      );
    } catch {
      setListError(true);
    } finally {
      setInitialLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    fetchList();
  }, [fetchList, workspaceId]);

  const addRow = React.useCallback(() => {
    setRows(prev => [...prev, { question: "", answer: "", tags: [] }]);
  }, []);

  const updateRow = React.useCallback(
    (index: number, patch: Partial<QAItem>) => {
      setRows(prev =>
        prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
      );
    },
    []
  );

  const removeRow = React.useCallback((index: number) => {
    setRows(prev => prev.filter((_, i) => i !== index));
  }, []);

  const toggleTagForRow = React.useCallback((index: number, tag: string) => {
    setRows(prev =>
      prev.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const currentTags = Array.isArray(row.tags) ? row.tags : [];
        const hasTag = currentTags.includes(tag);
        const nextTags = hasTag
          ? currentTags.filter(item => item !== tag)
          : [...currentTags, tag];
        return { ...row, tags: nextTags };
      })
    );
  }, []);

  async function saveAll() {
    if (loading) return;
    if (
      rows.some(
        row => Boolean(row.question.trim()) !== Boolean(row.answer.trim())
      )
    ) {
      toast.error(t("incompletePairs"));
      return;
    }
    const allowedCategories = new Set(categoryOptions);
    const allowedLabels = new Set(labelOptions);

    const items = rows
      .map(r => ({
        question: (r.question || "").trim(),
        answer: (r.answer || "").trim(),
        category:
          typeof r.category === "string" &&
          allowedCategories.has(r.category.trim())
            ? r.category.trim()
            : undefined,
        tags: Array.from(
          new Set(
            (Array.isArray(r.tags) ? r.tags : [])
              .map(tag => String(tag).trim())
              .filter(tag => allowedLabels.has(tag))
          )
        ),
      }))
      .filter(r => r.question && r.answer);

    if (items.length === 0) {
      toast.error(t("nothingToSave"), {
        description: t("fillPairs"),
      });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/answer-snippets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || t("saveFailed"));
      toast.success(t("saved"));
      setRows([{ question: "", answer: "", tags: [] }]);
      await fetchList();
    } catch (e: Error | unknown) {
      toast.error(t("saveFailed"), {
        description: (e as Error).message || "Try again later",
      });
    } finally {
      setLoading(false);
    }
  }

  async function deleteOne(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(
        `/api/answer-snippets?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Delete failed");
      await fetchList();
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <FileQuestion className="h-5 w-5" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={addRow}
            disabled={loading}
          >
            <Plus className="h-4 w-4 mr-1" />
            {t("addRow")}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <fieldset disabled={loading} className="space-y-3">
          {rows.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30 md:grid-cols-2"
            >
              <div>
                <label
                  htmlFor={`qa-question-${i}`}
                  className="mb-1.5 block text-xs font-medium"
                >
                  {t("commonQuestion")}
                </label>
                <Textarea
                  id={`qa-question-${i}`}
                  value={r.question}
                  onChange={e => updateRow(i, { question: e.target.value })}
                  placeholder={t("qPlaceholder")}
                  className="min-h-[80px]"
                />
              </div>
              <div>
                <label
                  htmlFor={`qa-answer-${i}`}
                  className="mb-1.5 block text-xs font-medium"
                >
                  {t("commonAnswer")}
                </label>
                <Textarea
                  id={`qa-answer-${i}`}
                  value={r.answer}
                  onChange={e => updateRow(i, { answer: e.target.value })}
                  placeholder={t("aPlaceholder")}
                  className="min-h-[80px]"
                />
              </div>
              <details className="md:col-span-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t("optionalDetails")}
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1.5 text-xs font-medium">
                      {t("category")}
                    </div>
                    <Select
                      value={
                        r.category && categoryOptions.includes(r.category)
                          ? r.category
                          : NO_OPTION_VALUE
                      }
                      onValueChange={value =>
                        updateRow(i, {
                          category:
                            value === NO_OPTION_VALUE ? undefined : value,
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("catPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_OPTION_VALUE}>-</SelectItem>
                        {categoryOptions.map(category => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="mb-1.5 text-xs font-medium">
                      {t("tags")}
                    </div>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-start text-left font-normal"
                        >
                          <span className="truncate">
                            {Array.isArray(r.tags) && r.tags.length > 0
                              ? r.tags.join(", ")
                              : t("tagsPlaceholder")}
                          </span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 p-2">
                        <div className="max-h-56 space-y-1 overflow-y-auto">
                          {labelOptions.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-muted-foreground">
                              -
                            </p>
                          ) : (
                            labelOptions.map(label => (
                              <label
                                key={label}
                                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted"
                              >
                                <Checkbox
                                  checked={Boolean(r.tags?.includes(label))}
                                  onCheckedChange={() =>
                                    toggleTagForRow(i, label)
                                  }
                                />
                                <span className="text-sm">{label}</span>
                              </label>
                            ))
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </details>
              <div className="flex justify-end md:col-span-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(i)}
                  disabled={loading}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t("remove")}
                </Button>
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-2">
            <Button onClick={saveAll} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? t("saving") : t("saveAll")}
            </Button>
          </div>
        </fieldset>

        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t("existingSnippets")}</h3>
            <p className="text-sm text-muted-foreground">
              {initialLoading
                ? t("loading")
                : listError
                  ? t("loadFailed")
                  : t("snippetsCount", { count: list.length })}
            </p>
          </div>

          {initialLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="rounded-lg border p-4">
                  <Skeleton className="mb-2 h-4 w-32" />
                  <Skeleton className="mb-2 h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          ) : listError ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm">{t("loadFailed")}</span>
              <Button size="sm" variant="outline" onClick={fetchList}>
                {t("retry")}
              </Button>
            </div>
          ) : list.length === 0 ? (
            <div className="py-6 text-center">
              <FileQuestion className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("noSnippets")}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {list.map(item => (
                <div
                  key={item.id}
                  className="rounded-lg border p-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2 break-words">
                      <div className="text-xs text-muted-foreground">
                        {item.updatedAt
                          ? t("updatedAt", {
                              time: new Date(item.updatedAt).toLocaleString(),
                            })
                          : t("updatedRecently")}
                      </div>
                      <div className="text-sm">
                        <span className="font-semibold text-primary">
                          {t("questionPrefix")}
                        </span>{" "}
                        {item.question}
                      </div>
                      <div className="text-sm">
                        <span className="font-semibold text-primary">
                          {t("answerPrefix")}
                        </span>{" "}
                        {item.answer}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("deleteAnswer", {
                        question: item.question,
                      })}
                      disabled={deletingId !== null}
                      onClick={() => deleteOne(item.id)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
