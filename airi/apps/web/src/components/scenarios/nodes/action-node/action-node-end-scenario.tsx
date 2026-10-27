"use client";

import { CardContent, CardHeader } from "@/components/ui/card";
import { CircleStop } from "lucide-react";
import { useTranslations } from "next-intl";
import { stopScenarioKeyboardPropagationFromEditableTarget } from "../../scenario-keyboard-events";
import type { ScenarioActionEditorNodeProps } from "../../view/node-enrichment/types";
import { ScenarioNodeCard } from "../node-card";
import { NodeHandles } from "../node-handlers";
import {
  ActionNodeHeaderChrome,
  ActionNodeHeaderTitle,
} from "./action-node-expanded-ui";

export function EndScenarioActionNode({
  data,
  selected,
  compact,
}: ScenarioActionEditorNodeProps & { compact: boolean }) {
  const t = useTranslations("Scenarios");
  return (
    <div
      className="relative w-max min-w-0"
      data-testid="scenario-end-node"
      onKeyDown={stopScenarioKeyboardPropagationFromEditableTarget}
    >
      <ScenarioNodeCard
        selected={selected}
        interactive
        className={
          compact
            ? "w-[300px] max-w-[300px] gap-1 py-2"
            : "w-[340px] max-w-[calc(100vw_-_24px)] gap-1 py-2"
        }
      >
        <NodeHandles kind="action" compact={compact} terminal />
        <CardHeader className="gap-0 px-3">
          <ActionNodeHeaderChrome
            leading={
              <ActionNodeHeaderTitle
                icon={
                  <CircleStop
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                }
                title={t("actionTypeEndScenario")}
              />
            }
            onRemove={data.uiOnRemove}
            t={t}
          />
        </CardHeader>
        <CardContent className="px-3 pb-1 text-xs text-muted-foreground">
          {t("actionEndScenarioSummary")}
        </CardContent>
      </ScenarioNodeCard>
    </div>
  );
}
