const mockGetAuthenticatedWorkspaceMembership = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetAuthenticatedWorkspaceMembership(...args),
}));

import {
  getWhatsAppWorkspaceContext,
  getWhatsAppWorkspaceReadiness,
} from "./get-workspace-context";

type SourceQueryResult = {
  data: Record<string, unknown> | null;
  error: unknown;
};

function arrangeWorkspaceAccess(params: {
  role?: string;
  sourceResult?: SourceQueryResult;
}) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue(
    params.sourceResult ?? {
      data: {
        id: "source-1",
        workspace_id: "workspace-1",
        type: "whatsapp",
        credentials: {
          access_token: "access-token",
          phone_number_id: "phone-1",
          waba_id: "waba-1",
        },
      },
      error: null,
    }
  );

  const supabase = {
    from: jest.fn(() => query),
  };
  mockGetAuthenticatedWorkspaceMembership.mockResolvedValue({
    membership: { role: params.role ?? "admin" },
    supabase,
    user: { id: "user-1" },
  });

  return { query, supabase };
}

async function readErrorStatus(
  result: Awaited<ReturnType<typeof getWhatsAppWorkspaceContext>>
) {
  if (!result.error) throw new Error("Expected an error response");
  return {
    body: await result.error.json(),
    status: result.error.status,
  };
}

describe("getWhatsAppWorkspaceContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(["admin", "manager"])(
    "allows the %s role through manager-only authorization",
    async role => {
      arrangeWorkspaceAccess({ role });

      const result = await getWhatsAppWorkspaceContext("workspace-1", {
        requireManager: true,
      });

      expect(result.error).toBeUndefined();
    }
  );

  it.each(["owner", "member"])(
    "denies the retired %s role from manager-only authorization",
    async role => {
      arrangeWorkspaceAccess({ role });

      const result = await getWhatsAppWorkspaceContext("workspace-1", {
        requireManager: true,
      });

      await expect(readErrorStatus(result)).resolves.toMatchObject({
        status: 403,
      });
    }
  );

  it("scopes an explicit source selector to the authorized workspace and WhatsApp type", async () => {
    const { query } = arrangeWorkspaceAccess({});

    const result = await getWhatsAppWorkspaceContext("workspace-1", {
      sourceId: "source-1",
    });

    expect(result.error).toBeUndefined();
    expect(query.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ["workspace_id", "workspace-1"],
        ["type", "whatsapp"],
        ["id", "source-1"],
      ])
    );
  });

  it("rejects a selected source returned from another workspace", async () => {
    arrangeWorkspaceAccess({
      sourceResult: {
        data: {
          id: "source-1",
          workspace_id: "workspace-2",
          type: "whatsapp",
          credentials: {
            access_token: "access-token",
            waba_id: "waba-1",
          },
        },
        error: null,
      },
    });

    const result = await getWhatsAppWorkspaceContext("workspace-1", {
      sourceId: "source-1",
    });

    await expect(readErrorStatus(result)).resolves.toMatchObject({
      status: 403,
    });
  });

  it("rejects a selected non-WhatsApp source", async () => {
    arrangeWorkspaceAccess({
      sourceResult: {
        data: {
          id: "source-1",
          workspace_id: "workspace-1",
          type: "telegram",
          credentials: {},
        },
        error: null,
      },
    });

    const result = await getWhatsAppWorkspaceContext("workspace-1", {
      sourceId: "source-1",
    });

    await expect(readErrorStatus(result)).resolves.toMatchObject({
      status: 404,
    });
  });

  it("distinguishes a source query failure from a confirmed missing source", async () => {
    arrangeWorkspaceAccess({
      sourceResult: {
        data: null,
        error: new Error("sources query unavailable"),
      },
    });
    const failedQuery = await getWhatsAppWorkspaceContext("workspace-1", {
      sourceId: "source-1",
    });

    arrangeWorkspaceAccess({
      sourceResult: {
        data: null,
        error: null,
      },
    });
    const missingSource = await getWhatsAppWorkspaceContext("workspace-1", {
      sourceId: "source-1",
    });

    await expect(readErrorStatus(failedQuery)).resolves.toMatchObject({
      body: { error: "Failed to query WhatsApp source" },
      status: 500,
    });
    await expect(readErrorStatus(missingSource)).resolves.toMatchObject({
      body: { error: "WhatsApp credentials not found" },
      status: 404,
    });
  });

  it("keeps newest-source compatibility when no source selector is provided", async () => {
    const { query } = arrangeWorkspaceAccess({});

    const result = await getWhatsAppWorkspaceContext("workspace-1");

    expect(result.error).toBeUndefined();
    expect(query.order).toHaveBeenCalledWith("created_at", {
      ascending: false,
    });
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(query.eq).not.toHaveBeenCalledWith("id", expect.anything());
  });

  it("returns the resolved source identity with Flow readiness", async () => {
    arrangeWorkspaceAccess({});

    const result = await getWhatsAppWorkspaceReadiness("workspace-1");

    expect(result.error).toBeUndefined();
    expect(result.sourceId).toBe("source-1");
  });
});
