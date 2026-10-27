jest.mock(
  "@/lib/airi/rag/conversation-summary/conversation-summary-storage",
  () => ({ persistConversationSummaryRevision: jest.fn() })
);
jest.mock("@/lib/analytics", () => ({
  trackConversationClassificationCompleted: jest.fn(),
}));
jest.mock("@/lib/realtime/server", () => ({
  enqueueConversationClassificationReadyRealtimeEvent: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDelta: jest.fn(),
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerClassificationCompletedStrict: jest.fn(),
}));

import {
  CONVERSATION_ANALYSIS_EFFECT_STEPS,
  type ConversationAnalysisEffectStep,
  type ConversationAnalysisEffectsLeaseIdentity,
  type ConversationAnalysisEffectsSnapshot,
} from "./conversation-classification-store";
import {
  dispatchConversationClassificationEffects,
  type ClassificationEffectsWideEvent,
  type ConversationClassificationEffectsDependencies,
} from "./conversation-classification-effects";

const NOW = new Date("2026-08-10T06:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-10T05:59:00.000Z");
const RETRY_AT = new Date("2026-08-10T06:01:00.000Z");

function emptyChecklist(): Record<ConversationAnalysisEffectStep, Date | null> {
  return Object.fromEntries(
    CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [step, null])
  ) as Record<ConversationAnalysisEffectStep, Date | null>;
}

function snapshot(
  overrides: Partial<ConversationAnalysisEffectsSnapshot> = {}
): ConversationAnalysisEffectsSnapshot {
  return {
    analysisRevisionId: "analysis-7",
    conversationId: "66b000000000000000000007",
    workspaceId: "workspace-1",
    sourceRevision: 7,
    completedAt: COMPLETED_AT,
    outcome: "ready",
    projection: {
      classification: {
        category: "Support",
        priority: "medium",
        sentiment: "neutral",
        summary: "Customer needs help.",
        confidence: { category: 0.75 },
      },
    },
    effectInputs: {
      companyId: "company-1",
      source: { id: "source-1", type: "whatsapp" },
      predictedCategoryConfidence: 0.9,
      processingTimeMs: 1_250,
      provider: "vertex",
      model: "gemini-2.5-flash",
      ragSummary: {
        mode: "replace",
        language: "en",
        summary: "Customer needs help.",
        chunks: ["Customer needs help."],
        metadata: {
          wordCount: 3,
          messageCount: 2,
          chunkCount: 1,
          generationTimeMs: 250,
        },
      },
    },
    checklist: emptyChecklist(),
    ...overrides,
  };
}

function lease(
  overrides: Partial<ConversationAnalysisEffectsLeaseIdentity> = {}
): ConversationAnalysisEffectsLeaseIdentity {
  return {
    analysisRevisionId: "analysis-7",
    conversationId: "66b000000000000000000007",
    sourceRevision: 7,
    ownerToken: "owner-1",
    fence: 1,
    expiresAt: new Date("2026-08-10T06:10:00.000Z"),
    attemptCount: 1,
    ...overrides,
  };
}

function makeDependencies() {
  const calls: string[] = [];
  let currentExpiryMs = lease().expiresAt.getTime();
  const completed = new Set<ConversationAnalysisEffectStep>();
  const writeWideEvent = jest.fn<void, [ClassificationEffectsWideEvent]>();
  const dependencies: ConversationClassificationEffectsDependencies = {
    claimConversationAnalysisEffects: jest.fn(async () => ({
      status: "claimed" as const,
      lease: lease(),
      analysis: snapshot(),
    })),
    renewConversationAnalysisEffectsLease: jest.fn(async current => {
      calls.push("renew");
      currentExpiryMs += 1;
      return {
        status: "renewed" as const,
        lease: { ...current, expiresAt: new Date(currentExpiryMs) },
      };
    }),
    authorizeConversationAnalysisEffectStep: jest.fn(async ({ step }) => {
      calls.push(`authorize:${step}`);
      return completed.has(step) ? "already_completed" : "authorized";
    }),
    completeConversationAnalysisEffectStep: jest.fn(async ({ step }) => {
      calls.push(`complete:${step}`);
      completed.add(step);
      return "completed";
    }),
    completeConversationAnalysisEffects: jest.fn(async () => {
      calls.push("complete:all");
      return "completed";
    }),
    recordConversationAnalysisEffectsFailure: jest.fn(async () => {
      calls.push("failure");
      return { status: "retry_scheduled" as const, nextAttemptAt: RETRY_AT };
    }),
    persistConversationSummaryRevision: jest.fn(async () => {
      calls.push("sink:summary");
      return { status: "completed" as const };
    }),
    trackConversationClassificationCompleted: jest.fn(async () => {
      calls.push("sink:analytics");
      return { status: "accepted" as const };
    }),
    enqueueConversationClassificationReadyRealtimeEvent: jest.fn(async () => {
      calls.push("sink:realtime");
    }),
    emitWorkspaceUsageDelta: jest.fn(async () => {
      calls.push("sink:usage");
      return { ok: true as const, messageId: "usage-1" };
    }),
    triggerClassificationCompletedStrict: jest.fn(async () => {
      calls.push("sink:webhook");
    }),
    now: () => new Date(NOW),
    setTimer: jest.fn(
      () => ({ fakeTimer: true }) as unknown as ReturnType<typeof setTimeout>
    ),
    clearTimer: jest.fn(),
    writeWideEvent,
  };
  return { dependencies, calls, completed, writeWideEvent };
}

describe("conversation classification durable effects dispatcher", () => {
  it.each([
    [{ status: "completed" }, { status: "completed" }],
    [
      { status: "retry_scheduled", nextAttemptAt: RETRY_AT },
      { status: "retry_scheduled", nextAttemptAt: RETRY_AT },
    ],
    [{ status: "superseded" }, { status: "superseded" }],
    [{ status: "lease_lost" }, { status: "lease_lost" }],
  ] as const)(
    "maps a persisted non-claim result without a sink",
    async (claim, expected) => {
      const { dependencies, calls, writeWideEvent } = makeDependencies();
      jest
        .mocked(dependencies.claimConversationAnalysisEffects)
        .mockResolvedValueOnce(claim);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual(expected);
      expect(calls).toEqual([]);
      expect(writeWideEvent).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["unknown status", { status: "private_unknown_status" }],
    ["null result", null],
    [
      "invalid retry date",
      { status: "retry_scheduled", nextAttemptAt: new Date(Number.NaN) },
    ],
  ])("fails closed on an initial claim with %s", async (_name, rawClaim) => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce(rawClaim as never);

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([]);
    expect(writeWideEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["inherited status", Object.create({ status: "completed" })],
    [
      "inherited retry date",
      Object.assign(Object.create({ nextAttemptAt: RETRY_AT }), {
        status: "retry_scheduled",
      }),
    ],
  ])("rejects an initial claim with %s", async (_name, rawResult) => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce(rawResult as never);

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([]);
    expect(writeWideEvent).not.toHaveBeenCalled();
  });

  it("treats own claimed status with non-own lease and analysis as an unpersisted attempt", async () => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();
    const rawClaim = new Proxy(
      { status: "claimed" },
      {
        get(target, field, receiver) {
          if (field === "lease") return lease();
          if (field === "analysis") return snapshot();
          return Reflect.get(target, field, receiver);
        },
      }
    );
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce(rawClaim as never);

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([]);
    expect(writeWideEvent).toHaveBeenCalledTimes(1);
    expect(writeWideEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisRevisionId: "analysis-7",
        conversationId: "invalid",
        workspaceId: "invalid",
        sourceRevision: null,
        attemptCount: 0,
        fence: 0,
        terminalStatus: "unpersisted_error",
      })
    );
  });

  it("backs off an unexpected renewal result without authorizing or running a sink", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockResolvedValueOnce({ status: "private_unknown_status" } as never);

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(
      dependencies.authorizeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.persistConversationSummaryRevision
    ).not.toHaveBeenCalled();
    expect(
      dependencies.completeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
  });

  it("backs off an inherited renewal success without running a sink", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockResolvedValueOnce(
        Object.create({
          status: "renewed",
          lease: lease({
            expiresAt: new Date("2026-08-10T06:10:00.001Z"),
          }),
        }) as never
      );

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(
      dependencies.authorizeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.persistConversationSummaryRevision
    ).not.toHaveBeenCalled();
  });

  it("normalizes an initial claim exception without retaining private error data", async () => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockRejectedValueOnce(
        Object.assign(new Error("private claim database payload"), {
          code: "PRIVATE_CLAIM_CODE",
        })
      );

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(String(error.stack)).not.toContain("private claim database payload");
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([]);
    expect(writeWideEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["null lease", null],
    [
      "malformed lease",
      {
        privatePayload: "summary secret payload",
        code: "PRIVATE_LEASE_CODE",
      },
    ],
  ])("fails closed on a claimed envelope with %s", async (_name, rawLease) => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce({
        status: "claimed",
        lease: rawLease,
        analysis: snapshot(),
      } as never);

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([]);
    expect(
      dependencies.renewConversationAnalysisEffectsLease
    ).not.toHaveBeenCalled();
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).not.toHaveBeenCalled();
    expect(writeWideEvent).toHaveBeenCalledTimes(1);
    expect(writeWideEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "classification.effects",
        analysisRevisionId: "analysis-7",
        conversationId: "66b000000000000000000007",
        workspaceId: "workspace-1",
        sourceRevision: 7,
        attemptCount: 0,
        fence: 0,
        steps: [],
        errors: [
          {
            scope: "control",
            name: "InvariantError",
            code: "invariant_violation",
            message: "Classification effects invariant failed",
          },
        ],
        terminalStatus: "unpersisted_error",
      })
    );
    expect(JSON.stringify(writeWideEvent.mock.calls)).not.toContain(
      "summary secret payload"
    );
    expect(JSON.stringify(writeWideEvent.mock.calls)).not.toContain(
      "PRIVATE_LEASE_CODE"
    );
  });

  it.each([
    ["null analysis", null],
    ["non-object analysis", "private analysis payload"],
  ])(
    "durably backs off a valid claimed lease with %s and emits safely",
    async (_name, rawAnalysis) => {
      const { dependencies, calls, writeWideEvent } = makeDependencies();
      jest
        .mocked(dependencies.claimConversationAnalysisEffects)
        .mockResolvedValueOnce({
          status: "claimed",
          lease: lease(),
          analysis: rawAnalysis,
        } as never);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(calls).toEqual(["renew", "failure"]);
      expect(writeWideEvent).toHaveBeenCalledTimes(1);
      expect(writeWideEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          analysisRevisionId: "analysis-7",
          conversationId: "66b000000000000000000007",
          workspaceId: "invalid",
          sourceRevision: 7,
          attemptCount: 1,
          fence: 1,
          terminalStatus: "retry_scheduled",
        })
      );
      expect(JSON.stringify(writeWideEvent.mock.calls)).not.toContain(
        "private analysis payload"
      );
    }
  );

  it("runs the exact five steps in order with fresh DTOs and independent confidence identities", async () => {
    const { dependencies, calls, writeWideEvent } = makeDependencies();

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toEqual([
      "renew",
      "authorize:summary",
      "sink:summary",
      "complete:summary",
      "renew",
      "authorize:analytics",
      "sink:analytics",
      "complete:analytics",
      "renew",
      "authorize:realtime",
      "sink:realtime",
      "complete:realtime",
      "renew",
      "authorize:usage",
      "sink:usage",
      "complete:usage",
      "renew",
      "authorize:webhook",
      "sink:webhook",
      "complete:webhook",
      "renew",
      "complete:all",
    ]);
    expect(
      dependencies.persistConversationSummaryRevision
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "66b000000000000000000007",
      analysisRevisionId: "analysis-7",
      sourceRevision: 7,
      completedAt: COMPLETED_AT,
      ragSummary: snapshot().effectInputs.ragSummary,
    });
    expect(
      dependencies.trackConversationClassificationCompleted
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisRevisionId: "analysis-7",
        conversationId: "66b000000000000000000007",
        sourceRevision: 7,
        completedAt: COMPLETED_AT,
        workspaceId: "workspace-1",
        effectInputs: expect.objectContaining({
          predictedCategoryConfidence: 0.9,
        }),
      })
    );
    expect(dependencies.emitWorkspaceUsageDelta).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      companyId: "company-1",
      metric: "classification_count",
      delta: 1,
      objectId: "66b000000000000000000007",
      occurredAt: COMPLETED_AT,
      source: "classification",
      metadata: { analysisRevisionId: "analysis-7", sourceRevision: 7 },
    });
    expect(
      dependencies.triggerClassificationCompletedStrict
    ).toHaveBeenCalledWith("workspace-1", {
      conversation_id: "66b000000000000000000007",
      category: "Support",
      priority: "medium",
      sentiment: "neutral",
      summary: "Customer needs help.",
      confidence: 0.75,
      completed_at: COMPLETED_AT.toISOString(),
      analysis_revision_id: "analysis-7",
      source_revision: 7,
    });
    expect(writeWideEvent).toHaveBeenCalledTimes(1);
    expect(dependencies.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      200_000
    );
    expect(dependencies.clearTimer).toHaveBeenCalledTimes(1);
    expect(writeWideEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "classification.effects",
        analysisRevisionId: "analysis-7",
        conversationId: "66b000000000000000000007",
        workspaceId: "workspace-1",
        attemptCount: 1,
        fence: 1,
        terminalStatus: "completed",
      })
    );
  });

  it("resumes completed checklist entries without rerunning their sinks", async () => {
    const { dependencies, calls } = makeDependencies();
    const checklist = emptyChecklist();
    checklist.summary = COMPLETED_AT;
    checklist.analytics = COMPLETED_AT;
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce({
        status: "claimed",
        lease: lease(),
        analysis: snapshot({ checklist }),
      });

    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );

    expect(calls).not.toContain("sink:summary");
    expect(calls).not.toContain("sink:analytics");
    expect(calls.filter(call => call.startsWith("sink:"))).toEqual([
      "sink:realtime",
      "sink:usage",
      "sink:webhook",
    ]);
  });

  it("persists successful independent steps before one global backoff", async () => {
    const { dependencies, calls, completed, writeWideEvent } =
      makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async () => {
        calls.push("sink:summary");
        throw Object.assign(new Error("summary secret payload"), {
          code: "SUMMARY_PRIVATE_CODE_THAT_IS_BOUNDED",
          stack: "private stack",
        });
      });
    jest
      .mocked(dependencies.trackConversationClassificationCompleted)
      .mockImplementationOnce(async () => {
        calls.push("sink:analytics");
        throw new Error("analytics failed");
      });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(calls).toContain("sink:realtime");
    expect(calls).toContain("sink:usage");
    expect(calls).toContain("sink:webhook");
    expect(completed).toEqual(new Set(["realtime", "usage", "webhook"]));
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledWith({
      lease: expect.objectContaining({ analysisRevisionId: "analysis-7" }),
    });
    const event = writeWideEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(event)).not.toContain("private stack");
    expect(JSON.stringify(event)).not.toContain("summary secret payload");
    expect(JSON.stringify(event)).not.toContain(
      "SUMMARY_PRIVATE_CODE_THAT_IS_BOUNDED"
    );
    expect(JSON.stringify(event)).not.toContain("Customer needs help");
    expect(event?.errors).toHaveLength(2);
  });

  it("turns summary supersession into a durable invariant backoff and stops later sinks", async () => {
    const { dependencies, calls } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async () => {
        calls.push("sink:summary");
        return { status: "superseded" };
      });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(calls).toEqual([
      "renew",
      "authorize:summary",
      "sink:summary",
      "renew",
      "authorize:summary",
      "renew",
      "failure",
    ]);
    expect(
      dependencies.completeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.trackConversationClassificationCompleted
    ).not.toHaveBeenCalled();
  });

  it.each(["superseded", "lease_lost"] as const)(
    "maps summary-superseded reauthorization %s without guessing a retry",
    async outcome => {
      const { dependencies, calls } = makeDependencies();
      jest
        .mocked(dependencies.persistConversationSummaryRevision)
        .mockResolvedValueOnce({ status: "superseded" });
      if (outcome === "lease_lost") {
        jest
          .mocked(dependencies.renewConversationAnalysisEffectsLease)
          .mockResolvedValueOnce({
            status: "renewed",
            lease: lease({
              expiresAt: new Date("2026-08-10T06:10:00.001Z"),
            }),
          })
          .mockResolvedValueOnce({ status: "lease_lost" });
      } else {
        jest
          .mocked(dependencies.authorizeConversationAnalysisEffectStep)
          .mockResolvedValueOnce("authorized")
          .mockResolvedValueOnce("superseded");
      }

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({ status: outcome });
      expect(
        dependencies.persistConversationSummaryRevision
      ).toHaveBeenCalledTimes(1);
      expect(calls.filter(call => call.startsWith("sink:")).slice(1)).toEqual(
        []
      );
      expect(
        dependencies.recordConversationAnalysisEffectsFailure
      ).not.toHaveBeenCalled();
    }
  );

  it("backs off an unexpected incomplete terminalization", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.completeConversationAnalysisEffects)
      .mockResolvedValueOnce("incomplete");

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
  });

  it.each(["superseded", "lease_lost"] as const)(
    "maps terminal completion %s directly",
    async outcome => {
      const { dependencies } = makeDependencies();
      jest
        .mocked(dependencies.completeConversationAnalysisEffects)
        .mockResolvedValueOnce(outcome);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({ status: outcome });
      expect(
        dependencies.recordConversationAnalysisEffectsFailure
      ).not.toHaveBeenCalled();
    }
  );

  it.each(["superseded", "lease_lost"] as const)(
    "maps failure persistence %s directly",
    async outcome => {
      const { dependencies } = makeDependencies();
      jest
        .mocked(dependencies.persistConversationSummaryRevision)
        .mockRejectedValueOnce(new Error("summary failed"));
      jest
        .mocked(dependencies.recordConversationAnalysisEffectsFailure)
        .mockResolvedValueOnce({ status: outcome });

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({ status: outcome });
    }
  );

  it("propagates failure persistence exceptions instead of inventing a public result", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockRejectedValueOnce(new Error("summary failed"));
    jest
      .mocked(dependencies.recordConversationAnalysisEffectsFailure)
      .mockRejectedValueOnce(new Error("failure store unavailable"));

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(String(error.stack)).not.toContain("failure store unavailable");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects inherited failure-persistence fields instead of inventing a retry", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockRejectedValueOnce(new Error("summary failed"));
    jest
      .mocked(dependencies.recordConversationAnalysisEffectsFailure)
      .mockResolvedValueOnce(
        Object.assign(Object.create({ nextAttemptAt: RETRY_AT }), {
          status: "retry_scheduled",
        }) as never
      );

    const error = (await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    ).then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it("treats summary superseded plus already-completed Mongo state as an invariant backoff", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockResolvedValueOnce({ status: "superseded" });
    jest
      .mocked(dependencies.authorizeConversationAnalysisEffectStep)
      .mockResolvedValueOnce("authorized")
      .mockResolvedValueOnce("already_completed");

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["summary", "persistConversationSummaryRevision", { status: "unknown" }],
    [
      "analytics",
      "trackConversationClassificationCompleted",
      { status: "unknown" },
    ],
    ["usage", "emitWorkspaceUsageDelta", { ok: false, skipped: false }],
  ] as const)(
    "backs off an unexpected %s owner result and continues independent sinks",
    async (step, dependencyName, invalidResult) => {
      const { dependencies, completed } = makeDependencies();
      (
        dependencies[dependencyName] as unknown as jest.Mock<Promise<unknown>>
      ).mockResolvedValueOnce(invalidResult);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(completed.has(step as ConversationAnalysisEffectStep)).toBe(false);
      expect(completed.has("webhook")).toBe(true);
    }
  );

  it.each([
    [
      "summary status",
      "persistConversationSummaryRevision",
      Object.create({ status: "completed" }),
      "summary",
    ],
    [
      "usage skip reason",
      "emitWorkspaceUsageDelta",
      Object.assign(Object.create({ reason: "disabled" }), {
        ok: false,
        skipped: true,
      }),
      "usage",
    ],
  ] as const)(
    "backs off inherited %s and never marks that step",
    async (_name, dependencyName, inheritedResult, step) => {
      const { dependencies, completed } = makeDependencies();
      (
        dependencies[dependencyName] as unknown as jest.Mock<Promise<unknown>>
      ).mockResolvedValueOnce(inheritedResult);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(completed.has(step)).toBe(false);
      expect(completed.has("webhook")).toBe(true);
    }
  );

  it("accepts only the exact disabled usage no-op", async () => {
    const { dependencies, completed } = makeDependencies();
    jest.mocked(dependencies.emitWorkspaceUsageDelta).mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: "disabled",
    });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({ status: "completed" });
    expect(completed.has("usage")).toBe(true);
  });

  it("backs off every non-disabled usage skip while retaining other successes", async () => {
    const { dependencies, completed } = makeDependencies();
    jest.mocked(dependencies.emitWorkspaceUsageDelta).mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: "missing_company",
    });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(completed.has("usage")).toBe(false);
    expect(completed.has("webhook")).toBe(true);
  });

  it.each([
    [
      "raw predicted confidence",
      snapshot({
        effectInputs: {
          ...snapshot().effectInputs,
          predictedCategoryConfidence: 1.1,
        },
      }),
    ],
    [
      "committed projection confidence",
      snapshot({
        projection: {
          classification: {
            category: "Support",
            priority: "medium",
            sentiment: "neutral",
            summary: "Customer needs help.",
            confidence: { category: -0.1 },
          },
        },
      }),
    ],
    [
      "malformed checklist",
      snapshot({ checklist: { summary: null } as never }),
    ],
    [
      "sparse rag summary chunks",
      (() => {
        const chunks = new Array<string>(1);
        return snapshot({
          effectInputs: {
            ...snapshot().effectInputs,
            ragSummary: {
              ...snapshot().effectInputs.ragSummary!,
              chunks,
            },
          },
        });
      })(),
    ],
  ])(
    "durably backs off malformed snapshot %s without a sink",
    async (_name, analysis) => {
      const { dependencies, calls } = makeDependencies();
      jest
        .mocked(dependencies.claimConversationAnalysisEffects)
        .mockResolvedValueOnce({
          status: "claimed",
          lease: lease(),
          analysis,
        });

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(calls).toEqual(["renew", "failure"]);
    }
  );

  it.each([
    [
      "requested analysis identity mismatch",
      lease(),
      snapshot({ analysisRevisionId: "different-analysis" }),
    ],
    [
      "claimed lease identity mismatch",
      lease({ analysisRevisionId: "different-analysis" }),
      snapshot(),
    ],
    [
      "conversation identity mismatch",
      lease(),
      snapshot({ conversationId: "66b000000000000000000000" }),
    ],
    ["source revision mismatch", lease(), snapshot({ sourceRevision: 8 })],
    [
      "non-ready outcome",
      lease(),
      snapshot({ outcome: "review_required" as never }),
    ],
    ["blank workspace", lease(), snapshot({ workspaceId: " " })],
    [
      "invalid completion date",
      lease(),
      snapshot({ completedAt: new Date("invalid") }),
    ],
    ["non-plain projection", lease(), snapshot({ projection: [] as never })],
    [
      "non-plain effect inputs",
      lease(),
      snapshot({ effectInputs: [] as never }),
    ],
    [
      "unbounded classification text",
      lease(),
      snapshot({
        projection: {
          classification: {
            category: "x".repeat(257),
            priority: "medium",
            sentiment: "neutral",
            summary: "Customer needs help.",
            confidence: { category: 0.75 },
          },
        },
      }),
    ],
    [
      "summary above the canonical output limit",
      lease(),
      snapshot({
        projection: {
          classification: {
            category: "Support",
            priority: "medium",
            sentiment: "neutral",
            summary: "x".repeat(221),
            confidence: { category: 0.75 },
          },
        },
      }),
    ],
    [
      "non-canonical classification whitespace",
      lease(),
      snapshot({
        projection: {
          classification: {
            category: " Support",
            priority: "medium ",
            sentiment: " neutral ",
            summary: " Customer needs help. ",
            confidence: { category: 0.75 },
          },
        },
      }),
    ],
  ])(
    "backs off exact snapshot invariant: %s",
    async (_name, claimedLease, analysis) => {
      const { dependencies, calls } = makeDependencies();
      jest
        .mocked(dependencies.claimConversationAnalysisEffects)
        .mockResolvedValueOnce({
          status: "claimed",
          lease: claimedLease,
          analysis,
        });

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(calls).toEqual(["renew", "failure"]);
    }
  );

  it("rejects an inherited projection contract instead of forwarding prototype data", async () => {
    const { dependencies, calls } = makeDependencies();
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "classification"
    );
    Object.defineProperty(Object.prototype, "classification", {
      configurable: true,
      value: {
        category: "Inherited secret category",
        priority: "medium",
        sentiment: "neutral",
        summary: "Inherited summary secret payload",
        confidence: { category: 0.75 },
      },
    });
    try {
      jest
        .mocked(dependencies.claimConversationAnalysisEffects)
        .mockResolvedValueOnce({
          status: "claimed",
          lease: lease(),
          analysis: snapshot({ projection: {} as never }),
        });

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({
        status: "retry_scheduled",
        nextAttemptAt: RETRY_AT,
      });
      expect(calls).toEqual(["renew", "failure"]);
      expect(
        dependencies.triggerClassificationCompletedStrict
      ).not.toHaveBeenCalled();
    } finally {
      if (previous) {
        Object.defineProperty(Object.prototype, "classification", previous);
      } else {
        delete (Object.prototype as Record<string, unknown>).classification;
      }
    }
  });

  it("deep-freezes detached sink inputs so mutation cannot alter a later sink", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async input => {
        expect(Object.isFrozen(input.ragSummary)).toBe(true);
        expect(Object.isFrozen(input.ragSummary?.chunks)).toBe(true);
        try {
          if (input.ragSummary) input.ragSummary.summary = "mutated";
        } catch {}
        return { status: "completed" };
      });
    jest
      .mocked(dependencies.trackConversationClassificationCompleted)
      .mockImplementationOnce(async input => {
        expect(Object.isFrozen(input.effectInputs)).toBe(true);
        expect(Object.isFrozen(input.effectInputs.ragSummary)).toBe(true);
        expect(input.effectInputs.ragSummary?.summary).toBe(
          "Customer needs help."
        );
        return { status: "accepted" };
      });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({ status: "completed" });
  });

  it("clones completedAt for every sink so Date mutation cannot cross the boundary", async () => {
    const { dependencies } = makeDependencies();
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async input => {
        input.completedAt.setTime(0);
        return { status: "completed" };
      });
    jest
      .mocked(dependencies.trackConversationClassificationCompleted)
      .mockImplementationOnce(async input => {
        expect(input.completedAt).toEqual(COMPLETED_AT);
        input.completedAt.setTime(1);
        return { status: "accepted" };
      });
    jest
      .mocked(dependencies.enqueueConversationClassificationReadyRealtimeEvent)
      .mockImplementationOnce(async input => {
        expect(input.completedAt).toEqual(COMPLETED_AT);
        input.completedAt.setTime(2);
      });
    jest
      .mocked(dependencies.emitWorkspaceUsageDelta)
      .mockImplementationOnce(async input => {
        expect(input.occurredAt).toEqual(COMPLETED_AT);
        (input.occurredAt as Date).setTime(3);
        return { ok: true };
      });

    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );
    expect(
      jest.mocked(dependencies.triggerClassificationCompletedStrict).mock
        .calls[0]?.[1].completed_at
    ).toBe(COMPLETED_AT.toISOString());
  });

  it.each(["superseded", "lease_lost"] as const)(
    "stops without marking when authorization reports %s",
    async outcome => {
      const { dependencies, calls } = makeDependencies();
      jest
        .mocked(dependencies.authorizeConversationAnalysisEffectStep)
        .mockResolvedValueOnce(outcome);

      await expect(
        dispatchConversationClassificationEffects(
          { analysisRevisionId: "analysis-7" },
          dependencies
        )
      ).resolves.toEqual({ status: outcome });
      expect(calls).toEqual(["renew"]);
      expect(
        dependencies.persistConversationSummaryRevision
      ).not.toHaveBeenCalled();
      expect(
        dependencies.completeConversationAnalysisEffectStep
      ).not.toHaveBeenCalled();
    }
  );

  it("uses the lease renewed by an already-queued heartbeat for later store operations", async () => {
    const { dependencies } = makeDependencies();
    let timerCallback: (() => void) | undefined;
    jest.mocked(dependencies.setTimer).mockImplementationOnce(callback => {
      timerCallback = callback;
      return { fakeTimer: true } as unknown as ReturnType<typeof setTimeout>;
    });
    const heartbeatExpiry = new Date("2026-08-10T06:11:00.000Z");
    let renewCount = 0;
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockImplementation(async current => {
        renewCount += 1;
        return {
          status: "renewed",
          lease: {
            ...current,
            expiresAt:
              renewCount === 2
                ? heartbeatExpiry
                : new Date(current.expiresAt.getTime() + 1),
          },
        };
      });
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async () => {
        timerCallback?.();
        await Promise.resolve();
        return { status: "completed" };
      });

    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );

    expect(dependencies.setTimer).toHaveBeenCalledTimes(2);
    for (const call of jest.mocked(dependencies.setTimer).mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(200_000);
    }
    expect(
      jest.mocked(dependencies.completeConversationAnalysisEffectStep).mock
        .calls[0]?.[0].lease.expiresAt
    ).toEqual(heartbeatExpiry);
  });

  it.each(["lease_lost", "superseded"] as const)(
    "lets an in-flight sink settle after heartbeat %s but never marks or starts later work",
    async outcome => {
      const { dependencies } = makeDependencies();
      let timerCallback: (() => void) | undefined;
      jest.mocked(dependencies.setTimer).mockImplementationOnce(callback => {
        timerCallback = callback;
        return { fakeTimer: true } as unknown as ReturnType<typeof setTimeout>;
      });
      let renewCount = 0;
      let heartbeatObserved!: () => void;
      const heartbeatObservedPromise = new Promise<void>(resolve => {
        heartbeatObserved = resolve;
      });
      jest
        .mocked(dependencies.renewConversationAnalysisEffectsLease)
        .mockImplementation(async current => {
          renewCount += 1;
          if (renewCount === 2) {
            heartbeatObserved();
            return { status: outcome };
          }
          return {
            status: "renewed",
            lease: {
              ...current,
              expiresAt: new Date(current.expiresAt.getTime() + 1),
            },
          };
        });
      let settleSummary!: () => void;
      const summaryGate = new Promise<void>(resolve => {
        settleSummary = resolve;
      });
      jest
        .mocked(dependencies.persistConversationSummaryRevision)
        .mockImplementationOnce(async () => {
          timerCallback?.();
          await summaryGate;
          return { status: "completed" };
        });

      const dispatch = dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      );
      await heartbeatObservedPromise;
      expect(
        dependencies.completeConversationAnalysisEffectStep
      ).not.toHaveBeenCalled();
      settleSummary();

      await expect(dispatch).resolves.toEqual({ status: outcome });
      expect(
        dependencies.completeConversationAnalysisEffectStep
      ).not.toHaveBeenCalled();
      expect(
        dependencies.trackConversationClassificationCompleted
      ).not.toHaveBeenCalled();
      expect(dependencies.setTimer).toHaveBeenCalledTimes(1);
    }
  );

  it("recovers a heartbeat renewal exception only through the final ownership renewal and persists backoff", async () => {
    const { dependencies } = makeDependencies();
    let timerCallback: (() => void) | undefined;
    jest.mocked(dependencies.setTimer).mockImplementationOnce(callback => {
      timerCallback = callback;
      return { fakeTimer: true } as unknown as ReturnType<typeof setTimeout>;
    });
    let renewCount = 0;
    let heartbeatObserved!: () => void;
    const heartbeatObservedPromise = new Promise<void>(resolve => {
      heartbeatObserved = resolve;
    });
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockImplementation(async current => {
        renewCount += 1;
        if (renewCount === 2) {
          heartbeatObserved();
          throw new Error("heartbeat unavailable");
        }
        return {
          status: "renewed",
          lease: {
            ...current,
            expiresAt: new Date(current.expiresAt.getTime() + 1),
          },
        };
      });
    let settleSummary!: () => void;
    const summaryGate = new Promise<void>(resolve => {
      settleSummary = resolve;
    });
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async () => {
        timerCallback?.();
        await summaryGate;
        return { status: "completed" };
      });

    const dispatch = dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );
    await heartbeatObservedPromise;
    settleSummary();

    await expect(dispatch).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(
      dependencies.completeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.trackConversationClassificationCompleted
    ).not.toHaveBeenCalled();
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
    expect(renewCount).toBe(3);
  });

  it("throws without a guessed result when heartbeat and final ownership renewal both fail", async () => {
    const { dependencies } = makeDependencies();
    let timerCallback: (() => void) | undefined;
    jest.mocked(dependencies.setTimer).mockImplementationOnce(callback => {
      timerCallback = callback;
      return { fakeTimer: true } as unknown as ReturnType<typeof setTimeout>;
    });
    let renewCount = 0;
    let heartbeatObserved!: () => void;
    const heartbeatObservedPromise = new Promise<void>(resolve => {
      heartbeatObserved = resolve;
    });
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockImplementation(async current => {
        renewCount += 1;
        if (renewCount === 2) heartbeatObserved();
        if (renewCount >= 2) {
          throw new Error(
            renewCount === 2
              ? "heartbeat unavailable"
              : "final renewal unavailable"
          );
        }
        return {
          status: "renewed",
          lease: {
            ...current,
            expiresAt: new Date(current.expiresAt.getTime() + 1),
          },
        };
      });
    let settleSummary!: () => void;
    const summaryGate = new Promise<void>(resolve => {
      settleSummary = resolve;
    });
    jest
      .mocked(dependencies.persistConversationSummaryRevision)
      .mockImplementationOnce(async () => {
        timerCallback?.();
        await summaryGate;
        return { status: "completed" };
      });

    const dispatch = dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );
    await heartbeatObservedPromise;
    settleSummary();

    const error = (await dispatch.then(
      () => null,
      value => value
    )) as Error & { code?: string; cause?: unknown };
    expect(error).toMatchObject({
      name: "ClassificationEffectsControlError",
      message: "Classification effects control operation failed",
      code: "classification_effects_control_failed",
    });
    expect(String(error.stack)).not.toContain("final renewal unavailable");
    expect(error).not.toHaveProperty("cause");
    expect(
      dependencies.completeConversationAnalysisEffectStep
    ).not.toHaveBeenCalled();
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).not.toHaveBeenCalled();
    expect(renewCount).toBe(3);
  });

  it("recovers a heartbeat error queued by the last step completion and backs off instead of terminalizing", async () => {
    const { dependencies } = makeDependencies();
    let timerCallback: (() => void) | undefined;
    jest.mocked(dependencies.setTimer).mockImplementationOnce(callback => {
      timerCallback = callback;
      return { fakeTimer: true } as unknown as ReturnType<typeof setTimeout>;
    });
    let heartbeatPending = false;
    let heartbeatFailed = false;
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockImplementation(async current => {
        if (heartbeatPending && !heartbeatFailed) {
          heartbeatFailed = true;
          throw new Error("late heartbeat unavailable");
        }
        return {
          status: "renewed",
          lease: {
            ...current,
            expiresAt: new Date(current.expiresAt.getTime() + 1),
          },
        };
      });
    jest
      .mocked(dependencies.completeConversationAnalysisEffectStep)
      .mockImplementation(async ({ step }) => {
        if (step === "webhook") {
          heartbeatPending = true;
          timerCallback?.();
        }
        return "completed";
      });

    await expect(
      dispatchConversationClassificationEffects(
        { analysisRevisionId: "analysis-7" },
        dependencies
      )
    ).resolves.toEqual({
      status: "retry_scheduled",
      nextAttemptAt: RETRY_AT,
    });
    expect(heartbeatFailed).toBe(true);
    expect(
      dependencies.completeConversationAnalysisEffects
    ).not.toHaveBeenCalled();
    expect(
      dependencies.recordConversationAnalysisEffectsFailure
    ).toHaveBeenCalledTimes(1);
  });

  it("serializes heartbeat, manual, authorize, completion, and terminal store operations", async () => {
    const { dependencies } = makeDependencies();
    let active = 0;
    let maximumActive = 0;
    const serializeProbe = async <T>(value: T): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value;
    };
    jest
      .mocked(dependencies.renewConversationAnalysisEffectsLease)
      .mockImplementation(async current =>
        serializeProbe({
          status: "renewed" as const,
          lease: {
            ...current,
            expiresAt: new Date(current.expiresAt.getTime() + 1),
          },
        })
      );
    jest
      .mocked(dependencies.authorizeConversationAnalysisEffectStep)
      .mockImplementation(async () => serializeProbe("authorized" as const));
    jest
      .mocked(dependencies.completeConversationAnalysisEffectStep)
      .mockImplementation(async () => serializeProbe("completed" as const));
    jest
      .mocked(dependencies.completeConversationAnalysisEffects)
      .mockImplementation(async () => serializeProbe("completed" as const));

    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );
    expect(maximumActive).toBe(1);
  });

  it("does not duplicate a completed sink when a dispatcher retry resumes its checklist", async () => {
    const { dependencies } = makeDependencies();
    const summaryDone = emptyChecklist();
    summaryDone.summary = COMPLETED_AT;
    jest
      .mocked(dependencies.claimConversationAnalysisEffects)
      .mockResolvedValueOnce({
        status: "claimed",
        lease: lease(),
        analysis: snapshot(),
      })
      .mockResolvedValueOnce({
        status: "claimed",
        lease: lease({ ownerToken: "owner-2", fence: 2, attemptCount: 2 }),
        analysis: snapshot({ checklist: summaryDone }),
      });

    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );
    await dispatchConversationClassificationEffects(
      { analysisRevisionId: "analysis-7" },
      dependencies
    );

    expect(
      dependencies.persistConversationSummaryRevision
    ).toHaveBeenCalledTimes(1);
  });
});

it("reuses the committed classification embedding in the summary effect", async () => {
  const { dependencies } = makeDependencies();
  const projection = {
    ...snapshot().projection,
    embedding: [0.1, 0.2],
    embeddingProvider: "vertex",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 2,
    embeddingTaskType: "RETRIEVAL_DOCUMENT",
  };
  jest
    .mocked(dependencies.claimConversationAnalysisEffects)
    .mockResolvedValueOnce({
      status: "claimed",
      lease: lease(),
      analysis: snapshot({ projection }),
    });
  await dispatchConversationClassificationEffects(
    { analysisRevisionId: "analysis-7" },
    dependencies
  );
  expect(dependencies.persistConversationSummaryRevision).toHaveBeenCalledWith(
    expect.objectContaining({
      existingEmbedding: {
        text: "Customer needs help.",
        result: {
          embedding: [0.1, 0.2],
          provider: "vertex",
          model: "gemini-embedding-001",
          dimensions: 2,
          taskType: "RETRIEVAL_DOCUMENT",
        },
      },
    })
  );
});
