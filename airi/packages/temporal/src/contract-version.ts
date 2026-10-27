/**
 * Supported contract versions: `{ max }` accepts 1..max, `{ exact }` only that
 * version. Pure and deterministic, so workflow code may call it.
 */
export type ContractVersionSupport = { max: number } | { exact: number };

/** Throws `Unsupported ${label} contract version: ${value}` for other versions. */
export function assertContractVersion(
  value: number,
  support: ContractVersionSupport,
  label: string,
): void {
  const unsupported =
    "exact" in support
      ? value !== support.exact
      : value < 1 || value > support.max;
  if (unsupported) {
    throw new Error(`Unsupported ${label} contract version: ${value}`);
  }
}
