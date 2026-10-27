import type { KBTableActionId } from "./kb-table-actions";

export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type KBTableBorderControl = {
  actionId: KBTableActionId;
  left: number;
  top: number;
};

export type KBTableBorderTargetKind = "row" | "column";

export type KBTableBorderTarget = {
  kind: KBTableBorderTargetKind;
  trigger: {
    left: number;
    top: number;
  };
  controls: KBTableBorderControl[];
};

export type KBTableBorderControlLayout = {
  addRowBefore: KBTableBorderControl;
  addRowAfter: KBTableBorderControl;
  deleteRow: KBTableBorderControl;
  addColumnBefore: KBTableBorderControl;
  addColumnAfter: KBTableBorderControl;
  deleteColumn: KBTableBorderControl;
};

export function buildKBTableBorderControlLayout({
  tableRect: _tableRect,
  cellRect,
  controlSize = 24,
  gap: _gap = 8,
}: {
  tableRect: RectLike;
  cellRect: RectLike;
  controlSize?: number;
  gap?: number;
}): KBTableBorderControlLayout {
  const halfControl = controlSize / 2;
  const rowCenter = cellRect.top + cellRect.height / 2;
  const columnCenter = cellRect.left + cellRect.width / 2;

  return {
    addRowBefore: {
      actionId: "addRowBefore",
      left: cellRect.left - halfControl,
      top: cellRect.top - halfControl,
    },
    addRowAfter: {
      actionId: "addRowAfter",
      left: cellRect.left - halfControl,
      top: cellRect.bottom - halfControl,
    },
    deleteRow: {
      actionId: "deleteRow",
      left: cellRect.right - halfControl,
      top: rowCenter - halfControl,
    },
    addColumnBefore: {
      actionId: "addColumnBefore",
      left: cellRect.left - halfControl,
      top: cellRect.top - halfControl,
    },
    addColumnAfter: {
      actionId: "addColumnAfter",
      left: cellRect.right - halfControl,
      top: cellRect.top - halfControl,
    },
    deleteColumn: {
      actionId: "deleteColumn",
      left: columnCenter - halfControl,
      top: cellRect.bottom - halfControl,
    },
  };
}

export function selectKBTableBorderTargetForPointer({
  layout,
  cellRect,
  pointerX,
  pointerY,
  controlSize = 24,
  floatOffset = 24,
  threshold = 8,
}: {
  layout: KBTableBorderControlLayout;
  cellRect: RectLike;
  pointerX: number;
  pointerY: number;
  controlSize?: number;
  floatOffset?: number;
  threshold?: number;
}): KBTableBorderTarget | null {
  const halfControl = controlSize / 2;
  const onTop = Math.abs(pointerY - cellRect.top) <= threshold;
  const onBottom = Math.abs(pointerY - cellRect.bottom) <= threshold;
  const onLeft = Math.abs(pointerX - cellRect.left) <= threshold;
  const onRight = Math.abs(pointerX - cellRect.right) <= threshold;

  if (onTop) {
    return {
      kind: "row",
      trigger: {
        left: pointerX - halfControl,
        top: cellRect.top - controlSize - floatOffset / 2,
      },
      controls: [layout.addRowBefore, layout.deleteRow],
    };
  }

  if (onBottom) {
    return {
      kind: "row",
      trigger: {
        left: pointerX - halfControl,
        top: cellRect.bottom + floatOffset,
      },
      controls: [layout.addRowAfter, layout.deleteRow],
    };
  }

  if (onLeft) {
    return {
      kind: "column",
      trigger: {
        left: cellRect.left - controlSize - floatOffset,
        top: pointerY - halfControl,
      },
      controls: [layout.addColumnBefore, layout.deleteColumn],
    };
  }

  if (onRight) {
    return {
      kind: "column",
      trigger: {
        left: cellRect.right + floatOffset,
        top: pointerY - halfControl,
      },
      controls: [layout.addColumnAfter, layout.deleteColumn],
    };
  }

  return null;
}
