const mockCreateClient = jest.fn();
const mockAdminUpdateUserById = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) =>
          mockAdminUpdateUserById(...args),
      },
    },
  },
}));

import { POST } from "./route";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/workspaces/last-used", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/workspaces/last-used", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const clientUpdateUser = jest.fn();
  const companyUsersUpdate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    const membershipQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { user_id: "user-1" },
        error: null,
      }),
    };

    const updateQuery = {
      eq: jest.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    companyUsersUpdate.mockReturnValue(updateQuery);

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: "user-1",
              user_metadata: { locale: "en" },
            },
          },
          error: null,
        }),
        updateUser: clientUpdateUser.mockResolvedValue({ error: null }),
      },
      from: jest.fn(() => ({
        ...membershipQuery,
        update: companyUsersUpdate,
      })),
    });

    mockAdminUpdateUserById.mockResolvedValue({ error: null });
  });

  it("records the last workspace through admin auth metadata without touching company_users.last_used_at", async () => {
    const response = await POST(jsonRequest({ workspaceId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      authMetadataRecorded: true,
    });

    expect(mockAdminUpdateUserById).toHaveBeenCalledWith("user-1", {
      user_metadata: {
        locale: "en",
        last_workspace_id: workspaceId,
      },
    });
    expect(clientUpdateUser).not.toHaveBeenCalled();
    expect(companyUsersUpdate).not.toHaveBeenCalled();
  });

  it("does not update auth metadata when the user is not a workspace member", async () => {
    const membershipQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    };

    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: "user-1", user_metadata: {} } },
          error: null,
        }),
        updateUser: clientUpdateUser,
      },
      from: jest.fn(() => membershipQuery),
    });

    const response = await POST(jsonRequest({ workspaceId }));

    expect(response.status).toBe(403);
    expect(mockAdminUpdateUserById).not.toHaveBeenCalled();
    expect(clientUpdateUser).not.toHaveBeenCalled();
  });
});
