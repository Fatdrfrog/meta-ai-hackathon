import { formatMongoQueryIndexError } from "./ensure-mongo-indexes";

describe("Mongo index CLI", () => {
  it.each([{ args: [] }, { args: ["--query-cost-only"] }])(
    "redacts raw driver messages for $args",
    async ({ args }) => {
      const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
      const errors: string[] = [];
      expect(
        await runEnsureMongoIndexes(args, {
          ensure: async () => {
            throw new Error("mongodb://user:secret@host/test private-key");
          },
          stderr: value => errors.push(value),
        })
      ).toBe(1);
      expect(errors.join("")).toContain("failed");
      expect(errors.join("")).not.toMatch(/secret|private-key|mongodb/);
    }
  );

  it.each([
    { code: 13, message: "permission denied" },
    { code: 85, message: "conflicting index definition" },
    { code: 11000, message: "Inspect duplicate groups" },
  ])(
    "keeps full-mode remediation for code $code",
    async ({ code, message }) => {
      const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
      const errors: string[] = [];
      expect(
        await runEnsureMongoIndexes([], {
          ensure: async () => {
            throw Object.assign(new Error("private-key"), { code });
          },
          stderr: value => errors.push(value),
        })
      ).toBe(1);
      expect(errors.join("")).toContain(message);
      expect(errors.join("")).not.toMatch(/private-key|Mongo query index/);
    }
  );

  it.each([
    { args: [], mode: "all", summary: "Mongo indexes ensured." },
    {
      args: ["--query-cost-only"],
      mode: "query-cost",
      summary: "Mongo query cost indexes verified",
    },
    {
      args: ["--airi-chat-only"],
      mode: "airi-chat",
      summary:
        "Airi chat indexes ensured (airichatthreads, airichatmessages, airichatruns).",
    },
  ])(
    "selects the expected index mode for $args",
    async ({ args, mode, summary }) => {
      const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
      const modes: string[] = [];
      const output: string[] = [];
      expect(
        await runEnsureMongoIndexes(args, {
          ensure: async selected => {
            modes.push(selected);
          },
          stdout: value => output.push(value),
        })
      ).toBe(0);
      expect(modes).toEqual([mode]);
      expect(output.join("")).toContain(summary);
    }
  );

  it("rejects combined mode flags before invoking index provisioning", async () => {
    const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
    const ensure = jest.fn();
    const errors: string[] = [];
    expect(
      await runEnsureMongoIndexes(["--airi-chat-only", "--query-cost-only"], {
        ensure,
        stderr: value => errors.push(value),
      })
    ).toBe(1);
    expect(ensure).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("--airi-chat-only");
  });

  it("redacts driver messages from the Airi chat index repair", async () => {
    const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
    const errors: string[] = [];
    expect(
      await runEnsureMongoIndexes(["--airi-chat-only"], {
        ensure: async () => {
          throw Object.assign(new Error("mongodb://user:secret@host/test"), {
            code: 13,
          });
        },
        stderr: value => errors.push(value),
      })
    ).toBe(1);
    expect(errors.join("")).toContain("permission denied");
    expect(errors.join("")).not.toMatch(/secret|mongodb|Mongo query index/);
  });

  it.each(["--help", "--unknown"])(
    "handles %s before invoking index provisioning",
    async flag => {
      const { runEnsureMongoIndexes } = await import("./ensure-mongo-indexes");
      const ensure = jest.fn();
      const output: string[] = [];
      expect(
        await runEnsureMongoIndexes([flag], {
          ensure,
          stdout: value => output.push(value),
          stderr: value => output.push(value),
        })
      ).toBe(flag === "--help" ? 0 : 1);
      expect(ensure).not.toHaveBeenCalled();
      expect(output.join("")).toContain("--query-cost-only");
    }
  );
});

describe("Mongo query index repair diagnostics", () => {
  it.each([
    [{ code: 11000 }, "duplicate keys"],
    [{ code: 13 }, "permission denied"],
    [{ codeName: "Unauthorized" }, "permission denied"],
    [{ code: 85 }, "conflicting index definition"],
    [{ code: 86 }, "conflicting index definition"],
    [{ codeName: "IndexOptionsConflict" }, "conflicting index definition"],
    [{ code: 999 }, "code 999"],
    [{}, "Mongo query index repair failed"],
  ])(
    "redacts driver data while preserving safe diagnostic metadata %j",
    (metadata, expected) => {
      const error = Object.assign(
        new Error(
          "mongodb://user:secret@host/test E11000 temporalDeliveryKey=private-key"
        ),
        metadata
      );
      const output = formatMongoQueryIndexError(error);
      expect(output).toContain(expected);
      expect(output).not.toMatch(/secret|private-key|mongodb:\/\//);
    }
  );

  it("keeps duplicate preflight remediation actionable without copying evidence", () => {
    const output = formatMongoQueryIndexError(
      new Error(
        "Temporal delivery-key unique index preflight found duplicate rows; no rows were modified. Evidence: private-key"
      )
    );
    expect(output).toMatch(/duplicate string keys.*--query-cost-only/);
    expect(output).not.toContain("private-key");
  });

  it.each(["Temporal delivery-key", "Requests dependency fanout"])(
    "preserves safe %s drift remediation without arbitrary stored metadata",
    label => {
      const output = formatMongoQueryIndexError(
        new Error(
          `${label} index verification failed after reconciliation: private-key`
        )
      );
      expect(output).toContain(label);
      expect(output).toContain("stored index definitions");
      expect(output).not.toContain("private-key");
    }
  );
});
