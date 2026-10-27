import {
  resolvePendingInteractiveOutboundAnchor,
  resolveAutoReplyExecutionGates,
  selectScenarioContinuationOutcome,
  selectScenarioResolutionOutcome,
  shouldSkipBeforeScenarioResolution,
} from "@/lib/airi/reply/runtime/auto-reply-execution-gates";

describe("auto-reply execution gates", () => {
  it("continues to scenario resolution when scenarios are on and auto-replies are off", () => {
    const gates = resolveAutoReplyExecutionGates({
      autoReplyEnabled: false,
      scenariosEnabled: true,
    });

    expect(gates.canResolveScenarios).toBe(true);
    expect(gates.canDeliverAutoReply).toBe(false);
    expect(shouldSkipBeforeScenarioResolution(gates, false)).toBe(false);
  });

  it("skips early when both scenarios and auto-replies are off for a normal inbound", () => {
    const gates = resolveAutoReplyExecutionGates({
      autoReplyEnabled: false,
      scenariosEnabled: false,
    });

    expect(gates.canResolveScenarios).toBe(false);
    expect(gates.canDeliverAutoReply).toBe(false);
    expect(shouldSkipBeforeScenarioResolution(gates, false)).toBe(true);
    expect(shouldSkipBeforeScenarioResolution(gates, true)).toBe(true);
  });

  it("does not let scenario enablement leak into auto-reply delivery", () => {
    const gates = resolveAutoReplyExecutionGates({
      autoReplyEnabled: false,
      scenariosEnabled: true,
    });

    expect(gates.canDeliverAutoReply).toBe(false);
  });

  it("retains a blocked scenario action as a terminal resolution outcome", () => {
    const blockedResolution = {
      runtime: null,
      blockedScenarioAction: {
        reason: "whatsapp_service_message_unsupported" as const,
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
    };

    expect(selectScenarioResolutionOutcome(null, blockedResolution)).toBe(
      blockedResolution
    );
  });

  it("ignores an unresolved scenario miss so another resolver may run", () => {
    expect(selectScenarioResolutionOutcome(null, { runtime: null })).toBeNull();
  });

  it("keeps an unresolved forced continuation authoritative", () => {
    const unresolvedContinuation = { runtime: null };

    expect(selectScenarioContinuationOutcome(unresolvedContinuation)).toBe(
      unresolvedContinuation
    );
    expect(selectScenarioContinuationOutcome()).toEqual({ runtime: null });
  });

  it("replaces the claimed continuation sentinel when forced resolution succeeds", () => {
    const resolvedContinuation = {
      runtime: { scenarioId: "scenario-1" },
    } as never;

    expect(selectScenarioContinuationOutcome(resolvedContinuation)).toBe(
      resolvedContinuation
    );
  });

  it.each([
    ["matching pending action", "action-1", "condition-1", "message-out-1"],
    ["different pending action", "action-2", "condition-1", null],
    ["missing pending condition", "action-1", null, null],
  ])(
    "selects the interactive outbound anchor for %s",
    (_, pendingSourceActionNodeId, pendingConditionNodeId, expected) => {
      expect(
        resolvePendingInteractiveOutboundAnchor({
          currentActionNodeId: "action-1",
          pendingConditionNodeId,
          pendingSourceActionNodeId,
          pendingLastOutboundMessageId: "message-out-1",
        })
      ).toBe(expected);
    }
  );
});
