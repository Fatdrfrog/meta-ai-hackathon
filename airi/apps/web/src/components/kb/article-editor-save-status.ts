import type { KBArticleEditorSaveStatus } from "@/lib/kb/kb-editor-state";

type SaveStatusTranslator = ((key: string) => string) & {
  has?: (key: string) => boolean;
};

const SAVE_STATUS_TRANSLATION_KEYS: Record<KBArticleEditorSaveStatus, string> =
  {
    saving: "saveStatus.saving",
    saved: "saveStatus.saved",
    error: "saveStatus.error",
    unsaved: "saveStatus.unsaved",
  };

const SAVE_STATUS_FALLBACKS: Record<KBArticleEditorSaveStatus, string> = {
  saving: "Saving...",
  saved: "Saved",
  error: "Save failed",
  unsaved: "Unsaved changes",
};

export function getKBEditorSaveStatusText(
  status: KBArticleEditorSaveStatus,
  t: SaveStatusTranslator
): string {
  const key = SAVE_STATUS_TRANSLATION_KEYS[status];

  try {
    if (typeof t.has === "function" && !t.has(key)) {
      return SAVE_STATUS_FALLBACKS[status];
    }

    return t(key);
  } catch {
    return SAVE_STATUS_FALLBACKS[status];
  }
}
