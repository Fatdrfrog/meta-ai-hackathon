"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw } from "lucide-react";
import {
  CampaignRecipientPicker,
  type CampaignRecipient,
} from "@/components/campaigns/campaign-recipient-picker";
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
import { Textarea } from "@/components/ui/textarea";
import { fetchScenarioWhatsAppTemplates } from "@/lib/scenarios/client";
import { extractWhatsAppTemplateQuickReplyBranchOptions } from "@/lib/scenarios/whatsapp-template-button-branches";
import { cn } from "@/lib/utils";
import type { ScenarioWhatsAppTemplate } from "../types";
import {
  isRevenuePlaybookTemplateSupported,
  RevenuePlaybookValidationError,
  type RevenuePlaybookConfig,
  type RevenuePlaybookGoal,
} from "./scenario-revenue-playbooks";

type RevenuePlaybookDialogProps = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCreating: boolean;
  sourceOptions: Array<{ id: string; label: string }>;
  onCreate: (config: RevenuePlaybookConfig) => Promise<boolean>;
};
const GOALS: RevenuePlaybookGoal[] = [
  "ad_consultation",
  "unpaid_recovery",
  "repeat_purchase",
  "service_reactivation",
];
const selectClass =
  "flex h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
function templateKey(template: ScenarioWhatsAppTemplate): string {
  return template.id || `${template.name}:${template.language}`;
}
function replyButtons(template?: ScenarioWhatsAppTemplate) {
  return extractWhatsAppTemplateQuickReplyBranchOptions({
    actionNodeId: "revenue-template",
    nodeData: { actionWhatsAppTemplateComponents: template?.components },
  });
}

export function RevenuePlaybookDialog(props: RevenuePlaybookDialogProps) {
  return <RevenuePlaybookForm key={props.workspaceId} {...props} />;
}

function RevenuePlaybookForm({
  workspaceId,
  open,
  onOpenChange,
  isCreating,
  sourceOptions,
  onCreate,
}: RevenuePlaybookDialogProps) {
  const t = useTranslations("Scenarios.revenuePlaybooks");
  const id = useId();
  const defaults = (goal: RevenuePlaybookGoal) => ({
    goal,
    name: t(`goals.${goal}.title`),
    openingText: t(`defaults.${goal}.openingText`),
    qualificationQuestion: t("defaults.qualificationQuestion"),
    bookingUrl: "",
    bookingButtonLabel: t("defaults.bookingButtonLabel"),
    reminderText: t(`defaults.${goal}.reminderText`),
    reminderMinutes: 120,
    successText: t("defaults.successText"),
    handoffText: t("defaults.handoffText"),
    triggerKeyword: "",
  });
  const [draft, setDraft] = useState(() => defaults("ad_consultation"));
  const [sourceId, setSourceId] = useState("");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [replyIndex, setReplyIndex] = useState("");
  const [recipients, setRecipients] = useState<CampaignRecipient[]>([]);
  const [retry, setRetry] = useState(0);
  const [catalog, setCatalog] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    items: ScenarioWhatsAppTemplate[];
  }>({ scope: "", status: "ready", items: [] });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitRef = useRef(false);
  const bulk =
    draft.goal === "repeat_purchase" || draft.goal === "service_reactivation";
  const booking =
    draft.goal === "ad_consultation" || draft.goal === "service_reactivation";
  const busy = isCreating || submitting;
  const validSourceId = sourceOptions.some(source => source.id === sourceId)
    ? sourceId
    : "";
  const scope = `${workspaceId}\u0000${validSourceId}`;
  const templates =
    catalog.scope === scope && catalog.status === "ready" ? catalog.items : [];
  const template = templates.find(
    item => templateKey(item) === selectedTemplateKey
  );
  const buttons = useMemo(() => replyButtons(template), [template]);

  useEffect(() => {
    if (!open || !bulk || !validSourceId) return;
    let current = true;
    setCatalog({ scope, status: "loading", items: [] });
    void fetchScenarioWhatsAppTemplates(workspaceId, {
      sourceId: validSourceId,
      force: retry > 0,
      throwOnError: true,
    })
      .then(items => {
        if (current)
          setCatalog({
            scope,
            status: "ready",
            items: items.filter(isRevenuePlaybookTemplateSupported),
          });
      })
      .catch(() => {
        if (current) setCatalog({ scope, status: "error", items: [] });
      });
    return () => {
      current = false;
    };
  }, [open, bulk, validSourceId, workspaceId, scope, retry]);

  const patch = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K]
  ) => setDraft(current => ({ ...current, [key]: value }));
  const selectGoal = (goal: RevenuePlaybookGoal) => {
    setDraft(defaults(goal));
    setError(null);
    setSourceId("");
    setSelectedTemplateKey("");
    setReplyIndex("");
    setRecipients([]);
    setRetry(0);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || submitRef.current) return;
    setError(null);
    const config: RevenuePlaybookConfig = {
      goal: draft.goal,
      name: draft.name.trim(),
      openingText: draft.openingText.trim(),
      reminderText: draft.reminderText.trim(),
      reminderMinutes: draft.reminderMinutes,
      successText: draft.successText.trim(),
      handoffText: draft.handoffText.trim(),
      ...(draft.goal === "ad_consultation"
        ? { qualificationQuestion: draft.qualificationQuestion.trim() }
        : {}),
      ...(booking
        ? {
            bookingUrl: draft.bookingUrl.trim(),
            bookingButtonLabel: draft.bookingButtonLabel.trim(),
          }
        : {}),
      ...(draft.goal === "unpaid_recovery"
        ? { triggerKeyword: draft.triggerKeyword.trim() }
        : {}),
      ...(bulk
        ? {
            sourceId: validSourceId,
            template,
            templateReplyButtonIndex:
              replyIndex === "" ? undefined : Number(replyIndex),
            recipients: recipients.map(recipient => recipient.phone || ""),
          }
        : {}),
    };
    try {
      submitRef.current = true;
      setSubmitting(true);
      if (!(await onCreate(config))) setError(t("createError"));
    } catch (cause) {
      setError(
        cause instanceof RevenuePlaybookValidationError
          ? t(`validation.${cause.code}`, { field: t(`fields.${cause.field}`) })
          : t("createError")
      );
    } finally {
      submitRef.current = false;
      setSubmitting(false);
    }
  };
  const field = (
    key:
      | "name"
      | "openingText"
      | "qualificationQuestion"
      | "bookingUrl"
      | "bookingButtonLabel"
      | "reminderText"
      | "successText"
      | "handoffText"
      | "triggerKeyword",
    options?: { multiline?: boolean; maxLength?: number }
  ) => (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={`${id}-${key}`}>{t(`fields.${key}`)}</Label>
      {options?.multiline ? (
        <Textarea
          id={`${id}-${key}`}
          required
          rows={2}
          maxLength={options.maxLength || 4000}
          value={draft[key]}
          onChange={event => patch(key, event.target.value)}
        />
      ) : (
        <Input
          id={`${id}-${key}`}
          required
          type={key === "bookingUrl" ? "url" : "text"}
          maxLength={options?.maxLength || 200}
          value={draft[key]}
          onChange={event => patch(key, event.target.value)}
        />
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 px-6 pb-2 pt-6">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <fieldset disabled={busy} className="min-w-0 space-y-5 px-6 py-3">
              <legend className="sr-only">{t("goalLabel")}</legend>
              <div
                className="grid gap-2 sm:grid-cols-2"
                aria-label={t("goalLabel")}
              >
                {GOALS.map(goal => (
                  <button
                    key={goal}
                    type="button"
                    aria-pressed={draft.goal === goal}
                    onClick={() => selectGoal(goal)}
                    className={cn(
                      "min-w-0 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                      draft.goal === goal
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted"
                    )}
                  >
                    <span className="block text-sm font-medium">
                      {t(`goals.${goal}.title`)}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t(`goals.${goal}.description`)}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("paidOutcomeHelp")}
              </p>
              {field("name", { maxLength: 120 })}
              {draft.goal === "unpaid_recovery" && field("triggerKeyword")}
              {bulk && (
                <div className="space-y-4 rounded-lg border p-3">
                  <p className="text-sm text-muted-foreground">
                    {t("explicitAudienceHelp")}
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-source`}>
                      {t("fields.sourceId")}
                    </Label>
                    <select
                      id={`${id}-source`}
                      className={selectClass}
                      value={validSourceId}
                      required
                      onChange={event => {
                        setSourceId(event.target.value);
                        setSelectedTemplateKey("");
                        setReplyIndex("");
                        setRecipients([]);
                        setRetry(0);
                      }}
                    >
                      <option value="">{t("chooseSource")}</option>
                      {sourceOptions.map(source => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {sourceOptions.length === 0 && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {t("noSources")}
                    </p>
                  )}
                  {validSourceId && (
                    <>
                      {catalog.scope === scope &&
                        catalog.status === "loading" && (
                          <p
                            role="status"
                            className="flex items-center gap-2 text-sm"
                          >
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t("templatesLoading")}
                          </p>
                        )}
                      {catalog.scope === scope &&
                        catalog.status === "error" && (
                          <div
                            role="alert"
                            className="flex flex-wrap items-center gap-2 text-sm text-destructive"
                          >
                            {t("templatesError")}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setRetry(value => value + 1)}
                            >
                              {t("retry")}
                            </Button>
                          </div>
                        )}
                      {catalog.scope === scope &&
                        catalog.status === "ready" && (
                          <>
                            <div className="space-y-1.5">
                              <Label htmlFor={`${id}-template`}>
                                {t("fields.template")}
                              </Label>
                              <select
                                id={`${id}-template`}
                                className={selectClass}
                                required
                                value={selectedTemplateKey}
                                onChange={event => {
                                  setSelectedTemplateKey(event.target.value);
                                  setReplyIndex("");
                                }}
                              >
                                <option value="">{t("chooseTemplate")}</option>
                                {templates.map(item => (
                                  <option
                                    key={templateKey(item)}
                                    value={templateKey(item)}
                                  >
                                    {item.name} · {item.language}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {templates.length === 0 && (
                              <p className="text-sm text-muted-foreground">
                                {t("noTemplates")}
                              </p>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setRetry(value => value + 1)}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              {t("refreshTemplates")}
                            </Button>
                          </>
                        )}
                      {template && (
                        <div className="space-y-1.5">
                          <Label htmlFor={`${id}-reply`}>
                            {t("fields.templateReplyButtonIndex")}
                          </Label>
                          <select
                            id={`${id}-reply`}
                            className={selectClass}
                            value={replyIndex}
                            required
                            onChange={event =>
                              setReplyIndex(event.target.value)
                            }
                          >
                            <option value="">{t("chooseReply")}</option>
                            {buttons.map(button => (
                              <option key={button.index} value={button.index}>
                                {button.label}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-muted-foreground">
                            {t("selectedReplyHelp")}
                          </p>
                        </div>
                      )}
                      <div className="space-y-2">
                        <p className="text-sm font-medium">
                          {t("fields.recipients")}
                        </p>
                        <CampaignRecipientPicker
                          workspaceId={workspaceId}
                          channel="whatsapp"
                          sourceIds={[validSourceId]}
                          recipients={recipients}
                          onRecipientsChange={setRecipients}
                          mode="manual"
                          compact
                          showHeader={false}
                          disabled={busy}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
              {field("openingText", {
                multiline: true,
                maxLength: booking ? 1024 : 4096,
              })}
              {draft.goal === "ad_consultation" &&
                field("qualificationQuestion", { multiline: true })}
              {booking && (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    {t("bookingHelp")}
                  </p>
                  {field("bookingUrl", { maxLength: 2000 })}
                  {field("bookingButtonLabel", { maxLength: 20 })}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                {field("reminderText", { multiline: true })}
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-minutes`}>
                    {t("fields.reminderMinutes")}
                  </Label>
                  <Input
                    id={`${id}-minutes`}
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    required
                    value={draft.reminderMinutes || ""}
                    onChange={event =>
                      patch("reminderMinutes", Number(event.target.value))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field("successText", { multiline: true })}
                {field("handoffText", { multiline: true })}
              </div>
            </fieldset>
          </div>
          <DialogFooter className="shrink-0 border-t bg-background px-6 py-4 sm:items-center">
            {error && (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                (bulk &&
                  (!validSourceId ||
                    catalog.scope !== scope ||
                    catalog.status !== "ready"))
              }
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t(busy ? "creating" : "createDraft")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
