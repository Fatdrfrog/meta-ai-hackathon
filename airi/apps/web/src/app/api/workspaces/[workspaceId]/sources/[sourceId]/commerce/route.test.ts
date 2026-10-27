/** @jest-environment node */

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: jest.fn(),
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: jest.fn(),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: string) => `plain-${value}`,
  encryptString: jest.fn(),
}));
jest.mock("@/models/website-cart", () => ({
  __esModule: true,
  default: {
    find: () => ({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    }),
  },
}));
jest.mock("@/models/website-commerce-settings", () => ({
  __esModule: true,
  default: {
    findOne: () => ({
      lean: async () => ({ enabled: true, tildaToken: "stored-token" }),
    }),
  },
}));

import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { GET, PUT } from "./route";

const mockMembership = getAuthenticatedWorkspaceMembership as jest.Mock;
const mockSource = fetchSourceWithCredentialsResult as jest.Mock;

const context = {
  params: Promise.resolve({ workspaceId: "workspace-1", sourceId: "widget-1" }),
};
const url =
  "https://airi.chat/api/workspaces/workspace-1/sources/widget-1/commerce";

function membership(role: string) {
  const sourcesQuery = {
    select: () => sourcesQuery,
    eq: () => sourcesQuery,
    order: async () => ({ data: [], error: null }),
  };
  return {
    membership: { role },
    supabase: { from: () => sourcesQuery },
    user: { id: "user-1" },
  };
}

describe("website commerce settings authorization", () => {
  beforeEach(() => jest.clearAllMocks());

  it("requires authenticated workspace membership before source lookup", async () => {
    mockMembership.mockResolvedValue({
      error: new Response("Unauthorized", { status: 401 }),
    });
    expect((await GET(new Request(url), context)).status).toBe(401);
    expect(mockSource).not.toHaveBeenCalled();
  });

  it("lets members read later but rejects writes before any persistence", async () => {
    mockMembership.mockResolvedValue({
      membership: { role: "member" },
      supabase: {},
      user: { id: "user-1" },
    });
    const response = await PUT(
      new Request(url, {
        method: "PUT",
        body: JSON.stringify({ action: "rotate_secret" }),
      }),
      context
    );
    expect(response.status).toBe(403);
    expect(mockSource).not.toHaveBeenCalled();
  });

  it.each([
    ["manager", true],
    ["admin", true],
    ["member", false],
  ])(
    "returns the secret-bearing Tilda webhook URL to %s: %s",
    async (role, revealed) => {
      mockMembership.mockResolvedValue(membership(role));
      mockSource.mockResolvedValue({
        ok: true,
        source: {
          id: "widget-1",
          type: "web_widget",
          workspace_id: "workspace-1",
        },
      });

      const response = await GET(new Request(url), context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).not.toHaveProperty("canManage");
      if (revealed) {
        expect(body.tildaWebhookUrl).toContain("token=plain-stored-token");
      } else {
        expect(body.tildaWebhookUrl).toBeNull();
      }
    }
  );
});
