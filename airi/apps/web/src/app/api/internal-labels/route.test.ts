const mockCreateClient = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

import { DELETE, POST, PUT } from "./route";

function arrange(role: string) {
  const membership = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { role }, error: null }),
  };
  const labels = {
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest
      .fn()
      .mockResolvedValue({ data: { id: "label-1", name: "VIP" }, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ error: null }).then(resolve),
  };
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      if (table === "company_users") return membership;
      if (table === "internal_labels") return labels;
      throw new Error(`Unexpected table ${table}`);
    },
  });
  return labels;
}

describe("internal label role authorization", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(["admin", "manager"])(
    "allows %s to create, update and delete labels",
    async role => {
      arrange(role);
      const request = () =>
        new Request(
          "http://localhost/api/internal-labels?workspaceId=workspace-1&id=label-1",
          {
            method: "POST",
            body: JSON.stringify({
              workspaceId: "workspace-1",
              id: "label-1",
              name: "VIP",
            }),
          }
        );
      expect((await POST(request())).status).toBe(201);
      expect((await PUT(request())).status).toBe(200);
      expect((await DELETE(request())).status).toBe(200);
    }
  );

  it.each(["owner", "member", "viewer"])(
    "denies %s before label writes",
    async role => {
      const labels = arrange(role);
      const request = () =>
        new Request(
          "http://localhost/api/internal-labels?workspaceId=workspace-1&id=label-1",
          {
            method: "POST",
            body: JSON.stringify({
              workspaceId: "workspace-1",
              id: "label-1",
              name: "VIP",
            }),
          }
        );
      expect((await POST(request())).status).toBe(403);
      expect((await PUT(request())).status).toBe(403);
      expect((await DELETE(request())).status).toBe(403);
      expect(labels.insert).not.toHaveBeenCalled();
      expect(labels.update).not.toHaveBeenCalled();
      expect(labels.delete).not.toHaveBeenCalled();
    }
  );
});
