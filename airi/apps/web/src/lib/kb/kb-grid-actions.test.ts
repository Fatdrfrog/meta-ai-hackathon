import type { Editor } from "@tiptap/react";
import {
  getKBGridActionGroups,
  runKBGridAction,
  type KBGridActionId,
} from "./kb-grid-actions";

describe("kb grid actions", () => {
  it("exposes grid mode controls for columns, borders, selection, and delete", () => {
    const groups = getKBGridActionGroups();

    expect(groups.map(group => group.id)).toEqual([
      "columns",
      "borders",
      "selection",
      "danger",
    ]);
    expect(
      groups.flatMap(group => group.actions.map(action => action.id))
    ).toEqual([
      "columns2",
      "columns3",
      "columns4",
      "borderSubtle",
      "borderSolid",
      "borderDashed",
      "borderNone",
      "selectGrid",
      "deleteGrid",
    ]);
  });

  it.each([
    ["columns2", "setKBGridColumns", { columns: 2 }],
    ["columns3", "setKBGridColumns", { columns: 3 }],
    ["columns4", "setKBGridColumns", { columns: 4 }],
    ["borderSubtle", "setKBGridBorder", { borderStyle: "subtle" }],
    ["borderSolid", "setKBGridBorder", { borderStyle: "solid" }],
    ["borderDashed", "setKBGridBorder", { borderStyle: "dashed" }],
    ["borderNone", "setKBGridBorder", { borderStyle: "none" }],
    ["selectGrid", "selectKBGrid", undefined],
    ["deleteGrid", "deleteKBGrid", undefined],
  ] as const)("runs the %s grid command", (actionId, commandName, payload) => {
    const chain = createChainMock();
    const editor = {
      chain: jest.fn(() => chain),
    };

    runKBGridAction(editor as unknown as Editor, actionId);

    expect(chain.focus).toHaveBeenCalled();
    if (payload) {
      expect(chain[commandName]).toHaveBeenCalledWith(payload);
    } else {
      expect(chain[commandName]).toHaveBeenCalledWith();
    }
    expect(chain.run).toHaveBeenCalled();
  });
});

type GridCommandName =
  | "focus"
  | "run"
  | "setKBGridColumns"
  | "setKBGridBorder"
  | "selectKBGrid"
  | "deleteKBGrid";

type ChainMock = Record<GridCommandName, jest.Mock> &
  Record<KBGridActionId, jest.Mock>;

function createChainMock(): ChainMock {
  const chain = {} as ChainMock;
  const commandNames: GridCommandName[] = [
    "focus",
    "run",
    "setKBGridColumns",
    "setKBGridBorder",
    "selectKBGrid",
    "deleteKBGrid",
  ];

  for (const commandName of commandNames) {
    chain[commandName] = jest.fn(() => chain);
  }

  return chain;
}
