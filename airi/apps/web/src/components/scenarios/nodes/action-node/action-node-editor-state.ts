import type {
  ScenarioActionSelectorType,
  ScenarioActionSourceId,
  ScenarioNodeData,
  TranslateFn,
} from "@/components/scenarios/types";
import { useCallback, useMemo, useRef, type ComponentProps } from "react";
import type { WhatsAppInlineEditorInsertApi } from "../../builders/whatsapp/inline-editor";
import { resolveDefaultActionSelectorForSource } from "../../view/action/selector-utils";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { buildScenarioFormAnswerTokenLabels } from "../../view/scenario-form-answer-labels";
import {
  createScenarioTokenLabelResolver,
  describeUnsupportedScenarioTemplateTokens,
  insertScenarioTemplateToken,
} from "../../view/scenario-template-utils";
import { useSyncedDraftValue } from "../draft-state";
import type { ActionNodeSourceControls } from "./action-node-expanded-ui";
import type { ActionNodeModeState } from "./action-node-state";

/*
 * State the inline action editor and the node settings panel share: which
 * editors apply, the source controls and the reply drafts.
 */

export type PatchActionNode = (patch: Partial<ScenarioNodeData>) => void;

/** Whether the Outcomes editor applies; handoff and Generative AI have none. */
export function showsActionNodeOutcomes(mode: ActionNodeModeState): boolean {
  return mode.actionType !== "assign_human" && !mode.isGenerativeAI;
}

/** Props for `ActionNodeSourceControls`: source and WhatsApp kind switching. */
export function useActionNodeSourceControls({
  nodeData,
  mode,
  t,
}: {
  nodeData: ScenarioActionEditorNodeData;
  mode: ActionNodeModeState;
  t: TranslateFn;
}): ComponentProps<typeof ActionNodeSourceControls> {
  const onActionSourceChange = useCallback(
    (value: string) => {
      const sourceId = value as ScenarioActionSourceId;
      const nextSelectorType = resolveDefaultActionSelectorForSource({
        sourceId,
        currentSelectorType: mode.actionSelectorType,
      });
      if (nextSelectorType === mode.actionSelectorType) return;
      nodeData.uiActionCommands.changeType(nextSelectorType);
    },
    [mode.actionSelectorType, nodeData]
  );
  const onWhatsAppActionKindChange = useCallback(
    (value: string) => {
      const nextSelectorType = value as ScenarioActionSelectorType;
      if (nextSelectorType === mode.actionSelectorType) return;
      nodeData.uiActionCommands.changeType(nextSelectorType);
    },
    [mode.actionSelectorType, nodeData]
  );
  const whatsAppActionKindOptions = useMemo(
    () => [
      {
        id: "whatsapp_service_message" as const,
        label: t("whatsappActionKindServiceMessage"),
      },
      {
        id: "whatsapp_template" as const,
        label: t("whatsappActionKindTemplate"),
      },
    ],
    [t]
  );
  return {
    actionSourceOptions: nodeData.uiActionSourceOptions,
    // Generative AI has no channel. Handoff keeps the channel select: picking
    // a channel is its only way to become a message step.
    hidden: mode.isGenerativeAI,
    selectedActionSourceId: mode.selectedActionSourceId,
    showWhatsAppActionKindSelect: mode.showWhatsAppActionKindSelect,
    t,
    whatsAppActionKindOptions,
    whatsAppActionKindValue:
      mode.isWhatsAppServiceMessage || mode.isWhatsAppTemplateAction
        ? mode.actionSelectorType
        : "whatsapp_service_message",
    onActionSourceChange,
    onWhatsAppActionKindChange,
  };
}

export type ActionNodeReplyDraft = {
  instruction: string;
  text: string;
  changeInstruction: (value: string) => void;
  changeText: (value: string) => void;
  /** Inserts a variable at the fixed-reply caret, or appends it. */
  insertToken: (token: string) => void;
  onInsertApiChange: (api: WhatsAppInlineEditorInsertApi | null) => void;
  resolveVariableLabel: (token: string) => string;
  /** Unsupported variables in fixed reply text (plain, Telegram, Instagram). */
  tokenWarning: string | null;
};

/**
 * Local reply drafts. They also feed the Telegram and Instagram builders,
 * which edit the same reply text and instruction.
 */
export function useActionNodeReplyDraft({
  nodeData,
  mode,
  patchNode,
  t,
}: {
  nodeData: ScenarioActionEditorNodeData;
  mode: ActionNodeModeState;
  patchNode: PatchActionNode;
  t: TranslateFn;
}): ActionNodeReplyDraft {
  const insertApiRef = useRef<WhatsAppInlineEditorInsertApi | null>(null);
  const [instruction, setInstruction] = useSyncedDraftValue(
    nodeData.actionReplyInstruction || ""
  );
  const [text, setText] = useSyncedDraftValue(
    nodeData.actionReplyText || "",
    !mode.isWhatsAppTemplateAction
  );

  const changeInstruction = useCallback(
    (value: string) => {
      setInstruction(value);
      patchNode({ actionReplyInstruction: value });
    },
    [patchNode, setInstruction]
  );

  const changeText = useCallback(
    (value: string) => {
      setText(value);
      patchNode({ actionReplyText: value });
    },
    [patchNode, setText]
  );

  const insertToken = useCallback(
    (token: string) => {
      if (mode.actionType !== "reply" || mode.replyMode !== "fixed") return;

      if (insertApiRef.current) {
        insertApiRef.current.insertVariable(token);
        return;
      }

      const nextReplyText = insertScenarioTemplateToken(text || "", token);
      setText(nextReplyText);
      patchNode({
        actionReplyText: nextReplyText,
      });
    },
    [mode.actionType, mode.replyMode, patchNode, text, setText]
  );

  const onInsertApiChange = useCallback(
    (api: WhatsAppInlineEditorInsertApi | null) => {
      insertApiRef.current = api;
    },
    []
  );

  // A form answer typed into the text reads as it does in Variables.
  const resolveVariableLabel = useMemo(
    () =>
      createScenarioTokenLabelResolver(
        key => t(key),
        buildScenarioFormAnswerTokenLabels(nodeData.uiScenarioFormAnswerSources)
      ),
    [nodeData.uiScenarioFormAnswerSources, t]
  );
  // Fixed reply text (plain, Telegram or Instagram) is rendered as a template.
  const tokenWarning =
    mode.actionType === "reply" &&
    mode.replyMode === "fixed" &&
    !mode.isWhatsAppServiceMessage
      ? describeUnsupportedScenarioTemplateTokens(text, t)
      : null;

  return {
    instruction,
    text,
    changeInstruction,
    changeText,
    insertToken,
    onInsertApiChange,
    resolveVariableLabel,
    tokenWarning,
  };
}

/** Whether the plain reply editor applies (not a builder reply). */
export function usesPlainReplyEditor(mode: ActionNodeModeState): boolean {
  return (
    mode.actionType === "reply" &&
    !mode.isTelegramBuilder &&
    !mode.isInstagramReply &&
    !mode.isWhatsAppServiceMessage
  );
}
