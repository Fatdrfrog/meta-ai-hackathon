const mockCreateClient = jest.fn();
const mockLoadStages = jest.fn();
const mockSavePipeline = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock("@/lib/crm/board", () => ({
  loadCrmPipelineStages: (...args: unknown[]) => mockLoadStages(...args),
  saveCrmPipeline: (...args: unknown[]) => mockSavePipeline(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET, PUT } from "./route";

describe("CRM pipeline role authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadStages.mockResolvedValue([{ key: "new", name: "New" }]);
    mockSavePipeline.mockResolvedValue({ stages: [] });
  });

  it.each([
    ["admin", 200],
    ["manager", 200],
    ["owner", 403],
    ["member", 403],
    ["viewer", 403],
  ])("returns %s access status %s", async (role, status) => {
    const membership = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { role }, error: null }),
    };
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: () => membership,
    });
    const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
    expect(
      (await GET(new NextRequest("http://localhost"), context)).status
    ).toBe(status);
    expect(
      (
        await PUT(
          new NextRequest("http://localhost", {
            method: "PUT",
            body: JSON.stringify({ stages: [] }),
          }),
          context
        )
      ).status
    ).toBe(status);
    if (status === 403) {
      expect(mockLoadStages).not.toHaveBeenCalled();
      expect(mockSavePipeline).not.toHaveBeenCalled();
    }
  });
});
