"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PanelRightClose, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ScenarioFlowNode } from "../../types";
import { useScenarioNodeEnrichment } from "../scenario-node-enrichment-context";
import {
  restoreScenarioNodeFocus,
  SCENARIO_NODE_SETTINGS_PANEL_ID,
} from "./restore-scenario-node-focus";
import {
  resolveScenarioNodeSettingsPresentation,
  resolveScenarioNodeSettingsTarget,
  ScenarioNodeSettingsContent,
  type ScenarioNodeSettingsTarget,
} from "./scenario-node-settings-content";

/** Narrower resizable groups use the full-width sheet instead of a dock. */
export const SCENARIO_NODE_SETTINGS_DOCK_MIN_WIDTH_PX = 1024;
const SETTINGS_DEFAULT_WIDTH_PX = 440;
const SETTINGS_MIN_WIDTH_PX = 360;
const SETTINGS_MAX_WIDTH_PX = 640;
const SETTINGS_MAX_SIZE_PERCENT = 46;
const CANVAS_MIN_WIDTH_PX = 320;
/** The canvas minimum when node settings are disabled (unchanged behaviour). */
export const SCENARIO_CANVAS_MIN_SIZE_PERCENT = 45;

export type ScenarioNodeSettingsLayout = {
  docked: boolean;
  canvasMinSize: number;
  settingsMinSize: number;
  settingsMaxSize: number;
  settingsDefaultSize: number;
};

/** Panel constraints, in percentages of the measured resizable group. */
export function resolveScenarioNodeSettingsLayout(
  groupWidth: number | null
): ScenarioNodeSettingsLayout {
  if (!groupWidth) {
    return {
      docked: false,
      canvasMinSize: SCENARIO_CANVAS_MIN_SIZE_PERCENT,
      settingsMinSize: 26,
      settingsMaxSize: SETTINGS_MAX_SIZE_PERCENT,
      settingsDefaultSize: 30,
    };
  }
  const percent = (pixels: number) => (pixels / groupWidth) * 100;
  const settingsMaxSize = Math.min(
    SETTINGS_MAX_SIZE_PERCENT,
    percent(SETTINGS_MAX_WIDTH_PX)
  );
  const settingsMinSize = Math.min(
    percent(SETTINGS_MIN_WIDTH_PX),
    settingsMaxSize
  );
  return {
    docked: groupWidth >= SCENARIO_NODE_SETTINGS_DOCK_MIN_WIDTH_PX,
    // Opening the dock shrinks the canvas, not the scenario list.
    canvasMinSize: Math.min(
      SCENARIO_CANVAS_MIN_SIZE_PERCENT,
      percent(CANVAS_MIN_WIDTH_PX)
    ),
    settingsMinSize,
    settingsMaxSize,
    settingsDefaultSize: Math.min(
      Math.max(percent(SETTINGS_DEFAULT_WIDTH_PX), settingsMinSize),
      settingsMaxSize
    ),
  };
}

function ScenarioNodeSettingsHeader({
  target,
  variant,
}: {
  target: ScenarioNodeSettingsTarget;
  variant: "docked" | "sheet";
}) {
  const t = useTranslations("Scenarios");
  const { Icon, iconClassName, label, description } =
    resolveScenarioNodeSettingsPresentation(target, t);
  return (
    <div className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", iconClassName)}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <SheetTitle className="truncate text-sm leading-5" title={label}>
          {label}
        </SheetTitle>
        <SheetDescription className="line-clamp-2 text-xs">
          {description}
        </SheetDescription>
      </div>
      <SheetClose asChild>
        <Button
          type="button"
          variant="ghost"
          size={variant === "sheet" ? "icon-lg" : "icon-sm"}
          className="-my-1 -mr-1 shrink-0"
          aria-label={t("nodeSettingsClose")}
        >
          {variant === "sheet" ? (
            <X aria-hidden />
          ) : (
            <PanelRightClose aria-hidden />
          )}
        </Button>
      </SheetClose>
    </div>
  );
}

type ScenarioNodeSettingsFocus = {
  /** Node whose settings were opened from the keyboard; they take focus. */
  requestRef: RefObject<string | null>;
  /** Node whose settings held focus when they closed or were replaced. */
  handoffRef: RefObject<string | null>;
  /** The host unmounted; pending focus restoration is dropped. */
  disposedRef: RefObject<boolean>;
};

/**
 * Whether focus is in the settings or in a popup they opened: Select lists,
 * menus and popovers render in a portal, named by `aria-controls` inside.
 */
function settingsHoldFocus(container: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active) return false;
  if (container.contains(active)) return true;
  const controlledIds = new Set(
    Array.from(container.querySelectorAll("[aria-controls]")).flatMap(
      element => element.getAttribute("aria-controls")?.split(/\s+/) ?? []
    )
  );
  let element: Element | null = active;
  while (element) {
    if (element.id && controlledIds.has(element.id)) return true;
    element = element.parentElement;
  }
  return false;
}

function blurFocusInside(container: HTMLElement | null) {
  const active = document.activeElement;
  if (!container || !(active instanceof HTMLElement)) return false;
  if (!container.contains(active)) return false;
  active.blur();
  return true;
}

/**
 * One node's settings, keyed by document session and node. Unmounting it
 * closes or replaces the settings. Focus follows only a keyboard user:
 * it moves into the settings on a keyboard open, and back to the card, or
 * into the replacement, when the settings held it.
 */
function ScenarioNodeSettingsDialog({
  target,
  variant,
  onClose,
  focus,
  children,
}: {
  target: ScenarioNodeSettingsTarget;
  variant: "docked" | "sheet";
  onClose: () => void;
  focus: ScenarioNodeSettingsFocus;
  children: ReactNode;
}) {
  const nodeId = target.node.id;
  const contentRef = useRef<HTMLDivElement | null>(null);
  // A modal sheet portals its content in after the first commit.
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null
  );
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    setContentElement(node);
  }, []);
  const { requestRef, handoffRef, disposedRef } = focus;

  // React ignores DOM events while it commits a removal, so a field removed
  // with the settings never reports blur. Blur when the interaction that
  // closes or switches the settings starts, so fields that commit on blur
  // save to this node first. Capture runs before canvas handlers.
  useEffect(() => {
    const blurBeforeOutsidePointer = (event: PointerEvent) => {
      const content = contentRef.current;
      if (event.target instanceof Node && content?.contains(event.target)) {
        return;
      }
      // A modal sheet closes on an outside press and returns focus.
      if (blurFocusInside(content) && variant === "sheet") {
        handoffRef.current = nodeId;
      }
    };
    document.addEventListener("pointerdown", blurBeforeOutsidePointer, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        blurBeforeOutsidePointer,
        true
      );
  }, [handoffRef, nodeId, variant]);

  useLayoutEffect(() => {
    if (!contentElement) return;
    return () => {
      // Includes a Select list that still holds focus in its portal.
      if (settingsHoldFocus(contentElement)) {
        handoffRef.current = nodeId;
      }
    };
  }, [contentElement, handoffRef, nodeId]);

  const handleOpenAutoFocus = (event: Event) => {
    const handedOff = handoffRef.current !== null;
    const requested = requestRef.current === nodeId;
    handoffRef.current = null;
    requestRef.current = null;
    // A modal sheet always moves focus inside.
    if (variant === "sheet") return;
    event.preventDefault();
    if (handedOff || requested) {
      contentRef.current?.focus({ preventScroll: true });
    }
  };
  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    // A replacement consumed the hand-off, or the whole editor is gone.
    if (disposedRef.current || handoffRef.current !== nodeId) return;
    handoffRef.current = null;
    restoreScenarioNodeFocus(nodeId);
  };
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    const eventTarget = event.target;
    if (
      !(eventTarget instanceof Node) ||
      !contentRef.current?.contains(eventTarget)
    ) {
      // Escape elsewhere, such as on the canvas, is not for the settings.
      event.preventDefault();
      return;
    }
    handoffRef.current = nodeId;
    blurFocusInside(contentRef.current);
  };
  const header = (
    <ScenarioNodeSettingsHeader target={target} variant={variant} />
  );
  const body = (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 [overflow-wrap:anywhere]">
      {children}
    </div>
  );

  if (variant === "sheet") {
    return (
      <Sheet
        open
        onOpenChange={open => {
          if (!open) onClose();
        }}
      >
        <SheetContent
          ref={setContent}
          id={SCENARIO_NODE_SETTINGS_PANEL_ID}
          className="w-full gap-0 overflow-hidden sm:max-w-[520px]"
          showCloseButton={false}
          data-scenario-node-settings-panel={nodeId}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
          onEscapeKeyDown={handleEscapeKeyDown}
        >
          {header}
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      modal={false}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Content
        ref={setContent}
        id={SCENARIO_NODE_SETTINGS_PANEL_ID}
        className="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none"
        data-scenario-node-settings-panel={nodeId}
        onOpenAutoFocus={handleOpenAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        // Canvas clicks select, switch or close through the canvas handlers.
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={handleEscapeKeyDown}
      >
        {header}
        {body}
      </DialogPrimitive.Content>
    </Sheet>
  );
}

/**
 * Settings for the selected trigger or sub-scenario link. On wide layouts it
 * is a docked, non-modal panel beside the canvas; otherwise a modal sheet.
 * Mounted inside the scenario ResizablePanelGroup after the canvas panel.
 */
export function ScenarioNodeSettingsPanel({
  nodes,
  nodeId,
  layout,
  canvasPanelRef,
}: {
  nodes: ScenarioFlowNode[];
  /** The selected node when it supports settings and the graph is loaded. */
  nodeId: string | null;
  layout: ScenarioNodeSettingsLayout;
  canvasPanelRef: RefObject<ImperativePanelHandle | null>;
}) {
  const t = useTranslations("Scenarios");
  const ctx = useScenarioNodeEnrichment();
  const target = useMemo(
    () =>
      nodeId
        ? resolveScenarioNodeSettingsTarget(
            nodes.find(node => node.id === nodeId),
            ctx
          )
        : null,
    [ctx, nodeId, nodes]
  );
  const dockedOpen = layout.docked && target !== null;
  const panelRef = useRef<ImperativePanelHandle>(null);
  const dockedOpenRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const focusHandoffRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const focus = useMemo<ScenarioNodeSettingsFocus>(
    () => ({
      requestRef: ctx.nodeSettingsFocusRequestRef,
      handoffRef: focusHandoffRef,
      disposedRef,
    }),
    [ctx.nodeSettingsFocusRequestRef]
  );
  const close = () => ctx.callbacksRef.current.selectNodeById(null);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || dockedOpenRef.current === dockedOpen) return;
    dockedOpenRef.current = dockedOpen;
    if (!dockedOpen) {
      panel.collapse();
      return;
    }
    // expand() restores the width the user last chose; the first open starts
    // at the default width without taking room from the scenario list.
    panel.expand();
    if (hasOpenedRef.current) return;
    hasOpenedRef.current = true;
    const canvasSize = canvasPanelRef.current?.getSize();
    const available =
      canvasSize === undefined
        ? layout.settingsDefaultSize
        : panel.getSize() + canvasSize - layout.canvasMinSize;
    panel.resize(
      Math.max(
        layout.settingsMinSize,
        Math.min(layout.settingsDefaultSize, available)
      )
    );
  }, [
    canvasPanelRef,
    dockedOpen,
    layout.canvasMinSize,
    layout.settingsDefaultSize,
    layout.settingsMinSize,
  ]);

  const dialog = (variant: "docked" | "sheet") =>
    target ? (
      <ScenarioNodeSettingsDialog
        key={`${ctx.scenarioSessionOwnerKey}:${target.node.id}`}
        target={target}
        variant={variant}
        onClose={close}
        focus={focus}
      >
        <ScenarioNodeSettingsContent target={target} ctx={ctx} />
      </ScenarioNodeSettingsDialog>
    ) : null;

  return (
    <>
      <ResizableHandle
        withHandle
        disabled={!dockedOpen}
        tabIndex={dockedOpen ? 0 : -1}
        aria-label={t("nodeSettingsResize")}
        className={cn(!dockedOpen && "hidden")}
      />
      <ResizablePanel
        ref={panelRef}
        id="scenario-node-settings"
        order={3}
        collapsible
        collapsedSize={0}
        defaultSize={0}
        minSize={layout.settingsMinSize}
        maxSize={layout.settingsMaxSize}
        onCollapse={() => {
          // Dragging the dock closed closes the settings as well.
          if (dockedOpenRef.current) close();
        }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {dockedOpen ? dialog("docked") : null}
      </ResizablePanel>
      {!layout.docked ? dialog("sheet") : null}
    </>
  );
}
