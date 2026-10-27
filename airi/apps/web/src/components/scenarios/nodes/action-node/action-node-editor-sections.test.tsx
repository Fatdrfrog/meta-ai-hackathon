/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useMemo } from "react";
import {
  ActionNodeAdvancedSection,
  ActionNodeBranchSummaries,
  ActionNodeGenerativeAIEditor,
  ActionNodeHandoffEditor,
  ActionNodeInstagramEditor,
  ActionNodeReplyEditor,
  ActionNodeTelegramEditor,
} from "./action-node-editor-sections";
import { useActionNodeReplyDraft } from "./action-node-editor-state";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import type { ActionNodeBranchState } from "./action-node-state";
import { resolveActionNodeModeState } from "./action-node-state";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const t = (key: string) => key;
const collectedName = [
  { key: "name", label: "Name", prompt: "Name on the holder" },
];

function formAnswerField(key: string, label: string, mayBeEmpty = false) {
  return {
    key,
    responseKey: key,
    label,
    description: "",
    fieldType: "TextInput" as const,
    required: !mayBeEmpty,
    screenIndex: 0,
    options: [],
    mayBeEmpty,
  };
}

const orderForm = {
  nodeId: "order",
  formKey: "order",
  formLabel: "Order",
  label: "Order details",
  availability: "always" as const,
  schema: "known" as const,
  fields: [
    formAnswerField("size", "Size"),
    formAnswerField("note", "Note", true),
  ],
};

function EditorHarness({
  data,
  showLabels,
}: {
  data: ActionNodeTestData;
  showLabels?: boolean;
}) {
  const nodeData = useMemo(() => createActionEditorTestData(data), [data]);
  const mode = resolveActionNodeModeState(nodeData);
  const draft = useActionNodeReplyDraft({
    nodeData,
    mode,
    patchNode: nodeData.uiOnPatch,
    t,
  });
  return (
    <>
      <ActionNodeReplyEditor
        mode={mode}
        draft={draft}
        nodeData={nodeData}
        t={t}
        showLabels={showLabels}
      />
      <ActionNodeTelegramEditor
        mode={mode}
        draft={draft}
        nodeData={nodeData}
        patchNode={nodeData.uiOnPatch}
      />
      <ActionNodeInstagramEditor
        mode={mode}
        draft={draft}
        nodeData={nodeData}
        patchNode={nodeData.uiOnPatch}
        t={t}
      />
      <ActionNodeAdvancedSection
        mode={mode}
        nodeData={nodeData}
        patchNode={nodeData.uiOnPatch}
        promptInputFields={[]}
        showAdvanced
        onToggle={jest.fn()}
        onInsertToken={draft.insertToken}
        t={t}
      />
    </>
  );
}

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([
    scenarioEditorChunks.whatsAppInlineEditor.load(),
    scenarioEditorChunks.generativeAISection.load(),
    scenarioEditorChunks.telegramReplyBuilder.load(),
  ]);
});

describe("action node editor sections", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalResizeObserver = globalThis.ResizeObserver;
  const rangePrototype = Range.prototype as Range & {
    getClientRects?: unknown;
    getBoundingClientRect?: unknown;
  };
  const originalRangeMethods = {
    getClientRects: rangePrototype.getClientRects,
    getBoundingClientRect: rangePrototype.getBoundingClientRect,
  };
  beforeAll(() => {
    // cmdk scrolls the active item and rich editors measure ranges.
    HTMLElement.prototype.scrollIntoView = jest.fn();
    installResizeObserver();
    const emptyRect = () => new DOMRect(0, 0, 0, 0);
    rangePrototype.getBoundingClientRect = emptyRect;
    rangePrototype.getClientRects = () =>
      Object.assign([emptyRect()], { item: () => emptyRect() });
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    globalThis.ResizeObserver = originalResizeObserver;
    Object.assign(rangePrototype, originalRangeMethods);
  });

  describe("plain reply", () => {
    it("chooses who writes the reply with a single-choice toggle", () => {
      const changeReplyMode = jest.fn();
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "ai",
            uiActionCommands: { changeReplyMode },
          }}
        />
      );

      const group = screen.getByRole("group", { name: "actionReplyModeLabel" });
      const ai = within(group).getByRole("radio", { name: "replyModeAi" });
      const fixed = within(group).getByRole("radio", {
        name: "replyModeFixed",
      });
      expect(ai).toHaveAttribute("aria-checked", "true");
      expect(fixed).toHaveAttribute("aria-checked", "false");
      // "Your text" comes first.
      expect(
        within(group)
          .getAllByRole("radio")
          .map(radio => radio.textContent)
      ).toEqual(["replyModeFixed", "replyModeAi"]);
      expect(screen.queryByRole("combobox")).toBeNull();

      fireEvent.click(fixed);
      expect(changeReplyMode).toHaveBeenCalledWith("fixed");
    });

    it("names the AI instructions with an aria-label on the canvas", () => {
      render(
        <EditorHarness
          data={{ kind: "action", actionType: "reply", actionReplyMode: "ai" }}
        />
      );

      const instructions = screen.getByRole("textbox", {
        name: "whatsappServiceAiInstructions",
      });
      expect(instructions).toHaveAttribute(
        "placeholder",
        "actionReplyInstructionPlaceholder"
      );
      expect(screen.queryByText("whatsappServiceAiInstructions")).toBeNull();
    });

    it("offers only the answers before this step while AI writes", () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "ai",
            uiScenarioPromptInputs: collectedName,
            uiScenarioFormAnswerSources: [orderForm],
          }}
        />
      );

      fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
      const menu = screen.getByTestId("service-message-variables-menu");
      expect(within(menu).getByText("variableGroupPromptInputs")).toBeTruthy();
      expect(within(menu).getByText("variableGroupForm")).toBeTruthy();
      expect(within(menu).queryByText("variableGroupContact")).toBeNull();
      expect(
        screen.getByTestId("service-message-variable-form.order.size")
      ).toBeTruthy();
    });

    it("inserts an answer at the instructions' caret and keeps typing there", async () => {
      const uiOnPatch = jest.fn();
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "ai",
            actionReplyInstruction: "Confirm the order.",
            uiOnPatch,
            uiScenarioFormAnswerSources: [orderForm],
          }}
        />
      );
      const instructions = screen.getByRole("textbox", {
        name: "whatsappServiceAiInstructions",
      }) as HTMLTextAreaElement;
      const caret = "Confirm the".length;
      instructions.focus();
      instructions.setSelectionRange(caret, caret);
      fireEvent.blur(instructions);

      fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
      fireEvent.click(
        screen.getByTestId("service-message-variable-form.order.size")
      );

      const next = "Confirm the {{form.order.size}} order.";
      expect(uiOnPatch).toHaveBeenLastCalledWith({
        actionReplyInstruction: next,
      });
      expect(instructions).toHaveValue(next);
      await waitFor(() => expect(instructions).toHaveFocus());
      const after = "Confirm the {{form.order.size}}".length;
      expect(instructions.selectionStart).toBe(after);
      expect(instructions.selectionEnd).toBe(after);
    });

    it("notes form answers no earlier form has and answers that may be empty", () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "ai",
            actionReplyInstruction:
              "Confirm {{form.order.size}}, {{form.order.note}} and {{form.order.colour}}.",
            uiScenarioFormAnswerSources: [orderForm],
          }}
        />
      );

      const unavailable = screen.getByTestId("form-answers-unavailable");
      const mayBeEmpty = screen.getByTestId("form-answers-may-be-empty");
      expect(unavailable).toHaveTextContent("formAnswersUnavailableNotice");
      expect(mayBeEmpty).toHaveTextContent("formAnswersMayBeEmptyReply");
      // The instructions name both notes, and the blocking one is read out.
      const instructions = screen.getByRole("textbox", {
        name: "whatsappServiceAiInstructions",
      });
      expect(instructions).toHaveAttribute("aria-invalid", "true");
      expect(instructions.getAttribute("aria-describedby")?.split(" ")).toEqual(
        [unavailable.id, mayBeEmpty.id]
      );
      expect(unavailable).toHaveAttribute("role", "status");
    });

    it("offers no form answers to Your text", () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Hello",
            uiScenarioPromptInputs: collectedName,
            uiScenarioFormAnswerSources: [orderForm],
          }}
        />
      );

      fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
      const menu = screen.getByTestId("service-message-variables-menu");
      expect(within(menu).queryByText("variableGroupForm")).toBeNull();
      expect(
        within(menu).queryByTestId("service-message-variable-form.order.size")
      ).toBeNull();
      expect(within(menu).getByText("variableGroupPromptInputs")).toBeTruthy();
      expect(within(menu).getByText("variableGroupContact")).toBeTruthy();
    });

    it("labels a form answer typed into Your text as Variables names it", () => {
      const nodeData = createActionEditorTestData({
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        uiScenarioFormAnswerSources: [orderForm],
      });
      const { result } = renderHook(() =>
        useActionNodeReplyDraft({
          nodeData,
          mode: resolveActionNodeModeState(nodeData),
          patchNode: nodeData.uiOnPatch,
          t,
        })
      );
      expect(result.current.resolveVariableLabel("form.order.size")).toBe(
        "Size · Order details"
      );
      expect(result.current.resolveVariableLabel("customer_name")).not.toBe(
        "Size · Order details"
      );
    });

    it("shows a visible instructions label in the settings panel", () => {
      render(
        <EditorHarness
          data={{ kind: "action", actionType: "reply", actionReplyMode: "ai" }}
          showLabels
        />
      );

      const instructions = screen.getByLabelText(
        "whatsappServiceAiInstructions"
      );
      expect(instructions.tagName).toBe("TEXTAREA");
      expect(instructions).not.toHaveAttribute("aria-label");
    });

    it("puts Variables next to the fixed text and nowhere else", () => {
      const uiOnPatch = jest.fn();
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "",
            uiOnPatch,
            uiScenarioPromptInputs: collectedName,
          }}
        />
      );

      expect(
        screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
      ).toBeInTheDocument();
      const variables = screen.getAllByTestId(
        "whatsapp-service-message-variables"
      );
      expect(variables).toHaveLength(1);
      expect(
        screen.getByRole("group", { name: "actionReplyModeLabel" })
          .parentElement
      ).toContainElement(variables[0]);
    });
  });

  describe("builder replies", () => {
    it("offers Variables for fixed Telegram text", () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyText: "Pick a team",
            actionTelegramQuickReplies: [[{ text: "Sales", payload: "sales" }]],
          }}
        />
      );

      expect(
        screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
      ).toBeInTheDocument();
      expect(
        screen.getAllByTestId("whatsapp-service-message-variables")
      ).toHaveLength(1);
    });

    it("offers Variables for fixed Instagram text", async () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "instagram",
            actionReplyMode: "fixed",
            actionReplyText: "Pick a team",
          }}
        />
      );

      expect(await screen.findByTestId("instagram-builder")).toBeTruthy();
      expect(
        screen.getAllByTestId("whatsapp-service-message-variables")
      ).toHaveLength(1);
    });

    it("explains a bulk-disabled Instagram reply in an inline notice", async () => {
      render(
        <EditorHarness
          data={{
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "instagram",
            uiInstagramReplyDisabledReason: "instagramReplyBulkDisabled",
          }}
        />
      );

      await screen.findByTestId("instagram-builder");
      const notice = screen.getByText("instagramReplyBulkDisabled");
      expect(notice.closest("[data-tone]")).toHaveAttribute(
        "data-tone",
        "warning"
      );
    });
  });

  describe("handoff", () => {
    function renderHandoff(data: Partial<ActionNodeTestData> = {}) {
      const uiOnPatch = jest.fn();
      const nodeData = createActionEditorTestData({
        kind: "action",
        actionType: "assign_human",
        uiOnPatch,
        ...data,
      });
      render(
        <ActionNodeHandoffEditor
          nodeData={nodeData}
          patchNode={uiOnPatch}
          t={t}
        />
      );
      return { uiOnPatch };
    }

    it("labels the customer message and says how it is sent", () => {
      renderHandoff();

      const message = screen.getByLabelText("handoffMessageLabel");
      expect(message).toHaveAttribute(
        "placeholder",
        "actionInstructionPlaceholder"
      );
      expect(message).toHaveAccessibleDescription("handoffMessageSentAs");
      expect(
        screen.getByTestId("whatsapp-service-message-variables")
      ).toBeInTheDocument();
    });

    it("groups the team notifications with their own labels", () => {
      const { uiOnPatch } = renderHandoff();

      const group = screen.getByRole("group", { name: "handoffNotifyLegend" });
      const email = within(group).getByLabelText("handoffNotifyEmailLabel");
      const whatsapp = within(group).getByLabelText(
        "handoffNotifyWhatsappLabel"
      );
      expect(email).toHaveAttribute(
        "placeholder",
        "handoffNotifyEmailPlaceholder"
      );
      expect(whatsapp).toHaveAttribute(
        "placeholder",
        "handoffNotifyWhatsappPlaceholder"
      );
      expect(whatsapp).toHaveAccessibleDescription("handoffNotifyWhatsappHint");

      fireEvent.change(whatsapp, { target: { value: "+7 700 123 45 67" } });
      expect(uiOnPatch).toHaveBeenLastCalledWith({
        actionHandoffNotifyWhatsapp: "+7 700 123 45 67",
      });
    });

    it("inserts a variable into the customer message", () => {
      const { uiOnPatch } = renderHandoff({
        actionInstruction: "Hello",
        uiScenarioPromptInputs: collectedName,
      });

      fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
      fireEvent.click(
        screen.getByTestId("service-message-variable-input.name")
      );

      expect(uiOnPatch).toHaveBeenLastCalledWith({
        actionInstruction: "Hello {{input.name}}",
      });
    });

    it("has no button, links and files section", () => {
      render(
        <EditorHarness data={{ kind: "action", actionType: "assign_human" }} />
      );

      expect(screen.queryByText("actionAdvancedSettings")).toBeNull();
    });
  });

  describe("generative AI", () => {
    const renderGenerative = (uiUsesSettingsPanel: boolean) => {
      const nodeData = createActionEditorTestData({
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "A teaser",
        },
        uiUsesSettingsPanel,
      });
      render(
        <ActionNodeGenerativeAIEditor
          nodeId="ai"
          nodeData={nodeData}
          patchNode={nodeData.uiOnPatch}
          promptInputFields={[]}
          t={t}
        />
      );
      return screen.getByTestId("generative-ai-editor");
    };

    it("keeps its own box on the canvas card", () => {
      expect(renderGenerative(false).className).toContain("border");
    });

    it("drops the nested box in the settings panel", () => {
      expect(renderGenerative(true).className).not.toContain("border");
    });
  });

  describe("branch summaries", () => {
    const branchState = (
      patch: Partial<ActionNodeBranchState>
    ): ActionNodeBranchState =>
      ({
        hasTelegramBranches: true,
        telegramBranchOptions: [{ text: "Sales", payload: "sales" }],
        hasInstagramBranches: false,
        instagramBranchOptions: [],
        hasWhatsAppServiceMessageBranches: false,
        whatsAppServiceMessageBranchOptions: [],
        hasWhatsAppTemplateButtonBranches: false,
        whatsAppTemplateButtonBranchOptions: [],
        showBulkTemplateFollowUpHint: false,
        ...patch,
      }) as unknown as ActionNodeBranchState;

    it("renders no per-channel branch boxes", () => {
      const { container } = render(
        <ActionNodeBranchSummaries branchState={branchState({})} t={t} />
      );

      expect(container).toBeEmptyDOMElement();
    });

    it("keeps the bulk template hint as an info notice", () => {
      const { container } = render(
        <ActionNodeBranchSummaries
          branchState={branchState({
            showBulkTemplateFollowUpHint: true,
            hasWhatsAppTemplateButtonBranches: true,
          })}
          t={t}
        />
      );

      expect(container.textContent).toBe("bulkTemplateFollowUpHint");
      expect(
        screen.getByText("bulkTemplateFollowUpHint").closest("[data-tone]")
      ).toHaveAttribute("data-tone", "info");
    });
  });
});
