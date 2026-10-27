import { atom } from "jotai";

export type KBArticleEditorSaveStatus =
  | "saved"
  | "saving"
  | "error"
  | "unsaved";

export type KBArticlePublishMode =
  | "public_with_auto_link"
  | "public_without_auto_link"
  | "ai_context_only";

export const kbArticleEditorPublishHandlerAtom = atom<
  (() => Promise<void>) | null
>(null);
export const kbArticleEditorIsPublishingAtom = atom<boolean>(false);
export const kbArticleEditorSaveStatusAtom =
  atom<KBArticleEditorSaveStatus>("saved");
export const kbArticleEditorStatusAtom = atom<string | null>(null);
export const kbArticlePublishModeAtom = atom<KBArticlePublishMode>(
  "public_with_auto_link"
);

export const kbArticleActiveIdAtom = atom<string | null>(null);
export const kbArticleActiveTitleAtom = atom<string>("");
export const kbArticleTitleOverridesAtom = atom<Record<string, string>>({});
export const kbArticleRoutePendingAtom = atom<boolean>(false);
export const kbArticleRouteTargetIdAtom = atom<string | null>(null);
export const kbArticleSaveDraftBeforeNavigateAtom = atom<
  (() => Promise<boolean>) | null
>(null);

/** Callback to refresh KB tree (e.g. after publish). Set by KBAdminSidebar. */
export const kbTreeRefreshCallbackAtom = atom<
  (() => void | Promise<void>) | null
>(null);
