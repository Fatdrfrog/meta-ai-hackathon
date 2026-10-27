jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  invalidateWhatsAppSourceResolutionCache,
  resolveWhatsAppSourceByAccountIdentifiers,
  resolveWhatsAppSourcesByAccountIdentifiers,
} from "./source-resolver";

type QueryResult = {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
};

type MockQuery = {
  table?: string;
  select: jest.Mock;
  eq: jest.Mock;
  not: jest.Mock;
  in: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
};

function makeQuery(result: QueryResult): MockQuery {
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    not: jest.fn(() => query),
    in: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn(async () => result),
  } as MockQuery;

  return query;
}

function queueQueries(queries: MockQuery[]) {
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const query = queries.shift();
    if (!query) {
      throw new Error(`Unexpected Supabase query for ${table}`);
    }
    query.table = table;
    return query;
  });
}

function whatsappSource(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    created_at: "2026-06-03T00:00:00.000Z",
    company_id: "company-1",
    workspace_id: "workspace-1",
    type: "whatsapp",
    name: "WhatsApp",
    credentials: {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
    },
    ...overrides,
  };
}

describe("resolveWhatsAppSourceByAccountIdentifiers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateWhatsAppSourceResolutionCache();
  });

  it("uses the normalized account table before credential JSON filters", async () => {
    const accountQuery = makeQuery({
      data: [{ source_id: "source-1" }],
      error: null,
    });
    const sourceQuery = makeQuery({
      data: [whatsappSource()],
      error: null,
    });
    queueQueries([accountQuery, sourceQuery]);

    const source = await resolveWhatsAppSourceByAccountIdentifiers({
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
    });

    expect(source?.id).toBe("source-1");
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
    expect(accountQuery.eq).toHaveBeenCalledWith("phone_number_id", "phone-1");
    expect(sourceQuery.in).toHaveBeenCalledWith("id", ["source-1"]);
  });

  it("keeps resolving offboarded or removed sources by their own account row", async () => {
    const accountQuery = makeQuery({
      data: [{ source_id: "source-1" }],
      error: null,
    });
    const sourceQuery = makeQuery({
      data: [whatsappSource()],
      error: null,
    });
    queueQueries([accountQuery, sourceQuery]);

    await resolveWhatsAppSourceByAccountIdentifiers({
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
    });

    // Routing must not depend on connection_status, or a suspended number's
    // events would fall through to a sibling source on the same WABA.
    expect(accountQuery.not).toHaveBeenCalledWith("source_id", "is", null);
    expect(accountQuery.eq).not.toHaveBeenCalledWith(
      "connection_status",
      expect.anything()
    );
  });

  it("does not fall back to global source lookup when workspaceId is provided", async () => {
    const queries = [
      makeQuery({ data: [], error: null }),
      makeQuery({ data: [], error: null }),
      makeQuery({ data: [], error: null }),
      makeQuery({ data: [], error: null }),
      makeQuery({ data: [], error: null }),
      makeQuery({ data: [], error: null }),
    ];
    queueQueries([...queries]);

    const sources = await resolveWhatsAppSourcesByAccountIdentifiers({
      workspaceId: "workspace-1",
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
    });

    expect(sources).toEqual([]);
    const sourceQueries = queries.filter(query => query.table === "sources");
    expect(sourceQueries).toHaveLength(3);
    for (const query of sourceQueries) {
      expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    }
  });

  it("coalesces repeated account resolution without bypassing the canonical lookup", async () => {
    queueQueries([
      makeQuery({ data: [{ source_id: "source-1" }], error: null }),
      makeQuery({ data: [whatsappSource()], error: null }),
    ]);

    const params = { phoneNumberId: "phone-1", wabaId: "waba-1" };
    const [first, second] = await Promise.all([
      resolveWhatsAppSourceByAccountIdentifiers(params),
      resolveWhatsAppSourceByAccountIdentifiers(params),
    ]);

    expect(first?.id).toBe("source-1");
    expect(second?.id).toBe("source-1");
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached account resolution after credentials change", async () => {
    queueQueries([
      makeQuery({ data: [{ source_id: "source-1" }], error: null }),
      makeQuery({ data: [whatsappSource()], error: null }),
      makeQuery({ data: [{ source_id: "source-1" }], error: null }),
      makeQuery({ data: [whatsappSource()], error: null }),
    ]);

    const params = { phoneNumberId: "phone-1", wabaId: "waba-1" };
    await resolveWhatsAppSourceByAccountIdentifiers(params);
    invalidateWhatsAppSourceResolutionCache();
    await resolveWhatsAppSourceByAccountIdentifiers(params);

    expect(supabaseAdmin.from).toHaveBeenCalledTimes(4);
  });

  it("can bypass stale connection metadata for session-scoped webhook ingress", async () => {
    queueQueries([
      makeQuery({ data: [{ source_id: "source-1" }], error: null }),
      makeQuery({ data: [whatsappSource()], error: null }),
      makeQuery({ data: [{ source_id: "source-1" }], error: null }),
      makeQuery({
        data: [
          whatsappSource({
            credentials: {
              phone_number_id: "phone-1",
              history_sync: { session_id: "new-session" },
            },
          }),
        ],
        error: null,
      }),
    ]);
    const params = { phoneNumberId: "phone-1", wabaId: "waba-1" };
    await resolveWhatsAppSourceByAccountIdentifiers(params);
    const current = await resolveWhatsAppSourceByAccountIdentifiers({
      ...params,
      bypassCache: true,
    });
    expect(current?.credentials).toMatchObject({
      history_sync: { session_id: "new-session" },
    });
    expect(supabaseAdmin.from).toHaveBeenCalledTimes(4);
  });
});
