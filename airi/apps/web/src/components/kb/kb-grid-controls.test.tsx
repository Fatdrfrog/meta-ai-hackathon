/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KBGridControls } from "./kb-grid-controls";

const useEditorState = jest.fn();

jest.mock("@tiptap/react", () => ({
  useEditorState: (options: unknown) => useEditorState(options),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "gridColumns" && values?.columns
      ? `${values.columns} columns`
      : key,
}));

function createEditorMock(active = true) {
  type ChainMock = {
    focus: jest.Mock<ChainMock, []>;
    setKBGridColumns: jest.Mock<ChainMock, [{ columns: number }]>;
    setKBGridBorder: jest.Mock<
      ChainMock,
      [
        {
          borderStyle?: string;
          borderColor?: string;
          borderWidth?: 1 | 2 | 3;
        },
      ]
    >;
    selectKBGrid: jest.Mock<ChainMock, []>;
    deleteKBGrid: jest.Mock<ChainMock, []>;
    run: jest.Mock<boolean, []>;
  };
  const chain = {} as ChainMock;
  chain.focus = jest.fn(() => chain);
  chain.setKBGridColumns = jest.fn((_options: { columns: number }) => chain);
  chain.setKBGridBorder = jest.fn(
    (_options: {
      borderStyle?: string;
      borderColor?: string;
      borderWidth?: 1 | 2 | 3;
    }) => chain
  );
  chain.selectKBGrid = jest.fn(() => chain);
  chain.deleteKBGrid = jest.fn(() => chain);
  chain.run = jest.fn(() => true);

  const editorDom = document.createElement("div");
  const gridElement = document.createElement("div");
  const firstColumn = document.createElement("div");
  const secondColumn = document.createElement("div");
  gridElement.dataset.kbGrid = "true";
  firstColumn.dataset.kbGridColumn = "true";
  secondColumn.dataset.kbGridColumn = "true";
  gridElement.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: 240,
        top: 320,
        right: 640,
        bottom: 480,
        width: 400,
        height: 160,
      }) as DOMRect
  );
  firstColumn.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: 240,
        top: 320,
        right: 430,
        bottom: 480,
        width: 190,
        height: 160,
      }) as DOMRect
  );
  secondColumn.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: 450,
        top: 320,
        right: 640,
        bottom: 480,
        width: 190,
        height: 160,
      }) as DOMRect
  );
  gridElement.append(firstColumn, secondColumn);
  editorDom.appendChild(gridElement);
  editorDom.dataset.editorMock = "true";
  document.body.appendChild(editorDom);

  const editor = {
    chain: jest.fn(() => chain),
    isActive: jest.fn(() => active),
    getAttributes: jest.fn(() => ({
      columns: 3,
      borderStyle: "dashed",
      borderColor: "#ef4444",
      borderWidth: 2,
    })),
    on: jest.fn(),
    off: jest.fn(),
    view: {
      dom: editorDom,
    },
  };

  return { chain, editor, editorDom, gridElement, firstColumn, secondColumn };
}

describe("KBGridControls", () => {
  beforeEach(() => {
    useEditorState.mockImplementation(({ editor, selector }) =>
      selector({ editor })
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });
  });

  afterEach(() => {
    document
      .querySelectorAll('[data-editor-mock="true"]')
      .forEach(element => element.remove());
    jest.clearAllMocks();
  });

  it("is hidden outside a grid", () => {
    const { editor } = createEditorMock(false);

    render(<KBGridControls editor={editor as never} />);

    expect(screen.queryByRole("button", { name: "gridMode" })).toBeNull();
  });

  it("anchors grid mode near the active grid and runs grid actions", async () => {
    const { chain, editor } = createEditorMock();

    render(<KBGridControls editor={editor as never} />);

    fireEvent.click(screen.getByRole("button", { name: "gridMode" }));

    const menu = await screen.findByRole("menu", { name: "gridMode" });
    await waitFor(() => expect(menu).toHaveStyle({ left: "240px" }));
    expect(menu).toHaveStyle({ top: "32px" });

    fireEvent.click(screen.getByRole("menuitem", { name: "2 columns" }));
    expect(chain.setKBGridColumns).toHaveBeenCalledWith({ columns: 2 });

    fireEvent.click(screen.getByRole("button", { name: "gridMode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "gridBorderSolid" }));
    expect(chain.setKBGridBorder).toHaveBeenCalledWith({
      borderStyle: "solid",
    });

    fireEvent.click(screen.getByRole("button", { name: "gridMode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "selectGrid" }));
    expect(chain.selectKBGrid).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "gridMode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "deleteGrid" }));
    expect(chain.deleteKBGrid).toHaveBeenCalled();
  });

  it("opens grid border editing from a directly pickable border", async () => {
    const { chain, editor } = createEditorMock();

    render(<KBGridControls editor={editor as never} />);

    const borderButtons = screen.getAllByRole("button", {
      name: "editGridBorder",
    });
    expect(borderButtons.length).toBeGreaterThan(0);

    fireEvent.click(borderButtons[0]);

    const menu = await screen.findByRole("menu", { name: "gridMode" });
    expect(menu).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole("button", { name: "gridBorderWidth" })[0]
    );
    expect(chain.setKBGridBorder).toHaveBeenCalledWith({ borderWidth: 1 });
  });
});
