/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";
import {
  scenarioGraphHasFlowRoot,
  useScenarioNodePaletteSections,
} from "./use-scenario-node-palette-sections";

const t = (key: string) =>
  ({
    badgeTrigger: "Start",
    presetTriggerWhatsAppQr: "WhatsApp QR",
    startTriggerSection: "Start / Trigger",
    startTriggerSectionHint: "Choose when this flow starts.",
    audienceCampaignSection: "Audience / Campaign",
    audienceCampaignSectionHint: "Choose recipients and send controls.",
    messageSection: "Message",
    messageSectionHint: "Choose what gets sent.",
    scenarioGatesSection: "Gates",
    aiContext: "Knowledge",
    aiContextSectionHint: "Pick what Airi can use to answer.",
    presetBulkCampaign: "Campaign audience",
    scenarioGate: "Gate",
    presetContextKnowledge: "Knowledge",
    presetActionReply: "Reply",
    presetActionGenerativeAI: "Generative AI",
    presetActionWhatsAppTemplate: "Send WhatsApp Template",
    presetActionInstagramReply: "Instagram Reply",
    presetActionTelegramBuilder: "Telegram Builder",
    actionSourceEmail: "Email",
    actionSourceWebWidget: "Web widget",
    presetActionAssignHuman: "Assign to Human Agent",
    canvasEmptyHintSecondary:
      "Other blocks unlock after you add a start block.",
  })[key] ?? key;

describe("useScenarioNodePaletteSections", () => {
  it("groups campaign graph blocks by start, audience, message, and follow-up", () => {
    const { result } = renderHook(() => useScenarioNodePaletteSections(t));
    expect(
      result.current.nodePaletteSections.map(section => section.id)
    ).toEqual(["trigger", "bulk", "action", "logic", "context"]);

    expect(result.current.nodePaletteSections[0]).toMatchObject({
      title: "Start / Trigger",
      subtitle: "Choose when this flow starts.",
      items: [
        expect.objectContaining({
          id: "trigger-incoming-message",
          kind: "trigger",
          title: "Start",
        }),
        expect.objectContaining({
          id: "trigger-whatsapp-qr",
          kind: "trigger",
          title: "WhatsApp QR",
        }),
      ],
    });

    const bulkSection = result.current.nodePaletteSections.find(
      section => section.id === "bulk"
    );

    expect(bulkSection).toBeDefined();
    expect(bulkSection).toMatchObject({
      title: "Audience / Campaign",
      subtitle: "Choose recipients and send controls.",
      items: [
        expect.objectContaining({
          id: "bulk-campaign",
          kind: "bulk",
          title: "Campaign audience",
        }),
      ],
    });

    expect(result.current.nodePaletteSections[2]).toMatchObject({
      id: "action",
      title: "Message",
      subtitle: "Choose what gets sent.",
    });
    expect(
      result.current.nodePaletteSections[2]?.items.map(item => item.id)
    ).toEqual(["action-reply", "action-generative-ai"]);
    expect(result.current.nodePaletteSections[2]?.items[0]).toMatchObject({
      title: "Reply",
    });
    expect(result.current.nodePaletteSections[2]?.items[1]).toMatchObject({
      title: "Generative AI",
      defaults: {
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "",
        },
      },
    });
    expect(result.current.nodePaletteSections[3]).toMatchObject({
      id: "logic",
      title: "Gates",
    });
    expect(
      result.current.nodePaletteSections[3]?.items.map(item => item.id)
    ).toEqual(["logic-if-else", "logic-recipient-column-split"]);
    expect(result.current.nodePaletteSections[3]?.items[0]).toMatchObject({
      title: "Gate",
    });
    expect(result.current.nodePaletteSections[3]?.items[1]).toMatchObject({
      id: "logic-recipient-column-split",
    });
  });

  it("disables non-root palette items until a trigger or bulk exists", () => {
    const { result } = renderHook(() =>
      useScenarioNodePaletteSections(t, { hasFlowRoot: false })
    );

    const items = result.current.nodePaletteSections.flatMap(
      section => section.items
    );
    const byId = Object.fromEntries(items.map(item => [item.id, item]));

    expect(byId["trigger-incoming-message"]?.disabled).toBeFalsy();
    expect(byId["bulk-campaign"]?.disabled).toBeFalsy();
    expect(byId["action-reply"]).toMatchObject({
      disabled: true,
      disabledHint: "Other blocks unlock after you add a start block.",
    });
    expect(byId["action-generative-ai"]).toMatchObject({
      disabled: true,
      disabledHint: "Other blocks unlock after you add a start block.",
    });
    expect(byId["logic-if-else"]?.disabled).toBe(true);
    expect(byId["context-knowledge"]?.disabled).toBe(true);
  });

  it("keeps all palette items enabled when a flow root exists", () => {
    const { result } = renderHook(() =>
      useScenarioNodePaletteSections(t, { hasFlowRoot: true })
    );

    const disabled = result.current.nodePaletteSections
      .flatMap(section => section.items)
      .filter(item => item.disabled);

    expect(disabled).toEqual([]);
  });
});

describe("scenarioGraphHasFlowRoot", () => {
  it("detects trigger and bulk roots", () => {
    expect(scenarioGraphHasFlowRoot([])).toBe(false);
    expect(scenarioGraphHasFlowRoot([{ data: { kind: "action" } }])).toBe(
      false
    );
    expect(scenarioGraphHasFlowRoot([{ data: { kind: "trigger" } }])).toBe(
      true
    );
    expect(scenarioGraphHasFlowRoot([{ data: { kind: "bulk" } }])).toBe(true);
  });
});
