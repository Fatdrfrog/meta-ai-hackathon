const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockChatCompletion = jest.fn();
const mockOptimizerFindOne = jest.fn();
const mockOptimizerCreate = jest.fn();
const mockOptimizerUpdate = jest.fn();
const mockEvalRunFindOne = jest.fn();
const mockEvalCaseFind = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletion(...args),
  getHeavyTextModel: jest.fn(() => "heavy-text-model"),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
  },
}));

jest.mock("@/models/scenario-eval-case", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockEvalCaseFind(...args) },
}));
jest.mock("@/models/scenario-eval-optimizer-run", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockOptimizerFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockOptimizerCreate(...args),
    updateOne: (...args: unknown[]) => mockOptimizerUpdate(...args),
  },
}));
jest.mock("@/models/scenario-eval-run", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockEvalRunFindOne(...args) },
}));

import {
  applyScenarioPromptPromotionWithCas,
  evaluatePromotionGate,
  keepsScenarioAnswerTokens,
  runScenarioPromptOptimizer,
} from "./prompt-optimizer";

function selectedLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

describe("optimizer AI allowance", () => {
  it.each([
    ["candidate", "own_ai_source_required"],
    ["candidate", "workspace_ai_policy_unavailable"],
    ["scoring", "own_ai_source_required"],
    ["scoring", "workspace_ai_policy_unavailable"],
  ])(
    "does not promote a fallback prompt when %s is denied by %s",
    async (phase, code) => {
      jest.clearAllMocks();
      mockChatCompletion.mockReset();
      mockOptimizerFindOne.mockReturnValue({
        sort: () => ({ lean: async () => null }),
      });
      mockOptimizerCreate.mockResolvedValue({ _id: "optimizer-1" });
      mockOptimizerUpdate.mockResolvedValue({ matchedCount: 1 });
      mockEvalRunFindOne.mockReturnValue({
        lean: async () => ({ status: "completed", scenarioId: "scenario-1" }),
      });
      mockScenarioFindOne.mockReturnValue(
        selectedLeanQuery({
          name: "Scenario",
          nodes: [
            {
              id: "reply-1",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyInstruction: "Existing prompt",
              },
            },
          ],
        })
      );
      mockEvalCaseFind.mockReturnValue({
        sort: () => ({ limit: () => ({ lean: async () => [] }) }),
      });
      if (phase === "scoring")
        mockChatCompletion.mockResolvedValueOnce({
          content: JSON.stringify({ candidatePrompt: "Candidate prompt" }),
        });
      const error = Object.assign(new Error("Policy denied inference"), {
        code,
      });
      mockChatCompletion.mockRejectedValueOnce(error);
      await expect(
        runScenarioPromptOptimizer({
          workspaceId: "workspace-1",
          evalRunId: "evaluation-1",
        })
      ).rejects.toBe(error);
      expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
      expect(mockOptimizerUpdate).toHaveBeenCalledWith(
        { _id: "optimizer-1" },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "failed" }),
        })
      );
    }
  );
});

describe("optimizer model", () => {
  const previousModel = process.env.SCENARIO_EVAL_OPTIMIZER_MODEL;

  afterEach(() => {
    if (previousModel === undefined)
      delete process.env.SCENARIO_EVAL_OPTIMIZER_MODEL;
    else process.env.SCENARIO_EVAL_OPTIMIZER_MODEL = previousModel;
  });

  it("passes a configured override through for the AI facade to map per provider", async () => {
    process.env.SCENARIO_EVAL_OPTIMIZER_MODEL = " gemini-3.5-pro ";
    jest.clearAllMocks();
    mockChatCompletion.mockReset();
    mockOptimizerFindOne.mockReturnValue({
      sort: () => ({ lean: async () => null }),
    });
    mockOptimizerCreate.mockResolvedValue({ _id: "optimizer-1" });
    mockOptimizerUpdate.mockResolvedValue({ matchedCount: 1 });
    mockEvalRunFindOne.mockReturnValue({
      lean: async () => ({ status: "completed", scenarioId: "scenario-1" }),
    });
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        name: "Scenario",
        nodes: [
          {
            id: "reply-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyInstruction: "Existing prompt",
            },
          },
        ],
      })
    );
    mockEvalCaseFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    });
    mockChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({ candidatePrompt: "Candidate prompt" }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ baselineScore: 0.5, candidateScore: 0.5 }),
      });

    await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
      autoPromote: false,
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of mockChatCompletion.mock.calls) {
      expect(request.model).toBe("gemini-3.5-pro");
    }
  });
});

describe("applyScenarioPromptPromotionWithCas", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retries from the latest graph and preserves an unrelated concurrent node edit", async () => {
    const initialRevision = new Date("2026-07-30T10:00:00.000Z");
    const concurrentRevision = new Date("2026-07-30T10:01:00.000Z");
    const initialNodes = [
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyInstruction: "baseline",
        },
      },
      {
        id: "action-2",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "before",
        },
      },
    ];
    const concurrentNodes = initialNodes.map(node =>
      node.id === "action-2"
        ? {
            ...node,
            data: {
              ...node.data,
              actionReplyText: "concurrent",
            },
          }
        : node
    );
    mockScenarioFindOne
      .mockReturnValueOnce(
        selectedLeanQuery({
          nodes: initialNodes,
          edges: [],
          updatedAt: initialRevision,
        })
      )
      .mockReturnValueOnce(
        selectedLeanQuery({
          nodes: concurrentNodes,
          edges: [],
          updatedAt: concurrentRevision,
        })
      );
    mockScenarioUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    const result = await applyScenarioPromptPromotionWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      actionNodeId: "action-1",
      promptField: "actionReplyInstruction",
      baselinePrompt: "baseline",
      candidatePrompt: "candidate",
      updatedBy: "user-1",
    });

    expect(result).toEqual({ applied: true, reason: null });
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne.mock.calls[1]?.[0]).toEqual({
      _id: "scenario-1",
      workspaceId: "workspace-1",
      deletedAt: null,
      status: "draft",
      updatedAt: concurrentRevision,
    });
    expect(mockScenarioUpdateOne.mock.calls[1]?.[1]?.$set?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "action-1",
          data: expect.objectContaining({
            actionReplyInstruction: "candidate",
          }),
        }),
        expect.objectContaining({
          id: "action-2",
          data: expect.objectContaining({
            actionReplyText: "concurrent",
          }),
        }),
      ])
    );
  });

  it("stops safely when the target prompt changes during a retry", async () => {
    const initialRevision = new Date("2026-07-30T10:00:00.000Z");
    const concurrentRevision = new Date("2026-07-30T10:01:00.000Z");
    mockScenarioFindOne
      .mockReturnValueOnce(
        selectedLeanQuery({
          nodes: [
            {
              id: "action-1",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyInstruction: "baseline",
              },
            },
          ],
          edges: [],
          updatedAt: initialRevision,
        })
      )
      .mockReturnValueOnce(
        selectedLeanQuery({
          nodes: [
            {
              id: "action-1",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyInstruction: "manager edit",
              },
            },
          ],
          edges: [],
          updatedAt: concurrentRevision,
        })
      );
    mockScenarioUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    const result = await applyScenarioPromptPromotionWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      actionNodeId: "action-1",
      promptField: "actionReplyInstruction",
      baselinePrompt: "baseline",
      candidatePrompt: "candidate",
      updatedBy: "user-1",
    });

    expect(result).toEqual({
      applied: false,
      reason: "baseline_changed_since_eval",
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("does not mutate a deleted or foreign-workspace scenario", async () => {
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(null));

    const result = await applyScenarioPromptPromotionWithCas({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      actionNodeId: "action-1",
      promptField: "actionReplyInstruction",
      baselinePrompt: "baseline",
      candidatePrompt: "candidate",
      updatedBy: "user-1",
    });

    expect(result).toEqual({
      applied: false,
      reason: "scenario_not_found",
    });
    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: "scenario-1",
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });
});

describe("answer tokens in an optimized prompt", () => {
  it("compares the customer answers two prompts name, in any order or syntax", () => {
    const baseline =
      "Confirm {{form.order.size}} for {{input.name}}, {{customer.firstName}}.";
    expect(
      keepsScenarioAnswerTokens(
        baseline,
        "Greet {input.name}. Confirm the size {{ form.order.size }}."
      )
    ).toBe(true);
    expect(
      keepsScenarioAnswerTokens(baseline, "Confirm {{form.order.size}}.")
    ).toBe(false);
    expect(
      keepsScenarioAnswerTokens(
        baseline,
        "Confirm {{form.order.colour}} for {{input.name}}."
      )
    ).toBe(false);
    expect(
      keepsScenarioAnswerTokens(
        baseline,
        "Confirm {{form.order.size}} for {{input.name}} in {{input.city}}."
      )
    ).toBe(false);
    // Other variables are the optimizer's to reword.
    expect(
      keepsScenarioAnswerTokens(
        baseline,
        "Confirm {{form.order.size}} for {{input.name}}."
      )
    ).toBe(true);
  });

  it("rejects a better-scored rewrite that drops an answer", async () => {
    jest.clearAllMocks();
    mockChatCompletion.mockReset();
    mockOptimizerFindOne.mockReturnValue({
      sort: () => ({ lean: async () => null }),
    });
    mockOptimizerCreate.mockResolvedValue({ _id: "optimizer-1" });
    mockOptimizerUpdate.mockResolvedValue({ matchedCount: 1 });
    mockEvalRunFindOne.mockReturnValue({
      lean: async () => ({ status: "completed", scenarioId: "scenario-1" }),
    });
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        name: "Scenario",
        nodes: [
          {
            id: "reply-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyInstruction:
                "Confirm the size {{form.order.size}} warmly.",
            },
          },
        ],
      })
    );
    mockEvalCaseFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    });
    mockChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({
          candidatePrompt: "Confirm the size warmly and briefly.",
          rationale: "Shorter",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          baselineScore: 0.4,
          candidateScore: 0.9,
          criticalRegressionRisk: false,
          reasons: [],
        }),
      });

    const result = await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
    });

    expect(result).toMatchObject({
      gateDecision: "reject",
      promotionApplied: false,
      reasons: expect.arrayContaining(["candidate_changed_answer_tokens"]),
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    const candidateRequest = mockChatCompletion.mock.calls[0][0];
    expect(candidateRequest.messages[1].content).toContain(
      "Keep every {{...}} variable exactly as written"
    );
    // Both the rewrite and the scoring run on the heavy tier, with a
    // deadline sized for it rather than the facade's 30 s default.
    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of mockChatCompletion.mock.calls) {
      expect(request.model).toBe("heavy-text-model");
      expect(request.resilience).toEqual({ timeoutMs: 60_000 });
    }
    expect(
      evaluatePromotionGate({
        baselineScore: 0.4,
        candidateScore: 0.9,
        candidateScored: true,
        candidateFromFallback: false,
        criticalRegressionRisk: false,
        sameAsBaseline: false,
        answerTokensChanged: false,
        requiredImprovement: 0.02,
      }).decision
    ).toBe("promote");
  });
});

describe("unscored candidates", () => {
  const graph = {
    name: "Scenario",
    nodes: [
      {
        id: "reply-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyInstruction: "Existing prompt",
        },
      },
    ],
    edges: [],
    updatedAt: new Date("2026-10-07T10:00:00.000Z"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatCompletion.mockReset();
    mockOptimizerFindOne.mockReturnValue({
      sort: () => ({ lean: async () => null }),
    });
    mockOptimizerCreate.mockResolvedValue({ _id: "optimizer-1" });
    mockOptimizerUpdate.mockResolvedValue({ matchedCount: 1 });
    mockEvalRunFindOne.mockReturnValue({
      lean: async () => ({
        status: "completed",
        scenarioId: "scenario-1",
        metricsSnapshot: { llmQualityPassRate: 0.5 },
      }),
    });
    mockScenarioFindOne.mockImplementation(() => selectedLeanQuery(graph));
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockEvalCaseFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    });
  });

  function expectRejectedUnscored(
    result: Awaited<ReturnType<typeof runScenarioPromptOptimizer>>,
    scorerReason: string
  ) {
    expect(result).toMatchObject({
      gateDecision: "reject",
      promotionApplied: false,
      baselineScore: 0.5,
      candidateScore: 0.5,
      improvement: 0,
      reasons: expect.arrayContaining([scorerReason, "candidate_unscored"]),
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    expect(mockOptimizerUpdate).toHaveBeenCalledWith(
      { _id: "optimizer-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "completed",
          gateDecision: "reject",
          promotionApplied: false,
          gateReasons: expect.arrayContaining([
            scorerReason,
            "candidate_unscored",
          ]),
        }),
      })
    );
  }

  it("does not auto-promote when the scorer call fails", async () => {
    mockChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({ candidatePrompt: "Candidate prompt" }),
      })
      .mockRejectedValueOnce(new Error("AI chat provider attempts failed"));

    const result = await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
      triggeredBy: "cron",
    });

    expectRejectedUnscored(result, "llm_scorer_fallback");
  });

  it("does not auto-promote the heuristic prompt during a full AI outage", async () => {
    mockChatCompletion.mockRejectedValue(
      new Error("AI chat provider attempts failed")
    );

    const result = await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
      triggeredBy: "cron",
    });

    expectRejectedUnscored(result, "llm_scorer_fallback");
    expect(result.reasons).toContain("candidate_from_fallback_template");
    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
  });

  const scores = (values: Record<string, unknown>) =>
    JSON.stringify({ criticalRegressionRisk: false, ...values });

  it.each([
    ["no JSON", "The candidate looks better."],
    ["a missing candidate score", scores({ baselineScore: 0.1 })],
    ["a missing baseline score", scores({ candidateScore: 0.9 })],
    [
      "non-numeric scores",
      scores({ baselineScore: "0.1", candidateScore: "0.9" }),
    ],
    [
      "a candidate score on another scale",
      scores({ baselineScore: 0.5, candidateScore: 55 }),
    ],
    [
      "a negative baseline score",
      scores({ baselineScore: -1, candidateScore: 0.4 }),
    ],
    [
      "a candidate score above 1",
      scores({ baselineScore: 0.5, candidateScore: 1.5 }),
    ],
    [
      "a non-boolean risk flag",
      JSON.stringify({
        baselineScore: 0.1,
        candidateScore: 0.9,
        criticalRegressionRisk: "true",
      }),
    ],
    [
      "no risk flag",
      JSON.stringify({ baselineScore: 0.1, candidateScore: 0.9 }),
    ],
  ])(
    "does not auto-promote when the scorer returns %s",
    async (_label, content) => {
      mockChatCompletion
        .mockResolvedValueOnce({
          content: JSON.stringify({ candidatePrompt: "Candidate prompt" }),
        })
        .mockResolvedValueOnce({ content });

      const result = await runScenarioPromptOptimizer({
        workspaceId: "workspace-1",
        evalRunId: "evaluation-1",
      });

      expectRejectedUnscored(result, "llm_scorer_invalid_response");
    }
  );

  it("still promotes a candidate the scorer rated above the threshold", async () => {
    mockChatCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({ candidatePrompt: "Candidate prompt" }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          baselineScore: 0.5,
          candidateScore: 0.6,
          criticalRegressionRisk: false,
          reasons: ["clearer next step"],
        }),
      });

    const result = await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
    });

    expect(result).toMatchObject({
      gateDecision: "promote",
      promotionApplied: true,
      reasons: ["clearer next step"],
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the generator call fails", null],
    ["the generator returns no candidate", { rationale: "No change" }],
  ])(
    "does not auto-promote the fallback template when %s, however well it scores",
    async (_label, generatorContent) => {
      if (generatorContent === null)
        mockChatCompletion.mockRejectedValueOnce(
          new Error("Anthropic request timeout")
        );
      else
        mockChatCompletion.mockResolvedValueOnce({
          content: JSON.stringify(generatorContent),
        });
      mockChatCompletion.mockResolvedValueOnce({
        content: scores({ baselineScore: 0.5, candidateScore: 0.7 }),
      });

      const result = await runScenarioPromptOptimizer({
        workspaceId: "workspace-1",
        evalRunId: "evaluation-1",
        triggeredBy: "cron",
      });

      expect(result).toMatchObject({
        gateDecision: "reject",
        promotionApplied: false,
        reasons: ["candidate_from_fallback_template"],
      });
      expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
    }
  );

  it("never writes the fallback template into a fixed customer reply", async () => {
    mockScenarioFindOne.mockImplementation(() =>
      selectedLeanQuery({
        ...graph,
        nodes: [
          {
            id: "reply-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyText: "Спасибо! Ваша заявка принята.",
            },
          },
        ],
      })
    );
    mockChatCompletion
      .mockResolvedValueOnce({ content: JSON.stringify({ prompt: "x" }) })
      .mockResolvedValueOnce({
        content: scores({ baselineScore: 0.5, candidateScore: 0.6 }),
      });

    const result = await runScenarioPromptOptimizer({
      workspaceId: "workspace-1",
      evalRunId: "evaluation-1",
      triggeredBy: "cron",
    });

    expect(result).toMatchObject({
      promptField: "actionReplyText",
      gateDecision: "reject",
      promotionApplied: false,
    });
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects an unscored candidate at the gate whatever its scores", () => {
    expect(
      evaluatePromotionGate({
        baselineScore: 0.1,
        candidateScore: 0.9,
        candidateScored: false,
        candidateFromFallback: false,
        criticalRegressionRisk: false,
        sameAsBaseline: false,
        answerTokensChanged: false,
        requiredImprovement: 0.02,
      })
    ).toMatchObject({
      decision: "reject",
      reasons: ["candidate_unscored"],
    });
  });

  it("rejects the fallback template at the gate whatever its scores", () => {
    expect(
      evaluatePromotionGate({
        baselineScore: 0.1,
        candidateScore: 0.9,
        candidateScored: true,
        candidateFromFallback: true,
        criticalRegressionRisk: false,
        sameAsBaseline: false,
        answerTokensChanged: false,
        requiredImprovement: 0.02,
      })
    ).toMatchObject({
      decision: "reject",
      reasons: ["candidate_from_fallback_template"],
    });
  });
});
