export function normalizeMetaAdAccountId(value: unknown): string {
  if (typeof value !== "string") return "";
  const bare = value.trim().toLowerCase().replace(/^act_/, "");
  if (!/^\d+$/.test(bare)) return "";
  return `act_${bare}`;
}
