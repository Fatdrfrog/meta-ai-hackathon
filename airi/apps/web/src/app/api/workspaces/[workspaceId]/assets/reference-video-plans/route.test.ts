const mockRequireAccess = jest.fn();
const mockCreatePlan = jest.fn();
const mockApprovePlan = jest.fn();
const mockSerializeAsset = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) => mockRequireAccess(...args),
}));
jest.mock("@/lib/creative-assets/reference-video/service", () => ({
  createReferenceVideoPlan: (...args: unknown[]) => mockCreatePlan(...args),
  approveReferenceVideoPlan: (...args: unknown[]) => mockApprovePlan(...args),
  ReferenceVideoPlanError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
jest.mock("@/lib/higgsfield/creative-asset-serialization", () => ({
  serializeCreativeAssetForResponse: (...args: unknown[]) =>
    mockSerializeAsset(...args),
}));

import { POST } from "./route";
import { POST as APPROVE } from "./[planId]/approve/route";
import { ReferenceVideoPlanError } from "@/lib/creative-assets/reference-video/service";

const HASH = "a".repeat(64);
const PLAN_ID = "64c13ab08edf48a008793ca1";
const params = {
  params: Promise.resolve({ workspaceId: "workspace-1", planId: PLAN_ID }),
};
function request(body: unknown) {
  return new Request(
    "https://airi.chat/api/workspaces/workspace-1/assets/reference-video-plans",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  ) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAccess.mockResolvedValue({ ok: true, userId: "user-1" });
  mockCreatePlan.mockResolvedValue({
    id: PLAN_ID,
    hash: HASH,
    status: "draft",
  });
  mockApprovePlan.mockResolvedValue({
    plan: { id: PLAN_ID, status: "approved" },
    asset: { _id: "output-1" },
    duplicate: false,
  });
  mockSerializeAsset.mockResolvedValue({ id: "output-1", status: "queued" });
});

test.each([
  ["draft", POST],
  ["approval", APPROVE],
] as const)(
  "%s checks workspace membership before reading input or starting work",
  async (_name, handler) => {
    mockRequireAccess.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });
    const response = await handler(request({ hash: HASH }), params);
    expect(response.status).toBe(403);
    expect(mockRequireAccess).toHaveBeenCalledWith("workspace-1");
    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(mockApprovePlan).not.toHaveBeenCalled();
  }
);

test("draft creation returns only the saved review and does not approve it", async () => {
  const input = {
    recipeId: "product-reveal",
    title: "New product",
    scenes: [],
  };
  const response = await POST(request(input), params);
  expect(response.status).toBe(201);
  expect(mockCreatePlan).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    userId: "user-1",
    input,
  });
  expect(await response.json()).toEqual({
    plan: { id: PLAN_ID, hash: HASH, status: "draft" },
  });
  expect(mockApprovePlan).not.toHaveBeenCalled();
});

test("approval forwards only the authenticated workspace, user, saved plan ID and exact hash", async () => {
  const response = await APPROVE(request({ hash: HASH }), params);
  expect(response.status).toBe(202);
  expect(mockApprovePlan).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    userId: "user-1",
    planId: PLAN_ID,
    hash: HASH,
  });
  expect(await response.json()).toEqual({
    plan: { id: PLAN_ID, status: "approved" },
    asset: { id: "output-1", status: "queued" },
    duplicate: false,
  });
});

test.each(["queued", "complete"])(
  "duplicate approval returns the existing %s render with HTTP 200",
  async status => {
    mockApprovePlan.mockResolvedValue({
      plan: { id: PLAN_ID, status: "approved" },
      asset: { _id: "output-1", status },
      duplicate: true,
    });
    mockSerializeAsset.mockResolvedValue({ id: "output-1", status });

    const response = await APPROVE(request({ hash: HASH }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plan: { id: PLAN_ID, status: "approved" },
      asset: { id: "output-1", status },
      duplicate: true,
    });
  }
);

test.each([
  { hash: HASH, timeline: { clips: [] } },
  { hash: HASH, cost: { amount: 100 } },
  { hash: HASH, outputAssetId: "other-output" },
  { hash: "invalid" },
  {},
])("approval rejects altered executable input: %j", async body => {
  const response = await APPROVE(request(body), params);
  expect(response.status).toBe(400);
  expect(mockApprovePlan).not.toHaveBeenCalled();
});

test.each([
  ["draft", POST],
  ["approval", APPROVE],
] as const)("%s rejects malformed JSON", async (_name, handler) => {
  const response = await handler(
    {
      json: async () => {
        throw new SyntaxError("Invalid JSON");
      },
    } as never,
    params
  );
  expect(response.status).toBe(400);
  expect(mockCreatePlan).not.toHaveBeenCalled();
  expect(mockApprovePlan).not.toHaveBeenCalled();
});

test("approval preserves actionable conflict and expiry status", async () => {
  mockApprovePlan.mockRejectedValue(
    new ReferenceVideoPlanError(410, "plan_expired", "Review a new plan")
  );
  const response = await APPROVE(request({ hash: HASH }), params);
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({
    code: "plan_expired",
    error: "Review a new plan",
  });
});

test.each([
  ["draft", POST, mockCreatePlan],
  ["approval", APPROVE, mockApprovePlan],
] as const)(
  "%s storage failures return retryable HTTP 503 without internal details",
  async (_name, handler, service) => {
    service.mockRejectedValue(new Error("database secret details"));
    const response = await handler(request({ hash: HASH }), params);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(
      "database secret details"
    );
  }
);
