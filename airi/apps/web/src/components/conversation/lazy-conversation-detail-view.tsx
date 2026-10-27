"use client";

import { lazyScenarioChunkComponent } from "@/components/scenarios/scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "@/components/scenarios/scenario-lazy-chunk-boundary";
import type { ConversationDetailViewProps } from "./conversation-detail-view";
import {
  getLoadedConversationDetailModule,
  loadConversationDetailModule,
  preloadConversationDetailView,
} from "./conversation-detail-loader";
import { ConversationSelectionPreview } from "./conversation-selection-preview";

// Adapt the existing shared preload cache to the same retry behavior used by
// Scenarios and Airi. A rejected React.lazy import otherwise stays rejected
// even though the module loader has cleared its failed request.
const conversationDetailChunk = {
  load: loadConversationDetailModule,
  loaded: getLoadedConversationDetailModule,
  preload: () => {
    void preloadConversationDetailView().catch(() => undefined);
  },
};

const ConversationDetailView = lazyScenarioChunkComponent(
  conversationDetailChunk,
  detailModule => detailModule.ConversationDetailView
);

export function LazyConversationDetailView(props: ConversationDetailViewProps) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={conversationDetailChunk}
      fallback={
        <ConversationSelectionPreview
          request={props.requestPreview}
          onBack={props.onBack}
        />
      }
    >
      <ConversationDetailView {...props} />
    </ScenarioLazyChunkBoundary>
  );
}
