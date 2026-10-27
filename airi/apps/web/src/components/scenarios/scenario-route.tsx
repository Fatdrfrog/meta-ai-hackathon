"use client";

import { cn } from "@/lib/utils";
import { CornerDownRight, type LucideIcon } from "lucide-react";
import { useContext } from "react";
import { sanitizeScenarioDestinationLabel } from "./scenario-node-labels";
import {
  ScenarioSourceHandleButton,
  SCENARIO_ROUTE_DOT_SIZE_CLASS,
  SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
  SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS,
} from "./source-handle-button";
import { ScenarioSourceHandlePresentationContext } from "./source-handle-presentation-context";
import type { ScenarioSourceHandleCreatePoint } from "./source-handle-types";
import type { TranslateFn } from "./types";

export function bindSourceHandleCreate(
  create:
    | ((sourceHandleId: string, clientX: number, clientY: number) => void)
    | undefined,
  handleId: string
): ((point: ScenarioSourceHandleCreatePoint) => void) | undefined {
  if (!create) return undefined;
  return point => create(handleId, point.clientX, point.clientY);
}

export const SCENARIO_ROUTE_HANDLE_EDGE_CLASS = cn(
  SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
  SCENARIO_ROUTE_DOT_SIZE_CLASS
);

/** Hang a route dot on the node border from content inset by `px-3`. */
export const SCENARIO_ROUTE_HANDLE_PADDED_EDGE_CLASS = cn(
  SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS,
  SCENARIO_ROUTE_DOT_SIZE_CLASS
);

/** Sit on a nested card/row edge. Same xyflow math as a node-edge source handle. */
export const SCENARIO_ROUTE_HANDLE_LOCAL_CLASS =
  SCENARIO_ROUTE_HANDLE_EDGE_CLASS;

export const SCENARIO_ROUTE_ROW_CLASS =
  "relative flex min-h-8 min-w-0 items-center gap-2 overflow-visible pl-3 pr-2.5";

type ScenarioRouteHandleProps = {
  id: string;
  connected?: boolean;
  /** False keeps click-to-create but blocks dragging a new edge. */
  connectable?: boolean;
  /** An unlinked required route shows a rose dot. */
  required?: boolean;
  title: string;
  ariaLabel?: string;
  testId?: string;
  inset?: boolean;
  /** Sit on the current row/card edge instead of the outer node border. */
  local?: boolean;
  externalAnchor?: boolean;
  routeLabel?: string;
  onCreateNode?: (point: ScenarioSourceHandleCreatePoint) => void;
  onInteractionStart?: () => void;
};

export function ScenarioRouteHandle({
  id,
  connected = false,
  connectable = true,
  required = false,
  title,
  ariaLabel,
  testId,
  inset = false,
  local = false,
  externalAnchor = false,
  routeLabel,
  onCreateNode,
  onInteractionStart,
}: ScenarioRouteHandleProps) {
  return (
    <ScenarioSourceHandleButton
      id={id}
      variant="route"
      connected={connected}
      connectable={connectable}
      required={required}
      externalAnchor={externalAnchor}
      routeLabel={routeLabel}
      className={
        externalAnchor
          ? undefined
          : local
            ? SCENARIO_ROUTE_HANDLE_LOCAL_CLASS
            : inset
              ? SCENARIO_ROUTE_HANDLE_PADDED_EDGE_CLASS
              : SCENARIO_ROUTE_HANDLE_EDGE_CLASS
      }
      interactionTargetPlacement="outward"
      title={title}
      aria-label={ariaLabel ?? title}
      data-testid={testId}
      onCreateNode={onCreateNode}
      onInteractionStart={onInteractionStart}
    />
  );
}

function joinRouteLabel(label: string, detail?: string): string {
  return detail ? `${label} · ${detail}` : label;
}

function resolveDestinationName(rawDestination: string | undefined) {
  return rawDestination
    ? sanitizeScenarioDestinationLabel(rawDestination) || rawDestination
    : undefined;
}

function RouteRowText({
  icon: Icon,
  label,
  detail,
  destination,
}: {
  icon?: LucideIcon;
  label: string;
  detail?: string;
  destination?: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5">
      {Icon ? (
        <Icon
          className="mt-0.5 size-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2 text-[11px]">
          <span className="line-clamp-2 min-w-0 flex-1 break-words font-medium text-foreground">
            {label}
          </span>
          {detail ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </div>
        {destination ? (
          <div className="flex min-w-0 items-start gap-1 text-[10px] text-muted-foreground">
            <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden />
            <span className="line-clamp-2 min-w-0 break-words">
              {destination}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type ScenarioRouteRowProps = {
  handleId: string;
  sourceLabel: string;
  /** The route kind; decorative. */
  icon?: LucideIcon;
  /** A short value such as "30 min", never truncated. */
  detail?: string;
  /** Names the dot, e.g. "Taps “Yes”"; defaults to "label · detail". */
  accessibleLabel?: string;
  connected?: boolean;
  /** False keeps click-to-create but blocks dragging a new edge. */
  connectable?: boolean;
  required?: boolean;
  chooseLabel?: string;
  destinationLabel?: string;
  externalAnchor?: boolean;
  onCreateNode?: (point: ScenarioSourceHandleCreatePoint) => void;
  onInteractionStart?: () => void;
  "data-testid"?: string;
};

export function ScenarioRouteRow({
  handleId,
  sourceLabel,
  icon,
  detail,
  accessibleLabel,
  connected = false,
  connectable = true,
  required = false,
  chooseLabel,
  destinationLabel,
  externalAnchor = false,
  onCreateNode,
  onInteractionStart,
  "data-testid": dataTestId = "scenario-route-row",
}: ScenarioRouteRowProps) {
  const presentation = useContext(ScenarioSourceHandlePresentationContext);
  const destination = resolveDestinationName(
    destinationLabel ??
      presentation?.destinationsBySourceHandle?.get(handleId)?.label
  );
  const isConnected = connected || Boolean(destination);
  const routeLabel = joinRouteLabel(sourceLabel, detail);
  // Mouse fallback only; the dot's accessible name carries the same text.
  const title =
    isConnected && destination ? `${routeLabel} → ${destination}` : routeLabel;

  return (
    <div
      className={SCENARIO_ROUTE_ROW_CLASS}
      data-testid={dataTestId}
      data-connected={String(isConnected)}
      title={title}
    >
      <RouteRowText
        icon={icon}
        label={sourceLabel}
        detail={detail}
        // An external anchor's button already names the next step.
        destination={isConnected && !externalAnchor ? destination : undefined}
      />
      <ScenarioRouteHandle
        id={handleId}
        externalAnchor={externalAnchor}
        connected={isConnected}
        connectable={connectable}
        required={required}
        routeLabel={
          isConnected ? destination : (chooseLabel ?? presentation?.chooseLabel)
        }
        title={title}
        ariaLabel={accessibleLabel ?? routeLabel}
        testId="scenario-route-dot"
        onCreateNode={onCreateNode}
        onInteractionStart={onInteractionStart}
      />
    </div>
  );
}

/**
 * A read-only route line for the settings panel, where route dots can't be
 * shown: the same layout as a route row, with the next step or its status.
 */
export function ScenarioRouteSummaryRow({
  icon,
  label,
  detail,
  destinationLabel,
  connected = false,
  required = false,
  t,
}: {
  icon?: LucideIcon;
  label: string;
  detail?: string;
  destinationLabel?: string;
  /** Linked with no known destination name. */
  connected?: boolean;
  required?: boolean;
  t: TranslateFn;
}) {
  const destination = resolveDestinationName(destinationLabel);
  const status = destination
    ? "linked"
    : connected
      ? "connected"
      : required
        ? "required"
        : "unlinked";
  return (
    <div
      className="flex min-h-8 min-w-0 items-start gap-2 py-1.5"
      data-testid="scenario-route-summary-row"
      data-route-status={status}
    >
      <div className="min-w-0 flex-1">
        <RouteRowText
          icon={icon}
          label={label}
          detail={detail}
          destination={destination}
        />
        {status === "linked" ? null : (
          <p
            className={cn(
              "text-[10px]",
              icon && "pl-[18px]",
              status === "required"
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground"
            )}
          >
            {t(
              status === "connected"
                ? "sourceHandleStatusConnected"
                : status === "required"
                  ? "sourceHandleStatusRequired"
                  : "sourceHandleStatusUnlinked"
            )}
          </p>
        )}
      </div>
    </div>
  );
}
