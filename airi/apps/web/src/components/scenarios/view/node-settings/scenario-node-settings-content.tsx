"use client";

import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import { Link2, Zap } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { ActionNodeKindIcon } from "../../nodes/action-node/action-node-kind-icon";
import {
  isTerminalActionNode,
  resolveActionNodeCardTitle,
} from "../../nodes/action-node/action-node-state";
import { LazyActionNodeSettings } from "../../nodes/action-node/lazy-action-node-sections";
import { LinkNodeSettings } from "../../nodes/link-node-settings";
import { LazyTriggerNodeSettings } from "../../nodes/trigger-node/lazy-trigger-node-settings";
import type { ScenarioFlowNode } from "../../types";
import { enrichScenarioEditorNode } from "../node-enrichment/enrich-scenario-node";
import type {
  ScenarioActionEditorFlowNode,
  ScenarioActionEditorNodeData,
  ScenarioLinkEditorFlowNode,
  ScenarioTriggerEditorFlowNode,
} from "../node-enrichment/types";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";

export type ScenarioNodeSettingsTarget =
  | { kind: "trigger"; node: ScenarioTriggerEditorFlowNode }
  | { kind: "scenario_link"; node: ScenarioLinkEditorFlowNode }
  | { kind: "action"; node: ScenarioActionEditorFlowNode };

/**
 * Kinds edited in node settings. Other kinds keep their canvas editors;
 * continuation entries cannot edit root criteria and a WhatsApp QR trigger
 * keeps its managed picker on the card. Every action except End scenario has
 * settings.
 */
export function supportsScenarioNodeSettings(
  node: ScenarioFlowNode | undefined
): boolean {
  if (!node) return false;
  if (node.data.kind === "scenario_link") return true;
  if (node.data.kind === "action") return !isTerminalActionNode(node.data);
  if (node.data.kind !== "trigger" || node.data.linkedConditionId) {
    return false;
  }
  return (
    normalizeScenarioTriggerConfig({ nodeData: node.data }).entryPointType !==
    "whatsapp_qr"
  );
}

/** Enriches a node with the same projection and commands as its card. */
export function resolveScenarioNodeSettingsTarget(
  node: ScenarioFlowNode | undefined,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioNodeSettingsTarget | null {
  if (!node || !supportsScenarioNodeSettings(node)) return null;
  const enriched = enrichScenarioEditorNode(node, ctx);
  if (enriched?.type === "triggerNode") {
    return { kind: "trigger", node: enriched };
  }
  if (enriched?.type === "scenarioLinkNode") {
    return { kind: "scenario_link", node: enriched };
  }
  if (enriched?.type === "actionNode") {
    return { kind: "action", node: enriched };
  }
  return null;
}

type ScenarioNodeSettingsIcon = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

const actionKindIcons = new WeakMap<
  ScenarioActionEditorNodeData,
  ScenarioNodeSettingsIcon
>();

/**
 * The action's kind icon, as the panel header renders icons. One component
 * per node data object, so re-rendering the header keeps the same icon.
 */
function resolveActionSettingsIcon(
  nodeData: ScenarioActionEditorNodeData
): ScenarioNodeSettingsIcon {
  const known = actionKindIcons.get(nodeData);
  if (known) return known;
  function ActionSettingsKindIcon({ className }: { className?: string }) {
    return <ActionNodeKindIcon nodeData={nodeData} className={className} />;
  }
  actionKindIcons.set(nodeData, ActionSettingsKindIcon);
  return ActionSettingsKindIcon;
}

export function resolveScenarioNodeSettingsPresentation(
  target: ScenarioNodeSettingsTarget,
  t: ScenarioNodeEnrichmentContextValue["t"]
): {
  Icon: ScenarioNodeSettingsIcon;
  iconClassName: string;
  label: string;
  description: ReactNode;
} {
  switch (target.kind) {
    case "trigger":
      return {
        Icon: Zap,
        iconClassName: "text-amber-500",
        label: target.node.data.uiNodeLabel,
        description: t("triggerEditorDescription"),
      };
    case "scenario_link":
      return {
        Icon: Link2,
        iconClassName: "text-orange-500",
        label:
          target.node.data.linkedScenarioName || t("scenarioLinkPlaceholder"),
        description: t("nodeSettingsLinkDescription"),
      };
    case "action":
      return {
        Icon: resolveActionSettingsIcon(target.node.data),
        iconClassName: "",
        label: resolveActionNodeCardTitle(target.node.data, t),
        // The dialog keeps its description; the title and fields say it.
        description: (
          <span className="sr-only">{t("nodeSettingsActionDescription")}</span>
        ),
      };
  }
}

export function ScenarioNodeSettingsContent({
  target,
  ctx,
}: {
  target: ScenarioNodeSettingsTarget;
  ctx: ScenarioNodeEnrichmentContextValue;
}) {
  switch (target.kind) {
    case "trigger":
      return (
        <LazyTriggerNodeSettings
          nodeId={target.node.id}
          data={target.node.data}
          businessEventCatalog={ctx.businessEventCatalog}
          onRefreshBusinessEventCatalog={ctx.refreshBusinessEventCatalog}
        />
      );
    case "scenario_link":
      return (
        <LinkNodeSettings nodeId={target.node.id} data={target.node.data} />
      );
    case "action":
      return (
        <LazyActionNodeSettings
          nodeId={target.node.id}
          data={target.node.data}
        />
      );
  }
}
