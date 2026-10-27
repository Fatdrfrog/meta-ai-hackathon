const mockFrom = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import {
  buildWhatsAppPhoneOwnership,
  findWhatsAppPhoneOwner,
  listWhatsAppPhoneOwnersForCompany,
} from "./inventory";

type Row = Record<string, unknown>;
type QueryResult = { data: Row[]; error: null };
type MockSupabaseQuery = {
  select: jest.Mock<MockSupabaseQuery, unknown[]>;
  eq: jest.Mock<MockSupabaseQuery, [string, unknown]>;
  in: jest.Mock<MockSupabaseQuery, [string, unknown[]]>;
  order: jest.Mock<MockSupabaseQuery, unknown[]>;
  then: Promise<QueryResult>["then"];
};

let accountRows: Row[] = [];
let sourceRows: Row[] = [];
let workspaceRows: Row[] = [];

function createQuery(table: string) {
  const eqFilters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};

  const resolve = () => {
    if (table === "whatsapp_accounts") {
      return {
        data: accountRows.filter(row =>
          matchesFilters(row, eqFilters, inFilters)
        ),
        error: null,
      };
    }
    if (table === "sources") {
      return {
        data: sourceRows.filter(row =>
          matchesFilters(row, eqFilters, inFilters)
        ),
        error: null,
      };
    }
    if (table === "workspaces") {
      return {
        data: workspaceRows.filter(row =>
          matchesFilters(row, eqFilters, inFilters)
        ),
        error: null,
      };
    }

    return { data: [], error: null };
  };

  const query = {} as MockSupabaseQuery;
  query.select = jest.fn(() => query);
  query.eq = jest.fn((column: string, value: unknown) => {
    eqFilters[column] = value;
    return query;
  });
  query.in = jest.fn((column: string, values: unknown[]) => {
    inFilters[column] = values;
    return query;
  });
  query.order = jest.fn(() => query);
  query.then = <TResult1 = QueryResult, TResult2 = never>(
    onFulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise.resolve(resolve()).then(onFulfilled, onRejected);

  return query;
}

function matchesFilters(
  row: Row,
  eqFilters: Record<string, unknown>,
  inFilters: Record<string, unknown[]>
) {
  for (const [column, value] of Object.entries(eqFilters)) {
    if (row[column] !== value) return false;
  }
  for (const [column, values] of Object.entries(inFilters)) {
    if (!values.includes(row[column])) return false;
  }
  return true;
}

describe("WhatsApp account inventory", () => {
  beforeEach(() => {
    accountRows = [];
    sourceRows = [];
    workspaceRows = [];
    mockFrom.mockImplementation((table: string) => createQuery(table));
  });

  it("returns active phone owners from whatsapp_accounts with workspace names", async () => {
    accountRows = [
      {
        source_id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        phone_number_id: "phone-1",
        connection_status: "active",
        display_phone_number: "+7 701 000 00 01",
        verified_name: "Sales",
      },
    ];
    workspaceRows = [{ id: "workspace-1", name: "Sales workspace" }];

    const owners = await listWhatsAppPhoneOwnersForCompany({
      companyId: "company-1",
      phoneNumberIds: ["phone-1"],
    });

    expect(owners.get("phone-1")).toEqual([
      expect.objectContaining({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        workspaceName: "Sales workspace",
        displayPhoneNumber: "+7 701 000 00 01",
      }),
    ]);
  });

  it("falls back to sources.credentials for rows not yet in inventory", async () => {
    sourceRows = [
      {
        id: "source-2",
        workspace_id: "workspace-2",
        company_id: "company-1",
        type: "whatsapp",
        credentials: {
          phone_number_id: "phone-2",
          display_phone_number: "+7 701 000 00 02",
        },
      },
    ];
    workspaceRows = [{ id: "workspace-2", name: "Support" }];

    const owner = await findWhatsAppPhoneOwner({
      companyId: "company-1",
      phoneNumberId: "phone-2",
      currentWorkspaceId: "workspace-1",
    });

    expect(owner).toEqual(
      expect.objectContaining({
        sourceId: "source-2",
        workspaceId: "workspace-2",
        workspaceName: "Support",
      })
    );
  });

  it("normalizes phone input before looking up owners", async () => {
    accountRows = [
      {
        source_id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        phone_number_id: "phone-1",
        connection_status: "active",
      },
    ];

    const owner = await findWhatsAppPhoneOwner({
      companyId: "company-1",
      phoneNumberId: "  phone-1  ",
      currentWorkspaceId: "workspace-2",
    });

    expect(owner).toEqual(
      expect.objectContaining({
        phoneNumberId: "phone-1",
        sourceId: "source-1",
        workspaceId: "workspace-1",
      })
    );
  });

  it("ignores the current workspace when checking for conflicts", async () => {
    sourceRows = [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        type: "whatsapp",
        credentials: { phone_number_id: "phone-1" },
      },
    ];

    await expect(
      findWhatsAppPhoneOwner({
        companyId: "company-1",
        phoneNumberId: "phone-1",
        currentWorkspaceId: "workspace-1",
      })
    ).resolves.toBeNull();
  });

  it("maps ownership relative to the current workspace", () => {
    expect(
      buildWhatsAppPhoneOwnership({
        owner: {
          phoneNumberId: "phone-1",
          sourceId: "source-1",
          workspaceId: "workspace-1",
          workspaceName: "Sales",
        },
        currentWorkspaceId: "workspace-2",
      })
    ).toEqual({
      status: "other_workspace",
      source_id: "source-1",
      workspace_id: "workspace-1",
      workspace_name: "Sales",
    });
  });
});
