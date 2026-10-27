import assert from "node:assert/strict";
import test from "node:test";

type ActivityModule = typeof import("./knowledge-canonical-sync-activity.js");

let loadedActivity: Promise<ActivityModule> | null = null;

function loadActivity(): Promise<ActivityModule> {
  loadedActivity ??= import("./knowledge-canonical-sync-activity.js");
  return loadedActivity;
}

test("the activity module loads without Mongo configuration", async () => {
  const originalMongoUri = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;

  try {
    await assert.doesNotReject(loadActivity());
  } finally {
    if (originalMongoUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalMongoUri;
  }
});

test("version-1 retired-only work is a successful no-op without loading Mongo", async () => {
  const { executeKnowledgeCanonicalSyncActivity } = await loadActivity();

  const result = await executeKnowledgeCanonicalSyncActivity({
    contractVersion: 1,
    workspaceId: "workspace-1",
    sourceKinds: ["conversation_summary"] as never,
  });

  assert.deepEqual(result, {
    workspaceId: "workspace-1",
    bySource: {},
    syncRunIds: [],
  });
});

test("explicit empty and all-unsupported source lists stay successful empty runs", async () => {
  const { executeKnowledgeCanonicalSyncActivity } = await loadActivity();

  for (const sourceKinds of [[], ["conversation_summary", "future_source"]]) {
    const result = await executeKnowledgeCanonicalSyncActivity({
      contractVersion: 2,
      workspaceId: "workspace-1",
      sourceKinds: sourceKinds as never,
    });

    assert.deepEqual(result, {
      workspaceId: "workspace-1",
      bySource: {},
      syncRunIds: [],
    });
  }
});

test("contract versions must be exact supported integers", async () => {
  const { executeKnowledgeCanonicalSyncActivity } = await loadActivity();

  for (const contractVersion of [undefined, Number.NaN, 1.5, 0, -1, 3]) {
    await assert.rejects(
      executeKnowledgeCanonicalSyncActivity({
        contractVersion: contractVersion as number,
        workspaceId: "workspace-1",
        sourceKinds: [],
      }),
      /Unsupported knowledge canonical sync contract version/,
    );
  }
});

test("an explicit empty record scope cannot broaden into a workspace sync", async () => {
  const { executeKnowledgeCanonicalSyncActivity } = await loadActivity();
  assert.deepEqual(
    await executeKnowledgeCanonicalSyncActivity({
      contractVersion: 2,
      workspaceId: "workspace-1",
      sourceKinds: ["kb_article"],
      sourceRecordIds: [],
    }),
    { workspaceId: "workspace-1", bySource: {}, syncRunIds: [] },
  );
});
