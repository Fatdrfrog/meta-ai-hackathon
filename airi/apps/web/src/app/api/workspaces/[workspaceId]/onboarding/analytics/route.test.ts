const mockGetUser = jest.fn();
const mockGetCompanyIdForUserWorkspace = jest.fn();
const mockTrackOnboardingLifecycleEvent = jest.fn();
const mockFlushServerPostHog = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mockGetUser,
    },
  }),
}));

jest.mock("@/lib/supabase/queries", () => ({
  getCompanyIdForUserWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForUserWorkspace(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackOnboardingLifecycleEvent: (...args: unknown[]) =>
    mockTrackOnboardingLifecycleEvent(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  flushServerPostHog: (...args: unknown[]) => mockFlushServerPostHog(...args),
}));

import { POST } from "./route";
import { NextRequest } from "next/server";

function buildRequest(body: unknown) {
  return new NextRequest(
    "https://www.airi.chat/api/workspaces/workspace-1/onboarding/analytics",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/workspaces/[workspaceId]/onboarding/analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
        },
      },
    });
    mockGetCompanyIdForUserWorkspace.mockResolvedValue("company-1");
    mockFlushServerPostHog.mockResolvedValue(undefined);
  });

  it("captures whitelisted onboarding metadata for a workspace member", async () => {
    const response = await POST(
      buildRequest({
        event: "onboarding_training_ready",
        step_id: "product_context_ready",
        metadata: {
          website_count: 2,
          has_website: true,
          raw_message: "do not forward",
        },
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockGetCompanyIdForUserWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "workspace-1"
    );
    expect(mockTrackOnboardingLifecycleEvent).toHaveBeenCalledWith(
      "company-1",
      "workspace-1",
      "onboarding_training_ready",
      "product_context_ready",
      {
        website_count: 2,
        has_website: true,
      }
    );
    expect(mockFlushServerPostHog).toHaveBeenCalledTimes(1);
  });

  it("accepts the integrations handoff and preserves only its safe state", async () => {
    const response = await POST(
      buildRequest({
        event: "onboarding_step_completed",
        step_id: "integrations_handoff",
        metadata: {
          training_started: true,
          training_ready: false,
          training_background: true,
          internal_phase: "background",
        },
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(202);
    expect(mockTrackOnboardingLifecycleEvent).toHaveBeenCalledWith(
      "company-1",
      "workspace-1",
      "onboarding_step_completed",
      "integrations_handoff",
      {
        training_started: true,
        training_ready: false,
        training_background: true,
      }
    );
  });

  it("rejects unauthenticated onboarding analytics", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await POST(
      buildRequest({
        event: "onboarding_training_started",
        step_id: "product_context_training",
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(401);
    expect(mockTrackOnboardingLifecycleEvent).not.toHaveBeenCalled();
  });

  it("rejects users without access to the workspace", async () => {
    mockGetCompanyIdForUserWorkspace.mockResolvedValue(null);

    const response = await POST(
      buildRequest({
        event: "onboarding_training_started",
        step_id: "product_context_training",
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(403);
    expect(mockTrackOnboardingLifecycleEvent).not.toHaveBeenCalled();
  });
});
