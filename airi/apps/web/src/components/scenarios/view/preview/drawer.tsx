"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FlaskConical, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { ScenarioPreviewResult } from "@icecore/scenario-contracts";
import {
  DEFAULT_SCENARIO_PREVIEW_EVENT_KIND,
  resolveScenarioPreviewChannel,
  resolveScenarioPreviewChannelOptions,
  resolveScenarioPreviewEventKinds,
  runScenarioPreviewEvaluation,
  type ScenarioDraftPreviewInput,
  type ScenarioPreviewEventKind,
  type ScenarioPreviewSelectableEventKind,
} from "./evaluation";
import { ScenarioConversationPreview } from "./conversation";
import type { ScenarioSimulationTrace } from "./use-scenario-simulation";

const EMPTY_AVAILABLE_CHANNELS: string[] = [];

type ScenarioPreviewFormState = {
  channel: string;
  eventKind: ScenarioPreviewEventKind;
  messageText: string;
  classificationCategory: string;
  internalLabelsText: string;
  funnelStage: string;
  quickReplyPayload: string;
  whatsAppFlowResponseJson: string;
  isNewCustomer: boolean;
  hasPurchaseHistory: boolean;
};

type ScenarioPreviewExecutionState = {
  loading: boolean;
  result: ScenarioPreviewResult | null;
  error: string | null;
};

type ScenarioPreviewDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  availableChannels?: string[];
  draftScenario?: ScenarioDraftPreviewInput | null;
  onSimulationTrace?: (trace: ScenarioSimulationTrace | null) => void;
};

function formatReason(
  reason: string | null | undefined,
  t: ReturnType<typeof useTranslations>
) {
  switch (reason) {
    case "already_started_in_conversation":
    case "blocked_by_once_per_conversation":
      return t("triggerLogReasonAlreadyStarted");
    case "trigger_mismatch":
      return t("previewReasonTriggerMismatch");
    case "matched_label":
      return t("triggerLogReasonMatchedLabelGeneric");
    case "matched_name_fallback":
      return t("triggerLogReasonMatchedNameGeneric");
    case "suppressed_label_precedence":
      return t("triggerLogReasonSuppressedLabelPrecedence");
    case "suppressed_label_conflict":
      return t("triggerLogReasonSuppressedLabelConflict");
    case "suppressed_name_ambiguous":
      return t("triggerLogReasonSuppressedNameAmbiguous");
    case "suppressed_labels_unavailable":
      return t("triggerLogReasonSuppressedLabelsUnavailable");
    case "product_no_match":
      return t("triggerLogReasonProductNoMatch");
    case "flow_no_matching_action":
      return t("previewReasonNoMatchingAction");
    case "shadowed_by_earlier_match":
      return t("previewReasonShadowed");
    default:
      return t("unknown");
  }
}

function evaluationTone(
  result: ScenarioPreviewResult["evaluations"][number]["result"]
) {
  if (result === "winner") {
    return "border-emerald-200 bg-emerald-50/70";
  }
  if (result === "matched_but_shadowed") {
    return "border-amber-200 bg-amber-50/70";
  }
  return "border-border bg-background";
}

function formatPreviewEventKind(
  eventKind: ScenarioPreviewSelectableEventKind,
  t: ReturnType<typeof useTranslations>
) {
  switch (eventKind) {
    case "inbound_message":
      return t("previewEventInbound");
    case "telegram_quick_reply":
      return t("previewEventTelegramQuickReply");
    case "instagram_quick_reply":
      return t("previewEventInstagramQuickReply");
    case "whatsapp_button_reply":
      return t("previewEventWhatsAppButtonReply");
    case "whatsapp_flow_reply":
      return t("previewEventWhatsAppFlowReply");
    default: {
      const exhaustiveEventKind: never = eventKind;
      return exhaustiveEventKind;
    }
  }
}

export function ScenarioPreviewDrawer({
  open,
  onOpenChange,
  workspaceId,
  availableChannels = EMPTY_AVAILABLE_CHANNELS,
  draftScenario,
  onSimulationTrace,
}: ScenarioPreviewDrawerProps) {
  const t = useTranslations("Scenarios");
  const [previewMode, setPreviewMode] = useState<"conversation" | "event">(
    "conversation"
  );
  const canSimulate = Boolean(
    draftScenario?.nodes.some(node => node.data.actionWhatsAppServiceMessage)
  );
  const showConversation = canSimulate && previewMode === "conversation";
  const [formState, setFormState] = useState<ScenarioPreviewFormState>(() => ({
    channel: resolveScenarioPreviewChannel(undefined, availableChannels),
    eventKind: DEFAULT_SCENARIO_PREVIEW_EVENT_KIND,
    messageText: "",
    classificationCategory: "",
    internalLabelsText: "",
    funnelStage: "",
    quickReplyPayload: "",
    whatsAppFlowResponseJson: "",
    isNewCustomer: false,
    hasPurchaseHistory: false,
  }));
  const [executionState, setExecutionState] =
    useState<ScenarioPreviewExecutionState>({
      loading: false,
      result: null,
      error: null,
    });

  const channelOptions = useMemo(
    () => resolveScenarioPreviewChannelOptions(availableChannels),
    [availableChannels]
  );
  const selectedChannel = resolveScenarioPreviewChannel(
    formState.channel,
    channelOptions
  );

  const eventOptions = useMemo(
    () =>
      resolveScenarioPreviewEventKinds().map(value => ({
        value,
        label: formatPreviewEventKind(value, t),
      })),
    [t]
  );

  const updateFormState = <Key extends keyof ScenarioPreviewFormState>(
    key: Key,
    value: ScenarioPreviewFormState[Key]
  ) => {
    setFormState(current =>
      current[key] === value
        ? current
        : {
            ...current,
            [key]: value,
          }
    );
  };

  const runPreview = async () => {
    try {
      setExecutionState(current => ({
        ...current,
        loading: true,
        error: null,
      }));
      const preview = await runScenarioPreviewEvaluation({
        workspaceId,
        channel: selectedChannel,
        eventKind: formState.eventKind,
        messageText: formState.messageText,
        classificationCategory: formState.classificationCategory,
        internalLabels: formState.internalLabelsText,
        funnelStage: formState.funnelStage,
        isNewCustomer: formState.isNewCustomer,
        hasPurchaseHistory: formState.hasPurchaseHistory,
        quickReplyPayload: formState.quickReplyPayload,
        whatsAppFlowResponseJson: formState.whatsAppFlowResponseJson,
        draftScenario,
      });
      setExecutionState({
        loading: false,
        result: preview,
        error: null,
      });
    } catch (previewError) {
      setExecutionState(current => ({
        ...current,
        loading: false,
        error:
          previewError instanceof Error
            ? previewError.message
            : t("previewRunFailed"),
      }));
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="overflow-clip data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:max-w-[560px]">
        <DrawerHeader className="relative shrink-0 border-b py-3 pe-14">
          <DrawerTitle className="break-words">
            {t("previewDrawerTitle")}
          </DrawerTitle>
          <DrawerDescription>
            {t(
              showConversation
                ? "simulationDescription"
                : "previewDrawerDescription"
            )}
          </DrawerDescription>
          <DrawerClose asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute end-2 top-2 size-11"
              aria-label={t("close")}
            >
              <X className="size-4" />
            </Button>
          </DrawerClose>
        </DrawerHeader>
        {canSimulate && (
          <div className="grid shrink-0 grid-cols-2 gap-2 border-b px-4 py-2">
            <Button
              size="sm"
              fullWidth
              className="h-auto min-h-9 min-w-0 whitespace-normal py-2"
              variant={showConversation ? "default" : "outline"}
              aria-pressed={showConversation}
              onClick={() => setPreviewMode("conversation")}
            >
              {t("simulationTryAsCustomer")}
            </Button>
            <Button
              size="sm"
              fullWidth
              className="h-auto min-h-9 min-w-0 whitespace-normal py-2"
              variant={!showConversation ? "default" : "outline"}
              aria-pressed={!showConversation}
              onClick={() => {
                onSimulationTrace?.(null);
                setPreviewMode("event");
              }}
            >
              {t("simulationEvaluateEvent")}
            </Button>
          </div>
        )}
        {showConversation && draftScenario && open ? (
          <ScenarioConversationPreview
            workspaceId={workspaceId}
            draftScenario={draftScenario}
            onTrace={onSimulationTrace}
            context={{
              classificationCategory: formState.classificationCategory,
              internalLabels: formState.internalLabelsText
                .split(",")
                .flatMap(value => {
                  const trimmed = value.trim();
                  return trimmed ? [trimmed] : [];
                }),
              funnelStage: formState.funnelStage,
              hasPurchaseHistory: formState.hasPurchaseHistory,
            }}
          />
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="min-w-0 space-y-5 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldChannel")}
                    </span>
                    <select
                      value={selectedChannel}
                      onChange={event =>
                        updateFormState("channel", event.target.value)
                      }
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      {channelOptions.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldEvent")}
                    </span>
                    <select
                      value={formState.eventKind}
                      onChange={event =>
                        updateFormState(
                          "eventKind",
                          event.target.value as ScenarioPreviewEventKind
                        )
                      }
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      {eventOptions.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block min-w-0 space-y-1.5 text-sm">
                  <span className="font-medium">
                    {t("previewFieldMessage")}
                  </span>
                  <Textarea
                    value={formState.messageText}
                    onChange={event =>
                      updateFormState("messageText", event.target.value)
                    }
                    placeholder={t("previewFieldMessagePlaceholder")}
                    rows={4}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldClassification")}
                    </span>
                    <Input
                      value={formState.classificationCategory}
                      onChange={event =>
                        updateFormState(
                          "classificationCategory",
                          event.target.value
                        )
                      }
                      placeholder={t("previewFieldClassificationPlaceholder")}
                    />
                  </label>

                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldFunnelStage")}
                    </span>
                    <Input
                      value={formState.funnelStage}
                      onChange={event =>
                        updateFormState("funnelStage", event.target.value)
                      }
                      placeholder={t("previewFieldFunnelStagePlaceholder")}
                    />
                  </label>
                </div>

                <label className="block min-w-0 space-y-1.5 text-sm">
                  <span className="font-medium">{t("previewFieldLabels")}</span>
                  <Input
                    value={formState.internalLabelsText}
                    onChange={event =>
                      updateFormState("internalLabelsText", event.target.value)
                    }
                    placeholder={t("previewFieldLabelsPlaceholder")}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldQuickReplyPayload")}
                    </span>
                    <Input
                      value={formState.quickReplyPayload}
                      onChange={event =>
                        updateFormState("quickReplyPayload", event.target.value)
                      }
                      placeholder={t(
                        "previewFieldQuickReplyPayloadPlaceholder"
                      )}
                    />
                  </label>

                  <label className="block min-w-0 space-y-1.5 text-sm">
                    <span className="font-medium">
                      {t("previewFieldFlowReply")}
                    </span>
                    <Input
                      value={formState.whatsAppFlowResponseJson}
                      onChange={event =>
                        updateFormState(
                          "whatsAppFlowResponseJson",
                          event.target.value
                        )
                      }
                      placeholder={t("previewFieldFlowReplyPlaceholder")}
                    />
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span className="text-sm font-medium">
                      {t("previewFieldNewCustomer")}
                    </span>
                    <Switch
                      checked={formState.isNewCustomer}
                      onCheckedChange={checked =>
                        updateFormState("isNewCustomer", checked)
                      }
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span className="text-sm font-medium">
                      {t("previewFieldPurchaseHistory")}
                    </span>
                    <Switch
                      checked={formState.hasPurchaseHistory}
                      onCheckedChange={checked =>
                        updateFormState("hasPurchaseHistory", checked)
                      }
                    />
                  </label>
                </div>

                {draftScenario ? (
                  <div className="break-words rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
                    {t("previewDraftIncluded", {
                      name: draftScenario.name,
                    })}
                  </div>
                ) : null}

                {executionState.error ? (
                  <div
                    role="alert"
                    className="break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  >
                    {executionState.error}
                  </div>
                ) : null}

                {executionState.result ? (
                  <div className="space-y-3">
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <div className="text-xs uppercase text-muted-foreground">
                        {t("previewWinnerLabel")}
                      </div>
                      {executionState.result.winner ? (
                        <>
                          <div className="mt-1 break-words text-sm font-semibold">
                            {executionState.result.winner.scenarioName}
                          </div>
                          {executionState.result.winner.selectedActionType ? (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              <Badge variant="secondary">
                                {
                                  executionState.result.winner
                                    .selectedActionType
                                }
                              </Badge>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="mt-1 text-sm text-muted-foreground">
                          {t("previewWinnerNone")}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      {executionState.result.evaluations.map(evaluation => (
                        <div
                          key={`${evaluation.scenarioId}-${evaluation.order}`}
                          className={cn(
                            "rounded-lg border p-3",
                            evaluationTone(evaluation.result)
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="break-words text-sm font-medium">
                                {evaluation.order}. {evaluation.scenarioName}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                <Badge variant="secondary">
                                  {evaluation.result === "winner"
                                    ? t("previewResultWinner")
                                    : evaluation.result ===
                                        "matched_but_shadowed"
                                      ? t("previewResultShadowed")
                                      : t("previewResultSkipped")}
                                </Badge>
                              </div>
                            </div>
                            <div className="shrink-0 text-xs text-muted-foreground">
                              {t("priority")}: {evaluation.scenarioPriority}
                            </div>
                          </div>

                          {evaluation.reason ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                              {formatReason(evaluation.reason, t)}
                            </div>
                          ) : null}

                          {evaluation.pathNodeIds?.length ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {evaluation.pathNodeIds.map(nodeId => (
                                <Badge
                                  key={`${evaluation.scenarioId}-${nodeId}`}
                                  variant="outline"
                                  className="max-w-full whitespace-normal break-all text-[10px]"
                                >
                                  {nodeId}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </ScrollArea>

            <DrawerFooter className="shrink-0 border-t pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Button
                fullWidth
                onClick={() => void runPreview()}
                disabled={executionState.loading}
              >
                {executionState.loading ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-1.5 h-4 w-4" />
                )}
                {t("previewRun")}
              </Button>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
