const EDITOR_NODE_DATA_KEYS = new Set([
  "actionPreviewText",
  "actionPreviewImageUrl",
  "compiledNodes",
  "compiledEdges",
]);

export function isScenarioEditorFieldKey(key: string): boolean {
  return key.startsWith("ui") || EDITOR_NODE_DATA_KEYS.has(key);
}

export function stripScenarioEditorFields(
  data: unknown
): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([key, value]) => {
      if (isScenarioEditorFieldKey(key)) return false;
      if (typeof value === "function") return false;
      return true;
    })
  );
}

export function stripScenarioEditorGraphNodes(
  nodes: readonly unknown[]
): unknown[] {
  return nodes.map(node => {
    if (!node || typeof node !== "object") return node;
    const record = node as { data?: unknown };
    if (!record.data || typeof record.data !== "object") return node;
    return {
      ...record,
      data: stripScenarioEditorFields(record.data),
    };
  });
}
