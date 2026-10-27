import type { AiriScenarioRuntimeResolution } from "@icecore/airi-runtime/scenario-runtime-types";

export type AutoReplyExecutionGates = {
  canResolveScenarios: boolean;
  canDeliverAutoReply: boolean;
  canProcessAnyAiriPath: boolean;
};

export function resolveAutoReplyExecutionGates(params: {
  autoReplyEnabled: boolean;
  scenariosEnabled: boolean;
}): AutoReplyExecutionGates {
  const canResolveScenarios = Boolean(params.scenariosEnabled);
  const canDeliverAutoReply = Boolean(params.autoReplyEnabled);

  return {
    canResolveScenarios,
    canDeliverAutoReply,
    canProcessAnyAiriPath: canResolveScenarios || canDeliverAutoReply,
  };
}

export function shouldSkipBeforeScenarioResolution(
  gates: AutoReplyExecutionGates,
  _hasExplicitAutoReplyTrigger: boolean
): boolean {
  return !gates.canProcessAnyAiriPath;
}

export function selectScenarioResolutionOutcome(
  current: AiriScenarioRuntimeResolution | null,
  candidate: AiriScenarioRuntimeResolution
): AiriScenarioRuntimeResolution | null {
  if (current) {
    return current;
  }
  return candidate.runtime || candidate.blockedScenarioAction
    ? candidate
    : null;
}

export function selectScenarioContinuationOutcome(
  candidate?: AiriScenarioRuntimeResolution | null
): AiriScenarioRuntimeResolution {
  return candidate ?? { runtime: null };
}

/** Reuse an outbound anchor only while it still belongs to the pending action. */
export function resolvePendingInteractiveOutboundAnchor(params: {
  currentActionNodeId?: string | null;
  pendingConditionNodeId?: string | null;
  pendingSourceActionNodeId?: string | null;
  pendingLastOutboundMessageId?: string | null;
}): string | null {
  const currentActionNodeId = params.currentActionNodeId?.trim() || "";
  const pendingConditionNodeId = params.pendingConditionNodeId?.trim() || "";
  const pendingSourceActionNodeId =
    params.pendingSourceActionNodeId?.trim() || "";
  const pendingLastOutboundMessageId =
    params.pendingLastOutboundMessageId?.trim() || "";

  if (
    !currentActionNodeId ||
    !pendingConditionNodeId ||
    pendingSourceActionNodeId !== currentActionNodeId
  ) {
    return null;
  }

  return pendingLastOutboundMessageId || null;
}
