import assert from "node:assert/strict";
import test from "node:test";

import { ProductVideoImportFailure } from "../media/product-video/import-job";
import { importSpendPort, insertDraftProducts } from "./product-video-import";

const IMPORT = "6ae43246b2009b6f5799236e";

/** The web's import spend, recording the AI action each call is booked to. */
function recordingSpend() {
  const calls: string[] = [];
  const spend: Parameters<typeof importSpendPort>[0] = {
    assertAiEnabled: async () => undefined,
    async allowance(workspaceId) {
      calls.push(`allowance ${workspaceId}`);
      return {
        includedActions: 500,
        remainingActions: 12,
        spendLimitReached: false,
        spendRemainingMicros: 335_000,
        trialEnded: false,
      };
    },
    async reserve(input) {
      calls.push(`reserve ${input.actionId} ${input.operationId}`);
      return {
        workspaceId: input.workspaceId,
        actionId: input.actionId,
        operationId: input.operationId,
        maxCostMicros: input.maxCostMicros,
      };
    },
    async settle(reservation, actualCostMicros) {
      calls.push(`settle ${reservation.actionId} ${actualCostMicros}`);
    },
  };
  return { spend, calls };
}

test("books an attempt's read steps to an action of its own, and a photo to one for its whole run", async () => {
  const { spend, calls } = recordingSpend();
  const port = (runId: string, attempt: number) =>
    importSpendPort(spend, {
      workspaceId: "w1",
      importId: IMPORT,
      runId,
      attempt,
    });
  const photo = { kind: "photo", productId: "p1", optionIndex: 2 } as const;

  await port("run-a", 1).reserve(
    { kind: "read" },
    "inventory:attempt-1",
    "meta",
    1,
  );
  await port("run-a", 2).reserve(
    { kind: "read" },
    "inventory:attempt-2",
    "meta",
    1,
  );
  await port("run-a", 1).reserve(photo, "photo:attempt-1", "meta", 1);
  await port("run-a", 2).reserve(photo, "photo:attempt-2", "meta", 1);
  await port("run-b", 1).reserve(photo, "photo:attempt-1", "meta", 1);

  assert.deepEqual(calls, [
    // A retry reads the video in a new action,
    `reserve product-video-import:${IMPORT}:read:run-a:1 inventory:attempt-1`,
    `reserve product-video-import:${IMPORT}:read:run-a:2 inventory:attempt-2`,
    // while a photo's attempts share one, until a later run.
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-a photo:attempt-1`,
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-a photo:attempt-2`,
    `reserve product-video-import:${IMPORT}:photo:p1:2:run-b photo:attempt-1`,
  ]);
});

test("checks the workspace's allowance and settles each reservation where it was made", async () => {
  const { spend, calls } = recordingSpend();
  const port = importSpendPort(spend, {
    workspaceId: "w1",
    importId: IMPORT,
    runId: "run-a",
    attempt: 1,
  });

  assert.deepEqual(await port.allowance(), {
    includedActions: 500,
    remainingActions: 12,
    spendLimitReached: false,
    spendRemainingMicros: 335_000,
    trialEnded: false,
  });
  const reservation = await port.reserve(
    { kind: "read" },
    "transcription:attempt-1",
    "elevenlabs",
    3_667,
  );
  await port.settle(reservation, 1_834);

  assert.deepEqual(calls.slice(-1), [
    `settle product-video-import:${IMPORT}:read:run-a:1 1834`,
  ]);
  assert.equal(calls[0], "allowance w1");
});

/**
 * The product model as saving drafts uses it: refusing the drafts `refuses`
 * picks, and failing the insert with `failure`.
 */
function productModel(
  options: {
    refuses?: (doc: Record<string, unknown>) => boolean;
    failure?: unknown;
  } = {},
) {
  const inserts: Array<{ docs: unknown[]; options: unknown }> = [];
  class Model {
    readonly #doc: Record<string, unknown>;
    constructor(doc: Record<string, unknown>) {
      this.#doc = doc;
    }
    validateSync() {
      return options.refuses?.(this.#doc)
        ? { errors: { price: { kind: "user defined" } } }
        : undefined;
    }
    static async insertMany(
      docs: Array<Record<string, unknown>>,
      insertOptions: unknown,
    ) {
      inserts.push({ docs, options: insertOptions });
      if (options.failure) throw options.failure;
      return docs;
    }
  }
  return { model: Model, inserts };
}

test("saves an import's drafts in one unordered insert, which throws for any draft it refuses", async () => {
  const { model, inserts } = productModel();

  await insertDraftProducts(model, [{ importIndex: 0 }, { importIndex: 1 }]);

  assert.deepEqual(inserts, [
    {
      docs: [{ importIndex: 0 }, { importIndex: 1 }],
      options: { ordered: false, throwOnValidationError: true },
    },
  ]);
});

test("drafts a previous attempt already saved are kept, one row each", async () => {
  for (const failure of [
    { code: 11000 },
    { writeErrors: [{ code: 11000 }] },
    { writeErrors: [{ err: { code: 11000 } }, { code: 11000 }] },
  ]) {
    const { model, inserts } = productModel({ failure });
    await insertDraftProducts(model, [{ importIndex: 0 }]);
    assert.equal(inserts.length, 1, JSON.stringify(failure));
  }
});

test("any other failure to save the drafts is thrown", async () => {
  for (const failure of [
    // Drafts the insert's own validation refused, after it saved the rest.
    Object.assign(new Error("validation"), {
      validationErrors: [new Error("price")],
    }),
    // No write refused at all is no duplicate.
    Object.assign(new Error("bulk write"), { writeErrors: [] }),
    Object.assign(new Error("mixed"), {
      writeErrors: [{ code: 11000 }, { code: 121 }],
    }),
  ]) {
    const { model } = productModel({ failure });
    await assert.rejects(
      insertDraftProducts(model, [{ importIndex: 0 }]),
      (error: unknown) => error === failure,
    );
  }
});

test("a draft the product model refuses fails the import for good, with nothing saved", async () => {
  const { model, inserts } = productModel({
    refuses: (doc) => doc.importIndex === 1,
  });

  await assert.rejects(
    insertDraftProducts(model, [
      { importIndex: 0 },
      { importIndex: 1 },
      { importIndex: 2 },
    ]),
    (error: unknown) =>
      error instanceof ProductVideoImportFailure &&
      error.code === "failed" &&
      !error.retryable &&
      error.message ===
        "A product found in the video failed the product model's checks: price (user defined)",
  );
  assert.deepEqual(inserts, []);
});
