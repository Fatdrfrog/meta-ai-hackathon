"use client";

import { Badge } from "@/components/ui/badge";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Link2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";
import type { ScenarioLinkEditorNodeProps } from "../view/node-enrichment/types";
import {
  resolveLinkedScenarioTriggerSummary,
  ScenarioLinkSelect,
} from "./link-node-settings";
import { ScenarioNodeCard } from "./node-card";
import { NodeHandles } from "./node-handlers";
import { areNodePropsEqual } from "./node-memo-utils";
import { ScenarioNodeSettingsButton } from "./node-settings-button";

export const ScenarioLinkNode = memo(function ScenarioLinkNode({
  id,
  data,
  selected,
}: ScenarioLinkEditorNodeProps) {
  const t = useTranslations("Scenarios");
  const nodeData = data;
  const linkedScenarioId = nodeData.linkedScenarioId || "";
  const linkedScenarioName = nodeData.linkedScenarioName || "";
  const scenarioOptions = nodeData.uiScenarioOptions ?? [];
  const onRemove = nodeData.uiOnRemove;
  const openSettings = nodeData.uiUsesSettingsPanel
    ? nodeData.uiOnOpenSettings
    : undefined;
  const title = linkedScenarioName || t("scenarioLinkPlaceholder");

  const selectedScenarioMeta = scenarioOptions.find(
    opt => opt.id === linkedScenarioId
  );
  const triggerSummary = resolveLinkedScenarioTriggerSummary(
    selectedScenarioMeta,
    t
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  return (
    <ScenarioNodeCard
      selected={selected}
      className="min-w-[260px] border-orange-300/70"
    >
      <NodeHandles kind="scenario_link" />

      <CardHeader className="flex flex-row items-center gap-2 p-3 pb-1">
        <Link2 className="h-4 w-4 shrink-0 text-orange-500" />
        <CardTitle className="flex-1 truncate text-xs font-semibold">
          {title}
        </CardTitle>
        <Badge
          variant="outline"
          className="shrink-0 border-orange-300 bg-orange-50 text-[9px] text-orange-700"
        >
          {t("badgeScenarioLink")}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-2 p-3 pt-1">
        {openSettings ? (
          <ScenarioNodeSettingsButton
            nodeId={id}
            label={t("settings")}
            accessibleLabel={t("nodeSettingsOpenFor", { label: title })}
            expanded={nodeData.uiIsEditorExpanded === true}
            onOpen={openSettings}
            className="h-7 text-xs"
          />
        ) : (
          <ScenarioLinkSelect
            data={nodeData}
            triggerClassName="h-7 text-xs"
            onTriggerKeyDown={handleKeyDown}
          />
        )}

        {triggerSummary ? (
          <div className="flex items-center gap-1 rounded bg-orange-50 px-2 py-1 text-[10px] text-orange-700">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{triggerSummary}</span>
          </div>
        ) : null}

        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex items-center gap-1 text-[10px] text-destructive hover:underline"
          >
            <Trash2 className="h-3 w-3" />
            {t("removeBlock")}
          </button>
        ) : null}
      </CardContent>
    </ScenarioNodeCard>
  );
}, areNodePropsEqual);
