"use client";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { PublicMetaAdsMcpExecution } from "@/lib/airi-chats/service";
import { ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

type ReconciliationResolution = "succeeded" | "not_executed";
type ProviderIdentifier = { kind: string; id: string };

export type MetaAdsMcpReconciliationDialogProps = {
  open: boolean;
  execution: PublicMetaAdsMcpExecution;
  submitting: boolean;
  error?: string;
  onOpenChange(open: boolean): void;
  onSubmit(input: {
    resolution: ReconciliationResolution;
    note: string;
    providerIdentifiers?: ProviderIdentifier[];
  }): void;
};

const EMPTY_PROVIDER_IDENTIFIER: ProviderIdentifier = { kind: "", id: "" };

export function MetaAdsMcpReconciliationDialog({
  open,
  execution,
  submitting,
  error,
  onOpenChange,
  onSubmit,
}: MetaAdsMcpReconciliationDialogProps) {
  const t = useTranslations("AiriMetaAds");
  const submissionLockRef = useRef(false);
  const [locallyLocked, setLocallyLocked] = useState(false);
  const [resolution, setResolution] =
    useState<ReconciliationResolution>("succeeded");
  const [note, setNote] = useState("");
  const [providerIdentifiers, setProviderIdentifiers] = useState<
    ProviderIdentifier[]
  >([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && submitting) return;
    onOpenChange(nextOpen);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || submissionLockRef.current) return;

    const normalizedNote = note.trim();
    if (!normalizedNote) {
      setValidationError(t("reconciliation.noteRequired"));
      return;
    }

    const normalizedIdentifiers = providerIdentifiers.flatMap(identifier => {
      const kind = identifier.kind.trim();
      const id = identifier.id.trim();
      return kind && id ? [{ kind, id }] : [];
    });
    if (
      resolution === "succeeded" &&
      providerIdentifiers.some(
        identifier =>
          Boolean(identifier.kind.trim()) !== Boolean(identifier.id.trim())
      )
    ) {
      setValidationError(t("reconciliation.identifiersRequired"));
      return;
    }

    submissionLockRef.current = true;
    setLocallyLocked(true);
    setValidationError(null);
    onSubmit({
      resolution,
      note: normalizedNote,
      ...(resolution === "succeeded" && normalizedIdentifiers.length > 0
        ? { providerIdentifiers: normalizedIdentifiers }
        : {}),
    });
    queueMicrotask(() => {
      submissionLockRef.current = false;
      setLocallyLocked(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(90dvh,42rem)] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left">
          <DialogTitle>{t("reconciliation.title")}</DialogTitle>
          <DialogDescription>
            {t("reconciliation.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:absolute [&>[data-slot=scroll-area-viewport]]:inset-0">
            <div className="space-y-5 px-5 py-4">
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("errors.record")}
                </p>
              ) : null}
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="font-medium break-all">
                  {execution.transaction?.summary || t("actions.outcome")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("reconciliation.currentOutcome", {
                    status: t(`reconciliation.statuses.${execution.status}`),
                  })}
                </p>
                <Collapsible className="mt-2">
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto max-w-full gap-2 whitespace-normal px-0 text-xs"
                    >
                      {t("common.technical")}
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 pt-2">
                    {error ? (
                      <p className="break-words text-xs">
                        {t("review.errorDetails")}: {error}
                      </p>
                    ) : null}
                    <p className="break-all text-xs">
                      {t("review.tool")}: {execution.toolName}
                    </p>
                    {execution.transaction ? (
                      <p className="break-all font-mono text-[11px] text-muted-foreground">
                        {execution.transaction.transactionDigest}
                      </p>
                    ) : null}
                  </CollapsibleContent>
                </Collapsible>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("reconciliation.outcome")}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    className="h-auto min-h-10 whitespace-normal"
                    variant={resolution === "succeeded" ? "default" : "outline"}
                    aria-pressed={resolution === "succeeded"}
                    disabled={submitting}
                    onClick={() => {
                      setResolution("succeeded");
                      setValidationError(null);
                    }}
                  >
                    {t("reconciliation.completed")}
                  </Button>
                  <Button
                    type="button"
                    className="h-auto min-h-10 whitespace-normal"
                    variant={
                      resolution === "not_executed" ? "default" : "outline"
                    }
                    aria-pressed={resolution === "not_executed"}
                    disabled={submitting}
                    onClick={() => {
                      setResolution("not_executed");
                      setValidationError(null);
                    }}
                  >
                    {t("reconciliation.notExecuted")}
                  </Button>
                </div>
              </fieldset>

              <div className="space-y-2">
                <Label htmlFor={`meta-mcp-reconciliation-note-${execution.id}`}>
                  {t("reconciliation.note")}
                </Label>
                <Textarea
                  id={`meta-mcp-reconciliation-note-${execution.id}`}
                  value={note}
                  maxLength={500}
                  rows={4}
                  required
                  disabled={submitting}
                  aria-invalid={Boolean(validationError) || undefined}
                  placeholder={t("reconciliation.notePlaceholder")}
                  onChange={event => {
                    setNote(event.target.value);
                    setValidationError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t("reconciliation.noteHelp", { count: note.length })}
                </p>
              </div>

              {resolution === "succeeded" ? (
                <fieldset className="space-y-3">
                  <legend className="sr-only">
                    {t("reconciliation.identifiers")}
                  </legend>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium" aria-hidden="true">
                      {t("reconciliation.identifiers")}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={submitting || providerIdentifiers.length >= 20}
                      onClick={() =>
                        setProviderIdentifiers(current => [
                          ...current,
                          { ...EMPTY_PROVIDER_IDENTIFIER },
                        ])
                      }
                    >
                      <Plus className="size-3.5" />
                      {t("reconciliation.addId")}
                    </Button>
                  </div>
                  {providerIdentifiers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("reconciliation.idsHelp")}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {providerIdentifiers.map((identifier, index) => (
                        <div
                          key={index}
                          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                        >
                          <Input
                            className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1"
                            value={identifier.kind}
                            maxLength={100}
                            disabled={submitting}
                            aria-label={t("reconciliation.identifierKind", {
                              index: index + 1,
                            })}
                            placeholder={t("reconciliation.kind")}
                            onChange={event =>
                              setProviderIdentifiers(current =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, kind: event.target.value }
                                    : item
                                )
                              )
                            }
                          />
                          <Input
                            value={identifier.id}
                            maxLength={200}
                            disabled={submitting}
                            aria-label={t("reconciliation.identifierId", {
                              index: index + 1,
                            })}
                            placeholder={t("reconciliation.id")}
                            onChange={event =>
                              setProviderIdentifiers(current =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, id: event.target.value }
                                    : item
                                )
                              )
                            }
                          />
                          <Button
                            className="col-start-2 row-span-2 row-start-1 sm:col-start-3 sm:row-span-1"
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={submitting}
                            aria-label={t("reconciliation.removeIdentifier", {
                              index: index + 1,
                            })}
                            onClick={() =>
                              setProviderIdentifiers(current =>
                                current.filter(
                                  (_, itemIndex) => itemIndex !== index
                                )
                              )
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </fieldset>
              ) : null}

              {validationError ? (
                <p role="alert" className="text-sm text-destructive">
                  {validationError}
                </p>
              ) : null}
            </div>
          </ScrollArea>

          <DialogFooter className="shrink-0 border-t px-5 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              className="h-auto min-h-10 whitespace-normal"
              disabled={submitting || locallyLocked || !note.trim()}
            >
              {submitting || locallyLocked ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t(
                submitting || locallyLocked
                  ? "reconciliation.recording"
                  : "reconciliation.record"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
