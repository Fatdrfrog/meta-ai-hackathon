/** @jest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import { ArticleEditor } from "./article-editor";
import { useKBEntityEditor } from "@/hooks/use-kb-entity-editor";
import { useKBArticleEditor } from "./kb-article-editor-context";
import {
  articleEditorContextValue,
  createJsonResponse,
  draftArticle,
  entityEditorValue,
} from "./article-editor-test-utils";

jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace-1" }),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/hooks/use-kb-entity-editor", () => ({
  useKBEntityEditor: jest.fn(),
}));

jest.mock("./kb-article-editor-context", () => ({
  useKBArticleEditor: jest.fn(),
}));

jest.mock("./kb-article-language-control", () => ({
  KBArticleLanguageControl: () => null,
}));

jest.mock("./publish-dropdown", () => ({
  PublishDropdown: () => null,
}));

jest.mock("./kb-editor-context-menu", () => ({
  KBEditorContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("./kb-editor-menus", () => ({
  KBEditorChunkHeadingHint: () => null,
  KBEditorMenus: () => null,
}));

jest.mock("./link-edit-dialog", () => ({
  LinkEditDialog: () => null,
}));

jest.mock("@tiptap/react", () => ({
  EditorContent: () => <div data-testid="editor-content" />,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("ArticleEditor autosave races", () => {
  const mockUseKBEntityEditor = jest.mocked(useKBEntityEditor);
  const mockUseKBArticleEditor = jest.mocked(useKBArticleEditor);

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/panel/w/workspace-1/kb/article-1");
  });

  it("saves the latest editor content when content changes while an older save is in flight", async () => {
    const setSaveStatus = jest.fn();
    const titleRef = { current: "Initial title" };
    let currentContent = "<p>First edit</p>";
    let autoSaveHandler: ((isSilent?: boolean) => Promise<void>) | undefined;
    const firstSave = createDeferred<Response>();
    const secondSave = createDeferred<Response>();
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);

    global.fetch = fetchMock;

    mockUseKBArticleEditor.mockReturnValue(
      articleEditorContextValue({ setSaveStatus })
    );

    mockUseKBEntityEditor.mockReturnValue(
      entityEditorValue({
        setTitle: jest.fn(nextTitle => {
          titleRef.current = nextTitle;
        }),
        titleRef,
        getContent: jest.fn(() => currentContent),
        registerAutoSaveHandler: jest.fn(handler => {
          autoSaveHandler = handler;
        }),
      })
    );

    render(<ArticleEditor initial={draftArticle()} />);

    await waitFor(() => expect(autoSaveHandler).toBeTruthy());

    const savePromise = autoSaveHandler?.(true);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    currentContent = "<p>Second edit</p>";
    await act(async () => {
      firstSave.resolve(createJsonResponse({ success: true }));
      await Promise.resolve();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      secondSave.resolve(createJsonResponse({ success: true }));
      await Promise.resolve();
    });

    await expect(savePromise).resolves.toBeUndefined();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      content_mdx: "<p>First edit</p>",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      content_mdx: "<p>Second edit</p>",
    });
    expect(setSaveStatus).toHaveBeenCalledWith("unsaved");
    expect(setSaveStatus).toHaveBeenLastCalledWith("saved");
  });

  it("saves through the existing draft path when Ctrl+S is pressed in edit mode", async () => {
    const setSaveStatus = jest.fn();
    const titleRef = { current: "Shortcut title" };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(createJsonResponse({ success: true }));

    global.fetch = fetchMock;

    mockUseKBArticleEditor.mockReturnValue(
      articleEditorContextValue({ setSaveStatus })
    );

    mockUseKBEntityEditor.mockReturnValue(
      entityEditorValue({
        setTitle: jest.fn(nextTitle => {
          titleRef.current = nextTitle;
        }),
        titleRef,
        getContent: jest.fn(() => "<p>Shortcut content</p>"),
      })
    );

    render(<ArticleEditor initial={draftArticle()} />);

    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      content_mdx: "<p>Shortcut content</p>",
    });
    expect(setSaveStatus).toHaveBeenLastCalledWith("saved");
  });
});
