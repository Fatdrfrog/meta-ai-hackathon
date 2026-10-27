/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react";
import type { ScenarioNodeData } from "../types";

jest.mock("../builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: () => null,
}));

const mockTemplateSectionLoaded = jest.fn();
jest.mock("../nodes/action-node/action-node-whatsapp-template-section", () => {
  mockTemplateSectionLoaded();
  return { ActionNodeWhatsAppTemplateSection: () => null };
});

import { scenarioEditorChunks } from "../scenario-editor-chunks";
import { SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS } from "./scenario-canvas-editor-chunks";
import { ScenarioCanvasEditorsGate } from "./scenario-canvas-editors-gate";

type TestStep = { data: Partial<ScenarioNodeData> };

const replyStep: TestStep = { data: { kind: "action", actionType: "reply" } };
const templateStep: TestStep = {
  data: { kind: "action", actionType: "whatsapp_template" },
};

function Gate({
  loading = false,
  scenarioKey = "scenario-1",
  nodes,
}: {
  loading?: boolean;
  scenarioKey?: string;
  nodes: TestStep[];
}) {
  return (
    <ScenarioCanvasEditorsGate
      loading={loading}
      scenarioKey={scenarioKey}
      nodes={nodes as { data: ScenarioNodeData }[]}
      fallback={<p>Loading graph</p>}
    >
      <p>Canvas</p>
    </ScenarioCanvasEditorsGate>
  );
}

describe("ScenarioCanvasEditorsGate", () => {
  beforeAll(async () => {
    // The message editor is warmed with the page; the template section is not.
    await scenarioEditorChunks.whatsAppInlineEditor.load();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("shows the canvas at once when its editors have downloaded", () => {
    render(<Gate nodes={[replyStep, { data: { kind: "trigger" } }]} />);
    expect(screen.getByText("Canvas")).toBeTruthy();
  });

  it("keeps the loading state while the scenario itself loads", () => {
    render(<Gate loading nodes={[]} />);
    expect(screen.getByText("Loading graph")).toBeTruthy();
  });

  it("waits for a step's editor before the first show, then never hides the canvas again", async () => {
    const view = render(<Gate nodes={[replyStep, templateStep]} />);
    // React Flow must not measure the template step's placeholder.
    expect(screen.getByText("Loading graph")).toBeTruthy();
    expect(screen.queryByText("Canvas")).toBeNull();

    expect(await screen.findByText("Canvas")).toBeTruthy();
    expect(mockTemplateSectionLoaded).toHaveBeenCalledTimes(1);

    // A step added later shows its own placeholder instead.
    jest
      .spyOn(scenarioEditorChunks.bulkRootNode, "load")
      .mockReturnValue(new Promise(() => undefined));
    view.rerender(
      <Gate nodes={[replyStep, templateStep, { data: { kind: "bulk" } }]} />
    );
    expect(screen.getByText("Canvas")).toBeTruthy();
  });

  it("shows the canvas after the capped wait when a download stalls", async () => {
    jest.useFakeTimers();
    jest
      .spyOn(scenarioEditorChunks.generativeAISection, "load")
      .mockReturnValue(new Promise(() => undefined));
    render(
      <Gate
        scenarioKey="scenario-2"
        nodes={[{ data: { kind: "action", actionType: "generative_ai" } }]}
      />
    );
    expect(screen.getByText("Loading graph")).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS);
    });
    expect(screen.getByText("Canvas")).toBeTruthy();
  });

  it("waits again for the next scenario's editors", async () => {
    jest
      .spyOn(scenarioEditorChunks.telegramReplyBuilder, "load")
      .mockReturnValue(new Promise(() => undefined));
    const view = render(<Gate scenarioKey="scenario-3" nodes={[replyStep]} />);
    expect(screen.getByText("Canvas")).toBeTruthy();

    view.rerender(<Gate loading scenarioKey="scenario-4" nodes={[]} />);
    view.rerender(
      <Gate
        scenarioKey="scenario-4"
        nodes={[
          {
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyChannel: "telegram",
            },
          },
        ]}
      />
    );
    expect(screen.getByText("Loading graph")).toBeTruthy();
  });
});
