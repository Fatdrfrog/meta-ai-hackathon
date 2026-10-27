"use client";

import {
  getScenarioWhatsAppServiceBodySource,
  type ScenarioPromptInputBehavior,
  type ScenarioPromptInputField,
  type ScenarioWhatsAppBodySource,
  type ScenarioWhatsAppCarouselCard,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { useState, type ContextType, type RefObject } from "react";
import { toast } from "sonner";
import {
  SCENARIO_UNDO_TOAST_DURATION_MS,
  type ScenarioGraphUndoContext,
} from "@/components/scenarios/view/graph/undo-context";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import type { TranslateFn } from "../../../types";
import { useScenarioEditorDraftStore } from "../../../view/editor-drafts";
import { bodyText } from "./service-message-builder-model";
import { createCarouselDraftCards } from "./service-message-carousel-fields";
import {
  applyServiceMessageEditorIntent,
  retainScenarioPromptInputs,
  type ServiceMessageEditorAction,
  type ServiceMessageEditorIntent,
} from "./service-message-editor-model";
import { createServiceMessageOptionId } from "./service-message-ids";

type UndoHistory = ContextType<typeof ScenarioGraphUndoContext>;
type DraftStore = ReturnType<typeof useScenarioEditorDraftStore>;

/** Keeps the current body so a mode or type switch can bring it back. */
function saveBodyDrafts(
  drafts: DraftStore,
  draftPrefix: string,
  currentBody: ScenarioWhatsAppBodySource | undefined
) {
  if (!currentBody) return;
  drafts.set(draftPrefix + ":body:" + currentBody.mode, bodyText(currentBody));
  drafts.set(draftPrefix + ":last-body", currentBody);
}

/** Switching body mode restores the text last written in that mode. */
function restoreBodyModeDraft(
  drafts: DraftStore,
  draftPrefix: string,
  next: ScenarioWhatsAppServiceMessage,
  intent: ServiceMessageEditorIntent
): ScenarioWhatsAppServiceMessage {
  if (intent.type !== "set_body_mode") return next;
  const saved = drafts.get<string>(draftPrefix + ":body:" + intent.mode);
  if (saved === undefined) return next;
  return applyServiceMessageEditorIntent(next, {
    type: "set_body",
    value: saved,
  });
}

/**
 * Changing the type saves the current message under its kind, restores the
 * one saved for the new kind, and keeps the body the author wrote.
 */
function restoreActionDrafts(
  drafts: DraftStore,
  draftPrefix: string,
  current: ScenarioWhatsAppServiceMessage,
  currentBody: ScenarioWhatsAppBodySource | undefined,
  next: ScenarioWhatsAppServiceMessage,
  intent: Extract<
    ServiceMessageEditorIntent,
    { type: "select_action" | "remove_action" }
  >
): ScenarioWhatsAppServiceMessage {
  drafts.set(draftPrefix + ":kind:" + current.message.kind, current);
  let restored = next;
  if (intent.type === "select_action" && next !== current) {
    restored =
      drafts.get<ScenarioWhatsAppServiceMessage>(
        draftPrefix + ":kind:" + intent.action
      ) ?? restored;
  }
  const retainedBody =
    currentBody ??
    drafts.get<ScenarioWhatsAppBodySource>(draftPrefix + ":last-body");
  if (retainedBody && getScenarioWhatsAppServiceBodySource(restored)) {
    restored = applyServiceMessageEditorIntent(restored, {
      type: "set_body_mode",
      mode: retainedBody.mode,
    });
    restored = applyServiceMessageEditorIntent(restored, {
      type: "set_body",
      value: bodyText(retainedBody),
    });
  }
  return restored;
}

function changedButtonType(
  current: ScenarioWhatsAppServiceMessage,
  next: ScenarioWhatsAppServiceMessage
): boolean {
  const hadButtons =
    current.message.kind !== "text" && current.message.kind !== "media";
  return hadButtons && next.message.kind !== current.message.kind;
}

// A changed button type drops routes; the canvas history can bring them back.
function showButtonTypeUndoToast(
  t: TranslateFn,
  actionNodeId: string,
  historyRef: RefObject<UndoHistory>
) {
  if (!historyRef.current) return;
  toast(t("whatsappServiceUndoHint"), {
    id: "whatsapp-service-button-type:" + actionNodeId,
    duration: SCENARIO_UNDO_TOAST_DURATION_MS,
    action: {
      label: t("whatsappServiceUndo"),
      onClick: () => {
        const history = historyRef.current;
        if (typeof history === "function") history();
        else history?.undo();
      },
    },
  });
}

/** Picking the current type again, or reply buttons on a list, changes nothing. */
function isCurrentAction(
  current: ScenarioWhatsAppServiceMessagePayload,
  intent: ServiceMessageEditorIntent
): boolean {
  return (
    intent.type === "select_action" &&
    (current.kind === intent.action ||
      (current.kind === "list" && intent.action === "reply_buttons"))
  );
}

/** Replacing a type with buttons, or a fourth reply button, asks first. */
function needsConfirmation(
  current: ScenarioWhatsAppServiceMessagePayload,
  intent: ServiceMessageEditorIntent
): boolean {
  const changingAction =
    (intent.type === "select_action" || intent.type === "remove_action") &&
    current.kind !== "text" &&
    current.kind !== "media";
  const changingToList =
    intent.type === "add_choice" &&
    current.kind === "reply_buttons" &&
    current.options.length === 3;
  return changingAction || changingToList;
}

function opensFlowEditor(intent: ServiceMessageEditorIntent): boolean {
  return intent.type === "select_action" && intent.action === "flow";
}

/**
 * Edits of a service message: every change goes through `apply` or a commit,
 * which keeps `valueRef` ahead of the parent so quick edits build on each other.
 */
export function useServiceMessageEditor({
  actionNodeId,
  value,
  workspaceId,
  draftScope,
  history,
  t,
  onChange,
  onOpenFlowEditor,
}: {
  actionNodeId: string;
  value: ScenarioWhatsAppServiceMessage;
  workspaceId: string;
  draftScope?: string;
  history: UndoHistory;
  t: TranslateFn;
  onChange: (value: ScenarioWhatsAppServiceMessage) => void;
  onOpenFlowEditor?: () => void;
}) {
  const valueRef = useLatestRef(value);
  const historyRef = useLatestRef(history);
  const drafts = useScenarioEditorDraftStore();
  const draftPrefix =
    "service:" + JSON.stringify([workspaceId, draftScope, actionNodeId]);
  const [pendingIntent, setPendingIntent] =
    useState<ServiceMessageEditorIntent | null>(null);

  const commit = (next: ScenarioWhatsAppServiceMessage) => {
    valueRef.current = next;
    onChange(next);
  };
  const apply = (intent: ServiceMessageEditorIntent) => {
    const current = valueRef.current;
    const currentBody = getScenarioWhatsAppServiceBodySource(current);
    saveBodyDrafts(drafts, draftPrefix, currentBody);
    let next = restoreBodyModeDraft(
      drafts,
      draftPrefix,
      applyServiceMessageEditorIntent(current, intent),
      intent
    );
    if (intent.type === "select_action" || intent.type === "remove_action") {
      next = restoreActionDrafts(
        drafts,
        draftPrefix,
        current,
        currentBody,
        next,
        intent
      );
      if (changedButtonType(current, next))
        showButtonTypeUndoToast(t, actionNodeId, historyRef);
    }
    if (next !== current) commit(next);
  };
  const updateMessage = (message: ScenarioWhatsAppServiceMessagePayload) =>
    commit(
      retainScenarioPromptInputs(valueRef.current, { version: 1, message })
    );
  const createOptionId = () => createServiceMessageOptionId(actionNodeId);
  const createDraftChoice = (): ScenarioWhatsAppInteractiveOption => ({
    id: createOptionId(),
    label: "",
  });
  const requestIntent = (intent: ServiceMessageEditorIntent) => {
    const current = valueRef.current.message;
    if (isCurrentAction(current, intent)) return;
    if (needsConfirmation(current, intent)) {
      setPendingIntent(intent);
      return;
    }
    apply(intent);
    if (opensFlowEditor(intent)) onOpenFlowEditor?.();
  };

  return {
    apply,
    updateMessage,
    createOptionId,
    selectAction: (action: ServiceMessageEditorAction) =>
      requestIntent({
        type: "select_action",
        action,
        createDraftChoice,
        createCarouselCards:
          action === "media_carousel"
            ? () => createCarouselDraftCards(createOptionId)
            : undefined,
      }),
    addChoice: () =>
      requestIntent({
        type: "add_choice",
        listButtonLabel: t("whatsappServiceListDefaultButton"),
        option: {
          id: createServiceMessageOptionId(actionNodeId),
          label: "",
        },
      }),
    removeAction: () => requestIntent({ type: "remove_action" }),
    updateCarouselCards: (cards: ScenarioWhatsAppCarouselCard[]) => {
      const current = valueRef.current;
      if (current.message.kind !== "media_carousel") return;
      commit({ ...current, message: { ...current.message, cards } });
    },
    updatePromptInputs: (fields: ScenarioPromptInputField[]) => {
      const current = valueRef.current;
      commit(
        fields.length > 0
          ? { ...current, promptInputs: fields }
          : { version: 1, message: current.message }
      );
    },
    updatePromptInputBehavior: (
      promptInputBehavior: ScenarioPromptInputBehavior
    ) => commit({ ...valueRef.current, promptInputBehavior }),
    pendingIntent,
    dismissPendingIntent: () => setPendingIntent(null),
    confirmPendingIntent: () => {
      if (pendingIntent) {
        apply(pendingIntent);
        if (opensFlowEditor(pendingIntent)) onOpenFlowEditor?.();
      }
      setPendingIntent(null);
    },
  };
}

export type ServiceMessageEditor = ReturnType<typeof useServiceMessageEditor>;
