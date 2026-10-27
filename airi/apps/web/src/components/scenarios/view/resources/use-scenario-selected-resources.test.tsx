/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react";
import type { ScenarioFlowNode, ScenarioNodeData } from "../../types";
import { useScenarioSelectedResources } from "./use-scenario-selected-resources";

function node(data: ScenarioNodeData): ScenarioFlowNode {
  return { id: "selected", position: { x: 0, y: 0 }, data };
}

function dependencies() {
  return {
    loadContextItems: jest.fn(async () => {}),
    loadWhatsAppTemplates: jest.fn(async () => {}),
    loadWhatsAppFlows: jest.fn(async () => {}),
    selectWhatsAppTemplate: jest.fn(),
    whatsAppTemplates: [
      {
        id: "catalog-1",
        name: "catalog_template",
        language: "en_US",
        category: "MARKETING",
      },
    ],
  };
}

describe("selected scenario resource ownership", () => {
  it.each([undefined, "", " "])(
    "preserves an explicit template with omitted language %s",
    language => {
      const props = dependencies();
      const selectedNode = node({
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "saved_template",
        actionWhatsAppTemplateLanguage: language,
      });
      const { rerender } = renderHook(
        ({ whatsAppTemplates }) =>
          useScenarioSelectedResources({
            ...props,
            whatsAppTemplates,
            selectedNode,
          }),
        { initialProps: { whatsAppTemplates: props.whatsAppTemplates } }
      );
      rerender({ whatsAppTemplates: [...props.whatsAppTemplates] });
      expect(props.selectWhatsAppTemplate).not.toHaveBeenCalled();
      expect(props.loadWhatsAppTemplates).toHaveBeenCalledTimes(1);
    }
  );

  it("retains a saved provider ID while its catalog entry is unavailable", () => {
    const props = dependencies();
    renderHook(() =>
      useScenarioSelectedResources({
        ...props,
        selectedNode: node({
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateId: "saved-id",
        }),
      })
    );
    expect(props.selectWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("initializes an unselected template through the existing selection command when the catalog arrives", () => {
    const props = dependencies();
    const selectedNode = node({
      kind: "action",
      actionType: "whatsapp_template",
    });
    const { rerender } = renderHook(
      ({ whatsAppTemplates }) =>
        useScenarioSelectedResources({
          ...props,
          whatsAppTemplates,
          selectedNode,
        }),
      {
        initialProps: {
          whatsAppTemplates: [] as typeof props.whatsAppTemplates,
        },
      }
    );
    expect(props.selectWhatsAppTemplate).not.toHaveBeenCalled();
    rerender({ whatsAppTemplates: props.whatsAppTemplates });
    expect(props.selectWhatsAppTemplate).toHaveBeenCalledWith(
      "selected",
      "catalog_template::en_US"
    );
  });

  it("loads resources for the current selection without making a previous template selection after navigation", () => {
    const props = dependencies();
    const { rerender } = renderHook(
      ({ selectedNode, whatsAppTemplates }) =>
        useScenarioSelectedResources({
          ...props,
          whatsAppTemplates,
          selectedNode,
        }),
      {
        initialProps: {
          selectedNode: node({
            kind: "action",
            actionType: "whatsapp_template",
          }),
          whatsAppTemplates: [] as typeof props.whatsAppTemplates,
        },
      }
    );
    rerender({
      selectedNode: node({
        kind: "context",
        contextOptionId: "knowledge_base_articles",
      }),
      whatsAppTemplates: props.whatsAppTemplates,
    });
    expect(props.loadContextItems).toHaveBeenCalledWith(
      "knowledge_base_articles"
    );
    expect(props.selectWhatsAppTemplate).not.toHaveBeenCalled();
    rerender({
      selectedNode: node({
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
      }),
      whatsAppTemplates: props.whatsAppTemplates,
    });
    expect(props.loadWhatsAppFlows).toHaveBeenCalledTimes(1);
    expect(props.loadWhatsAppTemplates).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or select anything without a selected node", () => {
    const props = dependencies();
    renderHook(() =>
      useScenarioSelectedResources({ ...props, selectedNode: undefined })
    );
    expect(props.loadContextItems).not.toHaveBeenCalled();
    expect(props.loadWhatsAppTemplates).not.toHaveBeenCalled();
    expect(props.loadWhatsAppFlows).not.toHaveBeenCalled();
    expect(props.selectWhatsAppTemplate).not.toHaveBeenCalled();
  });
});
