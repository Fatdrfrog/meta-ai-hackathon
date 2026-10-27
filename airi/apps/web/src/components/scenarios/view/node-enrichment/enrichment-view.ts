/*
 * An enrichment view is the part of the enrichment context one node reads,
 * with graph-index maps cut down to that node's entries. A node's editor data
 * depends only on its persisted data and its view, so an equal view lets the
 * canvas keep the node's previous editor data (and skip its re-render).
 */

const EMPTY_SLICE_MAP: ReadonlyMap<string, never> = new Map<string, never>();
const EMPTY_SLICE_SET: ReadonlySet<string> = new Set();

/** The map with only `key`'s entry, the way the node reads it. */
export function sliceIndexMap<V>(
  map: ReadonlyMap<string, V> | undefined,
  key: string | undefined
): ReadonlyMap<string, V> {
  if (!map || key === undefined || !map.has(key)) return EMPTY_SLICE_MAP;
  return new Map([[key, map.get(key) as V]]);
}

/** The set with only `key`, when it holds it. */
export function sliceIndexSet(
  set: ReadonlySet<string> | undefined,
  key: string
): ReadonlySet<string> {
  return set?.has(key) ? new Set([key]) : EMPTY_SLICE_SET;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSameMap(
  left: ReadonlyMap<unknown, unknown>,
  right: ReadonlyMap<unknown, unknown>
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || !isSameIndexSnapshot(value, right.get(key))) {
      return false;
    }
  }
  return true;
}

function isSameSet(
  left: ReadonlySet<unknown>,
  right: ReadonlySet<unknown>
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isSameArray(
  left: readonly unknown[],
  right: readonly unknown[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => isSameIndexSnapshot(value, right[index]))
  );
}

function isSamePlainObject(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(
    ([key, value]) =>
      Object.hasOwn(right, key) &&
      isSameIndexSnapshot(value, (right as Record<string, unknown>)[key])
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isSameObjectSnapshot(left: object, right: object): boolean {
  if (left instanceof Map)
    return right instanceof Map && isSameMap(left, right);
  if (left instanceof Set)
    return right instanceof Set && isSameSet(left, right);
  if (Array.isArray(left))
    return Array.isArray(right) && isSameArray(left, right);
  return (
    !Array.isArray(right) &&
    isPlainObject(left) &&
    isPlainObject(right) &&
    isSamePlainObject(left, right)
  );
}

/**
 * Value equality for graph-index snapshots: maps, sets, arrays and plain
 * objects compare by content, anything else (functions included) by
 * identity. A rebuilt index repeats unchanged entries as new objects.
 */
export function isSameIndexSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return isObject(left) && isObject(right) && isSameObjectSnapshot(left, right);
}

/**
 * Fields holding graph-index snapshots compare by content; every other
 * field is a context value or command and compares by identity.
 */
const SNAPSHOT_VIEW_FIELDS = new Set(["graphIndex", "legacyRoutingByActionId"]);

export function isSameEnrichmentView(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => {
    const other = (right as Record<string, unknown>)[key];
    return SNAPSHOT_VIEW_FIELDS.has(key)
      ? isSameIndexSnapshot(value, other)
      : Object.hasOwn(right, key) && Object.is(value, other);
  });
}
