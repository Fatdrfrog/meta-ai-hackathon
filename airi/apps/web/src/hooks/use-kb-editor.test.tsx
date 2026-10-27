/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import { useKBEditor } from "./use-kb-editor";

const mockUseEditor = jest.fn();

jest.mock("@/lib/kb/content-utils", () => ({
  convertContentToHtml: (value?: string | null) => value ?? "",
}));

jest.mock("@tiptap/react", () => ({
  useEditor: (...args: unknown[]) => mockUseEditor(...args),
}));

describe("useKBEditor", () => {
  let html: string;
  let setContent: jest.Mock;
  let editorOptions: { onUpdate?: (event: { editor: unknown }) => void };
  let mockEditor: {
    getHTML: () => string;
    commands: {
      setContent: jest.Mock;
    };
  };

  beforeEach(() => {
    html = "<p>Initial</p>";
    setContent = jest.fn((nextContent: string) => {
      html = nextContent;
    });
    mockEditor = {
      getHTML: () => html,
      commands: {
        setContent,
      },
    };
    editorOptions = {};
    mockUseEditor.mockImplementation((options: typeof editorOptions) => {
      editorOptions = options;
      return mockEditor;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("does not replace live content when refreshed props arrive for the same article locale", async () => {
    const { rerender } = renderHook(
      ({ content, entityKey }) =>
        useKBEditor({
          initialContentMdx: content,
          entityKey,
          extensions: [],
        }),
      {
        initialProps: {
          content: "<p>Initial</p>",
          entityKey: "article-1:en",
        },
      }
    );

    await waitFor(() => expect(mockUseEditor).toHaveBeenCalled());

    html = "<p>User draft that is not saved yet</p>";
    editorOptions.onUpdate?.({ editor: mockEditor });
    rerender({
      content: "<p>Older server refresh</p>",
      entityKey: "article-1:en",
    });

    await waitFor(() => expect(setContent).not.toHaveBeenCalled());
    expect(html).toBe("<p>User draft that is not saved yet</p>");
  });

  it("applies same article refreshed props when the editor has no local changes", async () => {
    const { rerender } = renderHook(
      ({ content, entityKey }) =>
        useKBEditor({
          initialContentMdx: content,
          entityKey,
          extensions: [],
        }),
      {
        initialProps: {
          content: "<p>Initial</p>",
          entityKey: "article-1:en",
        },
      }
    );

    await waitFor(() => expect(mockUseEditor).toHaveBeenCalled());

    rerender({
      content: "<p>Updated server content</p>",
      entityKey: "article-1:en",
    });

    await waitFor(() =>
      expect(setContent).toHaveBeenCalledWith("<p>Updated server content</p>", {
        emitUpdate: false,
      })
    );
    expect(html).toBe("<p>Updated server content</p>");
  });

  it("replaces content when a different article locale is opened", async () => {
    const { rerender } = renderHook(
      ({ content, entityKey }) =>
        useKBEditor({
          initialContentMdx: content,
          entityKey,
          extensions: [],
        }),
      {
        initialProps: {
          content: "<p>Initial</p>",
          entityKey: "article-1:en",
        },
      }
    );

    await waitFor(() => expect(mockUseEditor).toHaveBeenCalled());

    html = "<p>User draft in English</p>";
    rerender({
      content: "<p>Russian article</p>",
      entityKey: "article-1:ru",
    });

    await waitFor(() =>
      expect(setContent).toHaveBeenCalledWith("<p>Russian article</p>", {
        emitUpdate: false,
      })
    );
    expect(html).toBe("<p>Russian article</p>");
  });

  it("does not leave a hydration reset timer behind after unmount", async () => {
    jest.useFakeTimers();
    html = "<p>Client draft</p>";

    const { unmount } = renderHook(() =>
      useKBEditor({
        initialContentMdx: "<p>Server content</p>",
        entityKey: "article-1:en",
        extensions: [],
      })
    );

    await waitFor(() =>
      expect(setContent).toHaveBeenCalledWith("<p>Server content</p>", {
        emitUpdate: false,
      })
    );

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });
});
