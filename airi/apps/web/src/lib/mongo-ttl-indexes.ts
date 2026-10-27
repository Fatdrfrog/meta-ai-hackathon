type TtlIndex = {
  name?: string;
  key?: Record<string, unknown>;
  expireAfterSeconds?: number;
  unique?: boolean;
  sparse?: boolean;
  hidden?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
};

export type TtlIndexCollection = {
  collectionName: string;
  indexes(): Promise<TtlIndex[]>;
  createIndex(
    key: Record<string, 1>,
    options: { name: string; expireAfterSeconds: number }
  ): Promise<string>;
};

/** Repair schema-declared retention without rebuilding an existing plain index. */
export async function ensureSingleFieldTtlIndex(params: {
  collection: TtlIndexCollection;
  db: { command(command: Record<string, unknown>): Promise<unknown> };
  field: string;
  expireAfterSeconds: number;
  dryRun?: boolean;
}) {
  const { collection, db, field, expireAfterSeconds, dryRun = false } = params;
  if (
    !Number.isSafeInteger(expireAfterSeconds) ||
    expireAfterSeconds <= 0 ||
    expireAfterSeconds > 2_147_483_647
  ) {
    throw new Error(
      "TTL retention must be a positive 32-bit integer in seconds"
    );
  }
  const key = { [field]: 1 as const };
  const canonicalName = `${field}_1`;
  const sameKey = (index: TtlIndex) =>
    JSON.stringify(index.key) === JSON.stringify(key);
  const readIndexes = async () => {
    try {
      return await collection.indexes();
    } catch (error) {
      const mongoError = error as { code?: number; codeName?: string };
      if (
        mongoError.code === 26 ||
        mongoError.codeName === "NamespaceNotFound"
      ) {
        return [];
      }
      throw error;
    }
  };
  const indexes = await readIndexes();
  const named = indexes.find(index => index.name === canonicalName);
  const actual = named ?? indexes.find(sameKey);
  if (
    actual &&
    (!actual.name ||
      !sameKey(actual) ||
      actual.unique ||
      actual.sparse ||
      actual.hidden ||
      actual.partialFilterExpression ||
      actual.collation)
  ) {
    throw new Error(
      `Unexpected TTL index definition: ${collection.collectionName}.${actual.name}`
    );
  }
  const name = actual?.name ?? canonicalName;
  const action = !actual
    ? "create"
    : actual.expireAfterSeconds === expireAfterSeconds
      ? "unchanged"
      : actual.expireAfterSeconds === undefined
        ? "convert"
        : "update";
  const result = {
    collection: collection.collectionName,
    name,
    expireAfterSeconds,
    action,
    dryRun,
  };
  if (dryRun || action === "unchanged") return result;

  if (action === "create") {
    await collection.createIndex(key, { name, expireAfterSeconds });
  } else {
    await db.command({
      collMod: collection.collectionName,
      index: { name, expireAfterSeconds },
    });
  }
  const verified = (await readIndexes()).find(index => index.name === name);
  if (
    !verified ||
    !sameKey(verified) ||
    verified.expireAfterSeconds !== expireAfterSeconds ||
    verified.unique ||
    verified.sparse ||
    verified.hidden ||
    verified.partialFilterExpression ||
    verified.collation
  ) {
    throw new Error(
      `TTL index verification failed: ${collection.collectionName}.${name}`
    );
  }
  return result;
}
