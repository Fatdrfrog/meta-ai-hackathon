const mockAccess = jest.fn(),
  mockReport = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/analytics/service-lifecycle-report", () => ({
  getServiceLifecycleReport: (...args: unknown[]) => mockReport(...args),
}));
import { GET } from "./route";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = { params: Promise.resolve({ workspaceId }) };
const start = "2026-09-01T00:00:00.000Z",
  end = "2026-10-01T00:00:00.000Z";
const request = (query = "") => new Request(`https://local.test/api?${query}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ ok: true });
  mockReport.mockResolvedValue({ observed: { events: 2 }, bySource: [] });
});

test.each([401, 403])(
  "denied access %s cannot query retained service history",
  async status => {
    const denial = new Response(null, { status });
    mockAccess.mockResolvedValue({ ok: false, response: denial });
    expect(await GET(request("sourceId=bad"), context)).toBe(denial);
    expect(mockAccess).toHaveBeenCalledWith(workspaceId);
    expect(mockReport).not.toHaveBeenCalled();
  }
);

test("forwards the authorized workspace, exclusive date window and selected source", async () => {
  const response = await GET(
    request(`start=${start}&end=${end}&sourceId=${sourceId}`),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledWith(
    workspaceId,
    new Date(start),
    new Date(end),
    sourceId
  );
  expect(await response.json()).toEqual({
    observed: { events: 2 },
    bySource: [],
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("normalizes a valid UUID to its canonical lowercase source identity", async () => {
  const response = await GET(
    request(`start=${start}&end=${end}&sourceId=${sourceId.toUpperCase()}`),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport.mock.calls[0][3]).toBe(sourceId);
});

test("defaults to the preceding thirty days and keeps an omitted source unfiltered", async () => {
  jest.useFakeTimers().setSystemTime(new Date(end));
  try {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith(
      workspaceId,
      new Date(start),
      new Date(end),
      undefined
    );
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  "start=not-a-date",
  "end=not-a-date",
  `start=${end}&end=${start}`,
  `start=${end}&end=${end}`,
  "start=2026-01-01T00:00:00Z&end=2026-10-01T00:00:00Z",
  `start=&end=${end}`,
  "end=",
])(
  "rejects an invalid or unbounded window without querying: %s",
  async query => {
    const response = await GET(request(query), context);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockReport).not.toHaveBeenCalled();
  }
);

test("accepts the maximum ninety-day exclusive window", async () => {
  const response = await GET(
    request(`start=2026-07-03T00:00:00Z&end=${end}`),
    context
  );
  expect(response.status).toBe(200);
  expect(mockReport).toHaveBeenCalledTimes(1);
});

test.each([
  "sourceId=invalid",
  "sourceId=",
  `sourceId=${"a".repeat(36)}`,
  "sourceId=bbbbbbbb-bbbb-4bbb-gbbb-bbbbbbbbbbbb",
  `sourceId=%20${sourceId}`,
  `sourceId=${sourceId}&sourceId=${sourceId}`,
])(
  "rejects malformed or ambiguous source identity without querying: %s",
  async query => {
    const response = await GET(
      request(`start=${start}&end=${end}&${query}`),
      context
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockReport).not.toHaveBeenCalled();
  }
);

test("storage failure returns a generic non-cacheable 503 instead of empty history or database detail", async () => {
  mockReport.mockRejectedValue(new Error("private database credentials"));
  const response = await GET(
    request(`start=${start}&end=${end}&sourceId=${sourceId}`),
    context
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Service lifecycle analytics unavailable",
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
