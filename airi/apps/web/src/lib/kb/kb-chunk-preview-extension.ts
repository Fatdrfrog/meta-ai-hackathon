import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  KB_CHUNK_PREVIEW_META,
  kbChunkPreviewController,
} from "@/lib/kb/kb-chunk-preview-controller";

const kbChunkPreviewPluginKey = new PluginKey("kbChunkPreview");

function collectHeadingBlocks(
  doc: ProseMirrorNode
): { pos: number; text: string }[] {
  const headings: { pos: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return;
    }
    const level = Number(node.attrs.level);
    if (!Number.isFinite(level) || level < 1 || level > 3) {
      return;
    }
    const text = node.textContent.trim().slice(0, 120);
    headings.push({ pos, text });
  });
  return headings;
}

function makeBadge(
  chunkIndex: number,
  titleText: string,
  hint?: string
): HTMLElement {
  const el = document.createElement("div");
  el.className = "kb-rag-chunk-badge";
  el.setAttribute("contenteditable", "false");

  const idx = document.createElement("span");
  idx.className = "kb-rag-chunk-badge__idx";
  idx.textContent = `RAG ${chunkIndex}`;

  const title = document.createElement("span");
  title.className = "kb-rag-chunk-badge__title";
  title.textContent = titleText;

  el.appendChild(idx);
  el.appendChild(title);

  if (hint) {
    const h = document.createElement("span");
    h.className = "kb-rag-chunk-badge__hint";
    h.textContent = hint;
    el.appendChild(h);
  }

  return el;
}

function buildDecorationSet(doc: ProseMirrorNode): DecorationSet {
  if (!kbChunkPreviewController.enabled) {
    return DecorationSet.empty;
  }

  const articleTitle =
    kbChunkPreviewController.getArticleTitle().trim() || "Article";
  const headings = collectHeadingBlocks(doc);
  const widgets: Decoration[] = [];

  if (headings.length === 0) {
    widgets.push(
      Decoration.widget(0, makeBadge(0, articleTitle, " · single chunk"), {
        side: -1,
        block: true,
        key: "kb-chunk-0",
      })
    );
    return DecorationSet.create(doc, widgets);
  }

  let chunkIndex = 0;
  if (headings[0].pos > 0) {
    widgets.push(
      Decoration.widget(0, makeBadge(chunkIndex, articleTitle, " · intro"), {
        side: -1,
        block: true,
        key: `kb-chunk-${chunkIndex}-0`,
      })
    );
    chunkIndex += 1;
  }

  for (const h of headings) {
    const label = h.text || `Heading ${chunkIndex}`;
    widgets.push(
      Decoration.widget(h.pos, makeBadge(chunkIndex, label), {
        side: -1,
        block: true,
        key: `kb-chunk-${chunkIndex}-${h.pos}`,
      })
    );
    chunkIndex += 1;
  }

  return DecorationSet.create(doc, widgets);
}

export const KbChunkPreview = Extension.create({
  name: "kbChunkPreview",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: kbChunkPreviewPluginKey,
        state: {
          init: (_, state) => buildDecorationSet(state.doc),
          apply(tr, value, _oldState, newState) {
            if (!kbChunkPreviewController.enabled) {
              return DecorationSet.empty;
            }
            if (!tr.docChanged && !tr.getMeta(KB_CHUNK_PREVIEW_META)) {
              return value.map(tr.mapping, tr.doc);
            }
            return buildDecorationSet(newState.doc);
          },
        },
        props: {
          decorations(state) {
            return kbChunkPreviewPluginKey.getState(state) ?? null;
          },
        },
      }),
    ];
  },
});
