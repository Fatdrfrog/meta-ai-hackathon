/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { KBTextColorControls } from "./kb-text-color-controls";

const useEditorState = jest.fn();

jest.mock("@tiptap/react", () => ({
  useEditorState: (options: unknown) => useEditorState(options),
}));

jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

type EditorChainMock = {
  focus: jest.Mock<EditorChainMock, []>;
  setColor: jest.Mock<EditorChainMock, [string]>;
  unsetColor: jest.Mock<EditorChainMock, []>;
  setBackgroundColor: jest.Mock<EditorChainMock, [string]>;
  unsetBackgroundColor: jest.Mock<EditorChainMock, []>;
  run: jest.Mock<boolean, []>;
};

function createEditorMock() {
  const chain = {} as EditorChainMock;
  chain.focus = jest.fn(() => chain);
  chain.setColor = jest.fn((_color: string) => chain);
  chain.unsetColor = jest.fn(() => chain);
  chain.setBackgroundColor = jest.fn((_color: string) => chain);
  chain.unsetBackgroundColor = jest.fn(() => chain);
  chain.run = jest.fn(() => true);

  const editor = {
    chain: jest.fn(() => chain),
    getAttributes: jest.fn(() => ({
      color: "#111827",
      backgroundColor: "#fef3c7",
    })),
  };

  return { chain, editor };
}

describe("KBTextColorControls", () => {
  beforeEach(() => {
    useEditorState.mockImplementation(({ editor, selector }) =>
      selector({ editor })
    );
  });

  it("applies and clears text colors through one toolbar control", () => {
    const { chain, editor } = createEditorMock();

    render(<KBTextColorControls editor={editor as never} />);

    fireEvent.click(screen.getByRole("button", { name: "textColor #ef4444" }));
    expect(chain.setColor).toHaveBeenCalledWith("#ef4444");
    expect(chain.run).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "resetTextColor" }));
    expect(chain.unsetColor).toHaveBeenCalled();
  });

  it("applies and clears highlight colors through a separate toolbar control", () => {
    const { chain, editor } = createEditorMock();

    render(<KBTextColorControls editor={editor as never} />);

    fireEvent.click(
      screen.getByRole("button", { name: "highlightColor #fef3c7" })
    );
    expect(chain.setBackgroundColor).toHaveBeenCalledWith("#fef3c7");
    expect(chain.run).toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "resetHighlightColor" })
    );
    expect(chain.unsetBackgroundColor).toHaveBeenCalled();
  });
});
