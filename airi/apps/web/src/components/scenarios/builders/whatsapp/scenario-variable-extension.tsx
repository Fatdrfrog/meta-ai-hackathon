"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import {
  ScenarioVariableChip,
  SCENARIO_VARIABLE_CHIP_CLASSNAME,
} from "@/components/scenarios/view/scenario-variable-chip";
import {
  getScenarioTokenFallbackLabel,
  resolveScenarioVariableChipLabel,
} from "@/components/scenarios/view/scenario-template-utils";
import { useTranslations } from "next-intl";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    scenarioVariable: {
      insertScenarioVariable: (attrs: {
        token: string;
        label?: string;
      }) => ReturnType;
    };
  }
}

function ScenarioVariableNodeView({ node, deleteNode }: NodeViewProps) {
  const t = useTranslations("Scenarios");
  const token = String(node.attrs.token || "");
  const label = resolveScenarioVariableChipLabel(
    token,
    String(node.attrs.label || ""),
    t
  );

  return (
    <NodeViewWrapper as="span" className="inline align-baseline">
      <ScenarioVariableChip
        label={label}
        onRemove={deleteNode}
        removeLabel={t("variableRemove", { label })}
      />
    </NodeViewWrapper>
  );
}

export const ScenarioVariableExtension = Node.create({
  name: "scenarioVariable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      token: {
        default: null,
        parseHTML: element =>
          element.getAttribute("data-scenario-variable") || null,
        renderHTML: attributes => {
          if (!attributes.token) return {};
          return { "data-scenario-variable": attributes.token };
        },
      },
      label: {
        default: null,
        parseHTML: element =>
          element.getAttribute("data-label") || element.textContent || null,
        renderHTML: attributes => {
          if (!attributes.label) return {};
          return { "data-label": attributes.label };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-scenario-variable]",
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const token = String(node.attrs.token || "");
    const label =
      String(node.attrs.label || "") || getScenarioTokenFallbackLabel(token);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-scenario-variable": token,
        "data-label": label,
        class: SCENARIO_VARIABLE_CHIP_CLASSNAME,
      }),
      label,
    ];
  },

  addCommands() {
    return {
      insertScenarioVariable:
        attrs =>
        ({ commands }) => {
          const token = attrs.token?.trim();
          if (!token) return false;
          return commands.insertContent({
            type: this.name,
            attrs: {
              token,
              label: attrs.label || getScenarioTokenFallbackLabel(token),
            },
          });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ScenarioVariableNodeView);
  },
});
