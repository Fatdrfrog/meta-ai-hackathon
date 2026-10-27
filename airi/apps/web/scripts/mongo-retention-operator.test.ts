const mockConnectDB = jest.fn();
const mockEnsureRetention = jest.fn();
const mockDisconnect = jest.fn();
jest.mock("node:fs", () => ({ existsSync: () => false }));
jest.mock("mongoose", () => ({
  __esModule: true,
  default: { disconnect: (...args: unknown[]) => mockDisconnect(...args) },
}));
jest.mock("../src/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("../src/lib/scenarios/ensure-observability-indexes", () => ({
  ensureScenarioObservabilityIndexes: (...args: unknown[]) =>
    mockEnsureRetention(...args),
}));

describe("Mongo retention CLI", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureRetention.mockResolvedValue({ logs: { action: "unchanged" } });
    mockDisconnect.mockResolvedValue(undefined);
  });

  it("does not connect or run maintenance when imported", async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = [process.execPath, "importer.ts"];
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await import("./mongo-retention-operator");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(mockConnectDB).not.toHaveBeenCalled();
      expect(mockEnsureRetention).not.toHaveBeenCalled();
      expect(mockDisconnect).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      write.mockRestore();
    }
  });

  it.each([
    { args: [], dryRun: true },
    { args: ["--dry-run"], dryRun: true },
    { args: ["--apply"], dryRun: false },
  ])("runs $args with dryRun=$dryRun", async ({ args, dryRun }) => {
    const { runMongoRetentionOperator } = await import(
      "./mongo-retention-operator"
    );
    const output: string[] = [];
    expect(
      await runMongoRetentionOperator(args, {
        stdout: value => output.push(value),
      })
    ).toBe(0);
    expect(mockEnsureRetention).toHaveBeenCalledWith({ dryRun });
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output[0])).toEqual({ logs: { action: "unchanged" } });
  });

  it.each([
    { args: ["--help"], code: 0 },
    { args: ["--unknown"], code: 1 },
    { args: ["--apply", "--dry-run"], code: 1 },
    { args: ["--apply", "--apply"], code: 1 },
  ])("handles $args without database work", async ({ args, code }) => {
    const { runMongoRetentionOperator } = await import(
      "./mongo-retention-operator"
    );
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      await runMongoRetentionOperator(args, {
        stdout: value => output.push(value),
        stderr: value => errors.push(value),
      })
    ).toBe(code);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockEnsureRetention).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(code === 0 ? output.join("") : errors.join("")).toContain(
      "--dry-run"
    );
  });

  it("redacts driver failures and closes the failed connection", async () => {
    const { runMongoRetentionOperator } = await import(
      "./mongo-retention-operator"
    );
    mockConnectDB.mockRejectedValueOnce(
      new Error("mongodb://user:secret@host/test")
    );
    const errors: string[] = [];
    expect(
      await runMongoRetentionOperator([], {
        stderr: value => errors.push(value),
      })
    ).toBe(1);
    expect(errors.join("")).toContain(
      "Check permissions and index definitions"
    );
    expect(errors.join("")).not.toMatch(/secret|mongodb/);
    expect(mockEnsureRetention).not.toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
