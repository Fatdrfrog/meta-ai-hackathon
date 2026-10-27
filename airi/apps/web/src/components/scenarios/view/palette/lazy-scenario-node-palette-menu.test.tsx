/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import type { ComponentProps } from "react";

const mockMenuModuleLoaded = jest.fn();

jest.mock("./scenario-node-palette-menu", () => {
  mockMenuModuleLoaded();
  return jest.requireActual("./scenario-node-palette-menu");
});

import {
  scenarioEditorChunks,
  type ScenarioEditorChunkName,
} from "../../scenario-editor-chunks";
import { LazyScenarioNodePaletteMenu } from "./lazy-scenario-node-palette-menu";

type MenuProps = ComponentProps<typeof LazyScenarioNodePaletteMenu>;

const ACTION_EDITOR_CHUNKS: ScenarioEditorChunkName[] = [
  "whatsAppInlineEditor",
  "whatsAppServiceMessageSection",
  "whatsAppTemplateSection",
  "generativeAISection",
  "telegramReplyBuilder",
];

function menuProps(
  contextMenu: MenuProps["contextMenu"],
  overrides: Partial<MenuProps> = {}
): MenuProps {
  return {
    contextMenu,
    title: "addBlock",
    searchPlaceholder: "addBlockSearchPlaceholder",
    emptyLabel: "addBlockSearchNoResults",
    sections: [],
    onAddNodeFromPaletteItem: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
}

const templateItem = {
  id: "action-whatsapp-template",
  kind: "action" as const,
  title: "WhatsApp template",
};
const triggerItem = {
  id: "trigger-incoming-message",
  kind: "trigger" as const,
  title: "Incoming message",
};
const sections: MenuProps["sections"] = [
  {
    id: "action",
    title: "Actions",
    icon: MessageSquare,
    items: [templateItem, triggerItem],
  },
];

describe("LazyScenarioNodePaletteMenu", () => {
  let preloaded: ScenarioEditorChunkName[];

  beforeEach(() => {
    preloaded = [];
    // Record warm-ups instead of downloading every editor.
    for (const name of ACTION_EDITOR_CHUNKS) {
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

  it("downloads the menu on its first open and returns focus when it closes", async () => {
    const canvasButton = document.createElement("button");
    document.body.appendChild(canvasButton);
    canvasButton.focus();

    const view = render(<LazyScenarioNodePaletteMenu {...menuProps(null)} />);
    expect(mockMenuModuleLoaded).not.toHaveBeenCalled();

    view.rerender(
      <LazyScenarioNodePaletteMenu {...menuProps({ left: 40, top: 40 })} />
    );
    // The first import of the real menu module can take over a second on a
    // busy machine.
    expect(
      await screen.findByRole("menu", { name: "addBlock" }, { timeout: 5000 })
    ).toBeVisible();
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    expect(mockMenuModuleLoaded).toHaveBeenCalledTimes(1);

    // The menu stays mounted after its first open, so closing it still
    // hands focus back to where the user was.
    view.rerender(<LazyScenarioNodePaletteMenu {...menuProps(null)} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(canvasButton).toHaveFocus();
    canvasButton.remove();
  });

  it("starts every action editor when it opens", () => {
    const view = render(<LazyScenarioNodePaletteMenu {...menuProps(null)} />);
    expect(preloaded).toEqual([]);

    view.rerender(
      <LazyScenarioNodePaletteMenu {...menuProps({ left: 40, top: 40 })} />
    );
    expect(preloaded).toEqual(ACTION_EDITOR_CHUNKS);
  });

  it("adds an action only once the editors its card shows have downloaded", async () => {
    let finishDownload!: () => void;
    const download = new Promise<void>(resolve => {
      finishDownload = resolve;
    });
    jest
      .spyOn(scenarioEditorChunks.whatsAppTemplateSection, "loaded")
      .mockReturnValue(null);
    jest
      .spyOn(scenarioEditorChunks.whatsAppTemplateSection, "load")
      .mockReturnValue(download as never);
    for (const name of ACTION_EDITOR_CHUNKS.filter(
      name => name !== "whatsAppTemplateSection"
    )) {
      jest
        .spyOn(scenarioEditorChunks[name], "loaded")
        .mockReturnValue({} as never);
    }
    const onAddNodeFromPaletteItem = jest.fn();
    render(
      <LazyScenarioNodePaletteMenu
        {...menuProps(
          { left: 40, top: 40 },
          { sections, onAddNodeFromPaletteItem }
        )}
      />
    );

    // A step that shows no lazily loaded editor is added at once.
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Incoming message/ })
    );
    expect(onAddNodeFromPaletteItem).toHaveBeenCalledWith(triggerItem);

    onAddNodeFromPaletteItem.mockClear();
    const templateButton = screen.getByRole("menuitem", {
      name: /WhatsApp template/,
    });
    fireEvent.click(templateButton);
    // A second click while waiting does not add the step twice.
    fireEvent.click(templateButton);
    expect(onAddNodeFromPaletteItem).not.toHaveBeenCalled();

    await act(async () => {
      finishDownload();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(onAddNodeFromPaletteItem).toHaveBeenCalledTimes(1);
    expect(onAddNodeFromPaletteItem).toHaveBeenCalledWith(templateItem);
  });
});
