type ScenarioNodeMemoProps = {
  data: unknown;
  selected: boolean;
};

/**
 * Custom React.memo comparator for scenario node components.
 *
 * Scenario node renderers receive editor-local projected data. During drag,
 * React Flow preserves that `data` reference while updating positional props,
 * so data-reference and selection equality suppress drag-only re-renders.
 * Any persisted-data or enrichment change produces a new projected object.
 */
export function areNodePropsEqual<TProps extends ScenarioNodeMemoProps>(
  prev: TProps,
  next: TProps
): boolean {
  return prev.data === next.data && prev.selected === next.selected;
}
