"use client";

import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useId, type ReactNode, type SyntheticEvent } from "react";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  buildScenarioActionAnswerOutcomeHandleId,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import {
  ScenarioRouteHandle,
  ScenarioRouteRow,
  SCENARIO_ROUTE_ROW_CLASS,
  bindSourceHandleCreate,
} from "../../scenario-route";
import { ScenarioSourceHandleButton } from "../../source-handle-button";
import type { TranslateFn } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { resolveAnyReplyLabel } from "../../view/scenario-source-handle-copy";
import {
  AnswerMatchRulesEditor,
  MissingTextPhrasesEditor,
} from "../action-routing-controls";
import { NoReplyTimeoutControl } from "./no-reply-timeout-control";
import type { ActionNodePort } from "./action-node-ports";
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import { withDefaultNoReplyOutcome } from "./action-node-state";

type ActionNodeOutcomesEditorProps = {
  connectedHandleIds: ReadonlySet<string>;
  nodeData: ScenarioActionEditorNodeData;
  outcomes: ScenarioActionOutcomes;
  /** Route rows of the enabled outcomes, from `resolveActionNodePorts`. */
  outcomePorts: readonly ActionNodePort[];
  readOnly: boolean;
  t: TranslateFn;
  onChange: (outcomes: ScenarioActionOutcomes) => void;
  onHandlesChanged?: () => void;
  serviceMode?: boolean;
  /** Render outcome handles; node settings edit outcomes without them. */
  showPorts?: boolean;
};

type OptionalActionOutcomeKey =
  | "anyReply"
  | "noReply"
  | "answerMatches"
  | "paymentDetected";

function withoutActionOutcome(
  outcomes: ScenarioActionOutcomes,
  key: OptionalActionOutcomeKey
): ScenarioActionOutcomes {
  const next = { ...outcomes };
  delete next[key];
  return next;
}

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Route rows that keep outcome handles on the node edge while the section
 * that edits them is closed.
 */
export function ActionNodeOutcomeRouteRows({
  nodeData,
  onHandlesChanged,
  ports,
}: {
  nodeData: ScenarioActionEditorNodeData;
  onHandlesChanged?: () => void;
  ports: readonly ActionNodePort[];
}) {
  if (ports.length === 0) return null;
  return (
    <div data-testid="action-node-outcome-route-rows">
      {ports.map(port => (
        <ScenarioRouteRow
          key={port.handleId}
          handleId={port.handleId}
          sourceLabel={port.label}
          icon={resolveActionNodePortIcon(port)}
          detail={port.detail}
          accessibleLabel={port.accessibleLabel}
          connected={port.connected}
          connectable={port.connectable}
          required={port.required}
          destinationLabel={port.destinationLabel}
          onInteractionStart={onHandlesChanged}
          onCreateNode={bindSourceHandleCreate(
            nodeData.uiOnCreateNodeFromSourceHandle,
            port.handleId
          )}
        />
      ))}
    </div>
  );
}

function OutcomeSourceHandle({
  port,
  nodeData,
  onHandlesChanged,
  edge = false,
}: {
  port: ActionNodePort | undefined;
  nodeData: ScenarioActionEditorNodeData;
  onHandlesChanged?: () => void;
  edge?: boolean;
}) {
  if (!port) return null;
  const label = port.accessibleLabel ?? port.label;
  const onCreateNode = bindSourceHandleCreate(
    nodeData.uiOnCreateNodeFromSourceHandle,
    port.handleId
  );
  if (edge) {
    return (
      <ScenarioRouteHandle
        id={port.handleId}
        connected={port.connected}
        connectable={port.connectable}
        title={label}
        onInteractionStart={onHandlesChanged}
        onCreateNode={onCreateNode}
      />
    );
  }
  return (
    <ScenarioSourceHandleButton
      id={port.handleId}
      connected={port.connected}
      connectedLabel={label}
      connectable={port.connectable}
      appearance="ghost"
      inline
      className={
        port.connected
          ? "shrink-0 !border-emerald-400 !bg-emerald-50 dark:!bg-emerald-950/40"
          : "shrink-0"
      }
      title={label}
      aria-label={label}
      onInteractionStart={onHandlesChanged}
      onCreateNode={onCreateNode}
    />
  );
}

/** A checkbox whose visible label toggles it, with trailing controls. */
function OutcomeToggleRow({
  checked,
  children,
  className,
  disabled,
  label,
  labelClassName,
  onCheckedChange,
}: {
  checked: boolean;
  children?: ReactNode;
  className: string;
  disabled: boolean;
  label: ReactNode;
  labelClassName?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={className}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        className="nodrag nopan nokey"
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
        onCheckedChange={next => onCheckedChange(next === true)}
      />
      <Label
        htmlFor={id}
        className={cn(
          "min-w-0 text-[11px] font-normal leading-snug",
          labelClassName
        )}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

export function ActionNodeOutcomesEditor({
  connectedHandleIds,
  nodeData,
  outcomes,
  outcomePorts,
  readOnly,
  t,
  onChange,
  onHandlesChanged,
  serviceMode = false,
  showPorts = true,
}: ActionNodeOutcomesEditorProps) {
  const portsByHandleId = new Map(
    outcomePorts.map(port => [port.handleId, port] as const)
  );
  const portFor = (handleId: string) =>
    showPorts ? portsByHandleId.get(handleId) : undefined;
  const anyReplyLabel = resolveAnyReplyLabel(nodeData, t);
  const toggleSimpleOutcome = (
    kind: "anyReply" | "paymentDetected",
    enabled: boolean
  ): void => {
    if (enabled) {
      onChange({ ...outcomes, [kind]: { enabled: true } });
    } else {
      onChange(withoutActionOutcome(outcomes, kind));
    }
    onHandlesChanged?.();
  };

  const toggleNoReply = (enabled: boolean): void => {
    if (enabled) {
      onChange(withDefaultNoReplyOutcome(outcomes));
    } else {
      onChange(withoutActionOutcome(outcomes, "noReply"));
    }
    onHandlesChanged?.();
  };

  const outcomeHandleEdge = serviceMode;
  // Opening or closing a section moves the route handles below it.
  const remeasureHandles = onHandlesChanged
    ? () => onHandlesChanged()
    : undefined;
  const outcomeRowClass = serviceMode
    ? SCENARIO_ROUTE_ROW_CLASS
    : "flex min-h-10 items-center gap-2";
  const cancelPhrases = outcomes.noReply?.cancelIfPhrases ?? [];
  const cancelTitle = t("actionNoReplyCancelTitle");
  const cancelPhrasesEditor = outcomes.noReply?.enabled ? (
    <div className={serviceMode ? "px-2 pb-1" : undefined}>
      <ScenarioCollapsibleSection
        variant="inline"
        title={cancelTitle}
        count={cancelPhrases.length}
        info={{
          label: t("infoHintLabel", { topic: cancelTitle }),
          text: t("actionNoReplyCancelInfo"),
        }}
        onOpenChange={remeasureHandles}
        data-testid="action-node-no-reply-cancel"
      >
        <div className="px-1 pb-1 pt-0.5">
          <MissingTextPhrasesEditor
            phrases={outcomes.noReply.cancelIfPhrases}
            t={t}
            label={cancelTitle}
            hideLabel
            hint={null}
            disabled={readOnly}
            onCommit={cancelIfPhrases =>
              onChange({
                ...outcomes,
                noReply: {
                  ...outcomes.noReply!,
                  cancelIfPhrases: cancelIfPhrases.length
                    ? cancelIfPhrases
                    : undefined,
                },
              })
            }
          />
        </div>
      </ScenarioCollapsibleSection>
    </div>
  ) : null;

  const answerRulesEditor = (
    <AnswerMatchRulesEditor
      rules={outcomes.answerMatches}
      t={t}
      addLabel={t("actionOutcomeAddAnswer")}
      connectedHandleIds={connectedHandleIds}
      connectable={!nodeData.uiLegacyActionRouting?.actionOutcomesSource}
      disabled={readOnly}
      getHandleId={buildScenarioActionAnswerOutcomeHandleId}
      onCreateNodeFromSourceHandle={nodeData.uiOnCreateNodeFromSourceHandle}
      onHandlesChanged={onHandlesChanged}
      showPorts={showPorts}
      onRulesChange={answerMatches => {
        if (answerMatches.length > 0) {
          onChange({ ...outcomes, answerMatches });
          return;
        }
        onChange(withoutActionOutcome(outcomes, "answerMatches"));
      }}
    />
  );

  const paymentToggleLabel = t("actionOutcomePaymentToggle");
  const paymentRow = (
    <OutcomeToggleRow
      className={outcomeRowClass}
      checked={outcomes.paymentDetected?.enabled === true}
      disabled={readOnly}
      label={paymentToggleLabel}
      onCheckedChange={checked =>
        toggleSimpleOutcome("paymentDetected", checked)
      }
    >
      <ScenarioInfoHint
        label={t("infoHintLabel", { topic: paymentToggleLabel })}
      >
        {t("actionOutcomePaymentInfo")}
      </ScenarioInfoHint>
      <span className="min-w-0 flex-1" />
      <OutcomeSourceHandle
        edge={outcomeHandleEdge}
        port={portFor(ACTION_PAYMENT_OUTCOME_HANDLE_ID)}
        nodeData={nodeData}
        onHandlesChanged={onHandlesChanged}
      />
    </OutcomeToggleRow>
  );

  const secondaryPorts = outcomePorts.filter(
    port => port.kind === "answer" || port.kind === "payment_detected"
  );

  return (
    <div className="divide-y divide-border/60">
      <OutcomeToggleRow
        className={outcomeRowClass}
        checked={outcomes.anyReply?.enabled === true}
        disabled={readOnly}
        label={anyReplyLabel}
        labelClassName="flex-1"
        onCheckedChange={checked => toggleSimpleOutcome("anyReply", checked)}
      >
        <OutcomeSourceHandle
          edge={outcomeHandleEdge}
          port={portFor(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID)}
          nodeData={nodeData}
          onHandlesChanged={onHandlesChanged}
        />
      </OutcomeToggleRow>

      <div className="space-y-1 pb-1">
        <OutcomeToggleRow
          className={cn(outcomeRowClass, "gap-1.5")}
          checked={outcomes.noReply?.enabled === true}
          disabled={readOnly}
          label={t("actionOutcomeNoReply")}
          labelClassName="shrink-0"
          onCheckedChange={toggleNoReply}
        >
          {outcomes.noReply?.enabled ? (
            <NoReplyTimeoutControl
              className="min-w-0 flex-1"
              minutes={outcomes.noReply.timeoutMinutes}
              disabled={readOnly}
              t={t}
              onCommit={timeoutMinutes =>
                onChange({
                  ...outcomes,
                  noReply: { ...outcomes.noReply!, timeoutMinutes },
                })
              }
            />
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <OutcomeSourceHandle
            edge={outcomeHandleEdge}
            port={portFor(ACTION_NO_REPLY_OUTCOME_HANDLE_ID)}
            nodeData={nodeData}
            onHandlesChanged={onHandlesChanged}
          />
        </OutcomeToggleRow>
        {cancelPhrasesEditor}
      </div>

      {serviceMode ? (
        <ScenarioCollapsibleSection
          variant="inline"
          title={t("serviceRouteMoreOptions")}
          count={secondaryPorts.length}
          countLabel={t("routeCount", { count: secondaryPorts.length })}
          defaultOpen={secondaryPorts.length > 0}
          className="[&>div:first-child]:px-2 [&>div:first-child]:py-1"
          collapsedContent={
            showPorts ? (
              <ActionNodeOutcomeRouteRows
                nodeData={nodeData}
                onHandlesChanged={onHandlesChanged}
                ports={secondaryPorts}
              />
            ) : null
          }
          onOpenChange={remeasureHandles}
          data-testid="action-node-answers-and-payment"
        >
          <div className="divide-y divide-border/60">
            <div className="px-3 py-2">{answerRulesEditor}</div>
            {paymentRow}
          </div>
        </ScenarioCollapsibleSection>
      ) : (
        <>
          <div className="py-2">{answerRulesEditor}</div>
          {paymentRow}
        </>
      )}
    </div>
  );
}
