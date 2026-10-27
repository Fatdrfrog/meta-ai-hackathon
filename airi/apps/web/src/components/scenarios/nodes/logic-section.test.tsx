/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ScenarioLogicEditorNodeData } from "../view/node-enrichment/types";
import { ScenarioNodeLogicSection } from "./logic-section";

jest.mock("@xyflow/react", () => ({
  Handle: ({ id }: { id: string }) => (
    <div data-testid="source-handle" data-handle-id={id} />
  ),
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Right: "right" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
}));
// ui/select reads its scroll-button labels from next-intl (ESM-only in Jest).

const t = (key: string) => key;

function handleIds(): string[] {
  return screen
    .getAllByTestId("source-handle")
    .map(node => node.getAttribute("data-handle-id") || "");
}

describe("ScenarioNodeLogicSection", () => {
  it("preserves legacy answer ids and missing-text callbacks after editor reuse", () => {
    const onConditionBranchChange = jest.fn();
    const noReplyBranch = {
      id: "no-reply",
      type: "no_reply_timeout" as const,
      timeoutMinutes: 30,
      missingTextPhrases: ["stop"],
      answerMatchRules: [
        { id: "answer-stable", mode: "exact" as const, text: "Yes" },
      ],
    };
    const nodeData: ScenarioLogicEditorNodeData = {
      kind: "logic",
      uiOnSelect: jest.fn(),
      uiOnPatch: jest.fn(),
      uiOnRemove: jest.fn(),
      logicType: "post_action_condition",
      conditionBranches: [noReplyBranch],
      uiConditionBranches: [noReplyBranch],
      uiOnConditionBranchChange: onConditionBranchChange,
    };

    render(
      <ScenarioNodeLogicSection
        nodeData={nodeData}
        t={t}
        patchNode={jest.fn()}
      />
    );

    fireEvent.change(
      screen.getByPlaceholderText("postActionAnswerMatchInputPlaceholder"),
      { target: { value: "Definitely" } }
    );
    expect(onConditionBranchChange).toHaveBeenLastCalledWith(
      "no_reply_timeout",
      {
        answerMatchRules: [
          { id: "answer-stable", mode: "exact", text: "Definitely" },
        ],
      }
    );

    const phrases = screen.getByPlaceholderText(
      "postActionConditionMissingTextPlaceholder"
    );
    fireEvent.change(phrases, { target: { value: "stop\ncancel" } });
    fireEvent.blur(phrases);
    expect(onConditionBranchChange).toHaveBeenLastCalledWith(
      "no_reply_timeout",
      { missingTextPhrases: ["stop", "cancel"] }
    );

    expect(handleIds().some(id => id.includes("answer-stable"))).toBe(true);
  });

  it("exposes labeled routes for leftover post-action logical nodes", () => {
    render(
      <ScenarioNodeLogicSection
        t={t}
        patchNode={jest.fn()}
        nodeData={{
          kind: "logic",
          logicType: "post_action_condition",
          uiOnSelect: jest.fn(),
          uiOnPatch: jest.fn(),
          uiOnRemove: jest.fn(),
          uiOnCreateNodeFromSourceHandle: jest.fn(),
        }}
      />
    );

    expect(screen.getByText("postActionConditionUserReplied")).toBeTruthy();
    expect(screen.getByText("postActionConditionNoReply")).toBeTruthy();
    expect(handleIds().some(id => id.includes("user_replied"))).toBe(true);
    expect(handleIds().some(id => id.includes("no_reply"))).toBe(true);
  });

  it("exposes a labeled continue route on remaining audience gates", () => {
    render(
      <ScenarioNodeLogicSection
        t={t}
        patchNode={jest.fn()}
        nodeData={{
          kind: "logic",
          logicType: "audience_filter",
          audienceMode: "all",
          uiOnSelect: jest.fn(),
          uiOnPatch: jest.fn(),
          uiOnRemove: jest.fn(),
          uiOnCreateNodeFromSourceHandle: jest.fn(),
        }}
      />
    );

    expect(screen.getByText("routeChooseNextStep")).toBeTruthy();
    expect(handleIds()).toContain("right-source");
  });
});
