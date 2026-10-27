export const MONGO_DUPLICATE_KEY_CODE = 11000;

export function isMongoDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; codeName?: unknown };
  if (record.code === MONGO_DUPLICATE_KEY_CODE) return true;
  if (record.code === String(MONGO_DUPLICATE_KEY_CODE)) return true;
  return record.codeName === "DuplicateKey";
}
