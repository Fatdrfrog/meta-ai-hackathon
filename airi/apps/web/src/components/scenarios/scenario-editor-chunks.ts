import type {
  ScenarioActionType,
  ScenarioMode,
} from "@icecore/scenario-contracts";
import { createScenarioLazyChunk } from "./scenario-lazy-chunk";

/**
 * Editors and panels the Scenarios page loads on demand. Every lazy import of
 * these modules goes through this list, so a warm-up downloads the same chunk
 * a render would.
 */
export const scenarioEditorChunks = {
  whatsAppInlineEditor: createScenarioLazyChunk(
    () => import("./builders/whatsapp/inline-editor")
  ),
  whatsAppServiceMessageSection: createScenarioLazyChunk(
    () =>
      import("./nodes/action-node/action-node-whatsapp-service-message-section")
  ),
  whatsAppTemplateSection: createScenarioLazyChunk(
    () => import("./nodes/action-node/action-node-whatsapp-template-section")
  ),
  generativeAISection: createScenarioLazyChunk(
    () => import("./nodes/action-node/action-node-generative-ai-section")
  ),
  telegramReplyBuilder: createScenarioLazyChunk(
    () => import("./builders/telegram")
  ),
  bulkRootNode: createScenarioLazyChunk(() => import("./nodes/bulk-root-node")),
  triggerNodeSettings: createScenarioLazyChunk(
    () => import("./nodes/trigger-node/trigger-node-settings")
  ),
  actionNodeSettings: createScenarioLazyChunk(
    () => import("./nodes/action-node/action-node-settings")
  ),
  nodePaletteMenu: createScenarioLazyChunk(
    () => import("./view/palette/scenario-node-palette-menu")
  ),
  triggerLogPanel: createScenarioLazyChunk(
    () => import("./view/scenario-trigger-log-panel")
  ),
  createTypeDialog: createScenarioLazyChunk(
    () => import("./view/scenario-create-type-dialog")
  ),
  previewDrawer: createScenarioLazyChunk(() => import("./view/preview/drawer")),
  activationImpactDialog: createScenarioLazyChunk(
    () => import("./view/scenario-activation-impact-dialog")
  ),
  linkedFlowPreviewDialog: createScenarioLazyChunk(
    () => import("./view/whatsapp-linked-flow-preview-dialog")
  ),
};

/**
 * Needed by most scenario opens: the message editor, and the WhatsApp
 * service message editor that about a third of scenarios use. Start them
 * with the page, alongside the scenario request.
 */
export function preloadScenarioOpenChunks() {
  scenarioEditorChunks.whatsAppInlineEditor.preload();
  scenarioEditorChunks.whatsAppServiceMessageSection.preload();
}

/** Editors the scenario about to open needs, known from its list entry. */
export function preloadScenarioSummaryChunks({
  mode,
  primaryActionType,
}: {
  mode?: ScenarioMode | null;
  primaryActionType?: ScenarioActionType | null;
}) {
  if (mode === "bulk_campaign") scenarioEditorChunks.bulkRootNode.preload();
  if (primaryActionType === "whatsapp_template") {
    scenarioEditorChunks.whatsAppTemplateSection.preload();
  }
  if (primaryActionType === "generative_ai") {
    scenarioEditorChunks.generativeAISection.preload();
  }
}

/**
 * Everything else, fetched while the browser is idle once the canvas shows,
 * so a later click or another scenario rarely waits for a download (or
 * meets a connection that has dropped since).
 */
export function preloadScenarioIdleChunks({
  nodeSettingsPanel,
}: {
  nodeSettingsPanel: boolean;
}) {
  if (nodeSettingsPanel) scenarioEditorChunks.actionNodeSettings.preload();
  scenarioEditorChunks.createTypeDialog.preload();
  scenarioEditorChunks.nodePaletteMenu.preload();
  scenarioEditorChunks.triggerNodeSettings.preload();
  scenarioEditorChunks.whatsAppTemplateSection.preload();
  scenarioEditorChunks.generativeAISection.preload();
  scenarioEditorChunks.telegramReplyBuilder.preload();
  scenarioEditorChunks.bulkRootNode.preload();
  scenarioEditorChunks.previewDrawer.preload();
  scenarioEditorChunks.activationImpactDialog.preload();
  scenarioEditorChunks.linkedFlowPreviewDialog.preload();
  scenarioEditorChunks.triggerLogPanel.preload();
}

export type ScenarioEditorChunkName = keyof typeof scenarioEditorChunks;
