import { DatabaseSync } from "node:sqlite";
import {
  getPostHogQueryStatus,
  queryPageviews,
  querySessionStats,
  queryDeviceStats,
  queryTopPages,
  queryTrafficSources,
} from "./posthog-queries";

const workspaceId = "41b51d55-697c-4455-875a-9a7238bdf272";
const sourceId = "268bb34a-bc08-4740-9301-be04c7c1709b";
const dateRange = {
  start: "2026-05-24T00:00:00.000Z",
  end: "2026-06-23T00:00:00.000Z",
};
const envKeys = [
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_API_KEY",
  "POSTHOG_PROJECT_ID",
  "POSTHOG_QUERY_HOST",
  "NEXT_PUBLIC_POSTHOG_CAPTURE_HOST",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_UI_HOST",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]])
) as Partial<Record<(typeof envKeys)[number], string | undefined>>;
const originalFetch = global.fetch;

function mockPostHogRows(rows: unknown[][]) {
  (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ results: rows }),
  });
}

function readPostedQuery(): { kind: string; query: string } {
  const fetchMock = global.fetch as unknown as jest.Mock;
  const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
  return body.query;
}

describe("PostHog widget analytics queries", () => {
  beforeEach(() => {
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_test_personal";
    delete process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_PROJECT_ID = "12345";
    process.env.POSTHOG_QUERY_HOST = "https://us.posthog.com";
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_HOST = "https://f.airi.chat";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://f.airi.chat";
    process.env.NEXT_PUBLIC_POSTHOG_UI_HOST = "https://us.posthog.com";
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    global.fetch = originalFetch;
  });

  it("aggregates pageviews in HogQL with workspace, source, and date filters", async () => {
    mockPostHogRows([
      ["2026-06-21", 2],
      ["2026-06-22", 3],
    ]);

    await expect(
      queryPageviews(workspaceId, dateRange, sourceId)
    ).resolves.toEqual({
      total: 5,
      timeSeries: [
        { date: "2026-06-21", count: 2 },
        { date: "2026-06-22", count: 3 },
      ],
    });

    const query = readPostedQuery();
    expect(query.kind).toBe("HogQLQuery");
    expect(query.query).toContain("event = 'widget_pageview'");
    expect(query.query).toContain(`properties.workspace_id = '${workspaceId}'`);
    expect(query.query).toContain(`properties.source_id = '${sourceId}'`);
    expect(query.query).toContain(
      "timestamp >= toDateTime('2026-05-24 00:00:00')"
    );
    expect(query.query).toContain(
      "timestamp <= toDateTime('2026-06-23 00:00:00')"
    );
    expect((global.fetch as unknown as jest.Mock).mock.calls[0][0]).toBe(
      "https://us.posthog.com/api/projects/12345/query/"
    );
  });

  it("does not use the reverse proxy host for PostHog query API requests", async () => {
    process.env.POSTHOG_QUERY_HOST = "https://us.posthog.com/";
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_HOST = "https://f.airi.chat";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://f.airi.chat";
    mockPostHogRows([]);

    await queryPageviews(workspaceId, dateRange, sourceId);

    expect((global.fetch as unknown as jest.Mock).mock.calls[0][0]).toBe(
      "https://us.posthog.com/api/projects/12345/query/"
    );
  });

  it("counts sessions from starts while capping completed-session durations", async () => {
    mockPostHogRows([[404, 692_991, 138, 207]]);

    await expect(
      querySessionStats(workspaceId, dateRange, sourceId)
    ).resolves.toEqual({
      totalSessions: 404,
      avgSessionDuration: 692.991,
      bounceRate: (138 / 207) * 100,
    });

    const query = readPostedQuery();
    expect(query.kind).toBe("HogQLQuery");
    expect(query.query).toContain("countIf(event = 'widget_session_start')");
    expect(query.query).toContain("least(properties.duration_ms, 1800000)");
    expect(query.query).toContain(`properties.source_id = '${sourceId}'`);
    expect(query.query).toContain(
      "GROUP BY properties.source_id, properties.visitor_id, properties.session_id"
    );
    expect(query.query).toContain("maxIf(");
    expect(query.query).toContain(
      "avgIf(duration_ms, completed > 0 AND duration_ms > 0)"
    );
    expect(query.query).toContain("countIf(completed > 0 AND page_count <= 1)");
  });

  it("aggregates navigation snapshots once per visitor session, including late replays", async () => {
    // Run the generated SQL against fixture events, adapting only HogQL's
    // property syntax and ClickHouse aggregate functions to Node's SQLite.
    // Live HogQL syntax is a separate provider verification boundary.
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE events(event TEXT, timestamp TEXT, properties TEXT)");
    db.function("toDateTime", value => value);
    db.function("least", { varargs: true }, (...values) =>
      Math.min(...values.filter(value => value !== null).map(Number))
    );
    db.aggregate("countIf", {
      start: 0,
      step: (count, condition) => count + (condition ? 1 : 0),
    });
    db.aggregate("maxIf", {
      start: null as number | null,
      step: (max, value, condition) =>
        condition && value !== null
          ? Math.max(max ?? Number(value), Number(value))
          : max,
    });
    db.aggregate("avgIf", {
      start: () => ({ sum: 0, count: 0 }),
      step: (state, value, condition) => {
        if (condition && value !== null) {
          state.sum += Number(value);
          state.count++;
        }
        return state;
      },
      result: state => (state.count ? state.sum / state.count : null),
    });
    const append = (event: string, extra: Record<string, unknown> = {}) =>
      db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(
        event,
        "2026-06-01 12:00:00",
        JSON.stringify({
          workspace_id: workspaceId,
          source_id: sourceId,
          visitor_id: "visitor-1",
          session_id: "session-1",
          ...extra,
        })
      );
    (global.fetch as jest.Mock).mockImplementation(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      const sql = query.query.replace(
        /properties\.([a-z_]+)/g,
        "json_extract(properties, '$.$1')"
      );
      const results = db
        .prepare(sql)
        .all()
        .map(row => [
          row.total_sessions,
          row.avg_duration_ms,
          row.bounced_sessions,
          row.completed_sessions,
        ]);
      return { ok: true, json: async () => ({ results }) };
    });

    try {
      append("widget_session_start");
      for (const pages of [1, 2, 3, 1]) {
        append("widget_session_end", {
          duration_ms: pages * 10_000,
          page_count: pages,
        });
      }
      await expect(
        querySessionStats(workspaceId, dateRange, sourceId)
      ).resolves.toEqual({
        totalSessions: 1,
        avgSessionDuration: 30,
        bounceRate: 0,
      });

      // A different visitor may use the same session id; other sources and
      // workspaces must not contribute, and repeated starts count once.
      append("widget_session_start");
      append("widget_session_start", { visitor_id: "visitor-2" });
      append("widget_session_end", {
        visitor_id: "visitor-2",
        duration_ms: 10_000,
        page_count: 1,
      });
      for (const otherScope of [
        { workspace_id: "other-workspace" },
        { source_id: "other-source" },
      ]) {
        append("widget_session_start", otherScope);
        append("widget_session_end", {
          ...otherScope,
          duration_ms: 90_000,
          page_count: 1,
        });
      }
      await expect(
        querySessionStats(workspaceId, dateRange, sourceId)
      ).resolves.toEqual({
        totalSessions: 2,
        avgSessionDuration: 20,
        bounceRate: 50,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    queryPageviews,
    querySessionStats,
    queryDeviceStats,
    queryTopPages,
    queryTrafficSources,
  ])(
    "%p propagates provider failures instead of reporting zero traffic",
    async query => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });
      await expect(query(workspaceId, dateRange)).rejects.toThrow(
        "PostHog query unavailable"
      );
    }
  );

  it("rejects malformed provider results", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ error: "query failed" }),
    });
    await expect(queryPageviews(workspaceId, dateRange)).rejects.toThrow(
      "PostHog query unavailable"
    );
  });

  it("propagates network failures", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network offline"));
    await expect(queryPageviews(workspaceId, dateRange)).rejects.toThrow(
      "PostHog query unavailable"
    );
  });

  it("reports missing query config without making a PostHog request", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;

    try {
      expect(getPostHogQueryStatus()).toEqual({
        configured: false,
        reason: "missing_config",
      });
      await expect(
        queryPageviews(workspaceId, dateRange, sourceId)
      ).resolves.toEqual({
        total: 0,
        timeSeries: [],
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
