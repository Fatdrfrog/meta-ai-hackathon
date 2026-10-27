"use client";

import type {
  ScenarioActionSourceId,
  ScenarioNodeData,
} from "@/components/scenarios/types";
import { cn } from "@/lib/utils";
import { CircleStop, Headset, MessageSquare, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  buildActionSourceOptions,
  resolveActionSelectorTypeForNode,
  resolveActionSourceIdForSelector,
} from "../../view/action/selector-utils";
import { ActionSourceIcon } from "./action-node-helpers";

const CHANNEL_SOURCE_IDS: ReadonlySet<ScenarioActionSourceId> = new Set([
  "whatsapp",
  "instagram",
  "telegram",
  "email",
  "web_widget",
]);

/**
 * What an action step does, as one icon. A step that sends on a channel shows
 * that channel's icon, named for screen readers; the others are decorative.
 */
export function ActionNodeKindIcon({
  nodeData,
  className,
}: {
  nodeData: ScenarioNodeData;
  className?: string;
}) {
  const t = useTranslations("Scenarios");
  const iconClassName = cn("size-4 shrink-0", className);
  const selectorType = resolveActionSelectorTypeForNode(nodeData);
  switch (selectorType) {
    case "generative_ai":
      return (
        <Sparkles
          className={cn(iconClassName, "text-violet-500")}
          aria-hidden
          data-kind-icon="generative_ai"
        />
      );
    case "assign_human":
      return (
        <Headset
          className={cn(iconClassName, "text-amber-600")}
          aria-hidden
          data-kind-icon="assign_human"
        />
      );
    case "end_scenario":
      // Same icon as the End scenario card.
      return (
        <CircleStop
          className={cn(iconClassName, "text-muted-foreground")}
          aria-hidden
          data-kind-icon="end_scenario"
        />
      );
  }
  const sourceId = resolveActionSourceIdForSelector(selectorType);
  const channelLabel = CHANNEL_SOURCE_IDS.has(sourceId)
    ? buildActionSourceOptions({ selectedSourceId: sourceId, t })[0]?.label
    : undefined;
  if (!channelLabel) {
    return (
      <MessageSquare
        className={cn(iconClassName, "text-emerald-500")}
        aria-hidden
        data-kind-icon="same_chat"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={channelLabel}
      className="inline-flex shrink-0 items-center"
      data-kind-icon={sourceId}
    >
      <ActionSourceIcon sourceId={sourceId} className={iconClassName} />
    </span>
  );
}
