import {
  scenarioEditorChunks,
  type ScenarioEditorChunkName,
} from "../scenario-editor-chunks";
import type { ScenarioActionSelectorType, ScenarioNodeData } from "../types";
import { resolveActionSelectorTypeForNode } from "./action/selector-utils";

/*
 * Which lazily loaded editors the canvas cards need. Kept apart from the
 * chunk list, which the Airi builder imports too, so these node helpers stay
 * out of that page's first load.
 */

/**
 * The longest the canvas, or a step added from the menu, waits for its
 * editors. After that, or after a failed download, the editor's placeholder
 * shows and the editor follows when it arrives.
 */
export const SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS = 3000;

/** The editor section an action's canvas card shows, by its kind. */
const CANVAS_SECTION_CHUNK_BY_SELECTOR: Partial<
  Record<ScenarioActionSelectorType, ScenarioEditorChunkName>
> = {
  whatsapp_service_message: "whatsAppServiceMessageSection",
  whatsapp_template: "whatsAppTemplateSection",
  generative_ai: "generativeAISection",
  telegram_builder: "telegramReplyBuilder",
};

/** Every editor a new action's canvas card can show. */
const CANVAS_ACTION_CHUNKS: readonly ScenarioEditorChunkName[] = [
  "whatsAppInlineEditor",
  ...Object.values(CANVAS_SECTION_CHUNK_BY_SELECTOR),
];

function canvasChunksForNode(
  data: ScenarioNodeData
): ScenarioEditorChunkName[] {
  if (data.kind === "bulk") return ["bulkRootNode"];
  if (data.kind !== "action") return [];
  const section =
    CANVAS_SECTION_CHUNK_BY_SELECTOR[resolveActionSelectorTypeForNode(data)];
  return section ? ["whatsAppInlineEditor", section] : ["whatsAppInlineEditor"];
}

function notLoaded(
  names: readonly ScenarioEditorChunkName[]
): ScenarioEditorChunkName[] {
  return [...new Set(names)].filter(
    name => !scenarioEditorChunks[name].loaded()
  );
}

/** Editors these steps' canvas cards show that have not downloaded yet. */
export function coldScenarioCanvasChunks(
  nodes: readonly { data: ScenarioNodeData }[]
): ScenarioEditorChunkName[] {
  return notLoaded(nodes.flatMap(node => canvasChunksForNode(node.data)));
}

/**
 * Editors a step added from the menu may show that have not downloaded yet.
 * A new action's kind depends on the step it connects from, so it counts on
 * every action editor.
 */
export function coldScenarioPaletteItemChunks(
  kind: ScenarioNodeData["kind"]
): ScenarioEditorChunkName[] {
  if (kind === "bulk") return notLoaded(["bulkRootNode"]);
  return kind === "action" ? notLoaded(CANVAS_ACTION_CHUNKS) : [];
}

/** The add-step menu opened: start every editor a new action can show. */
export function preloadScenarioCanvasActionChunks() {
  for (const name of CANVAS_ACTION_CHUNKS) {
    scenarioEditorChunks[name].preload();
  }
}

/**
 * Resolves once these editors have downloaded, failed, or taken longer than
 * SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS. It never rejects.
 */
export function waitForScenarioEditorChunks(
  names: readonly ScenarioEditorChunkName[]
): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS);
    void Promise.allSettled(
      names.map(name => scenarioEditorChunks[name].load())
    ).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
