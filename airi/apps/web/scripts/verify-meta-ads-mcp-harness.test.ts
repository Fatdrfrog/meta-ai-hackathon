const mockTurn = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/meta-ads/mcp/agent-loop", () => ({
  runMetaAdsMcpTurn: (...args: unknown[]) => mockTurn(...args),
}));

test.each([
  {
    failureCode: "asset_unavailable",
    coverage: { complete: false },
    toolTrace: [],
    expected: "incomplete_report",
  },
  {
    failureCode: "request_timeout",
    coverage: { complete: false },
    toolTrace: [
      { name: "ads_get_ad_accounts", sideEffect: "read", status: "error" },
    ],
    expected: "tool_execution",
  },
  {
    failureCode: "incomplete_report",
    coverage: { complete: false, pendingPages: 1 },
    toolTrace: [],
    expected: "incomplete_report",
  },
  {
    failureCode: undefined,
    coverage: undefined,
    toolTrace: [],
    expected: "unsuccessful_result",
  },
])(
  "classifies normal unsuccessful smoke results: $failureCode",
  async ({ expected, ...result }) => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const originalConsole = Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map(method => [
        method,
        Reflect.get(console, method),
      ])
    );
    let resolveOutput!: (output: Record<string, unknown>) => void;
    const output = new Promise<Record<string, unknown>>(resolve => {
      resolveOutput = resolve;
    });
    const write = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(chunk => {
        resolveOutput(JSON.parse(String(chunk)));
        return true;
      });
    process.argv = [
      "node",
      "verify-meta-ads-mcp-harness.ts",
      "--workspace",
      "00000000-0000-0000-0000-000000000001",
    ];
    mockTurn.mockReset().mockResolvedValue({
      content: "Report unavailable",
      pendingMutations: [],
      ...result,
    });
    try {
      await jest.isolateModulesAsync(async () => {
        await import("./verify-meta-ads-mcp-harness");
        const report = await output;
        expect(report.success).toBe(false);
        expect(report.failureCategories).toEqual(
          expect.arrayContaining([expected])
        );
        expect(report.failureCode).toBe(result.failureCode);
        expect(process.exitCode).toBe(1);
      });
    } finally {
      write.mockRestore();
      Object.assign(console, originalConsole);
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  }
);
