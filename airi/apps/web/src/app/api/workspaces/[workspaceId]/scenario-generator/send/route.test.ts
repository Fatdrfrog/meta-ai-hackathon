const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockExecuteGeneratedBulkSend = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/campaign/generated-bulk-send-orchestrator", () => ({
  executeGeneratedBulkSend: (...args: unknown[]) =>
    mockExecuteGeneratedBulkSend(...args),
}));

import { POST } from "./route";

const SCENARIO_ID = "65f000000000000000000002";

function post(body: unknown) {
  return POST(
    new Request("https://airi.chat/api/generated-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

describe("POST /api/workspaces/[workspaceId]/scenario-generator/send", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockExecuteGeneratedBulkSend.mockResolvedValue({
      status: 200,
      body: { queued: true, childrenTotal: 1 },
    });
  });

  it("rejects malformed scenario IDs before domain orchestration", async () => {
    const result = await post({ scenarioId: "not-an-object-id" });

    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({
      error: "Invalid scenarioId",
      operationDisposition: "not_started",
    });
    expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
  });

  it.each([null, []])(
    "rejects a non-object JSON body before domain orchestration",
    async body => {
      const result = await post(body);

      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        error: "Invalid request body",
        operationDisposition: "not_started",
      });
      expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed confirmation fingerprints before orchestration", async () => {
    const result = await post({
      scenarioId: SCENARIO_ID,
      audienceConfirmationFingerprint: "not-a-sha256",
    });

    expect(result.status).toBe(400);
    expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
  });

  it.each([
    ["recipientPolicy", { version: 1, excludePriorFailedBulkSends: true }],
    ["excludePriorFailedBulkSends", true],
    ["audience", { kind: "inline", recipients: [] }],
    ["recipients", [{ phone: "+15550000001" }]],
    ["unknownCommandField", "must-not-be-stripped"],
  ])("rejects the unknown generated-send body key %s", async (key, value) => {
    const result = await post({ scenarioId: SCENARIO_ID, [key]: value });

    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({
      error: "Invalid request body",
      operationDisposition: "not_started",
    });
    expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
  });

  it.each([
    ["scenarioId", { recipientPolicy: { version: 1 } }],
    ["idempotencyKey", { audience: { kind: "inline" } }],
    ["acknowledgeMediaFailures", { recipients: [] }],
    ["audienceConfirmationFingerprint", { recipientPolicy: {} }],
    ["scheduledAt", { audience: {} }],
  ])(
    "rejects a nested override object at accepted body field %s",
    async (key, value) => {
      const result = await post({ scenarioId: SCENARIO_ID, [key]: value });

      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({
        error: "Invalid request body",
        operationDisposition: "not_started",
      });
      expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
    }
  );

  it("rejects idempotency keys outside the canonical 8 to 128 character contract", async () => {
    const tooShort = await post({
      scenarioId: SCENARIO_ID,
      idempotencyKey: "short",
    });
    const tooLong = await post({
      scenarioId: SCENARIO_ID,
      idempotencyKey: "x".repeat(129),
    });

    expect(tooShort.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(mockExecuteGeneratedBulkSend).not.toHaveBeenCalled();
  });

  it("preserves schedule omission for active-operation reacquisition", async () => {
    await post({
      scenarioId: SCENARIO_ID,
      idempotencyKey: "attempt-1",
    });

    expect(mockExecuteGeneratedBulkSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: SCENARIO_ID,
      userId: "user-1",
      requestUrl: "https://airi.chat/api/generated-send",
      idempotencyKey: "attempt-1",
      acknowledgeMediaFailures: false,
      audienceConfirmationFingerprint: null,
    });
  });

  it("passes a canonical past schedule to the domain for immutable-operation recovery", async () => {
    await post({
      scenarioId: SCENARIO_ID,
      scheduledAt: "2026-07-25T10:00:00+00:00",
    });

    expect(mockExecuteGeneratedBulkSend).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: "2026-07-25T10:00:00.000Z",
      })
    );
  });

  it("canonicalizes an explicitly supplied future schedule", async () => {
    await post({
      scenarioId: SCENARIO_ID,
      scheduledAt: "2099-07-25T10:00:00+00:00",
    });

    expect(mockExecuteGeneratedBulkSend).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: "2099-07-25T10:00:00.000Z",
      })
    );
  });

  it("keeps explicit null distinct from an omitted schedule", async () => {
    await post({
      scenarioId: SCENARIO_ID,
      scheduledAt: null,
    });

    expect(mockExecuteGeneratedBulkSend).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: null })
    );
  });

  it("returns the domain status and grouped body unchanged", async () => {
    mockExecuteGeneratedBulkSend.mockResolvedValue({
      status: 409,
      body: {
        partial: true,
        retryable: true,
        childrenTotal: 1,
        code: "bulk_campaign_recent_audience_confirmation_required",
      },
    });

    const result = await post({ scenarioId: SCENARIO_ID });

    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      partial: true,
      retryable: true,
      childrenTotal: 1,
      code: "bulk_campaign_recent_audience_confirmation_required",
    });
    expect(result.headers.get("Retry-After")).toBeNull();
  });

  it("tells the client when to retry a Meta rate limit", async () => {
    mockExecuteGeneratedBulkSend.mockResolvedValue({
      status: 503,
      body: {
        code: "meta_rate_limited",
        retryable: true,
        retryAfterSeconds: 60,
        operationDisposition: "not_started",
      },
      headers: { "Retry-After": "60" },
    });

    const result = await post({ scenarioId: SCENARIO_ID });

    expect(result.status).toBe(503);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(await result.json()).toMatchObject({
      code: "meta_rate_limited",
      retryAfterSeconds: 60,
    });
  });
});
