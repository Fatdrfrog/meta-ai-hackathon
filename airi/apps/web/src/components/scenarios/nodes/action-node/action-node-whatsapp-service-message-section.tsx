"use client";

import { WhatsAppServiceMessageBuilder } from "@/components/scenarios/builders/whatsapp/service-message";
import type { FlowBranchOptionHandleRenderParams } from "@/components/scenarios/builders/whatsapp/field-editor";
import {
  extractFlowBranchOptions,
  type FlowBranchOption,
} from "@/lib/scenarios/whatsapp-flow-branches";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import {
  buildWhatsAppServiceMessagePatch,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import { Button } from "@/components/ui/button";
import {
  createDefaultScenarioWhatsAppServiceMessage,
  getScenarioWhatsAppServiceBodySource,
  readScenarioActionPromptInputAsk,
  type ScenarioActionOutcomes,
  type ScenarioWhatsAppServiceMessage,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScenarioNodeData, TranslateFn } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { buildScenarioPromptInputVariableFields } from "../../view/scenario-variable-groups";
import { describeUnsupportedScenarioTemplateTokens } from "../../view/scenario-template-utils";
import type { ScenarioOptionBranchHandleLayout } from "../../source-handle-types";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import { FixedReplyEmptyWarning } from "./action-node-expanded-ui";
import { FlowBranchPreview } from "./action-node-flow-branch-preview";
import {
  DEFAULT_NO_REPLY_TIMEOUT_MINUTES,
  readEditableActionOutcomes,
  withDefaultNoReplyOutcome,
} from "./action-node-state";
import { stopScenarioWheelPropagation } from "./action-node-utils";
import { formatNoReplyDuration } from "./no-reply-timeout";
import { ActionNodeWhatsAppFlowBuilder } from "./action-node-whatsapp-flow-section";

export function ActionNodeWhatsAppServiceMessageSection({
  id,
  nodeData,
  patchNode,
  whatsAppFlowsLoading,
  whatsAppFlowsRefreshing,
  renderOptionBranchHandle,
  connectedOptionIds,
  renderFlowBranchHandle,
  onLayoutChange,
  hasWhatsAppCoexistence,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  whatsAppFlowsLoading: boolean;
  whatsAppFlowsRefreshing: boolean;
  /** Canvas only. */
  renderOptionBranchHandle?: (
    option: {
      id: string;
      label: string;
    },
    layout?: ScenarioOptionBranchHandleLayout
  ) => ReactNode;
  connectedOptionIds: ReadonlySet<string>;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  onLayoutChange?: () => void;
  hasWhatsAppCoexistence: boolean;
}) {
  const t = useTranslations("Scenarios");
  const flowPanelTitleId = useId();
  const { isReadOnlyUnsupported, value } =
    resolveServiceMessageSectionValue(nodeData);
  const isFlowMessage = value.message.kind === "flow";
  const { flowConfig, flowBranchOptions } = readServiceMessageFlow(value);
  const promptInputFields = useMemo(
    () =>
      buildScenarioPromptInputVariableFields(nodeData.uiScenarioPromptInputs),
    [nodeData.uiScenarioPromptInputs]
  );
  const bodyTokenWarning = describeServiceMessageBodyTokens(value, t);
  const { flowPanelRef, flowEditorOpen, openFlowEditor, closeFlowEditor } =
    useServiceMessageFlowEditor(isFlowMessage, onLayoutChange);
  const reminderOutcomes = resolveNoReplyReminderOutcomes(nodeData);

  // Changes made here that move Flow branch handles ask the canvas to
  // re-measure; the expanded node covers Flow branch changes made elsewhere.
  const handleFlowConfigChange = useCallback(
    (config: WhatsAppFlowConfig) => {
      if (value.message.kind !== "flow") return;
      const sanitized = sanitizeWhatsAppFlowConfig(config) ?? config;
      patchNode(
        buildWhatsAppServiceMessagePatch({
          version: 1,
          message: { ...value.message, flowConfig: sanitized },
        })
      );
      onLayoutChange?.();
    },
    [onLayoutChange, patchNode, value.message]
  );

  if (isReadOnlyUnsupported) {
    return (
      <div className="w-full max-w-full">
        <FixedReplyEmptyWarning
          message={t("whatsappServiceMessageUnsupportedEditor")}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-full flex-col gap-2">
      <WhatsAppServiceMessageBuilder
        key={`${nodeData.uiWorkspaceId}:${nodeData.uiActiveScenarioId}:${id}`}
        actionNodeId={id}
        draftScope={nodeData.uiActiveScenarioId ?? undefined}
        value={value}
        validationMode={nodeData.uiValidationMode}
        workspaceId={nodeData.uiWorkspaceId?.trim() || ""}
        promptInputFields={promptInputFields}
        formAnswerSources={nodeData.uiScenarioFormAnswerSources}
        upload={nodeData.uiMedia.upload}
        generateVoice={nodeData.uiMedia.generateVoice}
        hasWhatsAppCoexistence={hasWhatsAppCoexistence}
        renderOptionBranchHandle={renderOptionBranchHandle}
        connectedOptionIds={connectedOptionIds}
        onBranchHandleViewportChange={onLayoutChange}
        onOpenFlowEditor={openFlowEditor}
        onChange={next => {
          patchNode(buildWhatsAppServiceMessagePatch(next));
          onLayoutChange?.();
        }}
      />

      {bodyTokenWarning ? (
        <FixedReplyEmptyWarning message={bodyTokenWarning} />
      ) : null}

      {/* Drafts get the gentle hint; an activation attempt shows the
          builder's own field error instead. */}
      {nodeData.uiValidationMode === "draft" &&
      value.message.kind === "text" &&
      value.message.body.mode === "fixed" &&
      !value.message.body.text.trim() ? (
        <FixedReplyEmptyWarning message={t("fixedReplyEmptyWarning")} />
      ) : null}

      {reminderOutcomes ? (
        <ServiceMessageNoReplyReminder
          outcomes={reminderOutcomes}
          patchNode={patchNode}
          onLayoutChange={onLayoutChange}
          t={t}
        />
      ) : null}

      {isFlowMessage && flowBranchOptions.length > 0 && !flowEditorOpen ? (
        <FlowBranchPreview
          connectedBranchIds={nodeData.uiConnections.flowBranchIds}
          options={flowBranchOptions}
          renderFlowBranchHandle={renderFlowBranchHandle}
        />
      ) : null}

      {isFlowMessage && flowEditorOpen ? (
        <ServiceMessageFlowDrawer
          nodeId={id}
          panelRef={flowPanelRef}
          titleId={flowPanelTitleId}
          nodeData={nodeData}
          flowConfig={flowConfig}
          onFlowConfigChange={handleFlowConfigChange}
          whatsAppFlowsLoading={whatsAppFlowsLoading}
          whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
          onLayoutChange={onLayoutChange}
          onClose={closeFlowEditor}
          renderFlowBranchHandle={renderFlowBranchHandle}
          t={t}
        />
      ) : null}
    </div>
  );
}

/**
 * The message to edit: a readable saved message as it is, an unreadable one
 * read-only, and a new text message when there is none.
 */
function resolveServiceMessageSectionValue(
  nodeData: ScenarioActionEditorNodeData
): {
  isReadOnlyUnsupported: boolean;
  value: ScenarioWhatsAppServiceMessage;
} {
  const resolved = resolveScenarioWhatsAppServiceMessage(nodeData);
  return {
    isReadOnlyUnsupported:
      resolved.status === "invalid" ||
      resolved.status === "unsupported_version",
    value:
      resolved.status === "canonical"
        ? resolved.value
        : createDefaultScenarioWhatsAppServiceMessage("text"),
  };
}

function readServiceMessageFlow(value: ScenarioWhatsAppServiceMessage): {
  flowConfig: WhatsAppFlowConfig | null;
  flowBranchOptions: FlowBranchOption[];
} {
  if (value.message.kind !== "flow") {
    return { flowConfig: null, flowBranchOptions: [] };
  }
  return {
    flowConfig: value.message.flowConfig,
    flowBranchOptions: extractFlowBranchOptions(value.message.flowConfig),
  };
}

/** A fixed body is sent through the template renderer. */
function describeServiceMessageBodyTokens(
  value: ScenarioWhatsAppServiceMessage,
  t: TranslateFn
): string | null {
  const body = getScenarioWhatsAppServiceBodySource(value);
  return body?.mode === "fixed"
    ? describeUnsupportedScenarioTemplateTokens(body.text, t)
    : null;
}

/**
 * A customer who goes quiet on an ask hears nothing without No reply: the
 * outcomes to add it to, or null when it is on or nothing is asked.
 */
function resolveNoReplyReminderOutcomes(
  nodeData: ScenarioActionEditorNodeData
): ScenarioActionOutcomes | null {
  const editableOutcomes = readEditableActionOutcomes(nodeData.actionOutcomes);
  return readScenarioActionPromptInputAsk(nodeData) !== null &&
    editableOutcomes?.noReply?.enabled !== true
    ? editableOutcomes
    : null;
}

/**
 * Open state of the inline Flow editor. Opening it from the builder scrolls
 * the panel into view and focuses its first control on the next frame.
 */
function useServiceMessageFlowEditor(
  isFlowMessage: boolean,
  onLayoutChange: (() => void) | undefined
) {
  const flowPanelRef = useRef<HTMLDivElement>(null);
  const [focusFlowRevision, setFocusFlowRevision] = useState(0);
  const [flowEditorOpen, setFlowEditorOpen] = useState(isFlowMessage);

  const openFlowEditor = useCallback(() => {
    setFlowEditorOpen(true);
    setFocusFlowRevision(value => value + 1);
    onLayoutChange?.();
  }, [onLayoutChange]);

  const closeFlowEditor = useCallback(() => {
    setFlowEditorOpen(false);
    onLayoutChange?.();
  }, [onLayoutChange]);

  useEffect(() => {
    if (!flowEditorOpen || !focusFlowRevision) return;
    const frame = requestAnimationFrame(() => {
      const panel = flowPanelRef.current;
      panel?.scrollIntoView({ block: "nearest" });
      const target = panel?.querySelector<HTMLElement>(
        "[role=combobox], input:not(:disabled), textarea:not(:disabled), button:not(:disabled)"
      );
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [flowEditorOpen, focusFlowRevision]);

  return { flowPanelRef, flowEditorOpen, openFlowEditor, closeFlowEditor };
}

function ServiceMessageNoReplyReminder({
  outcomes,
  patchNode,
  onLayoutChange,
  t,
}: {
  outcomes: ScenarioActionOutcomes;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  onLayoutChange?: () => void;
  t: TranslateFn;
}) {
  return (
    <ScenarioInlineNotice
      live
      data-testid="whatsapp-service-prompt-inputs-no-reminder"
    >
      <span className="block">
        {t("whatsappServicePromptInputsNoReminder")}
      </span>
      {/* The button names what it adds, so it sits under the sentence. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="nodrag nopan mt-1.5 h-auto min-h-7 max-w-full bg-background px-2 py-1 text-[11px] whitespace-normal text-foreground"
        onPointerDown={event => event.stopPropagation()}
        onClick={() => {
          patchNode({
            actionOutcomes: withDefaultNoReplyOutcome(outcomes),
          });
          onLayoutChange?.();
        }}
      >
        {t("whatsappServicePromptInputsAddReminder", {
          duration: formatNoReplyDuration(DEFAULT_NO_REPLY_TIMEOUT_MINUTES, t),
        })}
      </Button>
    </ScenarioInlineNotice>
  );
}

function ServiceMessageFlowDrawer({
  nodeId,
  panelRef,
  titleId,
  nodeData,
  flowConfig,
  onFlowConfigChange,
  whatsAppFlowsLoading,
  whatsAppFlowsRefreshing,
  onLayoutChange,
  onClose,
  renderFlowBranchHandle,
  t,
}: {
  nodeId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  nodeData: ScenarioActionEditorNodeData;
  flowConfig: WhatsAppFlowConfig | null;
  onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
  whatsAppFlowsLoading: boolean;
  whatsAppFlowsRefreshing: boolean;
  onLayoutChange?: () => void;
  onClose: () => void;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  t: TranslateFn;
}) {
  return (
    <div
      ref={panelRef}
      data-sm-field="flowConfig"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="nowheel flex h-[min(28rem,70vh)] max-h-[min(28rem,70vh)] flex-col overflow-hidden overscroll-contain rounded-md border bg-background"
      data-testid="whatsapp-service-flow-drawer"
      onWheel={stopScenarioWheelPropagation}
    >
      <div id={titleId} className="sr-only">
        {t("flowBuilderLabel")}
      </div>
      <div className="nowheel flex min-h-0 flex-1 overflow-hidden overscroll-contain p-0">
        <ActionNodeWhatsAppFlowBuilder
          nodeId={nodeId}
          formKeysByNodeId={nodeData.uiScenarioFormKeys}
          validationMode={nodeData.uiValidationMode}
          flowConfig={flowConfig}
          onFlowConfigChange={onFlowConfigChange}
          flows={nodeData.uiWhatsAppFlows}
          existingFlowsLoading={whatsAppFlowsLoading}
          existingFlowsRefreshing={whatsAppFlowsRefreshing}
          workspaceId={nodeData.uiWorkspaceId}
          onBranchHandleViewportChange={onLayoutChange}
          onInlineClose={onClose}
          renderFlowBranchHandle={renderFlowBranchHandle}
          renderMode="inline"
          connectedBranchIds={nodeData.uiConnections.flowBranchIds}
        />
      </div>
    </div>
  );
}
