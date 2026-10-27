/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useActionNodeSourceControls } from "./action-node-editor-state";
import { ActionNodeSourceControls } from "./action-node-expanded-ui";
import { resolveActionNodeModeState } from "./action-node-state";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";

const t = (key: string) => key;

function sourceControlsFor(data: ActionNodeTestData) {
  const nodeData = createActionEditorTestData({
    uiActionSourceOptions: [
      { id: "whatsapp", label: "actionSourceWhatsApp" },
      { id: "telegram", label: "actionSourceTelegram" },
    ],
    ...data,
  });
  const mode = resolveActionNodeModeState(nodeData);
  const controls = renderHook(() =>
    useActionNodeSourceControls({ nodeData, mode, t })
  ).result.current;
  return { controls, nodeData };
}

describe("action source controls", () => {
  it("keeps the channel select for a handoff step, its only way to become a message", () => {
    const { controls, nodeData } = sourceControlsFor({
      kind: "action",
      actionType: "assign_human",
    });
    expect(controls.hidden).toBe(false);

    render(<ActionNodeSourceControls {...controls} />);
    const channel = screen.getByRole("combobox", {
      name: "actionSourceSelectLabel",
    });
    // Handoff isn't a channel, so the select shows its placeholder.
    expect(channel).toHaveTextContent("actionSourceSameChat");
    expect(
      screen.queryByRole("combobox", { name: "actionWhatsAppKindSelectLabel" })
    ).toBeNull();

    act(() => controls.onActionSourceChange("whatsapp"));
    expect(nodeData.uiActionCommands.changeType).toHaveBeenCalledWith(
      "whatsapp_service_message"
    );
  });

  it("hides the selects for a generative AI step", () => {
    const { controls } = sourceControlsFor({
      kind: "action",
      actionType: "generative_ai",
    });
    expect(controls.hidden).toBe(true);

    render(<ActionNodeSourceControls {...controls} />);
    expect(screen.queryByTestId("action-source-controls")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it.each<[string, ActionNodeTestData]>([
    ["a reply", { kind: "action", actionType: "reply" }],
    [
      "a channel reply",
      { kind: "action", actionType: "reply", actionReplyChannel: "telegram" },
    ],
    [
      "a WhatsApp template",
      {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "promo",
      },
    ],
  ])("keeps the selects for %s", (_name, data) => {
    const { controls } = sourceControlsFor(data);
    expect(controls.hidden).toBe(false);

    render(<ActionNodeSourceControls {...controls} />);
    expect(screen.getByTestId("action-source-controls")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "actionSourceSelectLabel" })
    ).toBeInTheDocument();
  });
});
