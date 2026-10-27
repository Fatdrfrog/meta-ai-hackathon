import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RECIPIENT_COLUMN_SPLIT_PATHS,
  RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
  RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
  buildRecipientColumnSplitPathHandleId,
  createDefaultRecipientColumnSplitPath,
  createEmptyRecipientColumnSplitConfig,
  getRecipientColumnSplitSourceHandleIds,
  isRecipientColumnSplitConfigReadyForSend,
  matchRecipientColumnSplit,
  normalizeScenarioRecipientColumnSplit,
  parseRecipientColumnSplitPathHandleId,
  summarizeRecipientColumnSplitRoutes,
  type ScenarioRecipientColumnSplitConfig,
} from "./scenario-recipient-column-split.ts";

function makeConfig(
  overrides?: Partial<ScenarioRecipientColumnSplitConfig>,
): ScenarioRecipientColumnSplitConfig {
  return {
    version: 1,
    paths: [
      {
        id: "gold",
        label: "Gold",
        rules: [
          { id: "r1", column: "loyalty", op: "equals", value: "gold" },
          { id: "r2", column: "region", op: "equals", value: "KZ" },
        ],
      },
      {
        id: "silver",
        label: "Silver",
        rules: [
          { id: "r3", column: "loyalty", op: "equals", value: "silver" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("scenario-recipient-column-split", () => {
  it("matches the first path in priority order", () => {
    const config = makeConfig({
      paths: [
        {
          id: "vip",
          rules: [{ id: "r1", column: "tier", op: "equals", value: "vip" }],
        },
        {
          id: "gold",
          rules: [{ id: "r2", column: "tier", op: "equals", value: "gold" }],
        },
      ],
    });

    const match = matchRecipientColumnSplit(
      { fields: { tier: "gold" } },
      config,
    );
    assert.equal(match.pathId, "gold");
    assert.equal(match.isElse, false);
  });

  it("requires all rules in a path to match", () => {
    const config = makeConfig();
    assert.equal(
      matchRecipientColumnSplit(
        { fields: { loyalty: "gold", region: "UZ" } },
        config,
      ).pathId,
      RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID,
    );
    assert.equal(
      matchRecipientColumnSplit(
        { fields: { loyalty: "gold", region: "KZ" } },
        config,
      ).pathId,
      "gold",
    );
  });

  it("routes unmatched recipients to else", () => {
    const config = makeConfig();
    const match = matchRecipientColumnSplit(
      { fields: { loyalty: "bronze" } },
      config,
    );
    assert.equal(match.pathId, RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID);
    assert.equal(match.handleId, RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID);
    assert.equal(match.isElse, true);
  });

  it("normalizes invalid config input", () => {
    assert.deepEqual(normalizeScenarioRecipientColumnSplit(null), {
      status: "absent",
      value: null,
    });
    assert.equal(
      normalizeScenarioRecipientColumnSplit({ version: 99, paths: [] }).status,
      "unsupported",
    );

    const normalized = normalizeScenarioRecipientColumnSplit({
      version: 1,
      paths: [
        {
          id: " path 1 ",
          label: " VIP ",
          rules: [
            {
              id: " rule ",
              column: " tier ",
              op: "equals",
              value: " vip ",
            },
            { id: "bad", column: "", op: "equals", value: "x" },
          ],
        },
      ],
    });
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") {
      throw new Error("expected supported normalization");
    }
    assert.equal(normalized.value.paths[0]?.id, "path_1");
    assert.equal(normalized.value.paths[0]?.rules.length, 1);
    assert.equal(normalized.value.paths[0]?.rules[0]?.column, "tier");
  });

  it("keeps the raw over-limit path count observable before normalization", () => {
    const raw = {
      version: 1,
      paths: Array.from(
        { length: MAX_RECIPIENT_COLUMN_SPLIT_PATHS + 1 },
        (_, index) => ({
          id: `path_${index + 1}`,
          rules: [
            {
              id: `rule_${index + 1}`,
              column: "tier",
              op: "equals",
              value: String(index + 1),
            },
          ],
        }),
      ),
    };

    assert.equal(raw.paths.length, 21);
    const normalizedOverLimit = normalizeScenarioRecipientColumnSplit(raw);
    assert.equal(normalizedOverLimit.status, "supported");
    if (normalizedOverLimit.status !== "supported") return;
    assert.equal(
      normalizedOverLimit.value.paths.length,
      MAX_RECIPIENT_COLUMN_SPLIT_PATHS,
    );

    const rawAtLimit = {
      ...raw,
      paths: raw.paths.slice(0, MAX_RECIPIENT_COLUMN_SPLIT_PATHS),
    };
    assert.equal(rawAtLimit.paths.length, 20);
    const normalizedAtLimit = normalizeScenarioRecipientColumnSplit(rawAtLimit);
    assert.equal(normalizedAtLimit.status, "supported");
    if (normalizedAtLimit.status !== "supported") return;
    assert.equal(
      normalizedAtLimit.value.paths.length,
      MAX_RECIPIENT_COLUMN_SPLIT_PATHS,
    );
  });

  it("builds and parses path handle ids", () => {
    assert.equal(
      buildRecipientColumnSplitPathHandleId("gold"),
      "right-source-column-split-gold",
    );
    assert.equal(
      buildRecipientColumnSplitPathHandleId(RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID),
      RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
    );
    assert.deepEqual(
      parseRecipientColumnSplitPathHandleId(
        "right-source-column-split-gold",
      ),
      { pathId: "gold", isElse: false },
    );
    assert.deepEqual(
      parseRecipientColumnSplitPathHandleId(RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID),
      { pathId: RECIPIENT_COLUMN_SPLIT_ELSE_PATH_ID, isElse: true },
    );
  });

  it("lists configured source handles including else", () => {
    const config = makeConfig();
    assert.deepEqual(getRecipientColumnSplitSourceHandleIds(config), [
      "right-source-column-split-gold",
      "right-source-column-split-silver",
      RECIPIENT_COLUMN_SPLIT_ELSE_HANDLE_ID,
    ]);
  });

  it("summarizes route counts", () => {
    const config = makeConfig();
    const summary = summarizeRecipientColumnSplitRoutes({
      config,
      recipients: [
        { fields: { loyalty: "gold", region: "KZ" } },
        { fields: { loyalty: "silver" } },
        { fields: { loyalty: "bronze" } },
      ],
    });
    assert.equal(summary.byPathId.gold, 1);
    assert.equal(summary.byPathId.silver, 1);
    assert.equal(summary.elseCount, 1);
    assert.equal(summary.total, 3);
  });

  it("parses comma-separated in-operator values from value field", () => {
    const normalized = normalizeScenarioRecipientColumnSplit({
      version: 1,
      paths: [
        {
          id: "vip",
          rules: [
            {
              id: "r1",
              column: "tier",
              op: "in",
              value: "gold, silver , platinum",
            },
          ],
        },
      ],
    });
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    const rule = normalized.value.paths[0]?.rules[0];
    assert.deepEqual(rule?.values, ["gold", "silver", "platinum"]);
    assert.equal(
      matchRecipientColumnSplit({ fields: { tier: "silver" } }, normalized.value)
        .pathId,
      "vip",
    );
    assert.equal(
      isRecipientColumnSplitConfigReadyForSend(normalized.value),
      true,
    );
  });

  it("allocates unique path ids after delete + add", () => {
    const first = createDefaultRecipientColumnSplitPath(0, []);
    const second = createDefaultRecipientColumnSplitPath(1, [first.id]);
    // Delete path_1, keep path_2, then add — must not reuse path_2.
    const afterDelete = createDefaultRecipientColumnSplitPath(1, [second.id]);
    assert.equal(first.id, "path_1");
    assert.equal(second.id, "path_2");
    assert.equal(afterDelete.id, "path_3");
    assert.notEqual(afterDelete.id, second.id);
    // Prefer lowest free index when starting from 0 with a hole.
    const reclaim = createDefaultRecipientColumnSplitPath(0, [second.id]);
    assert.equal(reclaim.id, "path_1");
  });

  it("validates send readiness", () => {
    assert.equal(
      isRecipientColumnSplitConfigReadyForSend(
        createEmptyRecipientColumnSplitConfig(),
      ),
      false,
    );
    assert.equal(
      isRecipientColumnSplitConfigReadyForSend({
        version: 1,
        paths: [createDefaultRecipientColumnSplitPath()],
      }),
      false,
    );
    assert.equal(isRecipientColumnSplitConfigReadyForSend(makeConfig()), true);
  });
});
