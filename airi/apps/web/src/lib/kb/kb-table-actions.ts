import type { Editor } from "@tiptap/react";

export type KBTableActionId =
  | "insertTable"
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "toggleHeaderColumn"
  | "toggleHeaderCell"
  | "mergeCells"
  | "splitCell"
  | "deleteTable";

export function runKBTableAction(editor: Editor, actionId: KBTableActionId) {
  const chain = editor.chain().focus();

  switch (actionId) {
    case "insertTable":
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case "addRowBefore":
      return chain.addRowBefore().run();
    case "addRowAfter":
      return chain.addRowAfter().run();
    case "deleteRow":
      return chain.deleteRow().run();
    case "addColumnBefore":
      return chain.addColumnBefore().run();
    case "addColumnAfter":
      return chain.addColumnAfter().run();
    case "deleteColumn":
      return chain.deleteColumn().run();
    case "toggleHeaderRow":
      return chain.toggleHeaderRow().run();
    case "toggleHeaderColumn":
      return chain.toggleHeaderColumn().run();
    case "toggleHeaderCell":
      return chain.toggleHeaderCell().run();
    case "mergeCells":
      return chain.mergeCells().run();
    case "splitCell":
      return chain.splitCell().run();
    case "deleteTable":
      return chain.deleteTable().run();
  }
}
