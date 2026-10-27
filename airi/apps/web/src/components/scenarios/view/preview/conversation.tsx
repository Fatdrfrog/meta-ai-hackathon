"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { Play, RotateCcw, Send, Clock, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  ScenarioSimulationContext,
  ScenarioSimulationEvent,
} from "@/lib/scenarios/scenario-simulation-types";
import type { ScenarioDraftPreviewInput } from "./evaluation";
import {
  useScenarioSimulation,
  type ScenarioSimulationTrace,
  type SimulationChatEntry,
} from "./use-scenario-simulation";
import { SimulationMessage } from "./simulation-message";

function ConversationStatus({
  loading,
  status,
  label,
  statusRef,
}: {
  loading: boolean;
  status: "completed" | "blocked" | "handoff" | "waiting";
  label: string;
  statusRef: RefObject<HTMLOutputElement | null>;
}) {
  return (
    <output
      className="flex items-center justify-center gap-2 py-2 text-center text-sm text-muted-foreground outline-none"
      ref={statusRef}
      tabIndex={-1}
    >
      {loading ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : status === "completed" ? (
        <Check className="size-4" />
      ) : (
        <Clock className="size-4" />
      )}
      {label}
    </output>
  );
}

function ConversationTranscript({
  entries,
  waiting,
  loading,
  lastMessageIndex,
  onEvent,
}: {
  entries: SimulationChatEntry[];
  waiting: boolean;
  loading: boolean;
  lastMessageIndex: number;
  onEvent: (event: ScenarioSimulationEvent, label?: string) => void;
}) {
  const t = useTranslations("Scenarios");
  return (
    <>
      {entries.map((entry, index) => (
        <div key={entry.id}>
          {entry.kind === "customer" ? (
            <p className="ms-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-xl bg-primary/10 px-3 py-2 text-sm">
              {entry.text}
            </p>
          ) : entry.kind === "time" ? (
            <p className="text-center text-xs text-muted-foreground">
              {t("simulationTimePassed", { minutes: entry.minutes })}
            </p>
          ) : entry.kind === "payment" ? (
            <p className="text-center text-xs text-muted-foreground">
              {t("simulationPaymentConfirmed")}
            </p>
          ) : (
            <SimulationMessage
              message={entry.message}
              enabled={waiting && !loading && index === lastMessageIndex}
              onEvent={onEvent}
            />
          )}
        </div>
      ))}
    </>
  );
}

function ConversationComposer({
  canSend,
  waiting,
  loading,
  text,
  dueAt,
  now,
  paymentEnabled,
  onTextChange,
  onEvent,
  onSend,
}: {
  canSend: boolean;
  waiting: boolean;
  loading: boolean;
  text: string;
  dueAt: number | null | undefined;
  now: number;
  paymentEnabled: boolean;
  onTextChange: (value: string) => void;
  onEvent: (event: ScenarioSimulationEvent, label?: string) => void;
  onSend: () => void;
}) {
  const t = useTranslations("Scenarios");
  if (!canSend) return null;
  return (
    <div className="shrink-0 space-y-2 border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {dueAt !== null && dueAt !== undefined && (
        <Button
          variant="outline"
          className="h-auto min-h-10 w-full whitespace-normal py-2"
          disabled={loading}
          onClick={() =>
            onEvent({
              kind: "advance",
              minutes: Math.max(1 / 60, (dueAt - now) / 60_000),
            })
          }
        >
          <Clock className="size-4" />
          {t("simulationSkipWait", {
            minutes: Math.max(1, Math.ceil((dueAt - now) / 60_000)),
          })}
        </Button>
      )}
      {waiting && paymentEnabled && (
        <Button
          variant="outline"
          className="h-auto min-h-10 w-full whitespace-normal py-2"
          disabled={loading}
          onClick={() => onEvent({ kind: "payment" })}
        >
          {t("simulationConfirmPayment")}
        </Button>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          rows={1}
          className="max-h-32 min-h-10 min-w-0 flex-1 resize-none"
          value={text}
          onChange={event => onTextChange(event.target.value)}
          disabled={!canSend || loading}
          maxLength={4096}
          onKeyDown={event => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSend();
            }
          }}
          aria-label={t("simulationYourMessage")}
          placeholder={t("simulationYourMessage")}
        />
        <Button
          type="button"
          size="icon"
          disabled={!canSend || loading || !text.trim()}
          aria-label={t("simulationSend")}
          onClick={onSend}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

export function ScenarioConversationPreview({
  workspaceId,
  draftScenario,
  context,
  onTrace,
}: {
  workspaceId: string;
  draftScenario: ScenarioDraftPreviewInput;
  context?: ScenarioSimulationContext;
  onTrace?: (trace: ScenarioSimulationTrace | null) => void;
}) {
  const t = useTranslations("Scenarios");
  const simulation = useScenarioSimulation({
    workspaceId,
    draftScenario,
    context,
    onTrace,
  });
  const [text, setText] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLOutputElement>(null);
  const state = simulation.result?.state;
  const latestEntryId = simulation.entries.at(-1)?.id;
  useEffect(() => {
    transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight });
    if (state?.status === "completed" || state?.status === "blocked")
      status.current?.focus({ preventScroll: true });
  }, [latestEntryId, simulation.error, state?.status]);
  const restart = () => {
    setText("");
    simulation.reset();
  };
  const waiting = state?.status === "waiting";
  const canSend = waiting || state?.status === "handoff";
  const current = draftScenario.nodes.find(
    node => node.id === state?.actionNodeId
  );
  const lastMessageIndex = simulation.entries.findLastIndex(
    entry => entry.kind === "message"
  );
  const onEvent = (event: ScenarioSimulationEvent, label?: string) => {
    void simulation.run(event, label);
  };
  const sendCustomerMessage = async () => {
    if (!text.trim() || !canSend || simulation.loading) return;
    const submittedText = text;
    if (
      await simulation.run({
        kind: "message",
        text: submittedText.trim(),
      })
    ) {
      setText(current => (current === submittedText ? "" : current));
    }
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="scenario-conversation-preview"
    >
      {state && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <span className="text-sm font-medium">WhatsApp</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={simulation.loading}
            onClick={restart}
          >
            <RotateCcw className="size-4" />
            {t("simulationRestart")}
          </Button>
        </div>
      )}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain bg-muted/40 p-4",
          !state && "flex flex-col"
        )}
        role="log"
        ref={transcript}
        aria-label={t("simulationConversation")}
        aria-live="polite"
        aria-busy={simulation.loading}
      >
        {!state && (
          <div className="flex min-h-40 flex-1 items-center justify-center">
            <Button
              disabled={simulation.loading}
              onClick={() => onEvent({ kind: "start" })}
            >
              {simulation.loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {t("simulationStart")}
            </Button>
          </div>
        )}
        <ConversationTranscript
          entries={simulation.entries}
          waiting={waiting}
          loading={simulation.loading}
          lastMessageIndex={lastMessageIndex}
          onEvent={onEvent}
        />
        {state && (
          <ConversationStatus
            loading={simulation.loading}
            status={state.status}
            statusRef={status}
            label={t(
              simulation.loading
                ? "loading"
                : state.status === "completed"
                  ? "simulationEnded"
                  : state.status === "handoff"
                    ? "simulationHandoff"
                    : state.status === "blocked"
                      ? "simulationUnsupportedAction"
                      : "simulationWaiting"
            )}
          />
        )}
        {simulation.error && (
          <p
            role="alert"
            className="break-words rounded-md border border-destructive/30 p-3 text-sm text-destructive"
          >
            {simulation.error}
          </p>
        )}
      </div>
      <ConversationComposer
        canSend={canSend}
        waiting={waiting}
        loading={simulation.loading}
        text={text}
        dueAt={state?.dueAt}
        now={state?.now ?? 0}
        paymentEnabled={Boolean(
          current?.data.actionOutcomes?.paymentDetected?.enabled
        )}
        onTextChange={setText}
        onEvent={onEvent}
        onSend={() => {
          void sendCustomerMessage();
        }}
      />
    </div>
  );
}
