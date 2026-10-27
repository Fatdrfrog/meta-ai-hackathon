/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";
import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import type { ScenarioFlowNode, ScenarioNodeData } from "../../types";
import { useScenarioNodePaletteSections } from "./use-scenario-node-palette-sections";
import { useScenarioContextMenu } from "./use-scenario-context-menu";

const t = (key: string, values?: Record<string, string | number | Date>) =>
  ({
    badgeTrigger: "Start",
    startTriggerSection: "Start / Trigger",
    startTriggerSectionHint: "Choose when this flow starts.",
    audienceCampaignSection: "Audience / Campaign",
    audienceCampaignSectionHint: "Choose recipients and send controls.",
    messageSection: "Message",
    messageSectionHint: "Choose what gets sent.",
    logicFollowupSection: "Logic / Follow-up",
    aiContext: "Knowledge",
    aiContextSectionHint: "Pick what Airi can use to answer.",
    presetBulkCampaign: "Campaign audience",
    ifSegment: "If / Segment",
    presetContextKnowledge: "Knowledge",
    presetActionReply: "Reply",
    presetActionWhatsAppTemplate: "Send WhatsApp Template",
    presetActionInstagramReply: "Instagram Reply",
    presetActionTelegramBuilder: "Telegram Builder",
    actionSourceEmail: "Email",
    actionSourceWebWidget: "Web widget",
    presetActionAssignHuman: "Assign to Human Agent",
    scenarioLinkSection: "Sub-Scenarios",
    scenarioLinkSectionHint: "Link action outcomes to other scenarios.",
    contextMenuSourcePrefix: `Source: ${values?.source ?? ""}`,
    actionOutcomeNoReply: "No reply",
    sourceHandleAnyUserReply: "Any user reply",
    sourceHandleTemplateQuickReply: `Button clicked: ${values?.label ?? ""}`,
    sourceHandleWhatsAppChoice: `Choice: ${values?.label ?? ""}`,
    sourceHandleFlowOption: `Picks: ${values?.label ?? ""}`,
  })[key] ?? key;

function createNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    type: data.kind === "logic" ? "scenarioNode" : "actionNode",
    position: { x: 0, y: 0 },
    data,
  };
}

describe("useScenarioContextMenu context menu sections", () => {
  it("keeps sub-scenario links out of the top-level add menu", () => {
    const { result } = renderHook(() => useScenarioNodePaletteSections(t));

    expect(
      result.current.nodePaletteSections.map(section => section.id)
    ).not.toContain("scenario_link");
  });

  it("builds a handle-originated palette from a canonical WhatsApp Flow option", () => {
    const sourceNode = createNode("flow-action", {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open" },
          flowConfig: {
            templateId: "flow-1",
            ctaText: "Open",
            screens: [
              {
                id: "SCREEN_A",
                title: "Screen",
                fields: [
                  {
                    id: "field-1",
                    label: "Choose",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "option-1", title: "One" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });

    const { result } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle: buildFlowBranchSourceHandleId(
            "field-1",
            "option-1"
          ),
        },
        nodePaletteSections,
        t,
      });
    });

    const itemIds = result.current.contextMenuSections.flatMap(section =>
      section.items.map(item => item.id)
    );
    expect(itemIds).toContain("action-reply");
    expect(itemIds).not.toContain("trigger-incoming-message");
    expect(result.current.contextMenuSourceLabel).toBe("Source: Picks: One");
  });

  it("keeps root-only blocks out of handle-originated palettes", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
    });

    const { result } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle: "right-source",
        },
        nodePaletteSections,
        t,
      });
    });

    const ids = result.current.contextMenuSections.flatMap(section =>
      section.items.map(item => item.id)
    );
    expect(ids).not.toContain("trigger-incoming-message");
    expect(ids).not.toContain("bulk-campaign");
  });

  it("keeps root blocks available from the pane palette", () => {
    const { result } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t, {
        hasFlowRoot: false,
      });
      return useScenarioContextMenu({
        nodesById: new Map(),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
        },
        nodePaletteSections,
        t,
      });
    });

    const ids = result.current.contextMenuSections.flatMap(section =>
      section.items.map(item => item.id)
    );
    expect(ids).toContain("trigger-incoming-message");
    expect(ids).toContain("bulk-campaign");
  });

  it("offers sub-scenario links from post-action condition branch handles", () => {
    const sourceNode = createNode("condition-1", {
      kind: "logic",
      logicType: "post_action_condition",
    });

    const { result } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle:
            getPostActionConditionHandleId("user_replied"),
        },
        nodePaletteSections,
        t,
      });
    });

    const scenarioLinkSection = result.current.contextMenuSections.find(
      section => section.id === "scenario_link"
    );

    expect(scenarioLinkSection?.items.map(item => item.id)).toEqual([
      "scenario-link",
    ]);
  });

  it("offers sub-scenario links from direct no-reply outcomes", () => {
    const sourceNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });

    const { result } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        },
        nodePaletteSections,
        t,
      });
    });

    expect(
      result.current.contextMenuSections
        .find(section => section.id === "scenario_link")
        ?.items.map(item => item.id)
    ).toEqual(["scenario-link"]);
    expect(result.current.contextMenuSourceLabel).toBe("Source: No reply");
  });

  it("describes the source handle when opening the add menu from a WhatsApp template", () => {
    const sourceNode = createNode("template-action", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Kaspi" }],
        },
      ],
    });

    const { result: defaultResult } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle: "right-source",
        },
        nodePaletteSections,
        t,
      });
    });

    expect(defaultResult.current.contextMenuSourceLabel).toBe(
      "Source: Any user reply"
    );

    const { result: branchResult } = renderHook(() => {
      const { nodePaletteSections } = useScenarioNodePaletteSections(t);
      return useScenarioContextMenu({
        nodesById: new Map([[sourceNode.id, sourceNode]]),
        contextMenu: {
          left: 0,
          top: 0,
          flowX: 0,
          flowY: 0,
          connectFromNodeId: sourceNode.id,
          connectFromSourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
        },
        nodePaletteSections,
        t,
      });
    });

    expect(branchResult.current.contextMenuSourceLabel).toBe(
      "Source: Button clicked: Kaspi"
    );
  });
});
