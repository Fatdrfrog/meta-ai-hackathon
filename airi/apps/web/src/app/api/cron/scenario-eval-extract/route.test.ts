const mockDistinct = jest.fn();
const mockRunFlywheel = jest.fn();
const mockRunOptimizer = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => null }));
jest.mock("@/models/scenario-trigger-log", () => ({
  ScenarioTriggerLog: {
    distinct: (...args: unknown[]) => mockDistinct(...args),
  },
}));
jest.mock("@/lib/scenarios/eval-flywheel", () => ({
  runScenarioEvalFlywheel: (...args: unknown[]) => mockRunFlywheel(...args),
}));
jest.mock("@/lib/scenarios/prompt-optimizer", () => ({
  SCENARIO_PROMPT_OPTIMIZER_MAX_AI_MS: 240_000,
  runScenarioPromptOptimizer: (...args: unknown[]) => mockRunOptimizer(...args),
}));

import { GET, maxDuration } from "./route";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("scenario-eval-extract cron time budget", () => {
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Week 9 (9 % 3 = 0), so the weekly rotation keeps the distinct() order.
    now = 9 * WEEK_MS;
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockRunFlywheel.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => {
        now += 1_000;
        return {
          runId: `run-${workspaceId}`,
          dominantScenarioId: "scenario-1",
        };
      }
    );
  });

  afterEach(() => {
    nowSpy.mockRestore();
    warn.mockRestore();
  });

  it("runs every flywheel but starts an optimizer only while its worst case fits", async () => {
    mockDistinct.mockResolvedValue(["ws-a", "ws-b", "ws-c"]);
    // The first optimizer run takes 70 s: the rest no longer fit 240 s + margin.
    mockRunOptimizer.mockImplementation(async () => {
      now += 70_000;
      return {};
    });

    const response = await GET(
      new Request("http://localhost/api/cron/scenario-eval-extract")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRunFlywheel).toHaveBeenCalledTimes(3);
    expect(mockRunOptimizer).toHaveBeenCalledTimes(1);
    expect(mockRunOptimizer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-a",
        evalRunId: "run-ws-a",
        scenarioId: "scenario-1",
        triggeredBy: "cron",
      })
    );
    expect(body).toMatchObject({
      workspaces: 3,
      completed: 3,
      failed: 0,
      optimizerCompleted: 1,
      optimizerFailed: 0,
      optimizerSkipped: 2,
      errors: [],
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), ["ws-b", "ws-c"]);
  });

  it("never starts an optimizer whose worst case would outlive maxDuration", async () => {
    mockDistinct.mockResolvedValue(["ws-a"]);
    // Slow startup: 31 s already gone before the optimizer could start.
    mockRunFlywheel.mockImplementationOnce(async () => {
      now += 31_000;
      return { runId: "run-ws-a", dominantScenarioId: "scenario-1" };
    });

    const response = await GET(
      new Request("http://localhost/api/cron/scenario-eval-extract")
    );
    const body = await response.json();

    // 31 s + 240 s worst case + 10 s margin passes the 280 s work budget
    // (maxDuration 300 s minus room to respond).
    expect(maxDuration).toBe(300);
    expect(mockRunOptimizer).not.toHaveBeenCalled();
    expect(body).toMatchObject({ completed: 1, optimizerSkipped: 1 });
  });

  it("rotates which workspace's optimizer goes first each week", async () => {
    now = 11 * WEEK_MS;
    mockDistinct.mockResolvedValue(["ws-a", "ws-b", "ws-c"]);
    mockRunOptimizer.mockImplementation(async () => {
      now += 70_000;
      return {};
    });

    await GET(new Request("http://localhost/api/cron/scenario-eval-extract"));

    expect(mockRunOptimizer).toHaveBeenCalledTimes(1);
    expect(mockRunOptimizer.mock.calls[0][0].workspaceId).toBe("ws-c");
  });

  it("runs every optimizer when they are fast", async () => {
    mockDistinct.mockResolvedValue(["ws-a", "ws-b"]);
    mockRunOptimizer.mockImplementation(async () => {
      now += 200;
      return {};
    });

    const response = await GET(
      new Request("http://localhost/api/cron/scenario-eval-extract")
    );
    const body = await response.json();

    expect(mockRunOptimizer).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ optimizerCompleted: 2, optimizerSkipped: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});
