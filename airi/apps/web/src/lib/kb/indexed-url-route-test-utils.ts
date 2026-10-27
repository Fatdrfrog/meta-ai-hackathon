// Doubles, fixtures and shared expectations for the kb_indexed_urls route
// suites (kb/indexed-urls, its reindex route and onboarding/crawl). Each suite
// creates its own jest.fn handles and passes them in, so its hoisted jest.mock
// factories still close over file-scope mock* variables.

import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";

type QueryResult = {
  data: unknown[] | null;
  error: { message?: string } | null;
};

/** A user-scoped client that must never touch kb_indexed_urls itself. */
export function createAuthClient(userId: string | null = "user-1") {
  return {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
    from: jest.fn(() => {
      throw new Error("Auth client must not access kb_indexed_urls");
    }),
  };
}

/**
 * Route admin kb_indexed_urls reads: awaiting the filtered select resolves
 * selectResult, order() resolves orderResult (selectResult by default) and
 * upsert succeeds.
 */
export function useAdminTable(
  mocks: {
    from: jest.Mock;
    select: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    upsert: jest.Mock;
  },
  params?: { selectResult?: QueryResult; orderResult?: QueryResult }
) {
  const selectResult = params?.selectResult ?? { data: [], error: null };
  const orderResult = params?.orderResult ?? selectResult;
  const query = {
    eq: (...args: unknown[]) => {
      mocks.eq(...args);
      return query;
    },
    order: (...args: unknown[]) => mocks.order(...args),
    then: (
      onfulfilled: (value: QueryResult) => unknown,
      onrejected?: (reason: unknown) => unknown
    ) => Promise.resolve(selectResult).then(onfulfilled, onrejected),
  };
  const table = {
    select: (...args: unknown[]) => {
      mocks.select(...args);
      return query;
    },
    upsert: (...args: unknown[]) => mocks.upsert(...args),
  };

  mocks.order.mockResolvedValue(orderResult);
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.from.mockReturnValue(table);
  return table;
}

/** An example.com row that is pending and was queued just now. */
export function freshPendingRow() {
  return {
    url: "https://example.com/",
    index_status: "pending",
    last_indexed_at: new Date().toISOString(),
  };
}

export const PERMISSION_DENIED_WRITE = {
  error: { message: "permission denied for table kb_indexed_urls" },
};

export const TEMPORAL_START_FAILURE = {
  ok: false,
  reason: "start_failed",
  message: "Temporal namespace prod-secret rejected the request",
};

/** The error text never names the table, RLS or a permission failure. */
export function expectNoStorageDiagnostics(payload: unknown) {
  expect(payload).not.toEqual(
    expect.objectContaining({
      error: expect.stringMatching(/permission denied|rls|kb_indexed_urls/i),
    })
  );
}

/** Two equivalent requests started the same default-limit workflow input. */
export function expectOneEffectiveWorkflowInput(
  tryStartCrawlWebsiteWorkflow: jest.Mock,
  responses: Response[],
  expected: { websites: string[]; includeInstagram: boolean }
) {
  for (const response of responses) {
    expect(response.status).toBe(202);
  }
  expect(tryStartCrawlWebsiteWorkflow).toHaveBeenCalledTimes(2);
  expect(tryStartCrawlWebsiteWorkflow).toHaveBeenNthCalledWith(
    1,
    expect.not.objectContaining({ executionId: expect.anything() })
  );
  expect(tryStartCrawlWebsiteWorkflow).toHaveBeenNthCalledWith(
    2,
    expect.not.objectContaining({ executionId: expect.anything() })
  );

  const firstInput = tryStartCrawlWebsiteWorkflow.mock.calls[0]?.[0];
  const secondInput = tryStartCrawlWebsiteWorkflow.mock.calls[1]?.[0];
  expect(firstInput).toEqual(secondInput);
  expect(firstInput).toMatchObject({
    ...expected,
    maxPagesPerSite: CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite,
    maxCrawlMsPerSite: CRAWL_INDEX_LIMITS.defaultCrawlMsPerSite,
    maxIndexChars: CRAWL_INDEX_LIMITS.maxAggregatedChars,
  });
}

/**
 * After TEMPORAL_START_FAILURE the route answers with the safe training
 * failure and persists it as the second upsert.
 */
export async function expectSafeTrainingStartFailure(
  response: Response,
  upsert: jest.Mock
) {
  const payload = await response.json();

  expect(response.status).toBe(500);
  expect(payload).toEqual({
    code: "training_start_failed",
    error: "We couldn't start training. Please try again.",
  });
  expect(upsert).toHaveBeenNthCalledWith(
    2,
    [
      expect.objectContaining({
        index_status: "failed",
        error_message: "We couldn't start training. Please try again.",
      }),
    ],
    { onConflict: "company_id,url" }
  );
  expect(JSON.stringify(payload)).not.toMatch(/Temporal|prod-secret/i);
}
