"use client";

import { Button } from "@/components/ui/button";
import {
  buildKBAnchoredControlPosition,
  getKBViewportSize,
  type KBControlRect,
  type KBControlSize,
} from "@/lib/kb/kb-object-controls";
import {
  getKBGridActionColumns,
  getKBGridActionGroups,
  runKBGridAction,
  type KBGridActionId,
} from "@/lib/kb/kb-grid-actions";
import {
  normalizeKBGridBorderStyle,
  normalizeKBGridBorderWidth,
  normalizeKBGridColumnCount,
} from "@/lib/kb/kb-grid-extension";
import { sanitizeKBColorValue } from "@/lib/kb/kb-text-colors";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Grid3X3, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

const GRID_PANEL_SIZE: KBControlSize = { width: 224, height: 280 };
const GRID_PANEL_OFFSET = 8;

type GridPanelPosition = {
  left: number;
  top: number;
};

type GridBorderSegment = {
  id: string;
  rect: KBControlRect;
};

export const KBGridControls = memo(function KBGridControls({
  editor,
}: {
  editor: Editor;
}) {
  const t = useTranslations("EnhancedMarkdownEditor");
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState<GridPanelPosition | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelSizeRef = useRef<KBControlSize>(GRID_PANEL_SIZE);
  const panelAnchorRectRef = useRef<KBControlRect | null>(null);

  const { active, columns, borderStyle, borderColor, borderWidth } =
    useEditorState({
      editor,
      selector: ctx => {
        const attrs = ctx.editor.getAttributes("kbGrid");
        return {
          active: ctx.editor.isActive("kbGrid"),
          columns: normalizeKBGridColumnCount(attrs.columns),
          borderStyle: normalizeKBGridBorderStyle(attrs.borderStyle),
          borderColor: sanitizeKBColorValue(attrs.borderColor) ?? "#d1d5db",
          borderWidth: normalizeKBGridBorderWidth(attrs.borderWidth),
        };
      },
    });
  const layoutVersion = useGridLayoutVersion(editor, active);

  const updatePanelPosition = useCallback(() => {
    const position = resolveKBGridPanelPosition(
      editor,
      panelSizeRef.current,
      panelAnchorRectRef.current
    );
    setPanelPosition(position);
    return position;
  }, [editor]);

  const isOpen = open && active;

  useEffect(() => {
    if (!isOpen) return;

    updatePanelPosition();

    const updateFromEditor = () => {
      if (!updatePanelPosition()) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    editor.on("selectionUpdate", updateFromEditor);
    editor.on("transaction", updateFromEditor);
    editor.on("focus", updateFromEditor);
    window.addEventListener("resize", updateFromEditor);
    window.addEventListener("scroll", updateFromEditor, true);
    document.addEventListener("keydown", closeOnEscape, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);

    return () => {
      editor.off("selectionUpdate", updateFromEditor);
      editor.off("transaction", updateFromEditor);
      editor.off("focus", updateFromEditor);
      window.removeEventListener("resize", updateFromEditor);
      window.removeEventListener("scroll", updateFromEditor, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [editor, isOpen, updatePanelPosition]);

  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    panelSizeRef.current = { width: rect.width, height: rect.height };
    updatePanelPosition();
  }, [isOpen, updatePanelPosition]);

  const runAction = useCallback(
    (actionId: KBGridActionId) => {
      runKBGridAction(editor, actionId);
      panelAnchorRectRef.current = null;
      setOpen(false);
    },
    [editor]
  );

  if (!active) return null;

  void layoutVersion;
  const actionGroups = getKBGridActionGroups();
  const borderSegments = resolveKBGridBorderSegments(editor);
  const panelStyle: CSSProperties | undefined = panelPosition
    ? {
        left: panelPosition.left,
        top: panelPosition.top,
        width: GRID_PANEL_SIZE.width,
        zIndex: 50,
      }
    : undefined;

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 px-2"
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          panelAnchorRectRef.current = null;
          if (!isOpen) {
            updatePanelPosition();
          }
          setOpen(value => !value);
        }}
        aria-label={t("gridMode")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Grid3X3 className="h-4 w-4" />
        <span className="hidden text-xs sm:inline">{t("gridMode")}</span>
      </Button>
      {typeof document !== "undefined"
        ? createPortal(
            <>
              {borderSegments.map(segment => (
                <button
                  key={segment.id}
                  type="button"
                  aria-label={t("editGridBorder")}
                  title={t("editGridBorder")}
                  className="kb-editor-grid-border-picker fixed rounded-sm bg-transparent transition hover:bg-[#8b5cf6]/45 focus-visible:bg-[#8b5cf6]/55 focus-visible:outline-none"
                  style={{
                    left: segment.rect.left,
                    top: segment.rect.top,
                    width: Math.max(segment.rect.width, 1),
                    height: Math.max(segment.rect.height, 1),
                    zIndex: 42,
                  }}
                  onMouseDown={event => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    panelAnchorRectRef.current = segment.rect;
                    setPanelPosition(
                      buildKBAnchoredControlPosition({
                        anchorRect: panelAnchorRectRef.current,
                        panelSize: panelSizeRef.current,
                        viewport: getKBViewportSize(),
                        placement: "top-start",
                        offset: GRID_PANEL_OFFSET,
                      })
                    );
                    setOpen(true);
                  }}
                />
              ))}
            </>,
            document.body
          )
        : null}
      {isOpen && panelPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              aria-label={t("gridMode")}
              className="kb-editor-grid-control-panel fixed w-56 overflow-hidden rounded-md border bg-background/95 text-sm shadow-lg backdrop-blur"
              role="menu"
              style={panelStyle}
              onMouseDown={event => {
                event.stopPropagation();
              }}
            >
              <div className="px-3 py-2 font-medium">
                {t("gridMode")} - {columns}
              </div>
              {actionGroups.map(group => (
                <div key={group.id} className="border-t">
                  {group.actions.map(action => {
                    const actionColumns = getKBGridActionColumns(action.id);
                    const isDanger = action.id === "deleteGrid";
                    return (
                      <button
                        key={action.id}
                        type="button"
                        role="menuitem"
                        className={`flex h-9 w-full items-center gap-2 px-3 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground ${
                          isDanger ? "text-destructive" : ""
                        }`}
                        onClick={event => {
                          event.preventDefault();
                          event.stopPropagation();
                          runAction(action.id);
                        }}
                      >
                        {isDanger ? <Trash2 className="h-4 w-4" /> : null}
                        <span className="flex-1">
                          {actionColumns
                            ? t(action.labelKey, { columns: actionColumns })
                            : t(action.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="border-t px-3 py-2">
                <label className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                  <span>{t("gridBorderColor")}</span>
                  <input
                    type="color"
                    value={borderColor}
                    className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    aria-label={t("gridBorderColor")}
                    onChange={event =>
                      editor
                        .chain()
                        .focus()
                        .setKBGridBorder({ borderColor: event.target.value })
                        .run()
                    }
                  />
                </label>
                <div className="mt-2 flex items-center gap-1">
                  {[1, 2, 3].map(width => (
                    <button
                      key={width}
                      type="button"
                      className={`h-7 flex-1 rounded border text-xs ${
                        borderWidth === width
                          ? "border-primary text-primary"
                          : "border-border text-muted-foreground"
                      }`}
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        editor
                          .chain()
                          .focus()
                          .setKBGridBorder({ borderWidth: width as 1 | 2 | 3 })
                          .run();
                      }}
                      aria-label={t("gridBorderWidth", { width })}
                    >
                      {width}px
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground mt-1 text-[0.68rem]">
                  {t(
                    `gridBorder${borderStyle[0].toUpperCase()}${borderStyle.slice(
                      1
                    )}`
                  )}
                </p>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
});

function resolveKBGridPanelPosition(
  editor: Editor,
  panelSize: KBControlSize,
  anchorRect?: KBControlRect | null
): GridPanelPosition | null {
  if (anchorRect) {
    return buildKBAnchoredControlPosition({
      anchorRect,
      panelSize,
      viewport: getKBViewportSize(),
      placement: "top-start",
      offset: GRID_PANEL_OFFSET,
    });
  }

  const grid = findActiveKBGridElement(editor);
  if (!grid) return null;
  const rect = toKBControlRect(grid.getBoundingClientRect());

  return buildKBAnchoredControlPosition({
    anchorRect: rect,
    panelSize,
    viewport: getKBViewportSize(),
    placement: "top-start",
    offset: GRID_PANEL_OFFSET,
  });
}

function resolveKBGridBorderSegments(editor: Editor): GridBorderSegment[] {
  const grid = findActiveKBGridElement(editor);
  if (!grid) return [];

  const columns = Array.from(
    grid.querySelectorAll('[data-kb-grid-column="true"]')
  ).filter((element): element is HTMLElement => element instanceof HTMLElement);

  const targets = columns.length > 0 ? columns : [grid];
  const segments: GridBorderSegment[] = [];

  targets.forEach((target, index) => {
    const rect = toKBControlRect(target.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) return;
    segments.push(
      {
        id: `${index}-top`,
        rect: {
          left: rect.left,
          top: rect.top - 4,
          right: rect.right,
          bottom: rect.top + 4,
          width: rect.width,
          height: 8,
        },
      },
      {
        id: `${index}-right`,
        rect: {
          left: rect.right - 4,
          top: rect.top,
          right: rect.right + 4,
          bottom: rect.bottom,
          width: 8,
          height: rect.height,
        },
      },
      {
        id: `${index}-bottom`,
        rect: {
          left: rect.left,
          top: rect.bottom - 4,
          right: rect.right,
          bottom: rect.bottom + 4,
          width: rect.width,
          height: 8,
        },
      },
      {
        id: `${index}-left`,
        rect: {
          left: rect.left - 4,
          top: rect.top,
          right: rect.left + 4,
          bottom: rect.bottom,
          width: 8,
          height: rect.height,
        },
      }
    );
  });

  return segments;
}

function useGridLayoutVersion(editor: Editor, active: boolean): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame: number | null = null;
    const update = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setVersion(value => value + 1);
      });
    };

    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("focus", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);

    return () => {
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("focus", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, editor]);

  return version;
}

function findActiveKBGridElement(editor: Editor): HTMLElement | null {
  const selectedGrid = editor.view.dom.querySelector(
    '[data-kb-grid="true"].ProseMirror-selectednode, .ProseMirror-selectednode[data-kb-grid="true"]'
  );
  if (selectedGrid instanceof HTMLElement) {
    return selectedGrid;
  }

  const selectionElement = getClosestElement(findSelectionNode(editor));
  const selectionGrid = selectionElement?.closest('[data-kb-grid="true"]');
  if (
    selectionGrid instanceof HTMLElement &&
    editor.view.dom.contains(selectionGrid)
  ) {
    return selectionGrid;
  }

  const domSelection = window.getSelection();
  const fallbackElement = getClosestElement(domSelection?.anchorNode ?? null);
  const fallbackGrid = fallbackElement?.closest('[data-kb-grid="true"]');
  if (
    fallbackGrid instanceof HTMLElement &&
    editor.view.dom.contains(fallbackGrid)
  ) {
    return fallbackGrid;
  }

  const firstGrid = editor.view.dom.querySelector('[data-kb-grid="true"]');
  return firstGrid instanceof HTMLElement ? firstGrid : null;
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

function toKBControlRect(rect: DOMRect): KBControlRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
