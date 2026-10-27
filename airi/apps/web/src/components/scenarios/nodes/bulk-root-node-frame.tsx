"use client";

import { BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID } from "@icecore/scenario-contracts";
import { Position } from "@xyflow/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS } from "../source-handle-button";
import type { ScenarioBulkEditorNodeProps } from "../view/node-enrichment/types";
import { ScenarioNodeCard } from "./node-card";
import { NodeHandles } from "./node-handlers";

/**
 * The bulk block's card and handles. Its loading placeholder uses the same
 * frame, so edges stay attached and the width holds while the editor loads.
 */
export function BulkRootNodeFrame({
  selected,
  nodeData,
  children,
}: {
  selected: boolean;
  nodeData: ScenarioBulkEditorNodeProps["data"];
  children: ReactNode;
}) {
  const t = useTranslations("Scenarios");
  return (
    <ScenarioNodeCard
      selected={selected}
      className="w-[min(440px,calc(100vw-2rem))] max-w-[440px] overflow-visible border-sky-300/70"
    >
      <NodeHandles
        kind="bulk"
        onCreateNodeFromSourceHandle={(sourceHandleId, point) =>
          nodeData.uiOnCreateNodeFromSourceHandle?.(
            sourceHandleId,
            point.clientX,
            point.clientY
          )
        }
        sourceHandles={[
          {
            id: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
            position: Position.Right,
            className: SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
            title: t("bulkNodeConnectAction"),
            ariaLabel: t("bulkNodeConnectAction"),
            testId: `source-handle-${BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID}`,
          },
        ]}
      />
      {children}
    </ScenarioNodeCard>
  );
}
