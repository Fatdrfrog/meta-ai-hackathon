import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  MAX_SCENARIO_ACTION_ANSWER_MATCHES,
  MAX_SCENARIO_ACTION_RUN_CONDITIONS,
  buildScenarioActionAnswerOutcomeHandleId,
  getConfiguredScenarioActionOutcomeHandleIds,
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRunConditions,
  parseScenarioActionOutcomeHandleId,
} from "@icecore/scenario-contracts";

describe("shared scenario action routing contracts", () => {
  it("keeps stable answer ids and deterministic handles", () => {
    const normalized = normalizeScenarioActionOutcomes({
      version: 1,
      answerMatches: [{ id: "price answer", mode: "exact", text: "Price" }],
    });

    expect(normalized.status).toBe("supported");
    expect(normalized.value?.answerMatches).toEqual([
      { id: "price_answer", mode: "exact", text: "Price" },
    ]);

    const handle = buildScenarioActionAnswerOutcomeHandleId("price_answer");
    expect(parseScenarioActionOutcomeHandleId(handle)).toEqual({
      type: "answer",
      ruleId: "price_answer",
    });
    expect(getScenarioActionOutcomeVirtualNodeId("action 1")).toBe(
      "__system:action-outcomes:action%201"
    );
  });

  it("bounds supported routing without enabling invalid outcomes", () => {
    expect(
      normalizeScenarioActionRunConditions({
        version: 1,
        match: "any",
        conditions: [
          { id: " vip ", type: "internal_label", label: " VIP " },
          { id: "skip", type: "classification", category: " " },
        ],
      })
    ).toEqual({
      status: "supported",
      value: {
        version: 1,
        match: "all",
        conditions: [{ id: "vip", type: "internal_label", label: "VIP" }],
      },
    });

    expect(
      normalizeScenarioActionOutcomes({
        version: 1,
        anyReply: { enabled: "yes" },
        noReply: { enabled: true, timeoutMinutes: 0 },
        paymentDetected: { enabled: true },
      })
    ).toEqual({
      status: "supported",
      value: {
        version: 1,
        paymentDetected: { enabled: true },
      },
    });
  });

  it("preserves unknown versions without interpreting their fields", () => {
    const raw = { version: 3, anyReply: { enabled: true } };

    expect(normalizeScenarioActionOutcomes(raw)).toEqual({
      status: "unsupported",
      value: null,
      version: 3,
      raw,
    });
  });

  it("caps condition and answer-match arrays", () => {
    const conditions = Array.from({ length: 25 }, (_, index) => ({
      id: `label-${index}`,
      type: "internal_label",
      label: `Label ${index}`,
    }));
    const answerMatches = Array.from({ length: 25 }, (_, index) => ({
      id: `answer-${index}`,
      mode: "exact",
      text: `Answer ${index}`,
    }));

    const runConditions = normalizeScenarioActionRunConditions({
      version: 1,
      conditions,
    });
    const outcomes = normalizeScenarioActionOutcomes({
      version: 1,
      answerMatches,
    });

    expect(runConditions.value?.conditions).toHaveLength(
      MAX_SCENARIO_ACTION_RUN_CONDITIONS
    );
    expect(outcomes.value?.answerMatches).toHaveLength(
      MAX_SCENARIO_ACTION_ANSWER_MATCHES
    );
  });

  it("parses only named action outcome handles", () => {
    expect(
      parseScenarioActionOutcomeHandleId(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID)
    ).toEqual({
      type: "any_reply",
    });
    expect(
      parseScenarioActionOutcomeHandleId(ACTION_NO_REPLY_OUTCOME_HANDLE_ID)
    ).toEqual({
      type: "no_reply",
    });
    expect(
      parseScenarioActionOutcomeHandleId(ACTION_PAYMENT_OUTCOME_HANDLE_ID)
    ).toEqual({ type: "payment_detected" });
    expect(parseScenarioActionOutcomeHandleId("right-source")).toBeNull();
    expect(
      parseScenarioActionOutcomeHandleId(
        "right-source-action-outcome::answer::%E0%A4%A"
      )
    ).toBeNull();
  });

  it("returns configured outcome handles in deterministic priority order", () => {
    expect(
      getConfiguredScenarioActionOutcomeHandleIds({
        version: 1,
        paymentDetected: { enabled: true },
        answerMatches: [
          { id: "answer-1", mode: "exact", text: "Yes" },
          { id: "answer-2", mode: "intent", text: "Interested" },
        ],
        noReply: { enabled: true, timeoutMinutes: 60 },
        anyReply: { enabled: true },
      })
    ).toEqual([
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      buildScenarioActionAnswerOutcomeHandleId("answer-1"),
      buildScenarioActionAnswerOutcomeHandleId("answer-2"),
      ACTION_PAYMENT_OUTCOME_HANDLE_ID,
    ]);
    expect(getConfiguredScenarioActionOutcomeHandleIds(undefined)).toEqual([]);
    expect(getConfiguredScenarioActionOutcomeHandleIds({ version: 3 })).toEqual(
      []
    );
  });
});
