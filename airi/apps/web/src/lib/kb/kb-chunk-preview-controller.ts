import type { Editor } from "@tiptap/react";

export const KB_CHUNK_PREVIEW_META = "kbChunkPreviewRedraw";

export type KbChunkPreviewController = {
  enabled: boolean;
  getArticleTitle: () => string;
};

export const kbChunkPreviewController: KbChunkPreviewController = {
  enabled: false,
  getArticleTitle: () => "Article",
};

export function dispatchKbChunkPreviewRedraw(editor: Editor | null): void {
  if (!editor) return;
  const tr = editor.state.tr.setMeta(KB_CHUNK_PREVIEW_META, true);
  editor.view.dispatch(tr);
}
