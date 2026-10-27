import type { ComponentProps } from "react";
import type { useKBEntityEditor } from "@/hooks/use-kb-entity-editor";
import type { ArticleEditor } from "./article-editor";
import type { useKBArticleEditor } from "./kb-article-editor-context";

// Shared doubles for the ArticleEditor suites. Each suite still declares its
// own jest.mock calls (they must be hoisted in the test file itself).

export function createJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as Response;
}

type InitialArticle = NonNullable<
  ComponentProps<typeof ArticleEditor>["initial"]
>;

/** The article an editor opens with: an English draft unless overridden. */
export function draftArticle(
  overrides: Partial<InitialArticle> = {}
): InitialArticle {
  return {
    id: "article-1",
    title: "Initial title",
    content_mdx: "<p>Initial content</p>",
    status: "draft",
    locale: "en",
    defaultLocale: "en",
    ...overrides,
  };
}

type ArticleEditorContextValue = ReturnType<typeof useKBArticleEditor>;

/** useKBArticleEditor's value with inert jest.fn handlers. */
export function articleEditorContextValue(
  overrides: Partial<ArticleEditorContextValue> = {}
): ArticleEditorContextValue {
  return {
    setSaveStatus: jest.fn(),
    setActiveId: jest.fn(),
    setActiveTitle: jest.fn(),
    performSafeAction: jest.fn(async action => action()),
    registerPublishHandler: jest.fn(),
    setIsPublishing: jest.fn(),
    mountTime: 0,
    ...overrides,
  };
}

/**
 * useKBEntityEditor's value with no TipTap editor and inert handlers; the
 * suite passes titleRef, getContent and whatever handlers it drives.
 */
export function entityEditorValue({
  initialTitle = "Initial title",
  initialContent = "<p>Initial content</p>",
  ...overrides
}: Record<string, unknown> & {
  initialTitle?: string;
  initialContent?: string;
}) {
  return {
    editor: null,
    editorRef: { current: null },
    isUploadingImage: false,
    setIsUploadingImage: jest.fn(),
    titleTextareaRef: { current: null },
    initialValuesRef: {
      current: { title: initialTitle, content: initialContent },
    },
    performSafeAction: jest.fn(async (action: () => unknown) => action()),
    registerPublishHandler: jest.fn(),
    linkDialogOpen: false,
    setLinkDialogOpen: jest.fn(),
    linkDialogUrl: "",
    linkDialogText: "",
    handleLinkEdit: jest.fn(),
    handleLinkSave: jest.fn(),
    registerAutoSaveHandler: jest.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useKBEntityEditor>;
}
