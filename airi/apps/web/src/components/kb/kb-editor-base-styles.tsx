"use client";

import { KB_RAG_CHUNK_TIGHT_HEADING_CSS } from "@/lib/kb/kb-editor-rag-preview-ui";
import { KB_GRID_CSS } from "@/lib/kb/kb-grid-extension";
import { KB_IMAGE_STACKING_CSS } from "@/lib/kb/kb-image-dimensions";
import { KB_OBJECT_SELECTION_COLOR } from "@/lib/kb/kb-object-controls";

export function KBEditorBaseStyles() {
  return (
    <style jsx global>{`
      .kb-editor h1 {
        margin-top: 1.5rem;
        margin-bottom: 0.75rem;
        font-size: 2.25rem;
        line-height: 2.5rem;
        font-weight: 700;
      }

      .kb-editor h2 {
        margin-top: 1.5rem;
        margin-bottom: 0.75rem;
        font-size: 1.875rem;
        line-height: 2.25rem;
        font-weight: 600;
      }

      .kb-editor h3 {
        margin-top: 1.25rem;
        margin-bottom: 0.5rem;
        font-size: 1.5rem;
        line-height: 2rem;
        font-weight: 600;
      }

      .kb-editor p {
        margin-bottom: 0.75rem;
        line-height: 1.7;
      }

      .kb-editor ol,
      .kb-editor ul {
        margin: 1rem 0 1rem 1.5rem;
        padding-left: 0;
        line-height: 1.6;
      }

      .kb-editor ul {
        list-style-type: disc;
      }

      .kb-editor ol {
        list-style-type: decimal;
      }

      .kb-editor li {
        margin-bottom: 0.35rem;
      }

      .kb-editor blockquote {
        margin: 1rem 0;
        padding-left: 1rem;
        border-left: 4px solid hsl(var(--border));
        color: hsl(var(--muted-foreground));
        font-style: italic;
      }

      .kb-editor :not(pre) > code,
      .kb-editor .kb-editor-inline-code {
        border: 1px solid hsl(var(--border));
        border-radius: 0.375rem;
        background: hsl(var(--muted) / 0.75);
        padding: 0.1rem 0.35rem;
        font-family:
          var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco,
          Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.875em;
        font-weight: 500;
        color: hsl(var(--foreground));
        white-space: break-spaces;
      }

      .kb-editor :not(pre) > code::before,
      .kb-editor :not(pre) > code::after,
      .kb-editor .kb-editor-inline-code::before,
      .kb-editor .kb-editor-inline-code::after {
        content: none;
      }

      .kb-editor pre.kb-editor-code-block {
        box-shadow: inset 0 0 0 1px hsl(var(--border));
      }

      .kb-editor pre.kb-editor-code-block code {
        color: inherit;
      }

      ${KB_IMAGE_STACKING_CSS}

      ${KB_GRID_CSS}

      .kb-editor-dropcursor {
        border-radius: 9999px;
        background: hsl(var(--primary));
        box-shadow: 0 0 0 3px hsl(var(--primary) / 0.16);
      }

      .kb-editor div[data-youtube-video] {
        margin: 1.5rem 0;
        width: 100%;
        max-width: 100%;
        overflow: hidden;
        border-radius: 0.75rem;
      }

      .kb-editor iframe.kb-editor-youtube-iframe {
        display: block;
        width: 100%;
        max-width: 100%;
        aspect-ratio: 16 / 9;
        height: auto;
        border: 0;
        border-radius: inherit;
        background: hsl(var(--muted));
      }

      .kb-editor .tableWrapper {
        width: 100%;
        max-width: 100%;
        margin: 1.25rem 0;
        overflow-x: auto;
        padding-bottom: 0.25rem;
      }

      .kb-editor table {
        width: max-content;
        min-width: min(100%, 38rem);
        margin: 0;
        table-layout: fixed;
        border-collapse: collapse;
      }

      .kb-editor table th,
      .kb-editor table td {
        position: relative;
        min-width: 6rem;
        vertical-align: top;
        overflow-wrap: break-word;
      }

      .kb-editor table th {
        background: hsl(var(--muted) / 0.45);
        font-weight: 600;
      }

      .kb-editor table .selectedCell::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        background: hsl(var(--primary) / 0.12);
      }

      .kb-editor table.ProseMirror-selectednode {
        outline: 2px solid ${KB_OBJECT_SELECTION_COLOR};
        outline-offset: 3px;
      }

      .kb-editor .column-resize-handle {
        position: absolute;
        top: 0;
        right: -3px;
        bottom: -1px;
        z-index: 10;
        width: 6px;
        background: hsl(var(--primary));
        pointer-events: none;
      }

      .kb-editor.resize-cursor,
      .kb-editor.resize-cursor *,
      .resize-cursor,
      .resize-cursor * {
        cursor: col-resize !important;
      }

      .kb-editor-table-border-control {
        opacity: 0.92;
        border-color: hsl(var(--border));
        transition:
          opacity 120ms ease,
          transform 120ms ease,
          background-color 120ms ease;
      }

      .kb-editor-table-border-control:hover {
        opacity: 1;
        transform: scale(1.04);
      }

      /* TipTap placeholder style */
      .kb-editor p.is-editor-empty:first-child::before {
        color: hsl(var(--muted-foreground));
        content: attr(data-placeholder);
        float: left;
        height: 0;
        pointer-events: none;
      }

      /* Stable scrollbar gutter to prevent layout shift */
      .scrollbar-hide {
        -ms-overflow-style: none; /* IE and Edge */
        scrollbar-width: none; /* Firefox */
      }
      .scrollbar-hide::-webkit-scrollbar {
        display: none; /* Chrome, Safari and Opera */
      }

      /* RAG chunk boundary preview (editor-only; not saved to article HTML) */
      .kb-rag-chunk-badge {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.35rem 0.5rem;
        margin: 0.35rem 0 0.15rem;
        padding: 0.35rem 0.5rem;
        border-radius: 0.375rem;
        border-left: 3px solid hsl(var(--primary));
        background: hsl(var(--muted) / 0.45);
        font-size: 0.7rem;
        line-height: 1.3;
        font-weight: 500;
        color: hsl(var(--muted-foreground));
        user-select: none;
        pointer-events: none;
      }

      ${KB_RAG_CHUNK_TIGHT_HEADING_CSS}

      .kb-rag-chunk-badge__idx {
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        color: hsl(var(--primary));
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .kb-rag-chunk-badge__title {
        color: hsl(var(--foreground));
        font-weight: 600;
      }

      .kb-rag-chunk-badge__hint {
        font-weight: 400;
        opacity: 0.85;
      }
    `}</style>
  );
}
