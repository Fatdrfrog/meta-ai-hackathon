import type { ScenarioNodeGraphIndex } from "./scenario-node-graph-index";

function assertReadonlyScenarioNodeGraphIndex(
  index: ScenarioNodeGraphIndex
): void {
  // @ts-expect-error Graph-index consumers cannot replace public snapshots.
  index.bulkActionByRootId = new Map();
  // @ts-expect-error Graph-index consumers cannot replace scalar projections.
  index.actionNodeCount = 2;
}

void assertReadonlyScenarioNodeGraphIndex;
