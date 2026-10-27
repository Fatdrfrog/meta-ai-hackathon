"use client";

import { ViewportPortal } from "@xyflow/react";
import { PlugZap, Users, Zap } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import type { ScenarioEmptyCanvasRootKind } from "../../graph/node-palette";
import type { ScenarioFlowNode } from "../../types";

export function ScenarioDemoCallouts({
  nodes,
  t,
}: {
  nodes: ScenarioFlowNode[];
  t: (key: string) => string;
}) {
  const callouts = useMemo(() => {
    const calloutDefinitions = [
      {
        id: "trigger",
        kind: "trigger" as const,
        title: t("scenarioOnboardingCalloutTriggerTitle"),
        body: t("scenarioOnboardingCalloutTriggerBody"),
        offset: { x: 8, y: -96 },
        tone: "border-amber-300/80 bg-amber-50/95 text-amber-950 dark:bg-amber-950/90 dark:text-amber-50",
      },
      {
        id: "context",
        kind: "context" as const,
        title: t("scenarioOnboardingCalloutContextTitle"),
        body: t("scenarioOnboardingCalloutContextBody"),
        offset: { x: 12, y: -110 },
        tone: "border-blue-300/80 bg-blue-50/95 text-blue-950 dark:bg-blue-950/90 dark:text-blue-50",
      },
      {
        id: "action",
        kind: "action" as const,
        title: t("scenarioOnboardingCalloutActionTitle"),
        body: t("scenarioOnboardingCalloutActionBody"),
        offset: { x: 18, y: -96 },
        tone: "border-emerald-300/80 bg-emerald-50/95 text-emerald-950 dark:bg-emerald-950/90 dark:text-emerald-50",
      },
    ];

    return calloutDefinitions.flatMap(definition => {
      const node = nodes.find(current => current.data.kind === definition.kind);
      return node ? [{ ...definition, node }] : [];
    });
  }, [nodes, t]);

  if (callouts.length === 0) return null;

  return (
    <ViewportPortal>
      {callouts.map(callout => (
        <div
          key={callout.id}
          className={`pointer-events-none absolute w-[220px] rounded-lg border px-3 py-2 text-xs shadow-sm backdrop-blur ${callout.tone}`}
          style={{
            transform: `translate(${callout.node.position.x + callout.offset.x}px, ${
              callout.node.position.y + callout.offset.y
            }px)`,
          }}
        >
          <div className="font-semibold leading-snug">{callout.title}</div>
          <div className="mt-1 leading-snug text-muted-foreground">
            {callout.body}
          </div>
        </div>
      ))}
    </ViewportPortal>
  );
}

export function ScenarioNoSourcePrompt({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10">
      <Link
        href={href}
        className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border bg-background/95 px-3 text-xs font-medium shadow-sm backdrop-blur transition-colors hover:bg-muted"
      >
        <PlugZap className="h-3.5 w-3.5 text-primary" />
        {label}
      </Link>
    </div>
  );
}

export function ScenarioCanvasEmptyState({
  title,
  body,
  secondary,
  triggerLabel,
  triggerHint,
  bulkLabel,
  bulkHint,
  onAddRoot,
}: {
  title: string;
  body: string;
  secondary: string;
  triggerLabel: string;
  triggerHint: string;
  bulkLabel: string;
  bulkHint: string;
  onAddRoot: (kind: ScenarioEmptyCanvasRootKind) => void;
}) {
  const rootChoices = [
    {
      kind: "trigger",
      label: triggerLabel,
      hint: triggerHint,
      Icon: Zap,
      tone: "border-amber-200/80 bg-amber-50/90 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 dark:hover:border-amber-800/60 dark:hover:bg-amber-950/50",
      iconTone:
        "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-800/60 dark:bg-amber-900/40 dark:text-amber-200",
    },
    {
      kind: "bulk",
      label: bulkLabel,
      hint: bulkHint,
      Icon: Users,
      tone: "border-sky-200/80 bg-sky-50/90 hover:border-sky-300 hover:bg-sky-50 dark:border-sky-900/50 dark:bg-sky-950/30 dark:hover:border-sky-800/60 dark:hover:bg-sky-950/50",
      iconTone:
        "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-800/60 dark:bg-sky-900/40 dark:text-sky-200",
    },
  ] as const;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-6"
      data-testid="scenario-canvas-empty-state"
    >
      <div className="max-w-lg text-center">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        <div className="pointer-events-auto mt-4 grid gap-2 sm:grid-cols-2">
          {rootChoices.map(({ kind, label, hint, Icon, tone, iconTone }) => (
            <button
              key={kind}
              type="button"
              data-testid={`scenario-canvas-empty-cta-${kind}`}
              className={`nodrag flex items-start gap-3 rounded-xl border px-3 py-3 text-left shadow-sm transition-colors ${tone}`}
              onClick={event => {
                event.stopPropagation();
                onAddRoot(kind);
              }}
              onPointerDown={event => event.stopPropagation()}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${iconTone}`}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  {label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {hint}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground/90">
          {secondary}
        </p>
      </div>
    </div>
  );
}
