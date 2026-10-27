import {
  findParentNodeClosestToPos,
  mergeAttributes,
  Node,
} from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

import { KB_OBJECT_SELECTION_COLOR } from "@/lib/kb/kb-object-controls";
import { sanitizeKBColorValue } from "@/lib/kb/kb-text-colors";

export type KBGridColumnCount = 2 | 3 | 4;
export type KBGridBorderStyle = "subtle" | "solid" | "dashed" | "none";
export type KBGridBorderWidth = 1 | 2 | 3;

export type KBGridBorderOptions = {
  borderStyle?: KBGridBorderStyle;
  borderColor?: string | null;
  borderWidth?: KBGridBorderWidth;
};

export const KB_GRID_CSS = `
  .kb-editor .kb-editor-grid,
  .public-kb-article-content .kb-editor-grid {
    display: grid;
    grid-template-columns: repeat(var(--kb-grid-columns, 2), minmax(0, 1fr));
    gap: 1rem;
    margin: 1.25rem 0;
    max-width: 100%;
  }

  .kb-editor .kb-editor-grid[data-columns="3"],
  .public-kb-article-content .kb-editor-grid[data-columns="3"] {
    --kb-grid-columns: 3;
  }

  .kb-editor .kb-editor-grid[data-columns="4"],
  .public-kb-article-content .kb-editor-grid[data-columns="4"] {
    --kb-grid-columns: 4;
  }

  .kb-editor .kb-editor-grid__column,
  .public-kb-article-content .kb-editor-grid__column {
    min-width: 0;
    border-color: var(--kb-grid-border-color, hsl(var(--border)));
    border-style: solid;
    border-width: var(--kb-grid-border-width, 1px);
    border-radius: 0.5rem;
    padding: 0.875rem;
    background: hsl(var(--background));
    overflow-wrap: anywhere;
  }

  .kb-editor .kb-editor-grid[data-border-style="solid"] .kb-editor-grid__column,
  .public-kb-article-content .kb-editor-grid[data-border-style="solid"] .kb-editor-grid__column {
    border-style: solid;
  }

  .kb-editor .kb-editor-grid[data-border-style="dashed"] .kb-editor-grid__column,
  .public-kb-article-content .kb-editor-grid[data-border-style="dashed"] .kb-editor-grid__column {
    border-style: dashed;
  }

  .kb-editor .kb-editor-grid[data-border-style="none"] .kb-editor-grid__column {
    border-style: dashed;
    border-color: hsl(var(--border) / 0.55);
  }

  .public-kb-article-content .kb-editor-grid[data-border-style="none"] .kb-editor-grid__column {
    border-color: transparent;
    box-shadow: none;
  }

  .kb-editor .kb-editor-grid.ProseMirror-selectednode {
    outline: 2px solid ${KB_OBJECT_SELECTION_COLOR};
    outline-offset: 3px;
  }

  .kb-editor .kb-editor-grid__column > :first-child,
  .public-kb-article-content .kb-editor-grid__column > :first-child {
    margin-top: 0;
  }

  .kb-editor .kb-editor-grid__column > :last-child,
  .public-kb-article-content .kb-editor-grid__column > :last-child {
    margin-bottom: 0;
  }

  @media (max-width: 640px) {
    .kb-editor .kb-editor-grid,
    .public-kb-article-content .kb-editor-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
`;

export function normalizeKBGridColumnCount(value: unknown): KBGridColumnCount {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  if (parsed >= 4) return 4;
  if (parsed === 3) return 3;
  return 2;
}

export function normalizeKBGridBorderStyle(value: unknown): KBGridBorderStyle {
  if (value === "solid" || value === "dashed" || value === "none") {
    return value;
  }
  return "subtle";
}

export function normalizeKBGridBorderWidth(value: unknown): KBGridBorderWidth {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  if (parsed >= 3) return 3;
  if (parsed === 2) return 2;
  return 1;
}

export function buildKBGridRenderAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const columns = normalizeKBGridColumnCount(attributes.columns);
  const borderStyle = normalizeKBGridBorderStyle(attributes.borderStyle);
  const borderWidth = normalizeKBGridBorderWidth(attributes.borderWidth);
  const borderColor = sanitizeKBColorValue(attributes.borderColor);
  const cssVariables = [
    borderColor ? `--kb-grid-border-color: ${borderColor}` : null,
    `--kb-grid-border-width: ${borderWidth}px`,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    "data-columns": columns,
    "data-border-style": borderStyle,
    ...(borderColor ? { "data-border-color": borderColor } : {}),
    "data-border-width": borderWidth,
    ...(cssVariables ? { style: cssVariables } : {}),
  };
}

export function createKBGridContent({ columns = 2 }: { columns?: number }) {
  const normalizedColumns = normalizeKBGridColumnCount(columns);

  return {
    type: "kbGrid",
    attrs: {
      columns: normalizedColumns,
      borderStyle: "subtle",
      borderWidth: 1,
    },
    content: Array.from({ length: normalizedColumns }, () => ({
      type: "kbGridColumn",
      content: [{ type: "paragraph" }],
    })),
  };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kbGrid: {
      insertKBGrid: (options?: { columns?: number }) => ReturnType;
      setKBGridColumns: (options: { columns: number }) => ReturnType;
      setKBGridBorder: (options: KBGridBorderOptions) => ReturnType;
      selectKBGrid: () => ReturnType;
      deleteKBGrid: () => ReturnType;
    };
  }
}

function findCurrentKBGrid(state: {
  selection: { $from: Parameters<typeof findParentNodeClosestToPos>[0] };
}) {
  const selection = state.selection;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "kbGrid"
  ) {
    return {
      node: selection.node,
      pos: selection.from,
    };
  }

  return findParentNodeClosestToPos(
    selection.$from,
    node => node.type.name === "kbGrid"
  );
}

export const KBGridColumn = Node.create({
  name: "kbGridColumn",
  content: "block+",
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-kb-grid-column="true"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-kb-grid-column": "true",
        class: "kb-editor-grid__column",
      }),
      0,
    ];
  },
});

export const KBGrid = Node.create({
  name: "kbGrid",
  group: "block",
  content: "kbGridColumn{2,4}",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: element =>
          normalizeKBGridColumnCount(element.getAttribute("data-columns")),
        renderHTML: attributes => ({
          "data-columns": normalizeKBGridColumnCount(attributes.columns),
        }),
      },
      borderStyle: {
        default: "subtle",
        parseHTML: element =>
          normalizeKBGridBorderStyle(element.getAttribute("data-border-style")),
        renderHTML: attributes => ({
          "data-border-style": normalizeKBGridBorderStyle(
            attributes.borderStyle
          ),
        }),
      },
      borderColor: {
        default: null,
        parseHTML: element =>
          sanitizeKBColorValue(element.getAttribute("data-border-color")),
        renderHTML: attributes => {
          const borderColor = sanitizeKBColorValue(attributes.borderColor);
          return borderColor ? { "data-border-color": borderColor } : {};
        },
      },
      borderWidth: {
        default: 1,
        parseHTML: element =>
          normalizeKBGridBorderWidth(element.getAttribute("data-border-width")),
        renderHTML: attributes => ({
          "data-border-width": normalizeKBGridBorderWidth(
            attributes.borderWidth
          ),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-kb-grid="true"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        HTMLAttributes,
        buildKBGridRenderAttributes(HTMLAttributes),
        {
          "data-kb-grid": "true",
          class: "kb-editor-grid",
        }
      ),
      0,
    ];
  },

  addCommands() {
    return {
      insertKBGrid:
        options =>
        ({ commands }) =>
          commands.insertContent(
            createKBGridContent({ columns: options?.columns })
          ),
      setKBGridColumns:
        options =>
        ({ state, dispatch }) => {
          const grid = findCurrentKBGrid(state);
          if (!grid) return false;
          const attrs = {
            ...grid.node.attrs,
            columns: normalizeKBGridColumnCount(options.columns),
          };
          if (dispatch) {
            dispatch(state.tr.setNodeMarkup(grid.pos, undefined, attrs));
          }
          return true;
        },
      setKBGridBorder:
        options =>
        ({ state, dispatch }) => {
          const grid = findCurrentKBGrid(state);
          if (!grid) return false;
          const attrs = {
            ...grid.node.attrs,
            ...(options.borderStyle
              ? { borderStyle: normalizeKBGridBorderStyle(options.borderStyle) }
              : {}),
            ...(options.borderWidth
              ? { borderWidth: normalizeKBGridBorderWidth(options.borderWidth) }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(options, "borderColor")
              ? { borderColor: sanitizeKBColorValue(options.borderColor) }
              : {}),
          };
          if (dispatch) {
            dispatch(state.tr.setNodeMarkup(grid.pos, undefined, attrs));
          }
          return true;
        },
      selectKBGrid:
        () =>
        ({ state, dispatch }) => {
          const grid = findCurrentKBGrid(state);
          if (!grid) return false;
          if (dispatch) {
            dispatch(
              state.tr
                .setSelection(NodeSelection.create(state.doc, grid.pos))
                .scrollIntoView()
            );
          }
          return true;
        },
      deleteKBGrid:
        () =>
        ({ state, dispatch }) => {
          const grid = findCurrentKBGrid(state);
          if (!grid) return false;
          if (dispatch) {
            dispatch(state.tr.delete(grid.pos, grid.pos + grid.node.nodeSize));
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    const deleteSelectedGrid = () => {
      const { selection } = this.editor.state;
      if (
        selection instanceof NodeSelection &&
        selection.node.type.name === "kbGrid"
      ) {
        return this.editor.commands.deleteKBGrid();
      }

      return false;
    };

    return {
      Backspace: deleteSelectedGrid,
      Delete: deleteSelectedGrid,
    };
  },
});
