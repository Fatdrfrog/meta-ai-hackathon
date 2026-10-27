import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Production: the current project, its custom domain, and the project it
// moved from on 2026-10-26 (docs/infrastructure/supabase-eu-move.md).
const PRODUCTION_PROJECT_HOSTS = new Set([
  "eufcprvswhmkgzkmwxxs.supabase.co",
  "api.airi.chat",
  "wnycyavumykzejnjelfb.supabase.co",
]);
const testUrl = process.env.CLASSIFICATION_SUPABASE_TEST_URL;
const testKey = process.env.CLASSIFICATION_SUPABASE_TEST_SERVICE_ROLE_KEY;
const describeBranch = testUrl && testKey ? describe : describe.skip;
const branchClient =
  testUrl && testKey
    ? createClient(testUrl, testKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

describeBranch("classification webhook Supabase branch", () => {
  jest.setTimeout(60_000);

  const companyId = randomUUID();
  const workspaceId = randomUUID();
  const webhookId = randomUUID();
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let dispatchWebhookEvent: typeof import("./webhooks").dispatchWebhookEvent;

  beforeAll(async () => {
    const parsedUrl = new URL(testUrl!);
    if (PRODUCTION_PROJECT_HOSTS.has(parsedUrl.hostname)) {
      throw new Error(
        "Refusing to run classification webhook tests on production"
      );
    }
    if (parsedUrl.hostname !== "hqvswyfyampyusjxpodt.supabase.co") {
      throw new Error(
        "Classification webhook test URL is not the approved branch"
      );
    }

    process.env.NEXT_PUBLIC_SUPABASE_URL = testUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = testKey;
    if (!branchClient) throw new Error("Supabase branch client is unavailable");

    const { error: companyError } = await branchClient
      .from("companies")
      .insert({
        id: companyId,
        name: "Classification webhook integration",
        slug: `classification-webhook-${companyId}`,
      });
    if (companyError) throw companyError;

    const { error: workspaceError } = await branchClient
      .from("workspaces")
      .insert({
        id: workspaceId,
        company_id: companyId,
        name: "Classification webhook integration",
      });
    if (workspaceError) throw workspaceError;

    const { error: webhookError } = await branchClient
      .from("webhook_subscriptions")
      .insert({
        id: webhookId,
        workspace_id: workspaceId,
        url: "https://customer.invalid/classification",
        secret: "whsec_branch_test",
        events: ["classification.completed"],
        headers: {},
        is_active: true,
      });
    if (webhookError) throw webhookError;

    jest.resetModules();
    ({ dispatchWebhookEvent } = await import("./webhooks"));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (branchClient) {
      const { error } = await branchClient
        .from("companies")
        .delete()
        .eq("id", companyId);
      if (error) throw error;
    }

    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    }
    if (originalServiceRoleKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    }
  });

  it("resolves a real unique conflict with only one live reservation", async () => {
    const analysisRevisionId = `analysis-${randomUUID()}`;
    let markStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          markStarted();
          releaseResponse = () => resolve(response(200, "accepted"));
        })
    );
    const input = {
      workspaceId,
      eventType: "classification.completed" as const,
      resourceId: analysisRevisionId,
      timestamp: "2026-08-10T06:06:03.645Z",
      data: {
        conversation_id: "507f1f77bcf86cd799439011",
        analysis_revision_id: analysisRevisionId,
        source_revision: 7,
        completed_at: "2026-08-10T06:06:03.645Z",
      },
    };

    const winner = dispatchWebhookEvent(input);
    await started;
    await expect(dispatchWebhookEvent(input)).rejects.toThrow(/reservation/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    releaseResponse();
    await expect(winner).resolves.toBeUndefined();
    fetchSpy.mockRestore();

    const { data, error } = await branchClient!
      .from("webhook_delivery_logs")
      .select("attempt_number, delivered_at, idempotency_key")
      .eq(
        "idempotency_key",
        `${webhookId}:classification.completed:${analysisRevisionId}`
      )
      .single();
    if (error) throw error;
    expect(data).toEqual({
      attempt_number: 1,
      delivered_at: expect.any(String),
      idempotency_key: `${webhookId}:classification.completed:${analysisRevisionId}`,
    });
  });

  it("claims failed rows monotonically through attempt six", async () => {
    const analysisRevisionId = `analysis-${randomUUID()}`;
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(response(503, "temporarily unavailable"));
    const input = {
      workspaceId,
      eventType: "classification.completed" as const,
      resourceId: analysisRevisionId,
      timestamp: "2026-08-10T06:07:03.645Z",
      data: {
        conversation_id: "507f1f77bcf86cd799439012",
        analysis_revision_id: analysisRevisionId,
        source_revision: 8,
        completed_at: "2026-08-10T06:07:03.645Z",
      },
    };

    for (let expectedAttempt = 1; expectedAttempt <= 6; expectedAttempt += 1) {
      await expect(dispatchWebhookEvent(input)).rejects.toThrow(/HTTP 503/);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    fetchSpy.mockRestore();

    const { data, error } = await branchClient!
      .from("webhook_delivery_logs")
      .select("attempt_number, delivered_at, response_status")
      .eq(
        "idempotency_key",
        `${webhookId}:classification.completed:${analysisRevisionId}`
      )
      .single();
    if (error) throw error;
    expect(data).toEqual({
      attempt_number: 6,
      delivered_at: null,
      response_status: 503,
    });
  });
});
