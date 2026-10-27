"use client";

import type { WhatsAppWelcomeMessageSequence } from "@icecore/shared/types/whatsapp";
import {
  Check,
  Copy,
  Edit3,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  WhatsAppActionRenderer,
  type WhatsAppActionRendererButton,
} from "@/components/scenarios/builders/whatsapp/action-renderer";
import { cn } from "@/lib/utils";

type DraftSequence = {
  name: string;
  text: string;
  autofillMessageContent: string;
  iceBreakers: string[];
};

const EMPTY_DRAFT: DraftSequence = {
  name: "",
  text: "",
  autofillMessageContent: "",
  iceBreakers: ["", "", ""],
};

function toDraft(sequence?: WhatsAppWelcomeMessageSequence): DraftSequence {
  if (!sequence) return EMPTY_DRAFT;
  return {
    name: sequence.name || "",
    text: sequence.text || "",
    autofillMessageContent: sequence.autofillMessageContent || "",
    iceBreakers: [
      sequence.iceBreakers?.[0]?.title || "",
      sequence.iceBreakers?.[1]?.title || "",
      sequence.iceBreakers?.[2]?.title || "",
    ],
  };
}

function normalizeDraft(draft: DraftSequence) {
  return {
    name: draft.name.trim(),
    text: draft.text.trim(),
    autofillMessageContent: draft.autofillMessageContent.trim(),
    iceBreakers: draft.iceBreakers
      .map(title => title.trim())
      .filter(Boolean)
      .map(title => ({ title })),
  };
}

async function parseApiError(response: Response, fallback: string) {
  try {
    const payload = await response.json();
    return typeof payload?.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
}

function WelcomeSequenceEditablePreview({
  draft,
  setDraft,
}: {
  draft: DraftSequence;
  setDraft: Dispatch<SetStateAction<DraftSequence>>;
}) {
  const t = useTranslations("WhatsAppWelcomeSequences.preview");
  const tForm = useTranslations("WhatsAppWelcomeSequences.form");
  const buttons = useMemo(
    (): WhatsAppActionRendererButton[] =>
      draft.iceBreakers.map((label, index) => ({
        key: `welcome-sequence-ice-breaker-${index}`,
        type: "quick_reply",
        label,
        onLabelChange: value =>
          setDraft(current => {
            const next = [...current.iceBreakers];
            next[index] = value;
            return { ...current, iceBreakers: next };
          }),
      })),
    [draft.iceBreakers, setDraft]
  );

  return (
    <div className="flex flex-col gap-3">
      <WhatsAppActionRenderer
        bodyText={draft.text}
        onBodyTextChange={value =>
          setDraft(current => ({ ...current, text: value }))
        }
        bodyPlaceholder={t("emptyText")}
        buttons={buttons}
        buttonLabelPlaceholder={tForm("iceBreakerPlaceholder", { index: 1 })}
        fitContent
        previewClassName="max-w-[420px]"
        className="justify-center"
      />

      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-2 rounded-[28px] border bg-background p-3">
        <Field>
          <FieldLabel htmlFor="welcome-sequence-autofill">
            {tForm("autofill")}
          </FieldLabel>
          <Input
            id="welcome-sequence-autofill"
            value={draft.autofillMessageContent}
            maxLength={200}
            onChange={event =>
              setDraft(current => ({
                ...current,
                autofillMessageContent: event.target.value,
              }))
            }
            placeholder={tForm("autofillPlaceholder")}
          />
        </Field>
      </div>
    </div>
  );
}

function SequenceDialog({
  sequence,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  sequence: WhatsAppWelcomeMessageSequence | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: DraftSequence) => Promise<void>;
}) {
  const t = useTranslations("WhatsAppWelcomeSequences");
  const [draft, setDraft] = useState<DraftSequence>(() =>
    toDraft(sequence || undefined)
  );
  const normalized = useMemo(() => normalizeDraft(draft), [draft]);
  const canSubmit =
    normalized.name &&
    (normalized.text ||
      normalized.autofillMessageContent ||
      normalized.iceBreakers.length > 0);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="!flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col gap-0 overflow-hidden !p-0 sm:!max-w-2xl">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>
            {sequence ? t("dialog.editTitle") : t("dialog.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 pb-6">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="welcome-sequence-name">
                {t("form.name")}
              </FieldLabel>
              <Input
                id="welcome-sequence-name"
                value={draft.name}
                maxLength={120}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder={t("form.namePlaceholder")}
              />
            </Field>

            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">{t("preview.title")}</h3>
              <WelcomeSequenceEditablePreview
                draft={draft}
                setDraft={setDraft}
              />
            </section>
          </FieldGroup>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={() => onSubmit(draft)}
          >
            {submitting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            {sequence ? t("actions.save") : t("actions.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WhatsAppWelcomeSequencesManager({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const t = useTranslations("WhatsAppWelcomeSequences");
  const [sequences, setSequences] = useState<WhatsAppWelcomeMessageSequence[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSequence, setEditingSequence] =
    useState<WhatsAppWelcomeMessageSequence | null>(null);

  function openSequenceDialog(sequence: WhatsAppWelcomeMessageSequence | null) {
    setEditingSequence(sequence);
    setDialogOpen(true);
  }

  function handleSequenceDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setEditingSequence(null);
    }
  }

  async function loadSequences(options?: { silent?: boolean }) {
    if (options?.silent) setSyncing(true);
    else setLoading(true);
    try {
      const response = await fetch(
        `/api/whatsapp/welcome-sequences?workspaceId=${encodeURIComponent(
          workspaceId
        )}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(await parseApiError(response, t("alerts.loadFailed")));
      }
      const payload = (await response.json()) as {
        sequences?: WhatsAppWelcomeMessageSequence[];
      };
      setSequences(payload.sequences || []);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("alerts.loadFailed")
      );
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }

  useEffect(() => {
    void loadSequences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function saveSequence(draft: DraftSequence) {
    const normalized = normalizeDraft(draft);
    setSubmitting(true);
    try {
      const isEdit = Boolean(editingSequence);
      const response = await fetch("/api/whatsapp/welcome-sequences", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...(isEdit ? { sequenceId: editingSequence?.id } : {}),
          ...normalized,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await parseApiError(
            response,
            isEdit ? t("alerts.updateFailed") : t("alerts.createFailed")
          )
        );
      }
      const payload = (await response.json()) as {
        sequence?: WhatsAppWelcomeMessageSequence;
      };
      if (payload.sequence) {
        setSequences(current => {
          const withoutCurrent = current.filter(
            item => item.id !== payload.sequence?.id
          );
          return [payload.sequence, ...withoutCurrent].filter(
            Boolean
          ) as WhatsAppWelcomeMessageSequence[];
        });
      }
      toast.success(isEdit ? t("alerts.updated") : t("alerts.created"));
      handleSequenceDialogOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : editingSequence
            ? t("alerts.updateFailed")
            : t("alerts.createFailed")
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteSequence(sequence: WhatsAppWelcomeMessageSequence) {
    if (sequence.is_used_in_ad) return;
    if (!window.confirm(t("alerts.deleteConfirm", { name: sequence.name }))) {
      return;
    }
    try {
      const response = await fetch(
        `/api/whatsapp/welcome-sequences?workspaceId=${encodeURIComponent(
          workspaceId
        )}&sequenceId=${encodeURIComponent(sequence.id)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new Error(
          await parseApiError(response, t("alerts.deleteFailed"))
        );
      }
      setSequences(current => current.filter(item => item.id !== sequence.id));
      toast.success(t("alerts.deleted"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("alerts.deleteFailed")
      );
    }
  }

  async function copySequenceId(sequenceId: string) {
    await navigator.clipboard.writeText(sequenceId);
    toast.success(t("alerts.copied"));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {t("summary", { count: sequences.length })}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => loadSequences({ silent: true })}
            disabled={syncing}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", syncing && "animate-spin")}
            />
            {t("actions.sync")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              openSequenceDialog(null);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("actions.create")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : sequences.length === 0 ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center rounded-md border border-dashed p-8 text-center">
          <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-semibold">{t("empty.title")}</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {t("empty.description")}
          </p>
          <Button
            type="button"
            className="mt-4"
            onClick={() => {
              openSequenceDialog(null);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("actions.create")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {sequences.map(sequence => (
            <div
              key={sequence.id}
              className="rounded-md border bg-background p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold">
                      {sequence.name}
                    </h3>
                    {sequence.is_used_in_ad ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="h-3 w-3" />
                        {t("badges.usedInAd")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
                    <p className="line-clamp-2">
                      <span className="font-medium text-foreground">
                        {t("fields.text")}:
                      </span>{" "}
                      {sequence.text || t("fields.empty")}
                    </p>
                    <p className="line-clamp-2">
                      <span className="font-medium text-foreground">
                        {t("fields.autofill")}:
                      </span>{" "}
                      {sequence.autofillMessageContent || t("fields.empty")}
                    </p>
                    <p className="line-clamp-2">
                      <span className="font-medium text-foreground">
                        {t("fields.iceBreakers")}:
                      </span>{" "}
                      {sequence.iceBreakers
                        ?.map(item => item.title)
                        .join(", ") || t("fields.empty")}
                    </p>
                  </div>
                  <code className="block truncate text-xs text-muted-foreground">
                    {sequence.id}
                  </code>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => copySequenceId(sequence.id)}
                    aria-label={t("actions.copyId")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={sequence.is_used_in_ad}
                    onClick={() => {
                      openSequenceDialog(sequence);
                    }}
                    aria-label={t("actions.edit")}
                  >
                    <Edit3 className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={sequence.is_used_in_ad}
                    onClick={() => deleteSequence(sequence)}
                    aria-label={t("actions.delete")}
                    title={
                      sequence.is_used_in_ad
                        ? t("alerts.usedInAdDeleteBlocked")
                        : undefined
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialogOpen ? (
        <SequenceDialog
          key={editingSequence?.id ?? "new"}
          sequence={editingSequence}
          submitting={submitting}
          onOpenChange={handleSequenceDialogOpenChange}
          onSubmit={saveSequence}
        />
      ) : null}
    </div>
  );
}
