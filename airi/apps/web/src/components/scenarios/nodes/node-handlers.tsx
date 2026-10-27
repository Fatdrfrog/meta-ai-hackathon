import { Handle, Position } from "@xyflow/react";
import { SCENARIO_HANDLE_RULES } from "../graph/config";
import { ScenarioNodeData } from "../types";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { memo, type CSSProperties } from "react";
import {
  ScenarioSourceHandleButton,
  SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
  SCENARIO_TARGET_HANDLE_ON_BOX_EDGE_CLASS,
  getXyflowHandleSideStyle,
} from "../source-handle-button";
import type { ScenarioSourceHandleCreatePoint } from "../source-handle-types";

export type ScenarioNodeSourceHandle = {
  id: string;
  top?: string;
  position?: Position;
  className?: string;
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
  connected?: boolean;
  connectedLabel?: string;
  testId?: string;
};

export const NodeHandles = memo(function NodeHandles({
  kind,
  compact = false,
  onCreateNodeFromSourceHandle,
  outputHandleOverride,
  hiddenSourceHandles,
  cornerSourceHandles,
  sourceHandles,
  suppressDefaultOutputHandle = false,
  defaultSourceHandleTitle,
  defaultSourceHandleAriaLabel,
  terminal = false,
  ownedSourceHandleIds,
}: {
  kind: ScenarioNodeData["kind"];
  compact?: boolean;
  onCreateNodeFromSourceHandle?: (
    sourceHandleId: string,
    point: ScenarioSourceHandleCreatePoint
  ) => void;
  /**
   * Overrides the static output handle for node variants with dynamic source
   * handles, such as interactive reply branches.
   */
  outputHandleOverride?: string | null;
  hiddenSourceHandles?: string[];
  /**
   * Hidden source handles anchored on the top right corner instead of mid
   * right edge: an edge that can't run then leaves no route's dot, and still
   * leaves rightward, clear of the node.
   */
  cornerSourceHandles?: readonly string[];
  sourceHandles?: ScenarioNodeSourceHandle[];
  suppressDefaultOutputHandle?: boolean;
  defaultSourceHandleTitle?: string;
  defaultSourceHandleAriaLabel?: string;
  terminal?: boolean;
  /**
   * Source handles the node renders in its own rows. NodeHandles adds no
   * hidden anchor or default output for them, so no id renders twice.
   */
  ownedSourceHandleIds?: readonly string[];
}) {
  const t = useTranslations("Scenarios");
  const defaultCreateNodeLabel = t("addBlock");
  const handleSizeClass = compact ? "!h-2.5 !w-2.5" : "!h-3 !w-3";
  const rule = SCENARIO_HANDLE_RULES[kind];
  const isOwned = (handleId: string) =>
    ownedSourceHandleIds?.includes(handleId) === true;
  const effectiveOutputHandleId = terminal
    ? null
    : suppressDefaultOutputHandle
      ? outputHandleOverride
      : (outputHandleOverride ?? rule?.outputHandleId);
  const visibleSourceHandleIds =
    Array.isArray(sourceHandles) && sourceHandles.length > 0
      ? sourceHandles.map(sourceHandle => sourceHandle.id)
      : effectiveOutputHandleId
        ? [effectiveOutputHandleId]
        : [];
  // Keep edges that were connected to the default output handle anchored even
  // when branch handles replace it (e.g. after quick-reply buttons are added).
  const hiddenDefaultOutputHandleId =
    !terminal &&
    rule?.outputHandleId &&
    !visibleSourceHandleIds.includes(rule.outputHandleId) &&
    !hiddenSourceHandles?.includes(rule.outputHandleId) &&
    !isOwned(rule.outputHandleId)
      ? rule.outputHandleId
      : null;

  return (
    <>
      {rule?.inputHandleId ? (
        <Handle
          key={`${kind}-${rule.inputHandleId}`}
          id={rule.inputHandleId}
          type="target"
          position={Position.Left}
          aria-label={t("canvasTargetHandle")}
          className={cn(
            "scenario-target-handle",
            handleSizeClass,
            SCENARIO_TARGET_HANDLE_ON_BOX_EDGE_CLASS,
            "!z-30 !border-2 !border-background !bg-primary"
          )}
          style={getXyflowHandleSideStyle(Position.Left)}
        />
      ) : null}
      {!terminal &&
        hiddenSourceHandles
          ?.filter(sourceHandleId => !isOwned(sourceHandleId))
          .map(sourceHandleId => (
            <Handle
              key={`${kind}-${sourceHandleId}-hidden`}
              id={sourceHandleId}
              type="source"
              position={Position.Right}
              aria-hidden
              className="!pointer-events-none !h-px !w-px !border-0 !bg-transparent !opacity-0"
              style={{
                top: cornerSourceHandles?.includes(sourceHandleId) ? 0 : "50%",
              }}
            />
          ))}
      {hiddenDefaultOutputHandleId ? (
        <Handle
          key={`${kind}-${hiddenDefaultOutputHandleId}-hidden-default`}
          id={hiddenDefaultOutputHandleId}
          type="source"
          position={Position.Right}
          aria-hidden
          className="!pointer-events-none !h-px !w-px !border-0 !bg-transparent !opacity-0"
          style={{ top: "50%" }}
        />
      ) : null}
      {!terminal && Array.isArray(sourceHandles) && sourceHandles.length > 0 ? (
        sourceHandles
          .filter(sourceHandle => !isOwned(sourceHandle.id))
          .map(sourceHandle => (
            <ScenarioSourceHandleButton
              key={`${kind}-${sourceHandle.id}`}
              id={sourceHandle.id}
              interactionTargetPlacement="outward"
              className={cn(
                SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
                sourceHandle.className
              )}
              position={sourceHandle.position}
              style={sourceHandle.style ?? { top: sourceHandle.top }}
              title={sourceHandle.title ?? defaultCreateNodeLabel}
              aria-label={sourceHandle.ariaLabel ?? defaultCreateNodeLabel}
              connected={sourceHandle.connected}
              connectedLabel={sourceHandle.connectedLabel}
              data-testid={sourceHandle.testId}
              onCreateNode={
                onCreateNodeFromSourceHandle
                  ? point =>
                      onCreateNodeFromSourceHandle(sourceHandle.id, point)
                  : undefined
              }
            />
          ))
      ) : effectiveOutputHandleId && !isOwned(effectiveOutputHandleId) ? (
        <ScenarioSourceHandleButton
          key={`${kind}-${effectiveOutputHandleId}`}
          id={effectiveOutputHandleId}
          interactionTargetPlacement="outward"
          className={SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS}
          title={defaultSourceHandleTitle ?? defaultCreateNodeLabel}
          aria-label={defaultSourceHandleAriaLabel ?? defaultCreateNodeLabel}
          onCreateNode={
            onCreateNodeFromSourceHandle
              ? point =>
                  onCreateNodeFromSourceHandle(effectiveOutputHandleId, point)
              : undefined
          }
        />
      ) : null}
    </>
  );
});
