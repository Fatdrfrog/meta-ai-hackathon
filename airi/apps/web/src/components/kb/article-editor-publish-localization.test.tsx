/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
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
  KBArticleLanguageControl: ({
    currentLocale,
    localizations,
  }: {
    currentLocale: string;
    localizations: Array<{
      locale: string;
      status: string | null;
      hasDraft: boolean;
    }>;
  }) => {
    const current = localizations.find(
      localization => localization.locale === currentLocale
    );
    return (
      <div data-testid="current-locale-status">
        {current?.status}:{String(current?.hasDraft)}
      </div>
    );
  },
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

describe("ArticleEditor publish localization state", () => {
  const mockUseKBEntityEditor = jest.mocked(useKBEntityEditor);
  const mockUseKBArticleEditor = jest.mocked(useKBArticleEditor);

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/panel/w/workspace-1/kb/article-1");
  });

  it("marks the current language published immediately after publish succeeds", async () => {
    let publishHandler: (() => Promise<void>) | undefined;
    const titleRef = { current: "How to KB" };

    global.fetch = jest.fn(async () =>
      createJsonResponse({
        success: true,
        publishedLocalization: {
          locale: "en",
          status: "published",
          published_at: "2026-05-19T12:00:00.000Z",
          updated_at: "2026-05-19T12:00:00.000Z",
          hasDraft: false,
          isDefault: true,
        },
      })
    ) as jest.Mock;

    mockUseKBArticleEditor.mockReturnValue(
      articleEditorContextValue({
        registerPublishHandler: jest.fn(handler => {
          publishHandler = handler;
        }),
        mountTime: 1000,
      })
    );

    mockUseKBEntityEditor.mockReturnValue(
      entityEditorValue({
        initialTitle: "How to KB",
        initialContent: "<p>Body</p>",
        setTitle: jest.fn(nextTitle => {
          titleRef.current = nextTitle;
        }),
        titleRef,
        getContent: jest.fn(() => "<p>Body</p>"),
        registerPublishHandler: jest.fn(handler => {
          publishHandler = handler;
        }),
      })
    );

    render(
      <ArticleEditor
        initial={draftArticle({
          title: "How to KB",
          content_mdx: "<p>Body</p>",
          availableLocales: ["en"],
          localizations: [
            {
              locale: "en",
              status: "draft",
              published_at: null,
              updated_at: null,
              hasDraft: true,
              isDefault: true,
            },
          ],
        })}
      />
    );

    expect(screen.getByTestId("current-locale-status")).toHaveTextContent(
      "draft:true"
    );

    await waitFor(() => expect(publishHandler).toBeTruthy());
    await act(async () => {
      await publishHandler?.();
    });

    expect(screen.getByTestId("current-locale-status")).toHaveTextContent(
      "published:false"
    );
  });
});
