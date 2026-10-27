import { createScenarioLazyChunk } from "@/components/scenarios/scenario-lazy-chunk";

/**
 * Airi modules downloaded on demand. The drawer loads the chat workspace
 * only when it opens, and the workspace loads the WhatsApp builder (Flow
 * builder included) only when a builder artifact is shown. A failed download
 * is forgotten, so the next open or render tries again.
 */
export const airiChatChunks = {
  workspace: createScenarioLazyChunk(() => import("./airi-chat-workspace")),
  builderSidePanel: createScenarioLazyChunk(
    () => import("./airi-builder-side-panel")
  ),
};
