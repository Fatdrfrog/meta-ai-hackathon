/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockSamples = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/products/voices", () => ({
  productVoiceSamples: (...args: unknown[]) => mockSamples(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const get = (query = "") =>
  GET(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/voice/samples${query}`
    ),
    { params: Promise.resolve({ workspaceId }) }
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "admin" },
  });
  mockFeatureEnabled.mockResolvedValue(true);
  mockSamples.mockReturnValue({ language: "kk", samples: [] });
});

it("lists airi's voices for the ad's language, English without one", async () => {
  const response = await get("?language=kk");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ language: "kk", samples: [] });
  expect(mockSamples).toHaveBeenCalledWith(workspaceId, "kk");
  await get();
  expect(mockSamples).toHaveBeenLastCalledWith(workspaceId, "en");
});

it("refuses another language, and anyone but an admin", async () => {
  expect((await get("?language=uz")).status).toBe(400);
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "member" },
  });
  expect((await get("?language=kk")).status).toBe(403);
});
