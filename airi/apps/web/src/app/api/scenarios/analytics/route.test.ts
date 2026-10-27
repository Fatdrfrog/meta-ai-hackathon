const mockEnsureIndexes = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockDailyMetricFind = jest.fn();
const mockTriggerLogAggregate = jest.fn();
const mockTriggerLogFind = jest.fn();
const mockFlowEventAggregate = jest.fn();

jest.mock("@/lib/mongo", () => ({
  ensureIndexes: (...args: unknown[]) => mockEnsureIndexes(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/models/scenario-trigger-daily-metric", () => ({
  ScenarioTriggerDailyMetric: {
    find: (...args: unknown[]) => mockDailyMetricFind(...args),
  },
}));

jest.mock("@/models/scenario-trigger-log", () => ({
  ScenarioTriggerLog: {
    aggregate: (...args: unknown[]) => mockTriggerLogAggregate(...args),
    find: (...args: unknown[]) => mockTriggerLogFind(...args),
  },
}));

jest.mock("@/models/scenario-flow-event", () => ({
  ScenarioFlowEvent: {
    aggregate: (...args: unknown[]) => mockFlowEventAggregate(...args),
  },
}));

import { GET } from "./route";

describe("GET /api/scenarios/analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockEnsureIndexes.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({ ok: true });

    mockDailyMetricFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          day: new Date("2026-04-01T00:00:00.000Z"),
          totalCount: 12,
          matchedCount: 5,
        },
      ]),
    });

    mockTriggerLogAggregate
      .mockResolvedValueOnce([
        { _id: "2026-04-01", noMatchingActionCount: 2, winnerCount: 5 },
      ])
      .mockResolvedValueOnce([{ _id: "trigger_mismatch", count: 7 }])
      .mockResolvedValueOnce([
        {
          _id: "scenario-1",
          scenarioName: "Welcome",
          evaluatedCount: 12,
          triggerMatchedCount: 7,
          winnerCount: 5,
          triggerMismatchCount: 7,
          noMatchingActionCount: 2,
          blockedCount: 2,
          blockReasons: ["blocked_by_once_per_conversation"],
          filters: {
            channelFilter: ["whatsapp"],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: "incoming_customer_message",
          evaluatedCount: 12,
          triggerMatchedCount: 7,
          winnerCount: 5,
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: "inbound_message",
          evaluatedCount: 12,
          triggerMatchedCount: 7,
          winnerCount: 5,
        },
      ]);

    mockTriggerLogFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          conversationId: "conversation-1",
          scenarioId: "scenario-1",
          scenarioName: "Welcome",
          mismatchReason: "trigger_mismatch",
          evaluatedAt: new Date("2026-04-01T10:00:00.000Z"),
          eventKind: "inbound_message",
          triggerType: "incoming_customer_message",
          selectedActionType: null,
          meta: {
            filters: {
              channelFilter: ["whatsapp"],
            },
          },
        },
      ]),
    });

    mockFlowEventAggregate.mockResolvedValue([
      {
        _id: {
          scenarioId: "scenario-1",
          scenarioName: "Welcome",
          flowId: "flow-1",
          conversationId: "conversation-1",
          customerWaId: "wa-1",
        },
        events: [
          {
            eventType: "sent",
            eventAt: new Date("2026-04-01T10:00:00.000Z"),
          },
          {
            eventType: "read",
            eventAt: new Date("2026-04-01T10:05:00.000Z"),
          },
          {
            eventType: "submitted",
            eventAt: new Date("2026-04-01T10:09:00.000Z"),
          },
        ],
        lastEventAt: new Date("2026-04-01T10:09:00.000Z"),
      },
    ]);
  });

  it("returns the new analytics surface and preserves legacy flow tables", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/scenarios/analytics?workspaceId=workspace-1&days=14&scenarioId=scenario-1&triggerType=incoming_customer_message&eventKind=inbound_message"
      ) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      window: {
        days: 14,
      },
      filters: {
        applied: {
          scenarioId: "scenario-1",
          triggerType: "incoming_customer_message",
          eventKind: "inbound_message",
        },
      },
      scenarioFunnel: {
        evaluatedCount: 12,
        triggerMatchedCount: 7,
        winnerCount: 5,
      },
      flowOutcomeFunnel: {
        sentCount: 1,
        readCount: 1,
        submittedCount: 1,
      },
      diagnostics: {
        topMismatchReasons: [
          {
            id: "trigger_mismatch",
            count: 7,
          },
        ],
      },
      recommendations: expect.any(Array),
      recentConversations: [
        {
          conversationId: "conversation-1",
          scenarioId: "scenario-1",
        },
      ],
      totals: {
        sent: 1,
        read: 1,
        submitted: 1,
      },
      scenarios: [
        {
          scenarioId: "scenario-1",
          read: 1,
        },
      ],
      flows: [
        {
          scenarioId: "scenario-1",
          flowId: "flow-1",
        },
      ],
      customers: [
        {
          scenarioId: "scenario-1",
          conversationId: "conversation-1",
        },
      ],
    });

    expect(mockDailyMetricFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        triggerType: "incoming_customer_message",
        eventKind: "inbound_message",
      })
    );
    const matchedCountPipelines = mockTriggerLogAggregate.mock.calls
      .slice(2, 5)
      .map(([pipeline]) => JSON.stringify(pipeline));
    expect(matchedCountPipelines).toHaveLength(3);
    for (const pipeline of matchedCountPipelines) {
      expect(pipeline).toContain("matched_but_shadowed");
    }
    const mismatchCategoryPipeline = JSON.stringify(
      mockTriggerLogAggregate.mock.calls[1]?.[0]
    );
    expect(mismatchCategoryPipeline).toContain('"$in"');
    expect(mismatchCategoryPipeline).not.toContain("journey_pool");
    expect(JSON.stringify(mockTriggerLogFind.mock.calls[0]?.[0])).not.toContain(
      "journey_pool"
    );
    expect(mockFlowEventAggregate).toHaveBeenCalled();
  });

  it("keeps shadowed candidates and no-action matches out of daily winners", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-02T12:00:00.000Z"));
    try {
      mockDailyMetricFind.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          {
            day: new Date("2026-04-01T00:00:00.000Z"),
            totalCount: 4,
            // The logger rolls up the winner and shadowed candidate together.
            matchedCount: 2,
          },
        ]),
      });
      mockTriggerLogAggregate.mockReset();
      mockTriggerLogAggregate
        .mockResolvedValueOnce([
          {
            _id: "2026-04-01",
            noMatchingActionCount: 1,
            winnerCount: 1,
          },
        ])
        .mockResolvedValueOnce([{ _id: "trigger_mismatch", count: 1 }])
        .mockResolvedValueOnce([
          {
            _id: "scenario-1",
            scenarioName: "Welcome",
            evaluatedCount: 4,
            triggerMatchedCount: 3,
            winnerCount: 1,
            triggerMismatchCount: 1,
            noMatchingActionCount: 1,
            blockedCount: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            _id: "incoming_customer_message",
            evaluatedCount: 4,
            triggerMatchedCount: 3,
            winnerCount: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            _id: "inbound_message",
            evaluatedCount: 4,
            triggerMatchedCount: 3,
            winnerCount: 1,
          },
        ]);

      const response = await GET(
        new Request(
          "http://localhost/api/scenarios/analytics?workspaceId=workspace-1&days=14&scenarioId=scenario-1&triggerType=incoming_customer_message&eventKind=inbound_message"
        )
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.scenarioFunnel).toMatchObject({
        evaluatedCount: 4,
        triggerMatchedCount: 3,
        winnerCount: 1,
        dailyTrend: expect.arrayContaining([
          {
            date: "2026-04-01",
            label: "04-01",
            evaluatedCount: 4,
            triggerMatchedCount: 3,
            winnerCount: 1,
            overallConversion: 0.25,
            relativeConversion: 1 / 3,
          },
        ]),
      });
      expect(payload.diagnostics.triggerTypeBreakdown[0].rate).toBe(0.25);
      expect(payload.diagnostics.eventKindBreakdown[0].rate).toBe(0.25);

      const expectedMatch = {
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        triggerType: "incoming_customer_message",
        eventKind: "inbound_message",
        evaluatedAt: { $gte: new Date("2026-03-19T12:00:00.000Z") },
      };
      const expectedWinnerCount = {
        $sum: { $cond: [{ $eq: ["$matched", true] }, 1, 0] },
      };
      const expectedNoActionCount = {
        $sum: {
          $cond: [
            { $eq: ["$mismatchReason", "flow_no_matching_action"] },
            1,
            0,
          ],
        },
      };
      const dailyPipeline = mockTriggerLogAggregate.mock.calls[0][0];
      expect(dailyPipeline).toEqual([
        { $match: expectedMatch },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$evaluatedAt",
                format: "%Y-%m-%d",
                timezone: "UTC",
              },
            },
            winnerCount: expectedWinnerCount,
            noMatchingActionCount: expectedNoActionCount,
          },
        },
        { $sort: { _id: 1 } },
      ]);
      for (const [pipeline] of mockTriggerLogAggregate.mock.calls.slice(2, 5)) {
        expect(pipeline[0]).toEqual({ $match: expectedMatch });
        expect(pipeline).toContainEqual({
          $group: expect.objectContaining({
            winnerCount: expectedWinnerCount,
            triggerMatchedCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$matched", true] },
                      { $eq: ["$result", "matched_but_shadowed"] },
                      { $eq: ["$mismatchReason", "flow_no_matching_action"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          }),
        });
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    { name: "an empty window", totalCount: 0, matchedCount: 0 },
    { name: "a retained rollup without logs", totalCount: 4, matchedCount: 2 },
  ])(
    "does not infer winners for $name",
    async ({ totalCount, matchedCount }) => {
      jest.useFakeTimers().setSystemTime(new Date("2026-04-02T12:00:00.000Z"));
      try {
        mockDailyMetricFind.mockReturnValue({
          select: jest.fn().mockReturnThis(),
          lean: jest.fn().mockResolvedValue(
            totalCount
              ? [
                  {
                    day: new Date("2026-04-01T00:00:00.000Z"),
                    totalCount,
                    matchedCount,
                  },
                ]
              : []
          ),
        });
        mockTriggerLogAggregate.mockReset().mockResolvedValue([]);
        const response = await GET(
          new Request(
            "http://localhost/api/scenarios/analytics?workspaceId=workspace-1&days=1"
          )
        );
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.scenarioFunnel.dailyTrend).toEqual([
          {
            date: "2026-04-01",
            label: "04-01",
            evaluatedCount: totalCount,
            triggerMatchedCount: matchedCount,
            winnerCount: 0,
            overallConversion: 0,
            relativeConversion: 0,
          },
          {
            date: "2026-04-02",
            label: "04-02",
            evaluatedCount: 0,
            triggerMatchedCount: 0,
            winnerCount: 0,
            overallConversion: 0,
            relativeConversion: 0,
          },
        ]);
      } finally {
        jest.useRealTimers();
      }
    }
  );
});
