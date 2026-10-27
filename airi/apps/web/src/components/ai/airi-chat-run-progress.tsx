"use client";

import {
  isAiriChatRunTerminal,
  type AiriChatRunEvent,
} from "@/lib/airi-chats/run-events";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";

const PHASE_BY_STAGE = {
  thread: "preparing",
  user_message: "preparing",
  intent: "understanding",
  source_validation: "context",
  selected_sources: "context",
  history: "context",
  workspace_retrieval: "context",
  product_context: "context",
  product_kb: "context",
  tool_access: "context",
  generation: "writing",
  template_draft: "template",
  flow_draft: "flow",
  image_brief: "image",
  image_generation: "image",
  opportunity_scan: "opportunities",
  opportunity_artifact: "saving",
  campaign_package: "campaign",
  campaign_artifact: "saving",
  builder_artifact: "saving",
  assistant_message: "saving",
  generation_recovery: "saving",
  meta_mcp_summary: "writing",
} as const;

type ProgressState = {
  phase:
    | (typeof PHASE_BY_STAGE)[keyof typeof PHASE_BY_STAGE]
    | "working"
    | "ads"
    | "ready"
    | "partial"
    | "stopped"
    | "error";
  running: boolean;
  error?: string;
};

type AiriChatRunStageEvent = Extract<AiriChatRunEvent, { type: "stage" }>;

/**
 * The stage the live label describes. Stages run side by side (retrieval
 * goes on while intent finishes), so the label follows the most recently
 * started stage that is still running, and falls back to the last stage
 * event when none is.
 */
function getLabelStage(
  events: AiriChatRunEvent[]
): AiriChatRunStageEvent | undefined {
  const latestById = new Map<string, AiriChatRunStageEvent>();
  let lastStage: AiriChatRunStageEvent | undefined;
  for (const event of events) {
    if (event.type !== "stage") continue;
    lastStage = event;
    // Re-inserting moves a stage that starts again to the end of the order.
    if (event.status === "running") latestById.delete(event.id);
    if (event.status === "running" || latestById.has(event.id)) {
      latestById.set(event.id, event);
    }
  }
  const running = [...latestById.values()].filter(
    stage => stage.status === "running"
  );
  return running.at(-1) ?? lastStage;
}

function getProgressState(events: AiriChatRunEvent[]): ProgressState {
  if (!isAiriChatRunTerminal(events)) {
    const stage = getLabelStage(events);
    const phase = stage
      ? (PHASE_BY_STAGE[stage.id as keyof typeof PHASE_BY_STAGE] ??
        (stage.id.startsWith("meta_mcp_") ? "ads" : "working"))
      : "preparing";
    return { phase, running: true };
  }
  // Stop: the run ended as cancelled, with or without a saved answer.
  const done = events.findLast(event => event.type === "done");
  if (done?.status === "cancelled") return { phase: "stopped", running: false };
  const error = events.findLast(event => event.type === "error");
  if (error?.code === "cancelled") return { phase: "stopped", running: false };
  if (error) return { phase: "error", running: false, error: error.message };
  const answer = events.findLast(event => event.type === "assistant_message");
  if (answer) {
    const metadata = answer.message.metadata;
    if (metadata?.cancelled === true) {
      return { phase: "stopped", running: false };
    }
    if (metadata?.failed) return { phase: "error", running: false };
    const coverage = metadata?.airiMetaAdsMcpCoverage;
    if (
      coverage &&
      typeof coverage === "object" &&
      "complete" in coverage &&
      coverage.complete === false
    ) {
      const stopped =
        "reasons" in coverage &&
        Array.isArray(coverage.reasons) &&
        coverage.reasons.includes("cancelled");
      return { phase: stopped ? "stopped" : "partial", running: false };
    }
    return { phase: "ready", running: false };
  }
  return { phase: "ready", running: false };
}

function ActivityTrace({ events }: { events: AiriChatRunEvent[] }) {
  const t = useTranslations("AiriChatProgress");
  const occurrences = new Map<string, number>();
  const activity = events.flatMap(event => {
    if (
      event.type !== "stage" &&
      event.type !== "model_attempt" &&
      event.type !== "resources"
    )
      return [];
    const identity = `${event.type}:${event.id}:${event.at}:${event.status}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return [{ key: `${identity}:${occurrence}`, event }];
  });
  return (
    <ol className="space-y-3 text-xs">
      {activity.map(({ key, event }) => (
        <li key={key} className="min-w-0 [overflow-wrap:anywhere]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 font-medium text-foreground/80">
              {event.label}
            </span>
            <span
              className={
                event.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {t(event.status === "error" ? "failed" : event.status)}
            </span>
          </div>
          {event.type === "resources" ? (
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {event.resources.map(resource => (
                <li
                  key={resource.id}
                  className="flex flex-wrap justify-between gap-x-3"
                >
                  <span className="min-w-0">{resource.label}</span>
                  <span>
                    {typeof resource.count === "number"
                      ? resource.count
                      : resource.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-0.5 space-y-0.5 text-muted-foreground">
              {event.type === "model_attempt" && event.model ? (
                <p>{event.model}</p>
              ) : null}
              {event.detail ? <p>{event.detail}</p> : null}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AiriChatRunProgress({
  events,
}: {
  events: AiriChatRunEvent[];
}) {
  const t = useTranslations("AiriChatProgress");
  const state = getProgressState(events);
  const Icon = state.running
    ? Loader2
    : state.phase === "stopped"
      ? CircleStop
      : state.phase === "error" || state.phase === "partial"
        ? AlertCircle
        : CheckCircle2;
  const hasActivity = events.some(
    event =>
      event.type === "stage" ||
      event.type === "model_attempt" ||
      event.type === "resources"
  );
  return (
    <div className="w-full min-w-0 max-w-xl rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5">
      <output
        aria-live="polite"
        aria-busy={state.running}
        className="flex min-w-0 items-center gap-2 text-sm"
      >
        <Icon
          aria-hidden="true"
          className={
            state.running
              ? "size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
              : "size-4 shrink-0 text-muted-foreground"
          }
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t(state.phase)}
        </span>
      </output>
      {state.error ? (
        // The workspace error banner (role="alert", with Retry) announces the
        // failure once; this copy in the chat log stays quiet.
        <p
          aria-live="off"
          className="mt-2 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {state.error}
        </p>
      ) : null}
      {hasActivity ? (
        <Collapsible className="mt-1 min-w-0">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group h-7 max-w-full justify-start gap-1.5 px-0 text-xs text-muted-foreground hover:bg-transparent"
            >
              <span className="min-w-0 whitespace-normal text-left">
                {t("details")}
              </span>
              <ChevronDown
                aria-hidden="true"
                className="size-3 shrink-0 group-data-[state=open]:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          {/* The status line above announces progress; trace rows added
              inside the chat log stay quiet instead of each being read. */}
          <CollapsibleContent
            aria-live="off"
            data-testid="airi-run-activity-trace"
            className="max-h-64 min-w-0 overflow-y-auto overscroll-contain pt-2"
          >
            <ActivityTrace events={events} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
