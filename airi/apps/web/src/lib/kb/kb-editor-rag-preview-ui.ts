export const KB_RAG_CHUNK_TIGHT_HEADING_CSS = `
  .kb-editor .kb-rag-chunk-badge + h1,
  .kb-editor .kb-rag-chunk-badge + h2,
  .kb-editor .kb-rag-chunk-badge + h3 {
    margin-top: 0.35rem;
  }
`;

export function getKBEditorRagPreviewClassNames() {
  return {
    container:
      "flex flex-col gap-1 border-t border-border/50 bg-muted/15 px-4 py-2",
    row: "flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3",
    toggleGroup: "flex min-w-0 items-center gap-1.5",
    checkbox: "size-3.5",
    label:
      "cursor-pointer text-xs font-medium leading-snug peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    hint: "m-0 max-w-2xl text-xs leading-snug text-muted-foreground",
  } as const;
}
