import {
  buildScenarioActionOutcomeHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  isPostActionConditionNodeData,
  normalizeScenarioActionOutcomes,
  parseFlowBranchSourceHandleId,
  parsePostActionAnswerMatchHandleId,
  parsePostActionConditionHandleId,
  getNoReplyAnswerMatchRules,
  getNoReplyMissingTextPhrases,
  getPostActionConditionBranch,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  getScenarioWhatsAppServiceBodySource,
  hasBlockingScenarioRoutingDiagnostics,
  resolvePostActionQuietPeriodDueAt,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioRuntimeEventKind,
} from "@icecore/scenario-contracts";
import {
  compileScenarioGraph,
  reconstructForwardPath,
  type ScenarioFlowMatch,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { scanPostActionTimerWindow } from "@icecore/airi-runtime/temporal-scenario-timers";
import { CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION } from "@icecore/shared/lib/conversation-classification-freshness";
import {
  buildScenarioRevisionFingerprint,
  type CanonicalScenarioGraph,
} from "@icecore/airi-runtime/scenario-generative-ai-identity";
import { nodePassesFlowFilters } from "@/lib/airi/scenario/scenario-audience";
import { evaluateScenarioFlow } from "@/lib/airi/scenario/scenario-interactive-replies";
import {
  resolveFirstReachableActionFromNode,
  resolvePostActionConditionSourceHandleTarget,
  resolveScenarioDispatchTransition,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import { resolvePendingConditionEventDisposition } from "@/lib/airi/interactive-no-reply";
import { resolvePostActionAnswerMatch } from "@/lib/airi/post-action-answer-matching";
import { normalizeActionType } from "./normalization";
import { resolveScenarioStructuredReplyActionNodeId } from "./structured-replies";
import { resolveScenarioWhatsAppServiceMessage } from "./whatsapp-service-message";
import type { ConversationDocument } from "@/types/models";
import type {
  ScenarioSimulationContext,
  ScenarioSimulationEvent,
  ScenarioSimulationGraph,
  ScenarioSimulationMessage,
  ScenarioSimulationResult,
  ScenarioSimulationState,
} from "./scenario-simulation-types";
import {
  scenarioSimulationEventSchema,
  scenarioSimulationStateSchema,
} from "./scenario-simulation-types";
import {
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  whatsAppTemplateButtonReplyMatchesSourceHandle,
} from "./transition-registry";

/** A dry run composes the same routing owners, with no database or delivery ports. */
export async function simulateScenarioStep(input: {
  graph: ScenarioSimulationGraph;
  state?: ScenarioSimulationState | null;
  event: ScenarioSimulationEvent;
  context?: ScenarioSimulationContext;
}): Promise<ScenarioSimulationResult> {
  const event = scenarioSimulationEventSchema.parse(input.event);
  const graphFingerprint = buildScenarioRevisionFingerprint(
    JSON.parse(
      JSON.stringify({
        version: 1,
        nodes: input.graph.nodes.map(({ id, data }) => ({ id, data })),
        edges: input.graph.edges,
      })
    ) as CanonicalScenarioGraph
  );
  const graph = compileScenarioGraph(input.graph.nodes, input.graph.edges);
  if (hasBlockingScenarioRoutingDiagnostics(graph.diagnostics)) {
    throw new Error(
      "The scenario has invalid routes. Fix them before trying it."
    );
  }
  const facts = input.context;
  const conversation = {
    _id: "scenario-preview",
    workspaceId: "preview",
    channel: "whatsapp",
    status: "open",
    classification: { category: facts?.classificationCategory },
    // Supplied preview facts represent a current classification, so the real
    // audience evaluator must receive the same freshness contract as runtime.
    is_classified: Boolean(facts?.classificationCategory),
    classification_revision: 1,
    classification_state: {
      contractVersion: CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
      status: "ready",
      requestedRevision: 1,
      appliedRevision: 1,
    },
    classification_meta: {
      source_revision: 1,
      provenance_kind: "v2",
      analysis_revision_id: "scenario-preview",
    },
    internal_labels: [
      ...(facts?.internalLabels ?? []),
      ...(facts?.funnelStage ? [`stage:${facts.funnelStage}`] : []),
    ],
    estimated_customer_ltv: facts?.hasPurchaseHistory ? 1 : 0,
    revenue_attribution_id: facts?.hasPurchaseHistory ? "preview" : null,
    createdAt: new Date(),
    messages: [],
  } as unknown as ConversationDocument;
  if (event.kind !== "start" && !input.state)
    throw new Error("Restart the preview before taking another step.");
  const parsedState =
    input.state && event.kind !== "start"
      ? scenarioSimulationStateSchema.safeParse(input.state)
      : null;
  if (
    parsedState &&
    (!parsedState.success ||
      parsedState.data.graphFingerprint !== graphFingerprint)
  )
    throw new Error("The scenario or preview changed. Restart the preview.");
  let state: ScenarioSimulationState =
    event.kind === "start"
      ? {
          graphFingerprint,
          handoffActive: false,
          status: "waiting",
          actionNodeId: null,
          nextActionNodeId: null,
          triggerNodeId: graph.triggerNodeIds[0] ?? null,
          pendingConditionNodeId: null,
          pendingSourceActionNodeId: null,
          now: 0,
          waitStartedAt: 0,
          latestActivityAt: 0,
          dueAt: null,
          textSinceWait: [],
        }
      : parsedState!.data!;
  const previousActionNodeId = state.actionNodeId;
  let path: string[] = [];
  let selectedCause: { source: string; handle: string } | null = null;
  const result = (
    message: ScenarioSimulationMessage | null = null,
    reason?: ScenarioSimulationResult["reason"]
  ): ScenarioSimulationResult => {
    // Virtual conditions are runtime-only. Highlight their persisted source→target edge.
    let visible = path.filter(id =>
      input.graph.nodes.some(node => node.id === id)
    );
    if (previousActionNodeId && event.kind !== "start") {
      const sourceIndex = visible
        .slice(0, -1)
        .lastIndexOf(previousActionNodeId);
      if (sourceIndex >= 0) visible = visible.slice(sourceIndex);
    }
    const pairs = new Set(
      visible.slice(1).map((id, i) => `${visible[i]}\0${id}`)
    );
    const pathEdgeIds = input.graph.edges.flatMap(edge => {
      if (!edge.id || !pairs.has(`${edge.source}\0${edge.target}`)) return [];
      if (selectedCause?.source === edge.source)
        return edge.sourceHandle === selectedCause.handle ? [edge.id] : [];
      if (edge.source === previousActionNodeId && event.kind === "choice") {
        const matches =
          WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.matchesSourceHandle(
            edge.sourceHandle,
            [{ id: event.payload, label: event.payload }]
          ) ||
          whatsAppTemplateButtonReplyMatchesSourceHandle({
            sourceActionNodeId: edge.source,
            sourceHandleId: edge.sourceHandle,
            quickReplyPayload: event.payload,
          });
        return matches ? [edge.id] : [];
      }
      if (edge.source === previousActionNodeId && event.kind === "flow") {
        const branch = parseFlowBranchSourceHandleId(edge.sourceHandle);
        if (branch) {
          const selected = event.values[branch.fieldId];
          const matches = Array.isArray(selected)
            ? selected.includes(branch.optionId)
            : selected === branch.optionId;
          return matches ? [edge.id] : [];
        }
      }
      return [edge.id];
    });
    return {
      state,
      message,
      pathNodeIds: visible,
      pathEdgeIds,
      ...(reason ? { reason } : {}),
    };
  };
  const pending = state.pendingConditionNodeId
    ? graph.nodesById.get(state.pendingConditionNodeId)
    : null;
  const source = state.pendingSourceActionNodeId
    ? graph.nodesById.get(state.pendingSourceActionNodeId)
    : null;
  const pendingOwner = pending
    ? graph.runtimeActionNodes.find(
        node => getScenarioActionOutcomeVirtualNodeId(node.id) === pending.id
      )
    : null;
  const timeoutMinutes = pending
    ? Math.max(
        1,
        Math.floor(
          getPostActionConditionBranch(pending.data, "no_reply_timeout")
            .timeoutMinutes ?? 1
        )
      )
    : 1;
  const hasTimer = Boolean(
    pending &&
      graph.edges.some(
        e =>
          e.source === pending.id &&
          e.sourceHandle === getPostActionConditionHandleId("no_reply_timeout")
      )
  );
  const expectedDueAt = hasTimer
    ? resolvePostActionQuietPeriodDueAt({
        waitStartedAt: new Date(state.waitStartedAt),
        latestActivityAt: new Date(state.latestActivityAt),
        timeoutMinutes,
      }).getTime()
    : null;
  if (
    (state.actionNodeId &&
      graph.nodesById.get(state.actionNodeId)?.data.kind !== "action") ||
    (state.nextActionNodeId &&
      graph.nodesById.get(state.nextActionNodeId)?.data.kind !== "action") ||
    Boolean(state.pendingConditionNodeId) !==
      Boolean(state.pendingSourceActionNodeId) ||
    (state.pendingConditionNodeId &&
      (!pending ||
        !isPostActionConditionNodeData(pending.data) ||
        source?.id !== state.actionNodeId)) ||
    (pendingOwner && pendingOwner.id !== source?.id) ||
    state.waitStartedAt > state.now ||
    state.latestActivityAt < state.waitStartedAt ||
    state.latestActivityAt > state.now ||
    state.dueAt !== expectedDueAt
  )
    throw new Error("The preview state is inconsistent. Restart the preview.");
  if (state.status === "completed" || state.status === "blocked")
    return result();
  const complete = () => {
    state = {
      ...state,
      status: "completed",
      nextActionNodeId: null,
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      dueAt: null,
    };
  };
  let match: ScenarioFlowMatch | null = null;
  let target: ScenarioRuntimeNode | null = null;
  let sourceHandle: string | null = null;
  const eventKind: ScenarioRuntimeEventKind =
    event.kind === "choice"
      ? SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply
      : event.kind === "flow"
        ? SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply
        : event.kind === "advance"
          ? SCENARIO_TRIGGER_EVENT_KIND.noHumanReplyTimeout
          : event.kind === "payment"
            ? "payment_detected"
            : SCENARIO_TRIGGER_EVENT_KIND.inboundMessage;

  if (event.kind === "advance") {
    state.now += event.minutes * 60_000;
    if (state.dueAt === null || state.now < state.dueAt || !pending)
      return result();
    const scan = await scanPostActionTimerWindow(
      {
        conversationId: "scenario-preview",
        after: new Date(state.waitStartedAt),
        phrases: getNoReplyMissingTextPhrases(pending.data),
      },
      {
        findLatestMessageAfter: async () => ({
          date: new Date(state.latestActivityAt),
        }),
        findTextMessagesAfter: async () =>
          state.textSinceWait.map(text => ({ text })),
      }
    );
    if (scan.matchedTextPhrase) {
      complete();
      return result(null, "cancelled");
    }
    sourceHandle = getPostActionConditionHandleId("no_reply_timeout");
  } else if (event.kind !== "start") {
    state.latestActivityAt = state.now;
    if (event.kind === "message")
      state.textSinceWait = [...state.textSinceWait, event.text].slice(-200);
    if (pending && state.dueAt !== null) {
      state.dueAt = resolvePostActionQuietPeriodDueAt({
        waitStartedAt: new Date(state.waitStartedAt),
        latestActivityAt: new Date(state.now),
        timeoutMinutes,
      }).getTime();
    }
    if (state.handoffActive) return result(null, "no_match");
    if (pending && event.kind === "message") {
      const rules = getNoReplyAnswerMatchRules(pending.data);
      const answer = await resolvePostActionAnswerMatch({
        messageText: event.text,
        rules,
      });
      if (answer)
        sourceHandle = getPostActionAnswerMatchHandleId(answer.ruleId);
      else if (rules.length) {
        const outcomes = normalizeScenarioActionOutcomes(
          source?.data.actionOutcomes
        );
        if (
          outcomes.status !== "supported" ||
          outcomes.value.anyReply?.enabled !== true
        )
          return result(null, "no_match");
      }
    }
    if (pending && !sourceHandle) {
      const disposition = resolvePendingConditionEventDisposition({
        triggerEventKind: eventKind,
        conditionNodeId: pending.id,
        conditionNodeData: pending.data,
        pendingSourceActionData: source?.data,
        confirmedPayment: event.kind === "payment",
      });
      if (disposition === "ignore") return result(null, "no_match");
      if (
        disposition !== "interactive_reply" &&
        disposition !== "unowned_interactive_reply"
      )
        sourceHandle = getPostActionConditionHandleId(disposition);
    }
  }

  // Audience filters use wall-clock dates. Project the preview's elapsed quiet
  // period onto that clock without changing the production evaluator.
  conversation.lastMessageAt = new Date(
    Date.now() - (state.now - state.latestActivityAt)
  );
  if (pending && sourceHandle) {
    const answerRule = parsePostActionAnswerMatchHandleId(sourceHandle);
    const conditionType = parsePostActionConditionHandleId(sourceHandle);
    selectedCause = {
      source: pending.id,
      handle: sourceHandle,
    };
    if (
      source &&
      pending.id === getScenarioActionOutcomeVirtualNodeId(source.id)
    ) {
      selectedCause = {
        source: source.id,
        handle: answerRule
          ? buildScenarioActionOutcomeHandleId({
              type: "answer",
              ruleId: answerRule,
            })
          : buildScenarioActionOutcomeHandleId(
              conditionType === "user_replied"
                ? "any_reply"
                : conditionType === "payment_detected"
                  ? "payment_detected"
                  : "no_reply"
            ),
      };
    }
    const first = resolvePostActionConditionSourceHandleTarget({
      graph,
      conditionNodeId: pending.id,
      sourceHandle,
      conversation,
      channel: "whatsapp",
    });
    target =
      first?.data.kind === "action"
        ? first
        : first
          ? resolveFirstReachableActionFromNode({
              graph,
              startNodeId: first.id,
              conversation,
              channel: "whatsapp",
            })
          : null;
    if (target)
      path = [
        source?.id ?? state.actionNodeId!,
        pending.id,
        ...(reconstructForwardPath({
          adjacency: graph.adjacency,
          startId: first!.id,
          targetId: target.id,
          canVisit: id => {
            const node = graph.nodesById.get(id);
            return Boolean(
              node && nodePassesFlowFilters(node, conversation, "whatsapp")
            );
          },
        }) ?? [target.id]),
      ];
    else {
      complete();
      return result(null, "no_match");
    }
  } else {
    match = evaluateScenarioFlow({
      graph,
      conversation,
      channel: "whatsapp",
      matchedTriggerNodeId: state.triggerNodeId ?? undefined,
      // Like the runtime, a button resumes the action that sent it.
      preferredActionNodeId:
        resolveScenarioStructuredReplyActionNodeId({
          triggerEventKind: eventKind,
          quickReplyPayload: event.kind === "choice" ? event.payload : null,
        }) ??
        state.nextActionNodeId ??
        state.actionNodeId ??
        undefined,
      triggerEventKind: eventKind,
      quickReplyPayload: event.kind === "choice" ? event.payload : null,
      whatsAppFlowResponseJson:
        event.kind === "flow" ? JSON.stringify(event.values) : null,
    });
    target = match?.selectedAction ?? null;
    path = match?.pathNodeIds ?? [];
    // The compiler may expose the sender as reachable even when no branch matched.
    if (
      event.kind !== "start" &&
      event.kind !== "choice" &&
      event.kind !== "flow" &&
      target?.id === state.actionNodeId
    )
      target = null;
  }
  if (!target) return result(null, "no_match");
  const actionType = normalizeActionType(target.data);
  if (!actionType) return result(null, "no_match");
  const transition = resolveScenarioDispatchTransition({
    graph,
    selectedAction: target,
    selectedActionType: actionType,
    selectedPathNodeIds: path,
    conversation,
    channel: "whatsapp",
  });
  state = {
    ...state,
    actionNodeId: target.id,
    nextActionNodeId: transition.nextActionNodeId,
    handoffActive: state.handoffActive || actionType === "assign_human",
    status:
      actionType === "assign_human"
        ? "handoff"
        : transition.completesScenario
          ? "completed"
          : state.handoffActive
            ? "handoff"
            : "waiting",
    pendingConditionNodeId: transition.pendingConditionNodeId ?? null,
    pendingSourceActionNodeId: transition.pendingSourceActionNodeId ?? null,
    waitStartedAt: state.now,
    latestActivityAt: state.now,
    dueAt: null,
    textSinceWait: [],
  };
  if (state.pendingConditionNodeId) {
    const condition = graph.nodesById.get(state.pendingConditionNodeId);
    if (
      condition &&
      graph.edges.some(
        e =>
          e.source === condition.id &&
          e.sourceHandle === getPostActionConditionHandleId("no_reply_timeout")
      )
    ) {
      state.dueAt = resolvePostActionQuietPeriodDueAt({
        waitStartedAt: new Date(state.now),
        latestActivityAt: null,
        timeoutMinutes:
          getPostActionConditionBranch(condition.data, "no_reply_timeout")
            .timeoutMinutes ?? 1,
      }).getTime();
    }
  }
  if (actionType === "end_scenario" || actionType === "assign_human")
    return result();
  if (actionType !== "reply") {
    state.status = "blocked";
    return result(null, "unsupported_action");
  }
  const resolved = resolveScenarioWhatsAppServiceMessage(target.data);
  const serviceMessage =
    resolved.status === "canonical" ? resolved.value : undefined;
  const body = serviceMessage
    ? getScenarioWhatsAppServiceBodySource(serviceMessage)
    : null;
  return result({
    actionNodeId: target.id,
    bodyText:
      body?.mode === "fixed" ? body.text : (target.data.actionReplyText ?? ""),
    dynamic: body?.mode === "ai" || target.data.actionReplyMode === "ai",
    ...(serviceMessage ? { serviceMessage } : {}),
  });
}
