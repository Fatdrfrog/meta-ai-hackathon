import type { Editor } from "@tiptap/react";
import { runKBTableAction, type KBTableActionId } from "./kb-table-actions";

describe("getKBTableActionGroups", () => {
  it.each([
    ["addRowBefore", "addRowBefore"],
    ["addRowAfter", "addRowAfter"],
    ["deleteRow", "deleteRow"],
    ["addColumnBefore", "addColumnBefore"],
    ["addColumnAfter", "addColumnAfter"],
    ["deleteColumn", "deleteColumn"],
    ["toggleHeaderRow", "toggleHeaderRow"],
    ["toggleHeaderColumn", "toggleHeaderColumn"],
    ["toggleHeaderCell", "toggleHeaderCell"],
    ["mergeCells", "mergeCells"],
    ["splitCell", "splitCell"],
    ["deleteTable", "deleteTable"],
  ] as const)("runs the %s table command", (actionId, commandName) => {
    const chain = createChainMock();
    const editor = {
      chain: jest.fn(() => chain),
    };

    runKBTableAction(editor as unknown as Editor, actionId);

    expect(chain.focus).toHaveBeenCalled();
    expect(chain[commandName]).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalled();
  });

  it("inserts a practical default table", () => {
    const chain = createChainMock();
    const editor = {
      chain: jest.fn(() => chain),
    };

    runKBTableAction(editor as unknown as Editor, "insertTable");

    expect(chain.insertTable).toHaveBeenCalledWith({
      rows: 3,
      cols: 3,
      withHeaderRow: true,
    });
  });
});

type ChainMock = Record<"focus" | "run" | KBTableActionId, jest.Mock>;

function createChainMock(): ChainMock {
  const chain = {} as ChainMock;
  const commandNames: Array<keyof ChainMock> = [
    "focus",
    "run",
    "insertTable",
    "addRowBefore",
    "addRowAfter",
    "deleteRow",
    "addColumnBefore",
    "addColumnAfter",
    "deleteColumn",
    "toggleHeaderRow",
    "toggleHeaderColumn",
    "toggleHeaderCell",
    "mergeCells",
    "splitCell",
    "deleteTable",
  ];

  for (const commandName of commandNames) {
    chain[commandName] = jest.fn(() => chain);
  }

  return chain;
}
