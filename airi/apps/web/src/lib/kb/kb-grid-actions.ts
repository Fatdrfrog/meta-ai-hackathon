import type { Editor } from "@tiptap/react";

export type KBGridActionId =
  | "columns2"
  | "columns3"
  | "columns4"
  | "borderSubtle"
  | "borderSolid"
  | "borderDashed"
  | "borderNone"
  | "selectGrid"
  | "deleteGrid";

export type KBGridActionGroupId =
  | "columns"
  | "borders"
  | "selection"
  | "danger";

export type KBGridAction = {
  id: KBGridActionId;
  labelKey: string;
};

export type KBGridActionGroup = {
  id: KBGridActionGroupId;
  actions: KBGridAction[];
};

export function getKBGridActionGroups(): KBGridActionGroup[] {
  return [
    {
      id: "columns",
      actions: [
        { id: "columns2", labelKey: "gridColumns" },
        { id: "columns3", labelKey: "gridColumns" },
        { id: "columns4", labelKey: "gridColumns" },
      ],
    },
    {
      id: "borders",
      actions: [
        { id: "borderSubtle", labelKey: "gridBorderSubtle" },
        { id: "borderSolid", labelKey: "gridBorderSolid" },
        { id: "borderDashed", labelKey: "gridBorderDashed" },
        { id: "borderNone", labelKey: "gridBorderNone" },
      ],
    },
    {
      id: "selection",
      actions: [{ id: "selectGrid", labelKey: "selectGrid" }],
    },
    {
      id: "danger",
      actions: [{ id: "deleteGrid", labelKey: "deleteGrid" }],
    },
  ];
}

export function getKBGridActionColumns(
  actionId: KBGridActionId
): 2 | 3 | 4 | null {
  if (actionId === "columns2") return 2;
  if (actionId === "columns3") return 3;
  if (actionId === "columns4") return 4;
  return null;
}

export function runKBGridAction(editor: Editor, actionId: KBGridActionId) {
  const chain = editor.chain().focus();

  switch (actionId) {
    case "columns2":
      return chain.setKBGridColumns({ columns: 2 }).run();
    case "columns3":
      return chain.setKBGridColumns({ columns: 3 }).run();
    case "columns4":
      return chain.setKBGridColumns({ columns: 4 }).run();
    case "borderSubtle":
      return chain.setKBGridBorder({ borderStyle: "subtle" }).run();
    case "borderSolid":
      return chain.setKBGridBorder({ borderStyle: "solid" }).run();
    case "borderDashed":
      return chain.setKBGridBorder({ borderStyle: "dashed" }).run();
    case "borderNone":
      return chain.setKBGridBorder({ borderStyle: "none" }).run();
    case "selectGrid":
      return chain.selectKBGrid().run();
    case "deleteGrid":
      return chain.deleteKBGrid().run();
  }
}
