/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { ArticleEditor } from "./article-editor";
import { useKBEntityEditor } from "@/hooks/use-kb-entity-editor";
import { kbArticleTitleOverridesAtom } from "@/lib/kb/kb-editor-state";
import {
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
    message: jest.fn(),
  },
}));

jest.mock("@/hooks/use-kb-entity-editor", () => ({
  useKBEntityEditor: jest.fn(),
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

describe("ArticleEditor title hydration", () => {
  const mockUseKBEntityEditor = jest.mocked(useKBEntityEditor);

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/panel/w/workspace-1/kb/article-1");
  });

  it("keeps an edited title when content save makes the tree title override drop before page props catch up", async () => {
    const store = createStore();
    const titleRef = { current: "Initial title" };
    let currentContent = "<p>Initial content</p>";
    let autoSaveHandler: ((isSilent?: boolean) => Promise<void>) | undefined;

    global.fetch = jest.fn(async () =>
      createJsonResponse({ success: true })
    ) as jest.Mock;

    mockUseKBEntityEditor.mockImplementation(({ sync }) =>
      entityEditorValue({
        setTitle: (nextTitle: string) => {
          titleRef.current = nextTitle;
          sync.setActiveTitle?.(nextTitle);
          sync.setSaveStatus("unsaved");
        },
        titleRef,
        getContent: () => currentContent,
        setSaveStatus: sync.setSaveStatus,
        setActiveId: sync.setActiveId,
        setActiveTitle: sync.setActiveTitle,
        registerAutoSaveHandler: (
          handler: (isSilent?: boolean) => Promise<void>
        ) => {
          autoSaveHandler = handler;
        },
      })
    );

    render(
      <Provider store={store}>
        <ArticleEditor initial={draftArticle()} />
      </Provider>
    );

    const titleInput = await screen.findByLabelText("enterArticleTitle");
    await waitFor(() => expect(titleInput).toHaveValue("Initial title"));

    fireEvent.change(titleInput, { target: { value: "Edited title" } });
    expect(titleInput).toHaveValue("Edited title");

    currentContent = "<p>Typed article body</p>";
    await act(async () => {
      await autoSaveHandler?.(true);
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      store.set(kbArticleTitleOverridesAtom, {});
    });

    expect(titleInput).toHaveValue("Edited title");
  });
});
