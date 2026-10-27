// Shared cases for generate routes that need the workspace's own AI source:
// GET reports generation unavailable, POST rejects with own_ai_source_required
// before creating assets or starting workflows, and an authorization failure
// is returned as is. Each suite keeps its own jest.mock header.

type RouteHandler = (
  request: never,
  context: { params: Promise<{ workspaceId: string }> }
) => Promise<Response>;

export function describeCustomerSourceGate(
  name: string,
  route: { GET: RouteHandler; POST: RouteHandler },
  mocks: {
    mockAccess: jest.Mock;
    mockCreate: jest.Mock;
    mockWorkflow: jest.Mock;
  },
  expectGetBody: (body: Record<string, unknown>) => void
) {
  const { GET, POST } = route;
  const { mockAccess, mockCreate, mockWorkflow } = mocks;
  const params = Promise.resolve({ workspaceId: "workspace-1" });
  describe(`${name} requires a supported customer source`, () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockAccess.mockResolvedValue({
        ok: true,
        supabase: {},
        userId: "user-1",
      });
    });
    it("reports generation unavailable", async () => {
      const response = await GET(new Request("http://localhost") as never, {
        params,
      });
      expectGetBody(await response.json());
    });
    it("rejects before creating assets or workflows", async () => {
      const response = await POST(
        new Request("http://localhost", {
          method: "POST",
          body: "{}",
        }) as never,
        { params }
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "own_ai_source_required",
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockWorkflow).not.toHaveBeenCalled();
    });
    it("preserves the authorization response", async () => {
      const denied = new Response("Unauthorized", { status: 401 });
      mockAccess.mockResolvedValue({ ok: false, response: denied });
      expect(
        await POST(new Request("http://localhost") as never, { params })
      ).toBe(denied);
    });
  });
}
