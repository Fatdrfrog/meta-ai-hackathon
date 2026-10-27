import {
  KB_RAG_CHUNK_TIGHT_HEADING_CSS,
  getKBEditorRagPreviewClassNames,
} from "./kb-editor-rag-preview-ui";

describe("kb editor rag preview ui", () => {
  test("keeps the RAG preview toggle row compact", () => {
    const classes = getKBEditorRagPreviewClassNames();

    expect(classes.container).toContain("gap-1");
    expect(classes.container).toContain("py-2");
    expect(classes.row).toContain("gap-1");
    expect(classes.toggleGroup).toContain("gap-1.5");
    expect(classes.toggleGroup).not.toContain("gap-2");
    expect(classes.checkbox).toContain("size-3.5");
    expect(classes.hint).toContain("leading-snug");
  });

  test("tightens preview badges against their headings", () => {
    expect(KB_RAG_CHUNK_TIGHT_HEADING_CSS).toContain(
      ".kb-rag-chunk-badge + h1"
    );
    expect(KB_RAG_CHUNK_TIGHT_HEADING_CSS).toContain(
      ".kb-rag-chunk-badge + h2"
    );
    expect(KB_RAG_CHUNK_TIGHT_HEADING_CSS).toContain(
      ".kb-rag-chunk-badge + h3"
    );
    expect(KB_RAG_CHUNK_TIGHT_HEADING_CSS).toContain("margin-top: 0.35rem");
  });
});
