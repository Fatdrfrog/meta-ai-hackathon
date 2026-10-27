"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { ErrorState } from "@/components/ui/async-states";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

type LabelStats = {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  is_active: boolean;
  count: number;
};

type FormState = {
  id?: string;
  name: string;
  color: string;
  description: string;
  is_active: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  color: "",
  description: "",
  is_active: true,
};

interface InternalLabelsManagerProps {
  workspaceId: string;
}

export function InternalLabelsManager({
  workspaceId,
}: InternalLabelsManagerProps) {
  const t = useTranslations("InternalLabelsManager");
  const settings = useTranslations("TaxonomyManager");
  const [labels, setLabels] = useState<LabelStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadLabels = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/internal-labels/stats?workspaceId=${workspaceId}`
      );
      const data = await res.json();
      if (!res.ok || !Array.isArray(data?.labels))
        throw new Error("load failed");
      setLabels(data.labels);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadLabels();
  }, [loadLabels]);

  const openCreate = () => {
    if (saving || deletingId) return;
    setFormState(EMPTY_FORM);
    setActionError(null);
    setFormOpen(true);
  };

  const openEdit = (label: LabelStats) => {
    if (saving || deletingId) return;
    setActionError(null);
    setFormState({
      id: label.id,
      name: label.name,
      color: label.color ?? "",
      description: label.description ?? "",
      is_active: label.is_active,
    });
    setFormOpen(true);
  };

  const saveLabel = async () => {
    if (saving || !formState.name.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const payload = {
        workspaceId,
        id: formState.id,
        name: formState.name.trim(),
        color: formState.color.trim() || null,
        description: formState.description.trim() || null,
        isActive: formState.is_active,
      };
      const res = await fetch("/api/internal-labels", {
        method: formState.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error?.error || t("saveFailed"));
      }
      setFormOpen(false);
      await loadLabels();
    } catch {
      setActionError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const deleteLabel = async (labelId: string) => {
    if (saving || deletingId) return;
    setDeletingId(labelId);
    setActionError(null);
    try {
      const params = new URLSearchParams({ workspaceId, id: labelId });
      const res = await fetch(`/api/internal-labels?${params}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error?.error || t("deleteFailed"));
      }
      await loadLabels();
    } catch {
      setActionError(t("deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {settings("manualTagsDescription")}
          </p>
        </div>
        <Button
          onClick={openCreate}
          disabled={loading || loadError || saving || !!deletingId}
          size="sm"
        >
          {t("newLabel")}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <ErrorState
          message={settings("loadTagsFailed")}
          onRetry={loadLabels}
          retryLabel={settings("retry")}
        />
      ) : labels.length ? (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("label")}</TableHead>
                <TableHead>{t("descriptionColumn")}</TableHead>
                <TableHead>{t("active")}</TableHead>
                <TableHead>{t("conversations")}</TableHead>
                <TableHead className="text-right">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {labels.map(label => (
                <TableRow key={label.id}>
                  <TableCell className="max-w-48 font-medium">
                    <div className="flex items-center gap-2">
                      <Badge
                        className="max-w-full truncate"
                        variant="secondary"
                        style={{
                          backgroundColor: label.color || undefined,
                        }}
                      >
                        {label.name}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal break-words text-sm text-muted-foreground">
                    {label.description || t("emDash")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={label.is_active ? "default" : "secondary"}>
                      {label.is_active ? t("activeBadge") : t("inactiveBadge")}
                    </Badge>
                  </TableCell>
                  <TableCell>{label.count}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(label)}
                        title={t("editLabel")}
                        aria-label={t("editLabel")}
                        disabled={saving || !!deletingId}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteLabel(label.id)}
                        disabled={saving || !!deletingId}
                        title={t("deleteLabel")}
                        aria-label={t("deleteLabel")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("noLabelsYet")}
        </div>
      )}

      {!formOpen && actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Dialog
        open={formOpen}
        onOpenChange={open => {
          if (!saving) setFormOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {formState.id ? t("editLabel") : t("createLabel")}
            </DialogTitle>
            <DialogDescription>{t("formDescription")}</DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving} className="grid min-w-0 gap-4">
            {actionError && (
              <Alert variant="destructive">
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label htmlFor="team-tag-name">{t("name")}</Label>
              <Input
                id="team-tag-name"
                value={formState.name}
                onChange={event =>
                  setFormState(current => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder={t("placeholderName")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-tag-color">{t("colorOptional")}</Label>
              <Input
                id="team-tag-color"
                value={formState.color}
                onChange={event =>
                  setFormState(current => ({
                    ...current,
                    color: event.target.value,
                  }))
                }
                placeholder={t("placeholderColor")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="team-tag-description">
                {t("descriptionColumn")}
              </Label>
              <Textarea
                id="team-tag-description"
                value={formState.description}
                onChange={event =>
                  setFormState(current => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder={t("placeholderDescription")}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="team-tag-active">{t("active")}</Label>
              <Switch
                id="team-tag-active"
                checked={formState.is_active}
                onCheckedChange={checked =>
                  setFormState(current => ({ ...current, is_active: checked }))
                }
              />
            </div>
          </fieldset>
          <DialogFooter>
            <Button
              onClick={saveLabel}
              disabled={saving || !formState.name.trim()}
            >
              {saving ? t("saving") : t("saveLabel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
