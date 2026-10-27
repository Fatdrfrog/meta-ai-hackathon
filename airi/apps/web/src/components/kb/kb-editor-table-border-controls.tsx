"use client";

import {
  buildKBTableBorderControlLayout,
  selectKBTableBorderTargetForPointer,
  type KBTableBorderTarget,
} from "@/lib/kb/kb-table-border-controls";
import {
  buildKBAnchoredControlPosition,
  clampKBViewportPosition,
  getKBViewportSize,
  type KBControlRect,
  type KBControlSize,
} from "@/lib/kb/kb-object-controls";
import {
  runKBTableAction,
  type KBTableActionId,
} from "@/lib/kb/kb-table-actions";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  MoreHorizontal,
  Plus,
  Rows3,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CONTROL_SIZE = 24;
const CONTROL_GAP = 8;
const OPTIONS_PANEL_SIZE: KBControlSize = { width: 176, height: 168 };

type TableBorderControlsState = {
  target: KBTableBorderTarget;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
  canMergeCells: boolean;
  canSplitCell: boolean;
};

type BorderControlConfig = {
  label: string;
  menuLabel: string;
  icons: readonly LucideIcon[];
  destructive?: boolean;
};

export const KBEditorTableBorderControls = memo(
  function KBEditorTableBorderControls({ editor }: { editor: Editor }) {
    const t = useTranslations("EnhancedMarkdownEditor");
    const [controlsState, setControlsState] =
      useState<TableBorderControlsState | null>(null);
    const [expanded, setExpanded] = useState(false);
    const activeCellRef = useRef<HTMLElement | null>(null);
    const pointerRef = useRef<{ x: number; y: number } | null>(null);
    const expandedRef = useRef(expanded);

    const updateControls = useCallback(
      (candidate?: unknown, pointer?: { x: number; y: number }) => {
        if (candidate instanceof HTMLElement) {
          activeCellRef.current = candidate;
        }
        if (pointer) {
          pointerRef.current = pointer;
        }
        setControlsState(
          resolveTableBorderControlsState(
            editor,
            activeCellRef.current,
            pointerRef.current
          )
        );
      },
      [editor]
    );
    const updateControlsRef = useRef(updateControls);

    useEffect(() => {
      expandedRef.current = expanded;
    }, [expanded]);

    useEffect(() => {
      updateControlsRef.current = updateControls;
    }, [updateControls]);

    useEffect(() => {
      const updateFromPointer = (event: PointerEvent) => {
        if (isTableBorderControlTarget(event.target)) {
          return;
        }

        if (expandedRef.current) {
          if (event.type === "pointerdown") {
            pointerRef.current = null;
            setExpanded(false);
            setControlsState(null);
          }
          return;
        }

        const pointer = { x: event.clientX, y: event.clientY };
        const cell = findTableCellNearPoint(editor, pointer.x, pointer.y);
        if (cell) {
          setExpanded(false);
          updateControlsRef.current(cell, pointer);
          return;
        }

        if (
          activeCellRef.current &&
          isPointInsideElement(pointer.x, pointer.y, activeCellRef.current)
        ) {
          return;
        }

        pointerRef.current = null;
        setExpanded(false);
        setControlsState(null);
      };
      const updateFromEditor = () => {
        updateControlsRef.current();
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        pointerRef.current = null;
        setExpanded(false);
        setControlsState(null);
      };

      document.addEventListener("pointermove", updateFromPointer, true);
      document.addEventListener("pointerdown", updateFromPointer, true);
      document.addEventListener("keydown", closeOnEscape, true);
      editor.on("selectionUpdate", updateFromEditor);
      editor.on("transaction", updateFromEditor);
      editor.on("focus", updateFromEditor);
      window.addEventListener("resize", updateFromEditor);
      window.addEventListener("scroll", updateFromEditor, true);

      const initialFrame = window.requestAnimationFrame(updateFromEditor);

      return () => {
        window.cancelAnimationFrame(initialFrame);
        document.removeEventListener("pointermove", updateFromPointer, true);
        document.removeEventListener("pointerdown", updateFromPointer, true);
        document.removeEventListener("keydown", closeOnEscape, true);
        editor.off("selectionUpdate", updateFromEditor);
        editor.off("transaction", updateFromEditor);
        editor.off("focus", updateFromEditor);
        window.removeEventListener("resize", updateFromEditor);
        window.removeEventListener("scroll", updateFromEditor, true);
      };
    }, [editor]);

    const runAction = useCallback(
      (actionId: KBTableActionId) => {
        focusTableCell(editor, activeCellRef.current);
        runKBTableAction(editor, actionId);
        setExpanded(false);
        window.requestAnimationFrame(() => updateControlsRef.current());
      },
      [editor]
    );

    if (
      !controlsState ||
      controlsState.target.controls.length === 0 ||
      typeof document === "undefined"
    ) {
      return null;
    }

    const trigger = controlsState.target.trigger;
    const panelPosition = buildOptionsPanelPosition(controlsState.target);

    return createPortal(
      <>
        <div
          aria-label={t("tableActions")}
          className="kb-editor-table-border-control fixed flex items-center gap-1 rounded-full border bg-background/95 p-1 text-muted-foreground shadow-lg backdrop-blur"
          role="toolbar"
          style={{
            left: clampViewportPosition(trigger.left, CONTROL_SIZE, "width"),
            top: clampViewportPosition(trigger.top, CONTROL_SIZE, "height"),
            zIndex: 40,
          }}
          onMouseDown={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {controlsState.target.controls.map(control => {
            const config = getBorderControlConfig(control.actionId, t);
            const disabled =
              (control.actionId === "deleteRow" &&
                !controlsState.canDeleteRow) ||
              (control.actionId === "deleteColumn" &&
                !controlsState.canDeleteColumn);
            const Icon = config.icons[0] ?? Plus;

            return (
              <button
                key={control.actionId}
                type="button"
                title={config.label}
                className={`inline-flex size-7 items-center justify-center rounded-full transition hover:bg-accent hover:text-primary ${
                  config.destructive ? "text-destructive" : ""
                }`}
                disabled={disabled}
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  runAction(control.actionId);
                }}
                aria-label={config.label}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
          <button
            type="button"
            title={t("tableActions")}
            className="inline-flex size-7 items-center justify-center rounded-full transition hover:bg-accent hover:text-primary"
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(value => !value);
            }}
            aria-label={t("tableActions")}
            aria-expanded={expanded}
            aria-haspopup="menu"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </div>
        {expanded ? (
          <div
            aria-label={t("tableActions")}
            className="kb-editor-table-border-control fixed flex min-w-36 flex-col gap-1 rounded-md border bg-background/95 p-1 shadow-lg backdrop-blur"
            role="menu"
            style={{
              left: clampViewportPosition(
                panelPosition.left,
                OPTIONS_PANEL_SIZE.width,
                "width"
              ),
              top: clampViewportPosition(
                panelPosition.top,
                OPTIONS_PANEL_SIZE.height,
                "height"
              ),
              zIndex: 40,
            }}
          >
            {getTableBorderMenuActionIds(controlsState.target).map(actionId => {
              const config = getBorderControlConfig(actionId, t);
              const disabled =
                (actionId === "deleteRow" && !controlsState.canDeleteRow) ||
                (actionId === "deleteColumn" &&
                  !controlsState.canDeleteColumn) ||
                (actionId === "mergeCells" && !controlsState.canMergeCells) ||
                (actionId === "splitCell" && !controlsState.canSplitCell);

              return (
                <button
                  key={actionId}
                  type="button"
                  title={config.label}
                  className={`inline-flex h-8 w-full items-center justify-start gap-2 rounded-md px-2 text-left text-xs font-medium ${
                    config.destructive
                      ? "text-destructive hover:text-destructive"
                      : "text-foreground hover:text-primary"
                  }`}
                  role="menuitem"
                  disabled={disabled}
                  onMouseDown={event => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    runAction(actionId);
                  }}
                  aria-label={config.label}
                >
                  {config.icons.map((Icon, index) => (
                    <Icon key={index} className="size-3" />
                  ))}
                  <span>{config.menuLabel}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </>,
      document.body
    );
  }
);

function resolveTableBorderControlsState(
  editor: Editor,
  fallbackCell?: HTMLElement | null,
  pointer?: { x: number; y: number } | null
): TableBorderControlsState | null {
  if (typeof window === "undefined") return null;
  if (!editor.isEditable) return null;

  const activeCell = fallbackCell ?? findActiveTableCell(editor);
  if (!activeCell) return null;
  if (!editor.view.dom.contains(activeCell)) return null;

  const table = activeCell.closest("table");
  if (!(table instanceof HTMLElement)) return null;

  const tableRect = table.getBoundingClientRect();
  const cellRect = activeCell.getBoundingClientRect();
  if (!hasUsableRect(tableRect) || !hasUsableRect(cellRect)) return null;
  const effectivePointer = pointer ?? {
    x: cellRect.right,
    y: cellRect.top + cellRect.height / 2,
  };

  const layout = buildKBTableBorderControlLayout({
    tableRect,
    cellRect,
    controlSize: CONTROL_SIZE,
    gap: CONTROL_GAP,
  });
  const target = selectKBTableBorderTargetForPointer({
    layout,
    cellRect,
    pointerX: effectivePointer.x,
    pointerY: effectivePointer.y,
    controlSize: CONTROL_SIZE,
    threshold: 10,
  });

  if (!target) return null;

  return {
    target,
    canDeleteRow: editor.can().deleteRow(),
    canDeleteColumn: editor.can().deleteColumn(),
    canMergeCells: editor.can().mergeCells(),
    canSplitCell: editor.can().splitCell(),
  };
}

function findTableCellNearPoint(
  editor: Editor,
  pointerX: number,
  pointerY: number
): HTMLElement | null {
  const directCell = findClosestTableCell(
    document.elementFromPoint(pointerX, pointerY)
  );
  if (directCell && editor.view.dom.contains(directCell)) {
    return directCell;
  }

  const cells = editor.view.dom.querySelectorAll("td, th");
  for (const cell of cells) {
    if (!(cell instanceof HTMLElement)) continue;
    const table = cell.closest("table");
    if (!(table instanceof HTMLElement)) continue;
    const tableRect = table.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    if (
      pointerX >= cellRect.left - 10 &&
      pointerX <= cellRect.right + 10 &&
      pointerY >= cellRect.top - 10 &&
      pointerY <= cellRect.bottom + 10
    ) {
      const layout = buildKBTableBorderControlLayout({
        tableRect,
        cellRect,
        controlSize: CONTROL_SIZE,
        gap: CONTROL_GAP,
      });
      const target = selectKBTableBorderTargetForPointer({
        layout,
        cellRect,
        pointerX,
        pointerY,
        threshold: 10,
      });
      if (target) return cell;
    }
  }

  return null;
}

function findActiveTableCell(editor: Editor): HTMLElement | null {
  const selectedCell = editor.view.dom.querySelector(
    "td.selectedCell, th.selectedCell"
  );
  if (selectedCell instanceof HTMLElement) {
    return selectedCell;
  }

  const selectionNode = findSelectionNode(editor);
  const selectionElement = getClosestElement(selectionNode);
  const cell = selectionElement?.closest("td, th");
  if (cell instanceof HTMLElement && editor.view.dom.contains(cell)) {
    return cell;
  }

  const domSelection = window.getSelection();
  const fallbackElement = getClosestElement(domSelection?.anchorNode ?? null);
  const fallbackCell = fallbackElement?.closest("td, th");
  if (
    fallbackCell instanceof HTMLElement &&
    editor.view.dom.contains(fallbackCell)
  ) {
    return fallbackCell;
  }

  return null;
}

function findClosestTableCell(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null;
  const element = getClosestElement(target);
  const cell = element?.closest("td, th");
  return cell instanceof HTMLElement ? cell : null;
}

function isTableBorderControlTarget(target: EventTarget | null): boolean {
  const element = getClosestElement(target instanceof Node ? target : null);
  return element?.closest(".kb-editor-table-border-control") !== null;
}

function buildOptionsPanelPosition(target: KBTableBorderTarget): {
  left: number;
  top: number;
} {
  const triggerRect = buildTriggerRect(target.trigger);
  const position = buildKBAnchoredControlPosition({
    anchorRect: triggerRect,
    panelSize: OPTIONS_PANEL_SIZE,
    placement: target.kind === "row" ? "bottom-start" : "top-end",
    offset: CONTROL_GAP,
  });

  return (
    position ?? {
      left: clampViewportPosition(
        target.trigger.left,
        OPTIONS_PANEL_SIZE.width,
        "width"
      ),
      top: clampViewportPosition(
        target.trigger.top,
        OPTIONS_PANEL_SIZE.height,
        "height"
      ),
    }
  );
}

function getBorderControlConfig(
  actionId: KBTableActionId,
  t: (key: string) => string
): BorderControlConfig {
  switch (actionId) {
    case "addRowBefore":
      return {
        label: t("addRowBefore"),
        menuLabel: t("addAbove"),
        icons: [Plus, ArrowUp],
      };
    case "addRowAfter":
      return {
        label: t("addRowAfter"),
        menuLabel: t("addBelow"),
        icons: [Plus, ArrowDown],
      };
    case "deleteRow":
      return {
        label: t("deleteRow"),
        menuLabel: t("deleteRowShort"),
        icons: [Trash2, Rows3],
        destructive: true,
      };
    case "addColumnBefore":
      return {
        label: t("addColumnBefore"),
        menuLabel: t("addLeft"),
        icons: [Plus, ArrowLeft],
      };
    case "addColumnAfter":
      return {
        label: t("addColumnAfter"),
        menuLabel: t("addRight"),
        icons: [Plus, ArrowRight],
      };
    case "deleteColumn":
      return {
        label: t("deleteColumn"),
        menuLabel: t("deleteColumnShort"),
        icons: [Trash2, Columns3],
        destructive: true,
      };
    case "mergeCells":
      return {
        label: t("mergeCells"),
        menuLabel: t("mergeCells"),
        icons: [Rows3],
      };
    case "splitCell":
      return {
        label: t("splitCell"),
        menuLabel: t("splitCell"),
        icons: [Columns3],
      };
    case "deleteTable":
      return {
        label: t("deleteTable"),
        menuLabel: t("deleteTable"),
        icons: [Trash2],
        destructive: true,
      };
    default:
      return { label: actionId, menuLabel: actionId, icons: [] };
  }
}

function getTableBorderMenuActionIds(
  target: KBTableBorderTarget
): KBTableActionId[] {
  return [
    ...target.controls.map(control => control.actionId),
    "mergeCells",
    "splitCell",
    "deleteTable",
  ];
}

function findSelectionNode(editor: Editor): Node | null {
  try {
    return editor.view.domAtPos(editor.state.selection.from).node;
  } catch {
    return null;
  }
}

function getClosestElement(node: Node | null): Element | null {
  if (!node) return null;
  if (node instanceof Element) return node;
  return node.parentElement;
}

function hasUsableRect(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function buildTriggerRect(trigger: {
  left: number;
  top: number;
}): KBControlRect {
  return {
    left: trigger.left,
    top: trigger.top,
    right: trigger.left + CONTROL_SIZE,
    bottom: trigger.top + CONTROL_SIZE,
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
  };
}

function clampViewportPosition(
  value: number,
  size: number,
  axis: "width" | "height"
): number {
  const viewport = getKBViewportSize();
  return clampKBViewportPosition({
    value,
    size,
    viewportSize: viewport[axis],
  });
}

function isPointInsideElement(
  pointerX: number,
  pointerY: number,
  element: HTMLElement
): boolean {
  const rect = element.getBoundingClientRect();
  return (
    pointerX >= rect.left - 12 &&
    pointerX <= rect.right + 12 &&
    pointerY >= rect.top - 12 &&
    pointerY <= rect.bottom + 12
  );
}

function focusTableCell(editor: Editor, cell: HTMLElement | null): void {
  if (!cell || !editor.view.dom.contains(cell)) {
    editor.chain().focus().run();
    return;
  }

  try {
    const position = editor.view.posAtDOM(cell, 0);
    const resolvedPosition = editor.state.doc.resolve(position + 1);
    const selection = TextSelection.near(resolvedPosition, 1);
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  } catch {
    editor.chain().focus().run();
  }
}
