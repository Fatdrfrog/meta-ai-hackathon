"use client";

import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { lazyScenarioChunkComponent } from "../../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../../scenario-lazy-chunk-boundary";
import type { WhatsAppInlineEditorProps } from "./inline-editor";
import { WhatsAppInlineEditorFallback } from "./inline-editor-fallback";

const WhatsAppInlineEditorChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.whatsAppInlineEditor,
  module => module.WhatsAppInlineEditor
);

/**
 * The TipTap message editor, downloaded on demand. Import the editor only
 * through this wrapper: a static import would put TipTap back in the
 * Scenarios page's first load.
 */
export function LazyWhatsAppInlineEditor(props: WhatsAppInlineEditorProps) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.whatsAppInlineEditor}
      fallback={<WhatsAppInlineEditorFallback {...props} />}
    >
      <WhatsAppInlineEditorChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}
