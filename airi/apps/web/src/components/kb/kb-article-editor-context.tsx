"use client";

import { useKBEditorSync } from "@/hooks/use-kb-editor-sync";
import {
  kbArticleActiveIdAtom,
  kbArticleActiveTitleAtom,
  kbArticleEditorIsPublishingAtom,
  kbArticleEditorPublishHandlerAtom,
  kbArticleEditorSaveStatusAtom,
} from "@/lib/kb/kb-editor-state";

export function useKBArticleEditor() {
  const sync = useKBEditorSync({
    isPublishingAtom: kbArticleEditorIsPublishingAtom,
    saveStatusAtom: kbArticleEditorSaveStatusAtom,
    publishHandlerAtom: kbArticleEditorPublishHandlerAtom,
    activeIdAtom: kbArticleActiveIdAtom,
    activeTitleAtom: kbArticleActiveTitleAtom,
  });

  return sync;
}
