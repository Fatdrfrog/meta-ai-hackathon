"use client";

import { cn } from "@/lib/utils";
import { Handle, Position, useStore, type ReactFlowState } from "@xyflow/react";
import { Check, Plus } from "lucide-react";
import { useContext, type CSSProperties } from "react";
import { sanitizeScenarioDestinationLabel } from "./scenario-node-labels";
import { ScenarioSourceHandlePresentationContext } from "./source-handle-presentation-context";
import type { ScenarioSourceHandleCreatePoint } from "./source-handle-types";
import { useSourceHandleCreate } from "./use-source-handle-create";

type ScenarioSourceHandleButtonProps = {
  id: string;
  appearance?: "default" | "ghost";
  className?: string;
  connectable?: boolean;
  connected?: boolean;
  connectedLabel?: string;
  inline?: boolean;
  interactionTargetPlacement?: "centered" | "outward";
  onCreateNode?: (point: ScenarioSourceHandleCreatePoint) => void;
  onInteractionStart?: () => void;
  position?: Position;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  variant?: "default" | "route";
  /** Route only: an unlinked required route shows a rose dot. */
  required?: boolean;
  routeLabel?: string;
  /** The node edge already retains this handle; render only its labeled control. */
  externalAnchor?: boolean;
};

/** Visible route outlet. Tiny dashed rings vanish on the node border. */
export const SCENARIO_ROUTE_DOT_PX = 14;
export const SCENARIO_ROUTE_DOT_SIZE_CLASS =
  "!h-3.5 !w-3.5 !min-h-3.5 !min-w-3.5";
export const SCENARIO_ROUTE_DOT_LINKED_CLASS =
  "scenario-source-handle-button--linked !border-2 !border-solid !border-white !bg-primary hover:!border-white hover:!bg-primary dark:!border-zinc-950";
export const SCENARIO_ROUTE_DOT_UNLINKED_CLASS =
  "scenario-source-handle-button--unlinked !border-2 !border-solid !border-white !bg-amber-400 hover:!border-white hover:!bg-amber-500 dark:!border-zinc-950 dark:hover:!bg-amber-300";
export const SCENARIO_ROUTE_DOT_REQUIRED_CLASS =
  "scenario-source-handle-button--unlinked scenario-source-handle-button--required !border-2 !border-solid !border-white !bg-rose-500 hover:!border-white hover:!bg-rose-600 dark:!border-zinc-950 dark:hover:!bg-rose-400";

/**
 * Official xyflow handle centering (`style.css` 12.x / reactflow.dev handles docs):
 * `.react-flow__handle-right { top: 50%; right: 0; transform: translate(50%, -50%); }`
 *
 * Never set Tailwind `translate-x` / `translate-y` on a Handle. Those utilities
 * write the separate CSS `translate` property (and `!` shorthand last-wins can
 * zero the X shift), so the 14px dot sits fully inside the card instead of on
 * the border. Apply this transform via inline `style` so it always wins.
 */
export const XYFLOW_HANDLE_SIDE_TRANSFORM: Record<Position, string> = {
  [Position.Left]: "translate(-50%, -50%)",
  [Position.Right]: "translate(50%, -50%)",
  [Position.Top]: "translate(-50%, -50%)",
  [Position.Bottom]: "translate(-50%, 50%)",
};

export function getXyflowHandleSideStyle(position: Position): CSSProperties {
  return { transform: XYFLOW_HANDLE_SIDE_TRANSFORM[position] };
}

export { SCENARIO_HANDLE_ANCHOR_CLASS } from "./source-handle-anchor";

export const SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS =
  "!absolute !right-0 !translate-none";

/** Node body uses `px-3` (12px). Offset only `right`; xyflow transform owns centering. */
export const SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS =
  "!absolute !-right-3 !translate-none";

export const SCENARIO_TARGET_HANDLE_ON_BOX_EDGE_CLASS =
  "!absolute !left-0 !translate-none";

const INTERACTION_TARGET_SIZE_PX = 44;
const INTERACTION_TARGET_CENTER = `calc(50% - ${INTERACTION_TARGET_SIZE_PX / 2}px)`;
const INTERACTION_TARGET_POSITION: Record<Position, CSSProperties> = {
  [Position.Right]: {
    left: 0,
    top: INTERACTION_TARGET_CENTER,
    transformOrigin: "left center",
  },
  [Position.Left]: {
    right: 0,
    top: INTERACTION_TARGET_CENTER,
    transformOrigin: "right center",
  },
  [Position.Top]: {
    bottom: 0,
    left: INTERACTION_TARGET_CENTER,
    transformOrigin: "center bottom",
  },
  [Position.Bottom]: {
    top: 0,
    left: INTERACTION_TARGET_CENTER,
    transformOrigin: "center top",
  },
};
const selectViewportZoom = (state: ReactFlowState) => state.transform[2];

export function buildScenarioHandleAccessibleName(params: {
  variant: "default" | "route";
  connected: boolean;
  label: string;
  destinationLabel?: string;
  connectedLabel?: string;
  unlinkedStatus: string;
  linkedPrefix: string;
  /** Linked with no destination name; falls back to `linkedPrefix`. */
  connectedStatus?: string;
  required?: boolean;
  /** Unlinked and required; falls back to `unlinkedStatus`. */
  requiredStatus?: string;
}): string {
  const label = params.label.trim();
  if (params.variant !== "route") {
    return params.connected ? params.connectedLabel?.trim() || label : label;
  }
  if (params.connected) {
    const destination = params.destinationLabel?.trim();
    return destination
      ? `${label}. ${params.linkedPrefix} ${destination}`
      : `${label}. ${params.connectedStatus?.trim() || params.linkedPrefix}`;
  }
  const status =
    (params.required && params.requiredStatus?.trim()) || params.unlinkedStatus;
  return `${label}. ${status}`;
}

/**
 * A labelled route control's name must contain its visible text (WCAG 2.5.3).
 * When it doesn't (an unlinked control shows "Choose next step"), the visible
 * text replaces the "Not connected" status.
 */
function buildVisibleRouteControlName(params: {
  accessibleName: string;
  visibleText: string;
  label: string;
  requiredStatus?: string;
}): string {
  const visibleText = params.visibleText.trim();
  if (!visibleText || params.accessibleName.includes(visibleText)) {
    return params.accessibleName;
  }
  return [params.label.trim(), params.requiredStatus?.trim(), visibleText]
    .filter(Boolean)
    .join(". ");
}

/** An unlinked route dot's Plus; it fills the dot, so it scales with it. */
function RouteDotGlyph({ required }: { required: boolean }) {
  return (
    <Plus
      aria-hidden
      strokeWidth={3}
      className={cn(
        "pointer-events-none relative z-10 size-full",
        required ? "text-white" : "text-amber-950"
      )}
    />
  );
}

function SourceHandleGlyph({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="pointer-events-none relative z-10" aria-hidden>
        <Check className="h-3 w-3 text-primary" aria-hidden />
      </span>
    );
  }
  return (
    <Plus
      className="pointer-events-none relative z-10 h-3 w-3 text-primary"
      aria-hidden
    />
  );
}

export function ScenarioSourceHandleButton({
  id,
  appearance = "default",
  className,
  connectable = true,
  connected = false,
  connectedLabel,
  inline = false,
  interactionTargetPlacement = "centered",
  onCreateNode,
  onInteractionStart,
  position = Position.Right,
  style,
  title,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
  variant = "default",
  required = false,
  routeLabel,
  externalAnchor = false,
}: ScenarioSourceHandleButtonProps) {
  const presentation = useContext(ScenarioSourceHandlePresentationContext);
  const isRoute = variant === "route";
  const destination = presentation?.destinationsBySourceHandle?.get(id);
  const isConnected = connected || Boolean(destination);
  const resolvedRouteLabel =
    routeLabel ?? destination?.label ?? presentation?.chooseLabel;
  const destinationName = isConnected
    ? sanitizeScenarioDestinationLabel(
        routeLabel ?? destination?.label ?? ""
      ) ||
      routeLabel ||
      destination?.label
    : undefined;
  const accessibleName = buildScenarioHandleAccessibleName({
    variant: isRoute ? "route" : "default",
    connected: isConnected,
    label: ariaLabel ?? title ?? "",
    destinationLabel: destinationName,
    connectedLabel,
    unlinkedStatus: presentation?.unlinkedStatus ?? "Not connected",
    linkedPrefix: presentation?.linkedPrefix ?? "Connected to",
    connectedStatus: presentation?.connectedStatus,
    required: isRoute && required,
    requiredStatus: presentation?.requiredStatus,
  });
  const viewportZoom = useStore(selectViewportZoom);
  const interactionScale = 1 / Math.max(viewportZoom, 0.01);
  const createNode = isConnected && !isRoute ? undefined : onCreateNode;
  const interaction = useSourceHandleCreate({
    createNode,
    onInteractionStart,
  });
  const resolvedStyle: CSSProperties | undefined = {
    ...(isRoute
      ? {
          width: SCENARIO_ROUTE_DOT_PX,
          height: SCENARIO_ROUTE_DOT_PX,
          minWidth: SCENARIO_ROUTE_DOT_PX,
          minHeight: SCENARIO_ROUTE_DOT_PX,
        }
      : null),
    ...(inline
      ? {
          position: "relative",
          inset: "auto",
        }
      : null),
    ...style,
    transform: inline ? "none" : XYFLOW_HANDLE_SIDE_TRANSFORM[position],
  };
  const showCreateTarget = Boolean(createNode);

  if (isRoute && externalAnchor) {
    if (!createNode) return null;
    // The row already shows the route name; the button names the next step.
    const buttonText =
      (isConnected
        ? destinationName || presentation?.connectedStatus
        : resolvedRouteLabel) ||
      ariaLabel ||
      title;
    const buttonName = buildVisibleRouteControlName({
      accessibleName,
      visibleText: buttonText ?? "",
      label: ariaLabel ?? title ?? "",
      requiredStatus: required ? presentation?.requiredStatus : undefined,
    });
    return (
      <button
        type="button"
        aria-label={buttonName}
        title={buttonName}
        className="nodrag nopan inline-flex h-8 max-w-full items-center truncate rounded-md px-0 text-left text-[11px] text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={event => event.stopPropagation()}
        onClick={interaction.handleCreateClick}
        onKeyDown={interaction.handleCreateKeyDown}
      >
        {buttonText}
      </button>
    );
  }

  return (
    <Handle
      id={id}
      type="source"
      isConnectable={isConnected ? false : connectable}
      position={position}
      aria-label={accessibleName}
      title={title ?? accessibleName}
      role={showCreateTarget ? "button" : undefined}
      tabIndex={showCreateTarget ? 0 : undefined}
      className={cn(
        "scenario-source-handle-button nodrag !z-20 !flex !items-center !justify-center !overflow-visible !rounded-full !transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        isRoute
          ? cn(
              "scenario-source-handle-button--route !shadow-sm",
              SCENARIO_ROUTE_DOT_SIZE_CLASS,
              isConnected
                ? SCENARIO_ROUTE_DOT_LINKED_CLASS
                : required
                  ? SCENARIO_ROUTE_DOT_REQUIRED_CLASS
                  : SCENARIO_ROUTE_DOT_UNLINKED_CLASS
            )
          : cn(
              "!h-5 !w-5",
              appearance === "default"
                ? "!border !border-primary/40 !bg-background !shadow-sm hover:!border-primary/60 hover:!bg-primary/10"
                : "!border !border-border/50 !bg-background/80 !shadow-none hover:!border-primary/30 hover:!bg-primary/10"
            ),
        createNode && "!cursor-pointer",
        inline && "!relative !z-20 !inset-auto !m-0 !translate-none",
        className
      )}
      style={resolvedStyle}
      data-route-status={
        isRoute ? (isConnected ? "linked" : "unlinked") : undefined
      }
      data-route-required={isRoute ? String(required) : undefined}
      data-testid={dataTestId}
      onPointerDownCapture={interaction.handlePointerDownCapture}
      onMouseDownCapture={interaction.handleMouseDownCapture}
      onClick={interaction.handleCreateClick}
      onKeyDown={interaction.handleCreateKeyDown}
    >
      {showCreateTarget ? (
        <span
          aria-hidden
          data-hit-target=""
          className="nodrag nopan pointer-events-auto absolute z-20 rounded-full bg-transparent p-0"
          style={
            interactionTargetPlacement === "outward"
              ? {
                  height: INTERACTION_TARGET_SIZE_PX,
                  width: INTERACTION_TARGET_SIZE_PX,
                  ...INTERACTION_TARGET_POSITION[position],
                  transform: `scale(${interactionScale})`,
                }
              : { inset: 0, width: "100%", height: "100%" }
          }
        />
      ) : null}
      {isRoute ? (
        isConnected ? null : (
          <RouteDotGlyph required={required} />
        )
      ) : (
        <SourceHandleGlyph connected={isConnected} />
      )}
    </Handle>
  );
}
