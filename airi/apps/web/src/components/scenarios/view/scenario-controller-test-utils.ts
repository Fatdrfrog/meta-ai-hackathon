import { DEFAULT_SCENARIO_VIEWPORT } from "@/components/scenarios/types";
import type { ScenarioDocument } from "../types";

// Fixtures for the useScenarioFlowController hook suites.

export const SCENARIO_REVISION = "2026-01-01T00:00:00.000Z";

/**
 * A draft conversation scenario named after its id, with a trigger and a
 * template step unless `overrides.nodes` replaces them.
 */
export function scenarioDocument(
  id: string,
  overrides: Partial<ScenarioDocument> = {}
): ScenarioDocument {
  return {
    _id: id,
    name: id,
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "repeatable",
    linkedParentScenarioIds: [],
    createdAt: SCENARIO_REVISION,
    updatedAt: SCENARIO_REVISION,
    nodes: [
      {
        id: "trigger-1",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", triggerConfig: { enabled: true } },
      },
      {
        id: "template-1",
        position: { x: 200, y: 0 },
        data: { kind: "action", actionType: "whatsapp_template" },
      },
    ],
    edges: [],
    viewport: DEFAULT_SCENARIO_VIEWPORT,
    ...overrides,
  } as unknown as ScenarioDocument;
}

/**
 * The scenarioEditorChunks module with inert lazy chunks. Use it inside the
 * suite's jest.mock("../scenario-editor-chunks", ...) factory.
 */
export function scenarioEditorChunksMock(load: () => jest.Mock = jest.fn) {
  const chunk = () => ({
    load: load(),
    loaded: () => null,
    preload: jest.fn(),
  });
  return {
    scenarioEditorChunks: {
      whatsAppInlineEditor: chunk(),
      whatsAppServiceMessageSection: chunk(),
      whatsAppTemplateSection: chunk(),
      generativeAISection: chunk(),
      telegramReplyBuilder: chunk(),
      bulkRootNode: chunk(),
    },
  };
}
