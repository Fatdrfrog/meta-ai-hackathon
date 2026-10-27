"use client";

import type {
  ScenarioActionNodeEnrichment,
  ScenarioEditorValidationMode,
} from "../../../view/node-enrichment/types";
import { ScenarioGraphUndoContext } from "@/components/scenarios/view/graph/undo-context";
import { insertScenarioTemplateToken } from "@/components/scenarios/view/scenario-template-utils";
import type { ScenarioFormAnswerChoice } from "@/components/scenarios/view/node-enrichment/scenario-node-graph-index";
import type { ScenarioVariableExtraField } from "@/components/scenarios/view/scenario-variable-inserter";
import type { ScenarioOptionBranchHandleLayout } from "@/components/scenarios/source-handle-types";
import {
  readScenarioPromptInputAskKind,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import {
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ServiceMessageFieldErrorsContext } from "./service-message-field";
import type { WhatsAppInlineEditorInsertApi } from "../inline-editor";
import { ServiceMessageCarouselActions } from "./service-message-action-control";
import { ServiceMessageBodyControls } from "./service-message-body-controls";
import {
  ServiceMessageCurrentActionNotice,
  ServiceMessagePendingIntentDialog,
  ServiceMessageResourcesFailedNotice,
  ServiceMessageValidationNotice,
} from "./service-message-builder-notices";
import { bodyText } from "./service-message-builder-model";
import {
  getAvailableServiceMessageActions,
  projectServiceMessageEditor,
  type ServiceMessageEditorAction,
} from "./service-message-editor-model";
import { ServiceMessageEditorSurface } from "./service-message-editor-surface";
import {
  fieldErrorMessage,
  findServiceMessageFieldTarget,
  hasServiceMessageField,
  scrollToServiceMessageField,
} from "./service-message-field-errors";
import { ServiceMessagePromptInputs } from "./service-message-prompt-inputs";
import { useWhatsAppServiceMessageResources } from "./service-message-resources";
import { summarizeServiceMessageValidation } from "./service-message-validation-summary";
import { useServiceMessageEditor } from "./use-service-message-editor";

function commerceCatalogId(
  message: ScenarioWhatsAppServiceMessagePayload
): string | undefined {
  return message.kind === "commerce" ? message.commerce.catalogId : undefined;
}

/** Form errors live in the form editor, which opens instead of scrolling. */
function isFlowConfigField(fieldKey: string): boolean {
  return fieldKey.startsWith("flowConfig");
}

/** Whether a field on the step, or the preview bubble, shows the first issue. */
function isFirstIssueShownInline(
  root: HTMLElement | null,
  fieldKey: string | null,
  shownInPreview: boolean
): boolean {
  if (fieldKey === null) return false;
  return shownInPreview || hasServiceMessageField(fieldKey, root);
}

/** Whether "Show" can take the author to the first issue. */
function isFirstIssueReachable(
  root: HTMLElement | null,
  fieldKey: string | null,
  canOpenFlowEditor: boolean
): boolean {
  if (fieldKey === null) return false;
  if (isFlowConfigField(fieldKey)) return canOpenFlowEditor;
  return (
    root !== null && findServiceMessageFieldTarget(fieldKey, root) !== null
  );
}

/** Calls stay in the menu, disabled, until their availability loads. */
function loadingServiceMessageActions(
  loading: boolean,
  availableActions: ServiceMessageEditorAction[]
): ServiceMessageEditorAction[] {
  return loading && !availableActions.includes("voice_call")
    ? ["voice_call"]
    : [];
}

export function WhatsAppServiceMessageBuilder({
  actionNodeId,
  value,
  workspaceId,
  upload,
  generateVoice,
  renderOptionBranchHandle,
  connectedOptionIds,
  onBranchHandleViewportChange,
  onOpenFlowEditor,
  draftScope,
  validationMode = "runnable",
  hasWhatsAppCoexistence = false,
  promptInputFields,
  formAnswerSources,
  onChange,
}: {
  actionNodeId: string;
  value: ScenarioWhatsAppServiceMessage;
  workspaceId: string;
  /** Answers collected before this message; the body renders them. */
  promptInputFields?: ScenarioVariableExtraField[];
  /** Earlier forms whose answers AI instructions for the body can use. */
  formAnswerSources?: readonly ScenarioFormAnswerChoice[];
  upload?: ScenarioActionNodeEnrichment["uiMedia"]["upload"];
  generateVoice?: ScenarioActionNodeEnrichment["uiMedia"]["generateVoice"];
  renderOptionBranchHandle?: (
    option: ScenarioWhatsAppInteractiveOption,
    layout?: ScenarioOptionBranchHandleLayout
  ) => ReactNode;
  connectedOptionIds?: ReadonlySet<string>;
  onBranchHandleViewportChange?: () => void;
  /** Opens the inline flow drawer (template-style); owned by the action-node section. */
  onOpenFlowEditor?: () => void;
  draftScope?: string;
  validationMode?: ScenarioEditorValidationMode;
  hasWhatsAppCoexistence?: boolean;
  onChange: (value: ScenarioWhatsAppServiceMessage) => void;
}) {
  const t = useTranslations("Scenarios");
  const message = value.message;
  const resources = useWhatsAppServiceMessageResources({
    workspaceId,
    kind: message.kind,
    catalogId: commerceCatalogId(message),
  });
  const capabilities = {
    callingReady: resources.callingReady,
    hasWhatsAppCoexistence,
  };
  const projection = projectServiceMessageEditor(value, capabilities);
  const body = projection.body;
  const bodyInsertApiRef = useRef<WhatsAppInlineEditorInsertApi | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const history = useContext(ScenarioGraphUndoContext);
  const aiInstructionsId = useId();
  const aiInstructionsHintId = useId();
  const editor = useServiceMessageEditor({
    actionNodeId,
    value,
    workspaceId,
    draftScope,
    history,
    t,
    onChange,
    onOpenFlowEditor,
  });
  const validation = summarizeServiceMessageValidation({
    value,
    validationMode,
    supportsRenderer: projection.supportsRenderer,
    t,
  });
  const { fieldErrors, firstFieldKey, firstIssueInPreview } = validation;
  const canOpenFlowEditor = Boolean(onOpenFlowEditor);
  // The summary names the first issue when nothing on the step shows it (a
  // form that isn't set up, an internal id), so it never reads as a bare
  // count, and offers Show only when there is something to show. Both read
  // the rendered fields.
  const [firstIssueShownInline, setFirstIssueShownInline] = useState(true);
  const [firstIssueReachable, setFirstIssueReachable] = useState(true);
  useLayoutEffect(() => {
    setFirstIssueShownInline(
      isFirstIssueShownInline(
        rootRef.current,
        firstFieldKey,
        firstIssueInPreview
      )
    );
    setFirstIssueReachable(
      isFirstIssueReachable(rootRef.current, firstFieldKey, canOpenFlowEditor)
    );
  }, [firstFieldKey, firstIssueInPreview, canOpenFlowEditor, value]);
  const showFirstIssue = () => {
    if (!firstFieldKey) return;
    if (isFlowConfigField(firstFieldKey)) onOpenFlowEditor?.();
    else scrollToServiceMessageField(firstFieldKey, rootRef.current);
  };
  const handleBodyInsertApiChange = (
    api: WhatsAppInlineEditorInsertApi | null
  ) => {
    bodyInsertApiRef.current = api;
  };
  const handleInsertBodyToken = (token: string) => {
    if (bodyInsertApiRef.current) {
      bodyInsertApiRef.current.insertVariable(token);
      return;
    }
    editor.apply({
      type: "set_body",
      value: insertScenarioTemplateToken(bodyText(body), token),
    });
  };
  const availableActions = getAvailableServiceMessageActions(
    value,
    capabilities
  );
  const loadingActions = loadingServiceMessageActions(
    resources.loading,
    availableActions
  );
  const promptInputAsk = readScenarioPromptInputAskKind(message.kind);

  return (
    <ServiceMessageFieldErrorsContext.Provider value={fieldErrors}>
      <div
        ref={rootRef}
        className="nodrag w-full max-w-full"
        data-testid="whatsapp-service-message-builder"
      >
        <ServiceMessageResourcesFailedNotice
          kind={message.kind}
          resources={resources}
          t={t}
        />
        <ServiceMessageBodyControls
          body={body}
          bodyError={fieldErrorMessage(fieldErrors, "body")}
          aiInstructionsId={aiInstructionsId}
          aiInstructionsHintId={aiInstructionsHintId}
          promptInputFields={promptInputFields}
          formAnswerSources={formAnswerSources}
          t={t}
          apply={editor.apply}
          onInsertToken={handleInsertBodyToken}
        />
        <ServiceMessageEditorSurface
          actionNodeId={actionNodeId}
          message={message}
          projection={projection}
          fieldErrors={fieldErrors}
          resources={resources}
          availableActions={availableActions}
          loadingActions={loadingActions}
          editor={editor}
          upload={upload}
          generateVoice={generateVoice}
          renderOptionBranchHandle={renderOptionBranchHandle}
          connectedOptionIds={connectedOptionIds}
          onBranchHandleViewportChange={onBranchHandleViewportChange}
          onOpenFlowEditor={onOpenFlowEditor}
          onBodyInsertApiChange={handleBodyInsertApiChange}
          t={t}
        />
        {promptInputAsk ? (
          <ServiceMessagePromptInputs
            fields={value.promptInputs}
            ask={promptInputAsk}
            behavior={value.promptInputBehavior}
            t={t}
            onChange={editor.updatePromptInputs}
            onBehaviorChange={editor.updatePromptInputBehavior}
          />
        ) : null}
        {message.kind === "media_carousel" ? (
          <ServiceMessageCarouselActions
            cards={message.cards}
            availableActions={availableActions}
            loadingActions={loadingActions}
            editor={editor}
            onCardsChange={cards => editor.updateMessage({ ...message, cards })}
          />
        ) : null}
        <ServiceMessageCurrentActionNotice
          projection={projection}
          resources={resources}
          t={t}
        />
        <ServiceMessageValidationNotice
          validation={validation}
          firstIssueShownInline={firstIssueShownInline}
          firstIssueReachable={firstIssueReachable}
          t={t}
          onShowFirstIssue={showFirstIssue}
        />
        <ServiceMessagePendingIntentDialog
          intent={editor.pendingIntent}
          t={t}
          onDismiss={editor.dismissPendingIntent}
          onConfirm={editor.confirmPendingIntent}
        />
      </div>
    </ServiceMessageFieldErrorsContext.Provider>
  );
}
