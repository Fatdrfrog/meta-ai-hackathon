import { createDefaultScenarioWhatsAppServiceMessage } from "@icecore/scenario-contracts";
import {
  scenarioEditorChunks,
  type ScenarioEditorChunkName,
} from "../scenario-editor-chunks";
import type { ScenarioNodeData } from "../types";
import {
  coldScenarioCanvasChunks,
  coldScenarioPaletteItemChunks,
  preloadScenarioCanvasActionChunks,
  SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS,
  waitForScenarioEditorChunks,
} from "./scenario-canvas-editor-chunks";

type ChunkName = ScenarioEditorChunkName;

describe("scenario canvas editor warm-up", () => {
  let preloaded: ChunkName[];

  beforeEach(() => {
    preloaded = [];
    for (const name of Object.keys(scenarioEditorChunks) as ChunkName[]) {
      jest
        .spyOn(scenarioEditorChunks[name], "preload")
        .mockImplementation(() => {
          preloaded.push(name);
        });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts every action editor when the add-step menu opens", () => {
    preloadScenarioCanvasActionChunks();
    expect(preloaded).toEqual([
      "whatsAppInlineEditor",
      "whatsAppServiceMessageSection",
      "whatsAppTemplateSection",
      "generativeAISection",
      "telegramReplyBuilder",
    ]);
  });
});

describe("scenario canvas editor needs", () => {
  let loadedChunks: Set<ChunkName>;

  beforeEach(() => {
    loadedChunks = new Set();
    for (const name of Object.keys(scenarioEditorChunks) as ChunkName[]) {
      jest
        .spyOn(scenarioEditorChunks[name], "loaded")
        .mockImplementation(
          () => (loadedChunks.has(name) ? {} : null) as never
        );
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const node = (data: Partial<ScenarioNodeData>) => ({
    data: { kind: "action", ...data } as ScenarioNodeData,
  });

  it.each([
    ["a trigger", node({ kind: "trigger" }), []],
    ["a bulk campaign", node({ kind: "bulk" }), ["bulkRootNode"]],
    ["a reply", node({ actionType: "reply" }), ["whatsAppInlineEditor"]],
    [
      "a service message",
      node({
        actionType: "reply",
        actionWhatsAppServiceMessage:
          createDefaultScenarioWhatsAppServiceMessage("text"),
      }),
      ["whatsAppInlineEditor", "whatsAppServiceMessageSection"],
    ],
    [
      "a WhatsApp template",
      node({ actionType: "whatsapp_template" }),
      ["whatsAppInlineEditor", "whatsAppTemplateSection"],
    ],
    [
      "a generative AI step",
      node({ actionType: "generative_ai" }),
      ["whatsAppInlineEditor", "generativeAISection"],
    ],
    [
      "a Telegram reply",
      node({ actionType: "reply", actionReplyChannel: "telegram" }),
      ["whatsAppInlineEditor", "telegramReplyBuilder"],
    ],
  ])("knows the editors %s card shows", (_label, step, expected) => {
    expect(coldScenarioCanvasChunks([step])).toEqual(expected);
  });

  it("lists each missing editor once and skips downloaded ones", () => {
    loadedChunks.add("whatsAppInlineEditor");
    const steps = [
      node({ actionType: "whatsapp_template" }),
      node({ actionType: "whatsapp_template" }),
      node({ kind: "bulk" }),
    ];
    expect(coldScenarioCanvasChunks(steps)).toEqual([
      "whatsAppTemplateSection",
      "bulkRootNode",
    ]);
  });

  it("counts on every action editor for a step added from the menu", () => {
    loadedChunks.add("whatsAppServiceMessageSection");
    expect(coldScenarioPaletteItemChunks("action")).toEqual([
      "whatsAppInlineEditor",
      "whatsAppTemplateSection",
      "generativeAISection",
      "telegramReplyBuilder",
    ]);
    expect(coldScenarioPaletteItemChunks("bulk")).toEqual(["bulkRootNode"]);
    expect(coldScenarioPaletteItemChunks("trigger")).toEqual([]);
  });

  it("waits for editors at most the capped time, and never rejects", async () => {
    jest.useFakeTimers();
    jest
      .spyOn(scenarioEditorChunks.whatsAppTemplateSection, "load")
      .mockReturnValue(new Promise(() => undefined));
    jest
      .spyOn(scenarioEditorChunks.generativeAISection, "load")
      .mockRejectedValue(new Error("Loading chunk failed"));
    const done = jest.fn();

    void waitForScenarioEditorChunks([
      "whatsAppTemplateSection",
      "generativeAISection",
    ]).then(done);
    await Promise.resolve();
    jest.advanceTimersByTime(SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS - 1);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);

    // A failed download resolves at once.
    const failed = jest.fn();
    void waitForScenarioEditorChunks(["generativeAISection"]).then(failed);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
