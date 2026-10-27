/**
 * @jest-environment jsdom
 */

import type { ScenarioNodeData } from "@/components/scenarios/types";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ActionNodeKindIcon } from "./action-node-kind-icon";

function renderIcon(data: Omit<ScenarioNodeData, "kind">) {
  const { container } = render(
    <ActionNodeKindIcon
      nodeData={{ kind: "action", ...data } as ScenarioNodeData}
      className="size-5"
    />
  );
  const icon = container.firstElementChild;
  if (!(icon instanceof Element)) throw new Error("missing icon");
  return icon;
}

describe("ActionNodeKindIcon", () => {
  it.each([
    [{ actionType: "generative_ai" }, "generative_ai", "lucide-sparkles"],
    [{ actionType: "assign_human" }, "assign_human", "lucide-headset"],
    [{ actionType: "end_scenario" }, "end_scenario", "lucide-circle-stop"],
    [{ actionType: "reply" }, "same_chat", "lucide-message-square"],
    [{}, "same_chat", "lucide-message-square"],
  ] as const)("shows a decorative icon for %j", (data, kind, iconClass) => {
    const icon = renderIcon(data);

    expect(icon).toHaveAttribute("data-kind-icon", kind);
    expect(icon.getAttribute("class")).toContain(iconClass);
    expect(icon.getAttribute("class")).toContain("size-5");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    [
      {
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
        },
      },
      "whatsapp",
      "actionSourceWhatsApp",
    ],
    [
      { actionType: "whatsapp_template", actionWhatsAppTemplateName: "promo" },
      "whatsapp",
      "actionSourceWhatsApp",
    ],
    [
      { actionType: "reply", actionReplyChannel: "telegram" },
      "telegram",
      "actionSourceTelegram",
    ],
    [
      { actionType: "reply", actionReplyChannel: "instagram" },
      "instagram",
      "actionSourceInstagram",
    ],
    [
      { actionType: "reply", actionReplyChannel: "email" },
      "email",
      "actionSourceEmail",
    ],
    [
      { actionType: "reply", actionReplyChannel: "web_widget" },
      "web_widget",
      "actionSourceWebWidget",
    ],
  ])("names the channel of a %j step", (data, sourceId, label) => {
    const icon = renderIcon(data as Omit<ScenarioNodeData, "kind">);

    expect(icon).toHaveAttribute("data-kind-icon", sourceId);
    expect(screen.getByRole("img", { name: label })).toBe(icon);
  });
});
