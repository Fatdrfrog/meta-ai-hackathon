import { NextRequest } from "next/server";
const mockAccess = jest.fn();
const mockUser = jest.fn();
const mockRecord = jest.fn();
const mockExists = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => mockUser() } }),
}));
jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/customers/behavior-events", () => ({
  recordCustomerBehaviorEvent: (...args: unknown[]) => mockRecord(...args),
  CustomerBehaviorEventError: class extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  },
}));
jest.mock("@/lib/campaign/customer-contact-policy", () => ({
  loadCustomerContactPolicy: async () => ({
    minIntervalHours: 24,
    maxPerWeek: 3,
  }),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({
  Conversation: { exists: (...args: unknown[]) => mockExists(...args) },
}));
jest.mock("@/models/customer-contact-policy", () => ({
  __esModule: true,
  default: { updateOne: (...args: unknown[]) => mockUpdate(...args) },
}));
jest.mock("@/models/scenario-behavior-run", () => ({
  __esModule: true,
  default: {},
}));
import { GET, POST, PATCH } from "./route";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const request = (method: string, body?: string, extra = "") =>
  new NextRequest(
    `http://localhost/api/scenarios/customer-behavior?workspaceId=${workspaceId}${extra}`,
    { method, ...(body === undefined ? {} : { body }) }
  );
beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockResolvedValue({ data: { user: { id: "manager" } } });
  mockAccess.mockResolvedValue(true);
});
test("all methods enforce authentication and workspace membership before work", async () => {
  mockUser.mockResolvedValue({ data: { user: null } });
  for (const [method, handler] of [
    ["GET", GET],
    ["POST", POST],
    ["PATCH", PATCH],
  ] as const)
    expect((await handler(request(method))).status).toBe(401);
  mockUser.mockResolvedValue({ data: { user: { id: "manager" } } });
  mockAccess.mockResolvedValue(false);
  expect((await POST(request("POST", "{}"))).status).toBe(403);
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("conversation ownership, bounded JSON and contact limits fail closed", async () => {
  mockExists.mockResolvedValue(null);
  expect(
    (await GET(request("GET", undefined, `&conversationId=${"a".repeat(24)}`)))
      .status
  ).toBe(404);
  expect((await POST(request("POST", "{"))).status).toBe(400);
  expect(
    (await POST(request("POST", JSON.stringify({ text: "a".repeat(17_000) }))))
      .status
  ).toBe(413);
  expect(
    (
      await PATCH(
        request("PATCH", JSON.stringify({ minIntervalHours: 0, maxPerWeek: 3 }))
      )
    ).status
  ).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
test("valid policy updates use only the authorized workspace", async () => {
  const policy = { minIntervalHours: 48, maxPerWeek: 2 };
  expect((await PATCH(request("PATCH", JSON.stringify(policy)))).status).toBe(
    200
  );
  expect(mockUpdate).toHaveBeenCalledWith(
    { workspaceId },
    { $set: policy },
    { upsert: true }
  );
});
