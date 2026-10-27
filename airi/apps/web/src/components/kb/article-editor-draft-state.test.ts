import {
  buildKBDraftUpdatePayload,
  createKBDraftSnapshot,
  isKBDraftSnapshotCurrent,
  normalizeEditorHtml,
} from "./article-editor-draft-state";

describe("article editor draft state helpers", () => {
  it.each(["", "   ", "<p></p>", "<p><br></p>"])(
    "normalizes empty editor html %p to an empty string",
    value => {
      expect(normalizeEditorHtml(value)).toBe("");
    }
  );

  it("builds a draft snapshot from title and html", () => {
    expect(createKBDraftSnapshot("Pricing", " <p>Body</p> ")).toEqual({
      title: "Pricing",
      content: " <p>Body</p> ",
      normalizedContent: "<p>Body</p>",
    });
  });

  it("returns only changed save fields", () => {
    expect(
      buildKBDraftUpdatePayload({
        previousTitle: "Old title",
        previousNormalizedContent: "<p>Same</p>",
        snapshot: createKBDraftSnapshot("New title", "<p>Same</p>"),
      })
    ).toEqual({
      hasChanges: true,
      hasTitleChanged: true,
      hasContentChanged: false,
      payload: { title: "New title" },
    });

    expect(
      buildKBDraftUpdatePayload({
        previousTitle: "New title",
        previousNormalizedContent: "<p>Same</p>",
        snapshot: createKBDraftSnapshot("New title", "<p>Changed</p>"),
      })
    ).toEqual({
      hasChanges: true,
      hasTitleChanged: false,
      hasContentChanged: true,
      payload: { content_mdx: "<p>Changed</p>" },
    });
  });

  it("compares snapshots by title and normalized content", () => {
    const saved = createKBDraftSnapshot("Title", "<p>Saved</p>");
    const same = createKBDraftSnapshot("Title", " <p>Saved</p> ");
    const changed = createKBDraftSnapshot("Title", "<p>Changed</p>");

    expect(isKBDraftSnapshotCurrent(saved, same)).toBe(true);
    expect(isKBDraftSnapshotCurrent(saved, changed)).toBe(false);
  });
});
