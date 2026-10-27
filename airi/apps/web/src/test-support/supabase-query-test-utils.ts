// A chainable PostgREST query double. Every builder method is a recording
// jest.fn that returns the query, maybeSingle/single resolve to the result,
// and awaiting the query itself resolves to the result, like supabase-js
// (unless `thenable: false`, for suites that must catch a missing terminal).

export type SupabaseQueryResult = {
  data: unknown;
  error: unknown;
  count?: number | null;
};

const FILTER_METHODS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "not",
  "or",
  "match",
  "filter",
] as const;

const BUILDER_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "order",
  "limit",
  "range",
  "abortSignal",
  ...FILTER_METHODS,
] as const;

type BuilderMethod = (typeof BUILDER_METHODS)[number];

export type SupabaseQueryMock = Record<
  BuilderMethod | "maybeSingle" | "single",
  jest.Mock
> &
  PromiseLike<SupabaseQueryResult>;

/** A query double without `then`: only maybeSingle/single resolve the result. */
export type TerminalSupabaseQueryMock = Omit<SupabaseQueryMock, "then">;

type SupabaseQueryMockOptions = {
  /** Results for successive awaits (then, maybeSingle or single); `result` after. */
  results?: SupabaseQueryResult[];
  /** Called with each filter call, e.g. ("eq", "workspace_id", "w-1"). */
  onFilter?: (method: string, ...args: unknown[]) => void;
  /**
   * false leaves out `then`, so awaiting a chain that skips maybeSingle/single
   * yields the builder itself rather than the result.
   */
  thenable?: boolean;
};

export function createSupabaseQueryMock(
  result: SupabaseQueryResult | undefined,
  options: SupabaseQueryMockOptions & { thenable: false }
): TerminalSupabaseQueryMock;
export function createSupabaseQueryMock(
  result?: SupabaseQueryResult,
  options?: SupabaseQueryMockOptions & { thenable?: true }
): SupabaseQueryMock;
export function createSupabaseQueryMock(
  result: SupabaseQueryResult = { data: null, error: null },
  { results = [], onFilter, thenable = true }: SupabaseQueryMockOptions = {}
): SupabaseQueryMock | TerminalSupabaseQueryMock {
  const queued = [...results];
  const next = () => queued.shift() ?? result;
  const query = {} as SupabaseQueryMock;
  const filters = new Set<string>(FILTER_METHODS);

  for (const method of BUILDER_METHODS) {
    query[method] = jest.fn((...args: unknown[]) => {
      if (filters.has(method)) onFilter?.(method, ...args);
      return query;
    });
  }
  query.maybeSingle = jest.fn(async () => next());
  query.single = jest.fn(async () => next());
  if (!thenable) return query;
  Object.assign(query, {
    then: <TResult1 = SupabaseQueryResult, TResult2 = never>(
      onFulfilled?:
        | ((value: SupabaseQueryResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onRejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null
    ) => Promise.resolve(next()).then(onFulfilled, onRejected),
  });
  return query;
}
