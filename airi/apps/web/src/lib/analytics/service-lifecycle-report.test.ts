jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
const mockAggregate = jest.fn(),
  mockCoverage = jest.fn();
jest.mock("@/models/analytics-service-lifecycle", () => ({
  AnalyticsServiceLifecycleFact: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));
jest.mock("./service-lifecycle-consumer", () => ({
  readServiceLifecycleCoverage: (...args: unknown[]) => mockCoverage(...args),
}));
import { getServiceLifecycleReport } from "./service-lifecycle-report";
const start = new Date("2026-10-01T00:00:00Z"),
  end = new Date("2026-10-02T00:00:00Z");
beforeEach(() => {
  jest.clearAllMocks();
  mockAggregate.mockReturnValue({
    allowDiskUse: jest.fn().mockResolvedValue([
      {
        totals: [
          {
            events: 3,
            handoffStarted: 1,
            measuredResolutions: 1,
            averageResolutionSeconds: 120,
          },
        ],
        bySource: [{ _id: { sourceId: "s", channel: "whatsapp" }, events: 3 }],
      },
    ]),
  });
  mockCoverage.mockResolvedValue({
    state: "history_gap",
    history: "history_gap",
  });
});
test("groups facts in Mongo with bounded output and keeps history coverage explicit", async () => {
  const result = await getServiceLifecycleReport("w", start, end);
  const pipeline = mockAggregate.mock.calls[0][0];
  expect(pipeline[0]).toEqual({
    $match: { workspaceId: "w", occurredAt: { $gte: start, $lt: end } },
  });
  expect(pipeline[2].$facet.bySource).toContainEqual({ $limit: 50 });
  expect(result.coverage.state).toBe("history_gap");
  expect(result.observed).toMatchObject({
    events: 3,
    handoffStarted: 1,
    measuredResolutions: 1,
    averageResolutionSeconds: 120,
  });
  expect(result.bySource[0]).toMatchObject({
    sourceId: "s",
    channel: "whatsapp",
    events: 3,
  });
});
test("empty retained evidence has unknown durations rather than zero", async () => {
  mockAggregate.mockReturnValue({
    allowDiskUse: jest.fn().mockResolvedValue([{ totals: [], bySource: [] }]),
  });
  const result = await getServiceLifecycleReport("w", start, end);
  expect(result.observed.events).toBe(0);
  expect(result.observed.averageResolutionSeconds).toBeNull();
  expect(result.observed.averageHandoffSeconds).toBeNull();
});
test("filters source facts before calculating totals, durations or source groups", async () => {
  await getServiceLifecycleReport("w", start, end, "selected-source");
  expect(mockAggregate.mock.calls[0][0][0]).toEqual({
    $match: {
      workspaceId: "w",
      sourceId: "selected-source",
      occurredAt: { $gte: start, $lt: end },
    },
  });
  // Stream coverage describes collection for the workspace, including historical gaps.
  expect(mockCoverage).toHaveBeenCalledWith("w");
});
test("rejects unbounded or reversed windows before querying facts", async () => {
  await expect(getServiceLifecycleReport("w", end, start)).rejects.toThrow(
    "window"
  );
  await expect(
    getServiceLifecycleReport("w", start, new Date("2027-01-10T00:00:00Z"))
  ).rejects.toThrow("window");
  expect(mockAggregate).not.toHaveBeenCalled();
});
