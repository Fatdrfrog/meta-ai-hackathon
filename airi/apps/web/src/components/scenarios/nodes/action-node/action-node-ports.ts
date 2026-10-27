import type { ScenarioActionDefaultRouteBlocker } from "@/lib/scenarios/branch-handle-predicates";
import {
  getScenarioActionBranchTransitionsForNode,
  type ScenarioBranchTransitionKind,
} from "@/lib/scenarios/transition-registry";
import {
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_SUCCESS_HANDLE,
  PROMPT_INPUTS_UNMET_HANDLE,
  readScenarioActionPromptInputAsk,
} from "@icecore/scenario-contracts";
import { SCENARIO_HANDLE_RULES } from "../../graph/config";
import { ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS } from "../../graph/source-handle-descriptors";
import type { TranslateFn } from "../../types";
import type {
  ScenarioActionConnections,
  ScenarioActionEditorNodeData,
} from "../../view/node-enrichment/types";
import {
  createScenarioBranchOptionLabeler,
  getAnswerRuleSourceHandleCopy,
  getBranchOptionSourceHandleCopy,
  resolveContinueLabel,
  resolveUntitledBranchOptionLabel,
  type ScenarioBranchOptionKind,
} from "../../view/scenario-source-handle-copy";
import {
  actionNodeDefaultRouteCannotRun,
  isTerminalActionNode,
  resolveActionNodeContinueRoute,
  resolveActionNodeFormSubmittedRoute,
  resolveActionNodeRoutingState,
  type ActionNodeFormSubmittedRouteError,
  type ActionNodeOutcomeRow,
} from "./action-node-state";

export { resolveContinueLabel } from "../../view/scenario-source-handle-copy";

/** A card renders at most this many route rows; the rest stay anchored. */
export const ACTION_NODE_CARD_MAX_PORT_ROWS = 8;

export type ActionNodePortKind =
  | "success"
  | "failure"
  | "branch"
  | "form_submitted"
  | "continue"
  | "inputs_unmet"
  | ActionNodeOutcomeRow["kind"];

export type ActionNodePort = {
  handleId: string;
  kind: ActionNodePortKind;
  label: string;
  detail?: string;
  connected: boolean;
  destinationLabel?: string;
  /** Names the route dot, e.g. "Taps “Yes”"; defaults to label and detail. */
  accessibleLabel?: string;
  /** Answer routes: how the rule matches. */
  answerMode?: "exact" | "intent";
  /** Branch routes: a tapped button or a picked option. */
  optionKind?: "button" | "option";
  /** A route that must be linked before activation. */
  required?: boolean;
  /** False keeps click-to-create but blocks dragging a new edge. */
  connectable?: boolean;
  /**
   * A linked default route that can't run, and why: a linked outcome or the
   * template's linked Form submitted route keeps the step waiting.
   */
  cannotRun?: ScenarioActionDefaultRouteBlocker;
};

export type ActionNodePorts = {
  /** One port per route the action offers, linked or not, in card order. */
  ports: ActionNodePort[];
  /**
   * Handles that saved edges may still use but that have no row: aggregate
   * branch outputs, the legacy interactive no-reply output, an unlinked
   * default output that Any reply stands in for or that can't run, and a
   * Form submitted route on a bulk send or on a template that no longer
   * offers it. The card keeps them as hidden anchors.
   */
  hiddenAnchorIds: string[];
  /**
   * The hidden anchors on the card's top right corner instead of the middle
   * of its right edge: a Form submitted route with no row. Away from every
   * route dot, its saved edge reads as no other route's.
   */
  cornerAnchorIds: string[];
  /** Why a linked route with only an anchor can't run; the card warns. */
  anchoredRouteError?: ActionNodeFormSubmittedRouteError;
  /** End scenario: no routes and no anchors. */
  terminal: boolean;
  /** Changes whenever the card's handles change; keys node internals. */
  signature: string;
};

type ActionNodePortInput = Omit<
  ActionNodePort,
  "connected" | "destinationLabel"
>;

const TERMINAL_PORTS: ActionNodePorts = {
  ports: [],
  hiddenAnchorIds: [],
  cornerAnchorIds: [],
  terminal: true,
  signature: "terminal",
};

/**
 * Every route of an action as the card renders it, one port per source
 * handle. The handle ids match the ones `resolveAvailableSourceHandleIds`
 * accepts for connections, so each port can be drag-connected and each saved
 * edge finds its handle.
 */
export function resolveActionNodePorts({
  id,
  nodeData,
  t,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
}): ActionNodePorts {
  if (isTerminalActionNode(nodeData)) return TERMINAL_PORTS;

  const connections = nodeData.uiConnections;
  const connectedHandleIds = new Set(connections.sourceHandleIds);
  const portsByHandleId = new Map<string, ActionNodePort>();
  const hiddenAnchorIds = new Set<string>();
  const cornerAnchorIds = new Set<string>();
  const addPort = (port: ActionNodePortInput) =>
    addActionNodePort(portsByHandleId, connections, connectedHandleIds, port);

  const fixedOutputHandleIds =
    ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS.find(descriptor =>
      descriptor.usesFixedHandles(nodeData)
    )?.getSourceHandleIds(nodeData) ?? [];
  // Generative AI continues only on Created or Not created.
  if (fixedOutputHandleIds.length > 0) {
    for (const handleId of fixedOutputHandleIds) {
      const success = handleId === GENERATIVE_AI_SUCCESS_HANDLE;
      const label = t(success ? "generativeAISuccess" : "generativeAIFailure");
      addPort({
        handleId,
        kind: success ? "success" : "failure",
        label,
        accessibleLabel: label,
      });
    }
    return finalizeActionNodePorts(portsByHandleId, hiddenAnchorIds);
  }

  const labelBranchOption = createScenarioBranchOptionLabeler(nodeData, t);
  const branchTransitions = getScenarioActionBranchTransitionsForNode(
    nodeData,
    id
  );
  for (const transition of branchTransitions) {
    const connectedOptionIds = new Set(
      connectedBranchOptionIds(connections, transition.kind)
    );
    const optionsByHandleId = new Map<
      string,
      {
        label: string;
        rawLabel: string;
        optionKind: ScenarioBranchOptionKind;
      }[]
    >();
    for (const option of transition.extractOptions(nodeData, id)) {
      const handleId = transition.buildSourceHandleForOption(option);
      if (!handleId) continue;
      optionsByHandleId.set(handleId, [
        ...(optionsByHandleId.get(handleId) ?? []),
        {
          ...labelBranchOption(transition.kind, option),
          rawLabel: option.label.trim(),
        },
      ]);
      if (connectedOptionIds.has(option.id)) connectedHandleIds.add(handleId);
    }
    // Options that share one handle, such as Instagram replies, share a row.
    for (const [handleId, options] of optionsByHandleId) {
      const optionKind = options[0]?.optionKind ?? "button";
      const label =
        options.length === 1
          ? options[0].label
          : options
              .map(option => option.rawLabel)
              .filter(Boolean)
              .join(", ") || resolveUntitledBranchOptionLabel(optionKind, t);
      addPort({
        handleId,
        kind: "branch",
        label,
        accessibleLabel: getBranchOptionSourceHandleCopy(
          t,
          transition.kind,
          optionKind,
          label
        ).label,
        optionKind,
        ...(transition.incompleteErrorKey ? { required: true } : {}),
      });
    }
    hiddenAnchorIds.add(transition.outputHandleId);
  }

  const formSubmittedRoute = resolveActionNodeFormSubmittedRoute(nodeData);
  if (formSubmittedRoute.placement === "row") {
    const label = t("serviceRouteFlowSubmitted");
    addPort({
      handleId: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
      kind: "form_submitted",
      label,
      accessibleLabel: label,
    });
  } else if (formSubmittedRoute.placement === "anchor") {
    hiddenAnchorIds.add(ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID);
    cornerAnchorIds.add(ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID);
  }

  const promptInputAsk = readScenarioActionPromptInputAsk(nodeData);
  const usesTemplateButtons = branchTransitions.some(
    transition => transition.kind === "whatsapp_template_button"
  );
  const usesFlowBranches = branchTransitions.some(
    transition => transition.kind === "whatsapp_flow"
  );
  const outcomeRows = resolveActionNodeRoutingState(
    nodeData,
    t
  ).actionOutcomeRows;
  const hasAnyReplyRow = outcomeRows.some(row => row.kind === "any_reply");
  const continueHandleId = SCENARIO_HANDLE_RULES.action.outputHandleId;
  // A choice ask continues on its options, never on the default output.
  if (
    continueHandleId &&
    (branchTransitions.length === 0 ||
      (usesTemplateButtons && !usesFlowBranches) ||
      promptInputAsk === "text")
  ) {
    const continueRoute = resolveActionNodeContinueRoute({
      id,
      nodeData,
      usesTemplateButtons,
      hasAnyReply: hasAnyReplyRow,
      connected: isHandleConnected(
        connections,
        connectedHandleIds,
        continueHandleId
      ),
    });
    if (continueRoute === "hidden") {
      hiddenAnchorIds.add(continueHandleId);
    } else {
      const cannotRun =
        continueRoute === "cannot_run"
          ? actionNodeDefaultRouteCannotRun(id, nodeData)
          : null;
      const label = resolveContinueLabel({
        nodeData,
        t,
        usesTemplateButtons,
        besideAnyReply: hasAnyReplyRow,
      });
      addPort({
        handleId: continueHandleId,
        kind: "continue",
        label,
        accessibleLabel: label,
        ...(cannotRun ? { cannotRun } : {}),
      });
    }
  }
  if (promptInputAsk) {
    const label = t("whatsappServicePromptInputsUnmet");
    addPort({
      handleId: PROMPT_INPUTS_UNMET_HANDLE,
      kind: "inputs_unmet",
      label,
      accessibleLabel: label,
    });
  }

  // Legacy routing keeps its outcomes until it is converted.
  const outcomesConnectable =
    !nodeData.uiLegacyActionRouting?.actionOutcomesSource;
  for (const row of outcomeRows) {
    addPort({
      handleId: row.handleId,
      kind: row.kind,
      label:
        row.kind === "answer" && row.answerText
          ? t("sourceHandleAnswerQuoted", { label: row.answerText })
          : row.label,
      ...(row.detail ? { detail: row.detail } : {}),
      accessibleLabel: joinRouteDetail(
        row.kind === "answer"
          ? getAnswerRuleSourceHandleCopy(t, {
              text: row.answerText,
              mode: row.mode,
            }).label
          : row.label,
        row.detail
      ),
      ...(row.mode ? { answerMode: row.mode } : {}),
      ...(outcomesConnectable ? {} : { connectable: false }),
    });
  }

  if (connectedHandleIds.has(ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID)) {
    hiddenAnchorIds.add(ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID);
  }
  return finalizeActionNodePorts(portsByHandleId, hiddenAnchorIds, {
    cornerAnchorIds,
    anchoredRouteError: formSubmittedRoute.error,
  });
}

/** A required route without a next step blocks activation. */
export function isActionNodeOutcomePort(port: ActionNodePort): boolean {
  return (
    port.kind === "any_reply" ||
    port.kind === "no_reply" ||
    port.kind === "answer" ||
    port.kind === "payment_detected"
  );
}

export function actionNodePortNeedsNextStep(port: ActionNodePort): boolean {
  return port.required === true && !port.connected;
}

/** A route the card's notice names: it needs a next step, or can't run. */
function actionNodePortNeedsAttention(port: ActionNodePort): boolean {
  return actionNodePortNeedsNextStep(port) || Boolean(port.cannotRun);
}

/**
 * Splits routes into rows shown up front and rows behind "+N more", keeping
 * route order. Routes that need a next step or can't run come into view
 * first. Compact cards show those and linked routes, and at least one row.
 */
export function splitActionNodeCardRows(
  ports: readonly ActionNodePort[],
  compact: boolean
): { rows: ActionNodePort[]; overflow: ActionNodePort[] } {
  const pinned = compact
    ? ports.filter(port => port.connected || actionNodePortNeedsNextStep(port))
    : [
        ...ports.filter(actionNodePortNeedsAttention),
        ...ports.filter(port => !actionNodePortNeedsAttention(port)),
      ].slice(0, ACTION_NODE_CARD_MAX_PORT_ROWS);
  const shown = new Set(pinned.length > 0 ? pinned : ports.slice(0, 1));
  return {
    rows: ports.filter(port => shown.has(port)),
    overflow: ports.filter(port => !shown.has(port)),
  };
}

function joinRouteDetail(label: string, detail?: string): string {
  return detail ? `${label} · ${detail}` : label;
}

function isHandleConnected(
  connections: ScenarioActionConnections,
  connectedHandleIds: ReadonlySet<string>,
  handleId: string
): boolean {
  return (
    connectedHandleIds.has(handleId) ||
    connections.destinationsBySourceHandle?.has(handleId) === true
  );
}

function addActionNodePort(
  portsByHandleId: Map<string, ActionNodePort>,
  connections: ScenarioActionConnections,
  connectedHandleIds: ReadonlySet<string>,
  port: ActionNodePortInput
) {
  if (portsByHandleId.has(port.handleId)) return;
  const destinationLabel = connections.destinationsBySourceHandle?.get(
    port.handleId
  )?.label;
  portsByHandleId.set(port.handleId, {
    ...port,
    connected:
      connectedHandleIds.has(port.handleId) || destinationLabel !== undefined,
    ...(destinationLabel ? { destinationLabel } : {}),
  });
}

function finalizeActionNodePorts(
  portsByHandleId: ReadonlyMap<string, ActionNodePort>,
  hiddenAnchorIds: ReadonlySet<string>,
  {
    cornerAnchorIds = new Set(),
    anchoredRouteError,
  }: {
    cornerAnchorIds?: ReadonlySet<string>;
    anchoredRouteError?: ActionNodeFormSubmittedRouteError;
  } = {}
): ActionNodePorts {
  const ports = Array.from(portsByHandleId.values());
  const hidden = Array.from(hiddenAnchorIds).filter(
    handleId => !portsByHandleId.has(handleId)
  );
  const anchorSide = (handleId: string) =>
    cornerAnchorIds.has(handleId) ? "corner" : "hidden";
  return {
    ports,
    hiddenAnchorIds: hidden,
    cornerAnchorIds: hidden.filter(handleId => cornerAnchorIds.has(handleId)),
    ...(anchoredRouteError ? { anchoredRouteError } : {}),
    terminal: false,
    signature: [
      ...ports.map(port => `port:${port.handleId}`),
      ...hidden.map(handleId => `${anchorSide(handleId)}:${handleId}`),
    ].join("|"),
  };
}

function connectedBranchOptionIds(
  connections: ScenarioActionConnections,
  kind: ScenarioBranchTransitionKind
): readonly string[] {
  switch (kind) {
    case "whatsapp_flow":
      return connections.flowBranchIds;
    case "telegram_quick_reply":
      return connections.telegramPayloads;
    case "instagram_reply":
      return connections.instagramPayloads;
    case "whatsapp_service_message":
      return connections.whatsAppChoicePayloads;
    case "whatsapp_template_button":
      return connections.templateButtonPayloads;
  }
}
