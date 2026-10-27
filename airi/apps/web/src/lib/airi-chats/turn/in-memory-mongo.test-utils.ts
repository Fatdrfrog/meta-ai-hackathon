/**
 * A small in-memory stand-in for the Mongoose models the Airi chat turn and
 * its durable runs use (threads, messages, runs), for integration tests.
 * It supports the query subset those modules issue: equality (ObjectIds by
 * value, null matching a missing field), $lt/$lte/$gt/$gte/$in/$ne/$exists,
 * $or/$and, sort/limit/select/lean, $set/$unset updates, unique and partial
 * unique indexes (E11000), and createdAt/updatedAt timestamps.
 */

import { Types } from "mongoose";

export type InMemoryDoc = Record<string, unknown> & { _id: Types.ObjectId };

type Filter = Record<string, unknown>;

type UniqueIndex = { keys: string[]; partial?: Filter };

export type InMemoryModel = ReturnType<typeof createInMemoryModel>;

/** A query: awaited it yields documents (with save/toObject), lean() plain ones. */
export type InMemoryQuery<T> = PromiseLike<T> & {
  sort: (sort: Record<string, 1 | -1>) => InMemoryQuery<T>;
  limit: (count: number) => InMemoryQuery<T>;
  select: (projection?: unknown) => InMemoryQuery<T>;
  lean: <R = T>() => Promise<R>;
};

function normalize(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value.getTime();
  return value;
}

function equals(left: unknown, right: unknown): boolean {
  if ((left === undefined || left === null) && right === null) return true;
  return normalize(left) === normalize(right);
}

function compare(left: unknown, right: unknown): number {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !(value instanceof Types.ObjectId) &&
    !(value instanceof Date) &&
    Object.keys(value as object).some(key => key.startsWith("$"))
  );
}

function matchesCondition(actual: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equals(actual, condition);
  return Object.entries(condition).every(([operator, expected]) => {
    switch (operator) {
      case "$lt":
        return actual !== undefined && compare(actual, expected) < 0;
      case "$lte":
        return actual !== undefined && compare(actual, expected) <= 0;
      case "$gt":
        return actual !== undefined && compare(actual, expected) > 0;
      case "$gte":
        return actual !== undefined && compare(actual, expected) >= 0;
      case "$in":
        return (expected as unknown[]).some(item => equals(actual, item));
      case "$ne":
        return !equals(actual, expected);
      case "$exists":
        return expected ? actual !== undefined : actual === undefined;
      default:
        throw new Error(`Unsupported operator ${operator}`);
    }
  });
}

export function matchesFilter(doc: InMemoryDoc, filter: Filter = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Filter[]).some(part => matchesFilter(doc, part));
    }
    if (key === "$and") {
      return (condition as Filter[]).every(part => matchesFilter(doc, part));
    }
    return matchesCondition(doc[key], condition);
  });
}

function copy(doc: InMemoryDoc): InMemoryDoc {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value === "function") continue;
    result[key] = Array.isArray(value)
      ? value.map(item =>
          item && typeof item === "object" && !(item instanceof Types.ObjectId)
            ? { ...item }
            : item
        )
      : value;
  }
  return result as InMemoryDoc;
}

export function createInMemoryModel(
  options: {
    timestamps?: boolean;
    unique?: UniqueIndex[];
    defaults?: Record<string, unknown>;
  } = {}
) {
  const docs: InMemoryDoc[] = [];
  // Monotonic clock: every write is 1 ms after the previous one.
  let clock = Date.UTC(2026, 9, 8, 9, 0, 0);
  const tick = () => new Date((clock += 1));

  const hydrate = (doc: InMemoryDoc): InMemoryDoc => {
    const hydrated = copy(doc);
    Object.defineProperties(hydrated, {
      toObject: { value: () => copy(hydrated), enumerable: false },
      save: {
        value: async () => {
          const stored = docs.find(item => equals(item._id, hydrated._id));
          if (stored) Object.assign(stored, copy(hydrated));
          return hydrated;
        },
        enumerable: false,
      },
    });
    return hydrated;
  };

  const assertUnique = (doc: InMemoryDoc) => {
    // _id is always unique, as in Mongo.
    if (docs.some(other => equals(other._id, doc._id))) {
      throw Object.assign(new Error("E11000 duplicate key (_id)"), {
        code: 11000,
      });
    }
    for (const index of options.unique ?? []) {
      if (index.partial && !matchesFilter(doc, index.partial)) continue;
      const clash = docs.find(
        other =>
          (!index.partial || matchesFilter(other, index.partial)) &&
          index.keys.every(key => equals(other[key], doc[key]))
      );
      if (clash) {
        throw Object.assign(
          new Error(`E11000 duplicate key (${index.keys.join(", ")})`),
          { code: 11000 }
        );
      }
    }
  };

  const applyUpdate = (doc: InMemoryDoc, update: Record<string, unknown>) => {
    const set = (update.$set ?? {}) as Record<string, unknown>;
    const unset = (update.$unset ?? {}) as Record<string, unknown>;
    Object.assign(doc, set);
    for (const key of Object.keys(unset)) delete doc[key];
    if (options.timestamps && !("updatedAt" in set)) doc.updatedAt = tick();
  };

  const query = <T>(
    select: () => InMemoryDoc[],
    single: boolean
  ): InMemoryQuery<T> => {
    let sortSpec: Record<string, 1 | -1> | null = null;
    let limitCount: number | null = null;
    const run = (hydrated: boolean) => {
      let rows = select();
      if (sortSpec) {
        const entries = Object.entries(sortSpec);
        rows = [...rows].sort((a, b) => {
          for (const [key, direction] of entries) {
            const order = compare(a[key], b[key]);
            if (order !== 0) return order * direction;
          }
          return 0;
        });
      }
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      const mapped = rows.map(row => (hydrated ? hydrate(row) : copy(row)));
      return single ? (mapped[0] ?? null) : mapped;
    };
    const chain = {
      sort: (sort: Record<string, 1 | -1>) => {
        sortSpec = sort;
        return chain;
      },
      limit: (count: number) => {
        limitCount = count;
        return chain;
      },
      select: () => chain,
      lean: async <R = T>() => run(false) as R,
      then: <A = T, B = never>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
      ) => Promise.resolve(run(true) as T).then(onFulfilled, onRejected),
    };
    return chain as never;
  };

  const model = {
    docs,
    reset: () => {
      docs.length = 0;
    },
    create: async (input: Record<string, unknown>) => {
      const now = tick();
      const doc: InMemoryDoc = {
        ...(options.defaults ?? {}),
        ...input,
        _id:
          input._id instanceof Types.ObjectId
            ? input._id
            : new Types.ObjectId(),
        ...(options.timestamps
          ? {
              createdAt: (input.createdAt as Date | undefined) ?? now,
              updatedAt: (input.updatedAt as Date | undefined) ?? now,
            }
          : {}),
      } as InMemoryDoc;
      assertUnique(doc);
      docs.push(doc);
      return hydrate(doc);
    },
    find: (filter: Filter = {}) =>
      query<InMemoryDoc[]>(
        () => docs.filter(doc => matchesFilter(doc, filter)),
        false
      ),
    findOne: (filter: Filter = {}) =>
      query<InMemoryDoc | null>(
        () => docs.filter(doc => matchesFilter(doc, filter)),
        true
      ),
    findOneAndUpdate: (
      filter: Filter,
      update: Record<string, unknown>,
      updateOptions: { new?: boolean } = {}
    ) =>
      query<InMemoryDoc | null>(() => {
        const doc = docs.find(item => matchesFilter(item, filter));
        if (!doc) return [];
        const before = copy(doc);
        applyUpdate(doc, update);
        return [updateOptions.new ? doc : before];
      }, true),
    updateOne: async (filter: Filter, update: Record<string, unknown>) => {
      const doc = docs.find(item => matchesFilter(item, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (filter: Filter) => {
      const index = docs.findIndex(item => matchesFilter(item, filter));
      if (index !== -1) docs.splice(index, 1);
      return { deletedCount: index === -1 ? 0 : 1 };
    },
    countDocuments: async (filter: Filter = {}) =>
      docs.filter(doc => matchesFilter(doc, filter)).length,
  };
  return model;
}
