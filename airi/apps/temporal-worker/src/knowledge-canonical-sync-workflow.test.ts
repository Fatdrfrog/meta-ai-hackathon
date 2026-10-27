import assert from "node:assert/strict";
import test from "node:test";

import type { KnowledgeCanonicalSyncWorkflowInput } from "@icecore/temporal";
import * as temporalContracts from "@icecore/temporal";
import * as workflowModule from "./workflows/knowledge-canonical-sync.js";

type NormalizeWorkflowInput = (
  input: KnowledgeCanonicalSyncWorkflowInput,
) => KnowledgeCanonicalSyncWorkflowInput;

function workflowInputNormalizer(): NormalizeWorkflowInput {
  const candidate = (
    workflowModule as typeof workflowModule & {
      normalizeKnowledgeCanonicalSyncWorkflowInput?: NormalizeWorkflowInput;
    }
  ).normalizeKnowledgeCanonicalSyncWorkflowInput;

  assert.equal(typeof candidate, "function");
  return candidate;
}

test("the rolling workflow contract is version 2 with exactly three sources", () => {
  assert.equal(
    temporalContracts.KNOWLEDGE_CANONICAL_SYNC_WORKFLOW_CONTRACT_VERSION,
    2,
  );
  const sourceKinds = (
    temporalContracts as typeof temporalContracts & {
      KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS?: readonly string[];
    }
  ).KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS;
  assert.deepEqual(sourceKinds, [
    "kb_article",
    "indexed_url",
    "curated_snippet",
  ]);
});

test("workflow normalization accepts versions 1 through 2 and retires old sources", () => {
  const normalize = workflowInputNormalizer();

  assert.deepEqual(
    normalize({
      contractVersion: 1,
      workspaceId: "workspace-1",
      sourceKinds: ["conversation_summary"] as never,
    }),
    {
      contractVersion: 1,
      workspaceId: "workspace-1",
      sourceKinds: [],
    },
  );
  assert.deepEqual(
    normalize({
      contractVersion: 2,
      workspaceId: "workspace-1",
    }),
    {
      contractVersion: 2,
      workspaceId: "workspace-1",
      sourceKinds: undefined,
    },
  );
});

test("workflow normalization preserves explicit empty and filters mixed runtime input", () => {
  const normalize = workflowInputNormalizer();

  assert.deepEqual(
    normalize({
      contractVersion: 2,
      workspaceId: "workspace-1",
      sourceKinds: [] as never,
    }).sourceKinds,
    [],
  );
  assert.deepEqual(
    normalize({
      contractVersion: 1,
      workspaceId: "workspace-1",
      sourceKinds: [
        "conversation_summary",
        "kb_article",
        "future_source",
        "kb_article",
      ] as never,
    }).sourceKinds,
    ["kb_article"],
  );
});

test("workflow normalization rejects missing, fractional, non-positive, and future versions", () => {
  const normalize = workflowInputNormalizer();

  for (const contractVersion of [undefined, Number.NaN, 1.5, 0, -1, 3]) {
    assert.throws(
      () =>
        normalize({
          contractVersion: contractVersion as number,
          workspaceId: "workspace-1",
          sourceKinds: [],
        }),
      /Unsupported knowledge canonical sync workflow contract version/,
    );
  }
});
