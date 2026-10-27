"use client";

import type { TranslateFn } from "@/components/scenarios/types";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { lazy, Suspense, useId, useMemo, type ComponentProps } from "react";
import type { TelegramReplyBuilder } from "../../builders/telegram";
import { LazyWhatsAppInlineEditor } from "../../builders/whatsapp/lazy-inline-editor";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import { useScenarioGraphResources } from "../../view/graph/resources-context";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { ScenarioFormAnswerNotices } from "../../view/scenario-form-answer-notices";
import {
  describeUnsupportedScenarioTemplateTokens,
  insertScenarioTemplateToken,
} from "../../view/scenario-template-utils";
import { buildScenarioPromptInputVariableFields } from "../../view/scenario-variable-groups";
import {
  ScenarioVariableInserter,
  type ScenarioVariableExtraField,
} from "../../view/scenario-variable-inserter";
import {
  useScenarioAnswerVariableFields,
  useScenarioFormAnswerNotices,
  useScenarioTextareaTokenInsert,
  type ScenarioTextareaTokenInsert,
} from "../../view/use-scenario-ai-prompt-variables";
import { useSyncedDraftValue } from "../draft-state";
import { ActionNodeAssetsSection } from "./action-node-assets-section";
import {
  ActionNodeAdvancedSettings,
  FixedReplyEmptyWarning,
} from "./action-node-expanded-ui";
import {
  usesPlainReplyEditor,
  type ActionNodeReplyDraft,
  type PatchActionNode,
} from "./action-node-editor-state";
import type {
  ActionNodeBranchState,
  ActionNodeModeState,
} from "./action-node-state";
import {
  ActionNodeEditorLoading,
  LazyActionNodeGenerativeAISection,
  LazyTelegramReplyBuilder,
} from "./lazy-action-node-sections";
import { ReplyModeToggle } from "./reply-mode-toggle";

const LazyInstagramReplyBuilder = lazy(() =>
  import("../../builders/instagram").then(m => ({
    default: m.InstagramReplyBuilder,
  }))
);

/*
 * Editors shared by the inline action editor and the node settings panel.
 * None of them calls a React Flow hook or renders a React Flow handle of its
 * own: route handles come only from render callbacks the canvas passes.
 */

const FIELD_LABEL_CLASS = "text-[11px] font-medium text-muted-foreground";
const FIELD_HINT_CLASS = "text-[11px] leading-snug";

/** Answers collected before this step, offered in the Variables picker. */
function useActionNodeVariableFields(
  nodeData: ScenarioActionEditorNodeData
): ScenarioVariableExtraField[] {
  return useMemo(
    () =>
      buildScenarioPromptInputVariableFields(nodeData.uiScenarioPromptInputs),
    [nodeData.uiScenarioPromptInputs]
  );
}

/**
 * The Variables picker in the mode toolbar. Your text offers every
 * variable; AI writes offers only the answers before this step, the only
 * variables its instructions fill in.
 */
function ActionNodeReplyVariables({
  replyMode,
  nodeData,
  t,
  onInsertText,
  onInsertInstruction,
}: {
  replyMode: ActionNodeModeState["replyMode"];
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  onInsertText: (token: string) => void;
  onInsertInstruction: (token: string) => void;
}) {
  const variableFields = useActionNodeVariableFields(nodeData);
  const answerFields = useScenarioAnswerVariableFields(
    variableFields,
    nodeData.uiScenarioFormAnswerSources,
    t
  );
  const aiWrites = replyMode === "ai";
  return (
    <ScenarioVariableInserter
      t={t}
      variant="onLight"
      answersOnly={aiWrites}
      extraFields={aiWrites ? answerFields : variableFields}
      onInsertToken={aiWrites ? onInsertInstruction : onInsertText}
    />
  );
}

/** The instructions AI writes the reply from, and notes on their form answers. */
function ActionNodeReplyInstructions({
  draft,
  textareaRef,
  onTextareaBlur,
  nodeData,
  t,
  showLabels,
}: {
  draft: ActionNodeReplyDraft;
  textareaRef: ScenarioTextareaTokenInsert["attachTextarea"];
  onTextareaBlur: ScenarioTextareaTokenInsert["rememberSelection"];
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  showLabels: boolean;
}) {
  const instructionId = useId();
  const instructionLabel = t("whatsappServiceAiInstructions");
  const notices = useScenarioFormAnswerNotices(
    draft.instruction,
    nodeData.uiScenarioFormAnswerSources,
    "ai_reply",
    t
  );
  return (
    <div className="space-y-1">
      {showLabels ? (
        <FieldLabel htmlFor={instructionId} className={FIELD_LABEL_CLASS}>
          {instructionLabel}
        </FieldLabel>
      ) : null}
      <Textarea
        ref={textareaRef}
        id={instructionId}
        rows={3}
        value={draft.instruction}
        aria-label={showLabels ? undefined : instructionLabel}
        aria-describedby={notices.describedBy}
        aria-invalid={notices.unavailable ? true : undefined}
        onChange={event => draft.changeInstruction(event.target.value)}
        onBlur={onTextareaBlur}
        placeholder={t("actionReplyInstructionPlaceholder")}
        className="nodrag nopan"
      />
      <ScenarioFormAnswerNotices notices={notices} />
    </div>
  );
}

/**
 * Who writes a plain reply, then its AI instructions or its text. The
 * Variables picker sits in the mode toolbar and inserts at the caret.
 */
export function ActionNodeReplyEditor({
  mode,
  draft,
  nodeData,
  t,
  showLabels = false,
}: {
  mode: ActionNodeModeState;
  draft: ActionNodeReplyDraft;
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  /** Settings panel: visible field labels. The canvas uses aria-labels. */
  showLabels?: boolean;
}) {
  const { attachTextarea, rememberSelection, insertToken } =
    useScenarioTextareaTokenInsert(draft.instruction, draft.changeInstruction);
  if (!usesPlainReplyEditor(mode)) return null;
  return (
    <>
      <ReplyModeToggle
        value={mode.replyMode}
        onChange={nodeData.uiActionCommands.changeReplyMode}
        t={t}
      >
        <ActionNodeReplyVariables
          replyMode={mode.replyMode}
          nodeData={nodeData}
          t={t}
          onInsertText={draft.insertToken}
          onInsertInstruction={insertToken}
        />
      </ReplyModeToggle>

      {mode.replyMode === "ai" ? (
        <ActionNodeReplyInstructions
          draft={draft}
          textareaRef={attachTextarea}
          onTextareaBlur={rememberSelection}
          nodeData={nodeData}
          t={t}
          showLabels={showLabels}
        />
      ) : (
        <div className="space-y-1">
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-2">
            <LazyWhatsAppInlineEditor
              value={draft.text}
              onChange={draft.changeText}
              onInsertApiChange={draft.onInsertApiChange}
              resolveVariableLabel={draft.resolveVariableLabel}
              ariaLabel={t("scenarioMessageEditorLabel")}
              placeholder={t("actionReplyTextPlaceholder")}
              outputFormat="plain_text"
              className="nodrag min-h-[88px] text-sm text-foreground [&_.ProseMirror]:min-h-[88px]"
              multiline
            />
          </div>
          {!draft.text.trim() ? (
            <FixedReplyEmptyWarning message={t("fixedReplyEmptyWarning")} />
          ) : null}
        </div>
      )}
    </>
  );
}

/** Empty Telegram text and unsupported reply variables. */
export function ActionNodeReplyWarnings({
  mode,
  draft,
  t,
}: {
  mode: ActionNodeModeState;
  draft: ActionNodeReplyDraft;
  t: TranslateFn;
}) {
  return (
    <>
      {mode.isTelegramBuilder && !draft.text.trim() ? (
        <FixedReplyEmptyWarning message={t("fixedReplyEmptyWarning")} />
      ) : null}

      {draft.tokenWarning ? (
        <FixedReplyEmptyWarning message={draft.tokenWarning} />
      ) : null}
    </>
  );
}

/** Telegram reply text and button rows. */
export function ActionNodeTelegramEditor({
  mode,
  draft,
  nodeData,
  patchNode,
  renderButtonBranchHandle,
  routeAnchorHandleIds,
  onRouteAnchorsRemoved,
}: {
  mode: ActionNodeModeState;
  draft: ActionNodeReplyDraft;
  nodeData: ScenarioActionEditorNodeData;
  patchNode: PatchActionNode;
  renderButtonBranchHandle?: ComponentProps<
    typeof TelegramReplyBuilder
  >["renderButtonBranchHandle"];
} & Pick<
  ComponentProps<typeof LazyTelegramReplyBuilder>,
  "routeAnchorHandleIds" | "onRouteAnchorsRemoved"
>) {
  const variableFields = useActionNodeVariableFields(nodeData);
  if (!mode.isTelegramBuilder) return null;
  return (
    <div className="nodrag">
      <LazyTelegramReplyBuilder
        messageText={draft.text}
        onMessageTextChange={draft.changeText}
        quickReplies={nodeData.actionTelegramQuickReplies}
        connectedPayloads={nodeData.uiConnections.telegramPayloads}
        renderButtonBranchHandle={renderButtonBranchHandle}
        routeAnchorHandleIds={routeAnchorHandleIds}
        onRouteAnchorsRemoved={onRouteAnchorsRemoved}
        onInsertToken={draft.insertToken}
        variableFields={variableFields}
        onChange={next => {
          patchNode({ actionTelegramQuickReplies: next });
        }}
        onButtonListChanged={next => {
          nodeData.uiActionCommands.changeTelegramQuickReplies(next);
        }}
      />
    </div>
  );
}

/**
 * Instagram reply mode, text and options, and why a bulk campaign disables
 * it. Its options share one route, so it renders no handles.
 */
export function ActionNodeInstagramEditor({
  mode,
  draft,
  nodeData,
  patchNode,
  t,
}: {
  mode: ActionNodeModeState;
  draft: ActionNodeReplyDraft;
  nodeData: ScenarioActionEditorNodeData;
  patchNode: PatchActionNode;
  t: TranslateFn;
}) {
  const variableFields = useActionNodeVariableFields(nodeData);
  if (!mode.isInstagramReply) return null;
  return (
    <div className="nodrag space-y-2">
      <Suspense
        fallback={<ActionNodeEditorLoading label={t("loadingItems")} />}
      >
        <LazyInstagramReplyBuilder
          replyMode={mode.replyMode}
          onReplyModeChange={nodeData.uiActionCommands.changeReplyMode}
          messageText={draft.text}
          onMessageTextChange={draft.changeText}
          instructionText={draft.instruction}
          onInstructionTextChange={draft.changeInstruction}
          config={nodeData.actionInstagramConfig}
          disabled={mode.isInstagramReplyDisabled}
          connectedPayloads={nodeData.uiConnections.instagramPayloads}
          onInsertToken={draft.insertToken}
          variableFields={variableFields}
          onConfigChange={next => {
            patchNode({ actionInstagramConfig: next });
          }}
          onBranchOptionsChanged={next => {
            nodeData.uiActionCommands.changeInstagramConfig(next);
          }}
        />
      </Suspense>
      {mode.instagramReplyDisabledReason ? (
        <ScenarioInlineNotice tone="warning">
          {mode.instagramReplyDisabledReason}
        </ScenarioInlineNotice>
      ) : null}
    </div>
  );
}

/**
 * The bulk template hint. Buttons and choices show their own routes, and the
 * settings panel lists every route, so no per-channel branch box remains.
 */
export function ActionNodeBranchSummaries({
  branchState,
  t,
}: {
  branchState: ActionNodeBranchState;
  t: TranslateFn;
}) {
  if (!branchState.showBulkTemplateFollowUpHint) return null;
  return (
    <ScenarioInlineNotice tone="info">
      {branchState.hasWhatsAppTemplateButtonBranches
        ? t("bulkTemplateFollowUpHint")
        : t("bulkTemplateAddQuickReplyForFollowUps")}
    </ScenarioInlineNotice>
  );
}

/** Handoff message and the optional team notifications. */
export function ActionNodeHandoffEditor({
  nodeData,
  patchNode,
  t,
}: {
  nodeData: ScenarioActionEditorNodeData;
  patchNode: PatchActionNode;
  t: TranslateFn;
}) {
  const [instructionDraft, setInstructionDraft] = useSyncedDraftValue(
    nodeData.actionInstruction || ""
  );
  const [notifyEmailDraft, setNotifyEmailDraft] = useSyncedDraftValue(
    nodeData.actionHandoffNotifyEmail || ""
  );
  const [notifyWhatsappDraft, setNotifyWhatsappDraft] = useSyncedDraftValue(
    nodeData.actionHandoffNotifyWhatsapp || ""
  );
  const instructionTokenWarning = describeUnsupportedScenarioTemplateTokens(
    instructionDraft,
    t
  );
  const variableFields = useActionNodeVariableFields(nodeData);
  const fieldId = useId();
  const messageId = `${fieldId}-message`;
  const sentAsId = `${fieldId}-sent-as`;
  const emailId = `${fieldId}-email`;
  const whatsappId = `${fieldId}-whatsapp`;
  const whatsappHintId = `${fieldId}-whatsapp-hint`;

  const changeInstruction = (value: string) => {
    setInstructionDraft(value);
    patchNode({ actionInstruction: value });
  };

  return (
    <div className="space-y-3">
      <Field className="gap-1">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
          <FieldLabel htmlFor={messageId} className={FIELD_LABEL_CLASS}>
            {t("handoffMessageLabel")}
          </FieldLabel>
          <ScenarioVariableInserter
            t={t}
            variant="onLight"
            extraFields={variableFields}
            onInsertToken={token =>
              changeInstruction(
                insertScenarioTemplateToken(instructionDraft, token)
              )
            }
          />
        </div>
        <Textarea
          id={messageId}
          rows={3}
          value={instructionDraft}
          aria-describedby={sentAsId}
          onChange={event => changeInstruction(event.target.value)}
          placeholder={t("actionInstructionPlaceholder")}
          className="nodrag nopan"
        />
        <FieldDescription id={sentAsId} className={FIELD_HINT_CLASS}>
          {t("handoffMessageSentAs")}
        </FieldDescription>
        {instructionTokenWarning ? (
          <FixedReplyEmptyWarning message={instructionTokenWarning} />
        ) : null}
      </Field>
      <FieldSet className="min-w-0 gap-2">
        <FieldLegend variant="label" className={cn("mb-0", FIELD_LABEL_CLASS)}>
          {t("handoffNotifyLegend")}
        </FieldLegend>
        <Field className="gap-1">
          <FieldLabel htmlFor={emailId} className={FIELD_LABEL_CLASS}>
            {t("handoffNotifyEmailLabel")}
          </FieldLabel>
          <Input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={notifyEmailDraft}
            onChange={event => {
              setNotifyEmailDraft(event.target.value);
              patchNode({
                actionHandoffNotifyEmail: event.target.value,
              });
            }}
            placeholder={t("handoffNotifyEmailPlaceholder")}
            className="nodrag nopan h-8 text-xs"
          />
        </Field>
        <Field className="gap-1">
          <FieldLabel htmlFor={whatsappId} className={FIELD_LABEL_CLASS}>
            {t("handoffNotifyWhatsappLabel")}
          </FieldLabel>
          <Input
            id={whatsappId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={notifyWhatsappDraft}
            aria-describedby={whatsappHintId}
            onChange={event => {
              setNotifyWhatsappDraft(event.target.value);
              patchNode({
                actionHandoffNotifyWhatsapp: event.target.value,
              });
            }}
            placeholder={t("handoffNotifyWhatsappPlaceholder")}
            className="nodrag nopan h-8 text-xs"
          />
          <FieldDescription id={whatsappHintId} className={FIELD_HINT_CLASS}>
            {t("handoffNotifyWhatsappHint")}
          </FieldDescription>
        </Field>
      </FieldSet>
    </div>
  );
}

/** Generative AI settings, reset per scenario and node. */
export function ActionNodeGenerativeAIEditor({
  nodeId,
  nodeData,
  patchNode,
  promptInputFields,
  t,
}: {
  nodeId: string;
  nodeData: ScenarioActionEditorNodeData;
  patchNode: PatchActionNode;
  promptInputFields: ScenarioVariableExtraField[];
  t: TranslateFn;
}) {
  return (
    <LazyActionNodeGenerativeAISection
      key={`${nodeData.uiActiveScenarioId ?? "draft"}:${nodeId}`}
      workspaceId={nodeData.uiWorkspaceId}
      upload={nodeData.uiMedia.upload}
      validationMode={nodeData.uiValidationMode}
      config={nodeData.actionGenerativeAIConfig}
      promptInputFields={promptInputFields}
      pickedOptionSources={nodeData.uiScenarioPickedOptionSources}
      formAnswerSources={nodeData.uiScenarioFormAnswerSources}
      layout={nodeData.uiUsesSettingsPanel ? "panel" : "card"}
      patchNode={patchNode}
      t={t}
    />
  );
}

/**
 * The reply's button, links and files. Variables live next to the text they
 * fill, so a step without assets has no section.
 */
export function ActionNodeAdvancedSection({
  mode,
  nodeData,
  patchNode,
  promptInputFields,
  showAdvanced,
  onToggle,
  onInsertToken,
  t,
}: {
  mode: ActionNodeModeState;
  nodeData: ScenarioActionEditorNodeData;
  patchNode: PatchActionNode;
  promptInputFields: ScenarioVariableExtraField[];
  showAdvanced: boolean;
  onToggle: () => void;
  onInsertToken: (token: string) => void;
  t: TranslateFn;
}) {
  const { whatsAppFlowsLoading, whatsAppFlowsRefreshing } =
    useScenarioGraphResources();
  if (
    mode.isWhatsAppTemplateAction ||
    mode.isWhatsAppServiceMessage ||
    mode.isGenerativeAI
  ) {
    return null;
  }
  const showActionAssets =
    mode.actionType === "reply" &&
    !mode.isWhatsAppServiceMessage &&
    !mode.isInstagramReply;
  const replyFixedAssets =
    mode.actionType === "reply" &&
    mode.replyMode === "fixed" &&
    !mode.isTelegramBuilder &&
    !mode.isInstagramReply;
  const telegramCompactAssets =
    mode.actionType === "reply" &&
    mode.replyMode === "fixed" &&
    mode.isTelegramBuilder;
  if (!showActionAssets) return null;

  return (
    <ActionNodeAdvancedSettings
      actionAssetsSection={
        <ActionNodeAssetsSection
          nodeData={nodeData}
          patchNode={patchNode}
          replyCtaType={mode.replyCtaType}
          replyFixedAssets={replyFixedAssets}
          telegramCompactAssets={telegramCompactAssets}
          whatsAppFlowsLoading={whatsAppFlowsLoading}
          whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
        />
      }
      showAdvanced={showAdvanced}
      showAdvancedActionAssets
      showTokenControls={false}
      promptInputFields={promptInputFields}
      t={t}
      onInsertToken={onInsertToken}
      onToggle={onToggle}
    />
  );
}
