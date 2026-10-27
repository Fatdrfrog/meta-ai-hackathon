const mockAdminFrom = jest.fn();
const mockCreateCookieClient = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Widget visitors have no Airi session; the cookie client is anon for them
// and anon cannot read taxonomies.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateCookieClient(...args),
}));

import { generateTagsFromUrl } from "./auto-tagger";

type TaxonomyRow = {
  workspace_id: string;
  labels: unknown;
  updated_at: string;
};

/** A taxonomies table that answers like PostgREST for the chain it receives. */
function taxonomiesTable(rows: TaxonomyRow[]) {
  const calls: unknown[][] = [];
  const query = () => {
    let selected = [...rows];
    let limited = false;
    const finish = (singleRow: boolean) => {
      if (selected.length > 1 && !limited)
        return Promise.resolve({
          data: null,
          error: {
            code: "PGRST116",
            message: "JSON object requested, multiple rows returned",
          },
        });
      if (singleRow && selected.length === 0)
        return Promise.resolve({
          data: null,
          error: { code: "PGRST116", message: "no rows" },
        });
      return Promise.resolve({ data: selected[0] ?? null, error: null });
    };
    const builder = {
      select: (...args: unknown[]) => {
        calls.push(["select", ...args]);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        calls.push(["eq", column, value]);
        selected = selected.filter(
          row => row[column as keyof TaxonomyRow] === value
        );
        return builder;
      },
      order: (column: string, options: { ascending: boolean }) => {
        calls.push(["order", column, options]);
        const key = column as keyof TaxonomyRow;
        selected.sort((left, right) =>
          String(left[key]).localeCompare(String(right[key]))
        );
        if (!options.ascending) selected.reverse();
        return builder;
      },
      limit: (count: number) => {
        calls.push(["limit", count]);
        selected = selected.slice(0, count);
        limited = true;
        return builder;
      },
      single: () => finish(true),
      maybeSingle: () => finish(false),
    };
    return builder;
  };
  mockAdminFrom.mockImplementation(() => query());
  return calls;
}

describe("generateTagsFromUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("applies the workspace taxonomy read on the server for widget visitors", async () => {
    const calls = taxonomiesTable([
      {
        workspace_id: "workspace-1",
        labels: ["Delivery"],
        updated_at: "2026-09-01T00:00:00Z",
      },
    ]);

    const tags = await generateTagsFromUrl(
      "https://shop.test/delivery/pricing",
      "workspace-1"
    );

    expect(mockAdminFrom).toHaveBeenCalledWith("taxonomies");
    expect(calls).toContainEqual(["eq", "workspace_id", "workspace-1"]);
    expect(mockCreateCookieClient).not.toHaveBeenCalled();
    expect(tags).toEqual(
      expect.arrayContaining(["delivery", "pricing", "sales"])
    );
  });

  it("uses the newest of several taxonomy rows, like the classifier", async () => {
    const calls = taxonomiesTable([
      {
        workspace_id: "workspace-1",
        labels: ["Returns"],
        updated_at: "2026-08-01T00:00:00Z",
      },
      {
        workspace_id: "workspace-1",
        labels: ["Delivery"],
        updated_at: "2026-09-20T00:00:00Z",
      },
      {
        workspace_id: "workspace-1",
        labels: ["Wholesale"],
        updated_at: "2026-05-01T00:00:00Z",
      },
      {
        workspace_id: "workspace-2",
        labels: ["Returns"],
        updated_at: "2026-10-01T00:00:00Z",
      },
    ]);

    const tags = await generateTagsFromUrl(
      "https://shop.test/delivery/returns",
      "workspace-1"
    );

    expect(tags).toEqual(["delivery"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["order", "updated_at", { ascending: false }],
        ["limit", 1],
      ])
    );
  });

  it("matches labels literally, never as tenant-controlled regular expressions", async () => {
    taxonomiesTable([
      {
        workspace_id: "workspace-1",
        // "VIP+(b2b" alone is an invalid pattern that used to drop every label.
        labels: ["VIP+(b2b", "(a+)+$", "c.o", "  ", 42],
        updated_at: "2026-09-01T00:00:00Z",
      },
    ]);

    const literal = await generateTagsFromUrl(
      "https://shop.test/offers/vip+(b2b",
      "workspace-1"
    );
    expect(literal).toEqual(["vip+(b2b"]);

    // As a regex, "c.o" would match "cto"; "(a+)+$" would backtrack.
    const started = Date.now();
    const other = await generateTagsFromUrl(
      `https://shop.test/cto/${"a".repeat(40)}!`,
      "workspace-1"
    );
    expect(other).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps the fallback rules when the workspace has no taxonomy", async () => {
    taxonomiesTable([]);

    const tags = await generateTagsFromUrl(
      "https://shop.test/pricing",
      "workspace-1"
    );

    expect(tags).toEqual(["pricing", "sales"]);
  });
});
