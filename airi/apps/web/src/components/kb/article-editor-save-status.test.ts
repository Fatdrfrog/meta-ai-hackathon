import { getKBEditorSaveStatusText } from "./article-editor-save-status";

describe("getKBEditorSaveStatusText", () => {
  it("falls back when an optional save status translation is missing", () => {
    const t = Object.assign(
      (key: string) => {
        throw new Error(`Missing translation: ${key}`);
      },
      {
        has: () => false,
      }
    );

    expect(getKBEditorSaveStatusText("unsaved", t)).toBe("Unsaved changes");
  });

  it("uses translations when they are present", () => {
    const messages: Record<string, string> = {
      "saveStatus.saved": "Saved locally",
      "saveStatus.saving": "Saving now",
    };
    const t = Object.assign((key: string) => messages[key] ?? key, {
      has: (key: string) => key in messages,
    });

    expect(getKBEditorSaveStatusText("saving", t)).toBe("Saving now");
    expect(getKBEditorSaveStatusText("saved", t)).toBe("Saved locally");
  });
});
