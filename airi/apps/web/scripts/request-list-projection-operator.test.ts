import { spawnSync } from "node:child_process";
import path from "node:path";

const mockVerifyRequestsProjectionForOperator = jest.fn();
const mockWriteReceiptFile = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock("@/lib/requests-projection/provisioning", () => ({
  verifyRequestsProjectionForOperator: (...args: unknown[]) =>
    mockVerifyRequestsProjectionForOperator(...args),
}));

jest.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteReceiptFile(...args),
}));

import {
  parseRequestListProjectionOperatorArgs,
  runRequestListProjectionOperator,
} from "./request-list-projection-operator";

const appRoot = path.resolve(__dirname, "..");

function run(args: string[]) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions=react-server",
      "scripts/request-list-projection-operator.ts",
      ...args,
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MONGODB_URI: "",
        REQUEST_PROJECTION_TEST_IMPORT_TRAP: "true",
      },
      shell: process.platform === "win32",
    }
  );
}

describe("request-list-projection operator CLI", () => {
  it("parses the exact mode-specific valid flag sets", () => {
    const uuid = "00112233445566778899aabbccddeeff";
    expect(
      parseRequestListProjectionOperatorArgs([
        "provision",
        "--apply",
        "--expected-collection-uuid",
        "absent",
        "--approved-cardinality-cap",
        "10000000",
      ])
    ).toEqual({
      mode: "provision",
      apply: true,
      expectedCollectionUuid: "absent",
      approvedCardinalityCap: 10_000_000,
    });
    expect(
      parseRequestListProjectionOperatorArgs([
        "migrate-watermarks",
        "--apply",
        "--expected-collection-uuid",
        uuid,
        "--approved-cardinality-cap",
        "10000000",
      ])
    ).toEqual({
      mode: "migrate-watermarks",
      apply: true,
      expectedCollectionUuid: uuid,
      approvedCardinalityCap: 10_000_000,
    });
    expect(
      parseRequestListProjectionOperatorArgs([
        "verify",
        "--expected-collection-uuid",
        uuid,
        "--receipt-output",
        path.resolve(appRoot, "receipt.json"),
      ])
    ).toEqual({
      mode: "verify",
      expectedCollectionUuid: uuid,
      receiptOutput: path.resolve(appRoot, "receipt.json"),
    });
    expect(
      parseRequestListProjectionOperatorArgs([
        "activate",
        "--apply",
        "--expected-collection-uuid",
        uuid,
      ])
    ).toEqual({
      mode: "activate",
      apply: true,
      expectedCollectionUuid: uuid,
    });
  });

  it.each([
    [
      "duplicate",
      [
        "verify",
        "--expected-collection-uuid",
        "00".repeat(16),
        "--expected-collection-uuid",
        "00".repeat(16),
      ],
    ],
    [
      "relative output",
      [
        "verify",
        "--expected-collection-uuid",
        "00".repeat(16),
        "--receipt-output",
        "relative.json",
      ],
    ],
    [
      "irrelevant apply",
      ["verify", "--apply", "--expected-collection-uuid", "00".repeat(16)],
    ],
    [
      "adjusted cap",
      [
        "provision",
        "--apply",
        "--expected-collection-uuid",
        "absent",
        "--approved-cardinality-cap",
        "9999999",
      ],
    ],
  ])("rejects %s flags before importing Mongo", (_label, args) => {
    expect(() => parseRequestListProjectionOperatorArgs(args)).toThrow(
      /arguments/i
    );
  });

  it("publishes the exact five command contract without importing Mongo", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      contractVersion: 3,
      mode: "help",
      status: "help",
      modes: [
        "activate",
        "provision",
        "migrate-watermarks",
        "verify",
        "transition-sequence",
      ],
    });
    expect(result.stderr).not.toContain("MONGODB_URI");
  });

  it("keeps transition-sequence import-free and closed until Task 18", () => {
    const result = run(["transition-sequence"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim())).toEqual({
      contractVersion: 3,
      mode: "transition-sequence",
      status: "not_available",
      reasonCode: "not_available_until_task_18",
    });
    expect(result.stderr).not.toContain("MONGODB_URI environment variable");
  });

  it.each([
    ["ready", 0],
    ["not_ready", 2],
  ] as const)(
    "keeps successful %s verify stdout on contract v3 and writes v1 evidence with wx",
    async (status, expectedExit) => {
      const receiptOutput = path.resolve(appRoot, `verify-${status}.json`);
      const evidence = {
        schemaVersion: 1,
        contractVersion: 1,
        status,
        collectionUuid: "01".repeat(16),
      };
      const stdout: string[] = [];
      const stderr: string[] = [];
      const processStdout: string[] = [];
      const receiptWrites: Array<{
        path: string;
        contents: string;
        options: Record<string, unknown>;
      }> = [];
      const runOperator = runRequestListProjectionOperator as unknown as (
        args: string[],
        dependencies: {
          loadProvisioning: () => Promise<{
            verifyRequestsProjectionForOperator: () => Promise<typeof evidence>;
          }>;
          writeReceipt: (
            filePath: string,
            contents: string,
            options: Record<string, unknown>
          ) => Promise<void>;
          stdout: { write(value: string): boolean };
          stderr: { write(value: string): boolean };
        }
      ) => Promise<number>;
      mockVerifyRequestsProjectionForOperator.mockResolvedValue(evidence);
      const stdoutSpy = jest
        .spyOn(process.stdout, "write")
        .mockImplementation(value => {
          processStdout.push(String(value));
          return true;
        });

      try {
        const exit = await runOperator(
          [
            "verify",
            "--expected-collection-uuid",
            "01".repeat(16),
            "--receipt-output",
            receiptOutput,
          ],
          {
            loadProvisioning: async () => ({
              verifyRequestsProjectionForOperator: async () => evidence,
            }),
            writeReceipt: async (filePath, contents, options) => {
              receiptWrites.push({ path: filePath, contents, options });
            },
            stdout: {
              write: value => {
                stdout.push(value);
                return true;
              },
            },
            stderr: {
              write: value => {
                stderr.push(value);
                return true;
              },
            },
          }
        );

        expect(exit).toBe(expectedExit);
        expect(stderr).toEqual([]);
        expect(
          JSON.parse((stdout.join("") || processStdout.join("")).trim())
        ).toEqual({
          ...evidence,
          contractVersion: 3,
          mode: "verify",
        });
        expect(receiptWrites).toHaveLength(1);
        expect(receiptWrites[0]).toEqual({
          path: receiptOutput,
          contents: expect.stringMatching(/^\{.*\}\n$/),
          options: { encoding: "utf8", flag: "wx" },
        });
        expect(JSON.parse(receiptWrites[0]!.contents)).toEqual(evidence);
      } finally {
        stdoutSpy.mockRestore();
      }
    }
  );

  it.each([
    ["provision", ["provision"]],
    [
      "migrate-watermarks",
      [
        "migrate-watermarks",
        "--apply",
        "--expected-collection-uuid",
        "00112233445566778899aabbccddeeff",
      ],
    ],
    [
      "activate",
      [
        "activate",
        "--expected-collection-uuid",
        "00112233445566778899aabbccddeeff",
      ],
    ],
  ])(
    "rejects incomplete %s mutation arguments before importing Mongo",
    (_mode, args) => {
      const result = run(args as string[]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr.trim())).toMatchObject({
        contractVersion: 3,
        status: "error",
        reasonCode: "invalid_arguments",
      });
      expect(result.stderr).not.toContain("MONGODB_URI environment variable");
    }
  );

  it("rejects superseded control-plane modes before importing Mongo", () => {
    const result = run(["--mode", "apply-bootstrap"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      contractVersion: 3,
      status: "error",
      reasonCode: "invalid_arguments",
    });
    expect(result.stderr).not.toContain("MONGODB_URI environment variable");
  });
});
