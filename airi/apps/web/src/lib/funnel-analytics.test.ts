const mockCapture = jest.fn();
const mockGetPostHogClient = jest.fn();
const mockReadConsent = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();

jest.mock("@/lib/posthog/server", () => ({
  getPostHogClient: () => mockGetPostHogClient(),
}));
jest.mock("@/lib/tracking-consent-server", () => ({
  readServerTrackingConsent: () => mockReadConsent(),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { admin: true } }));
jest.mock("@icecore/shared/lib/workspace-company", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

import { captureFunnelEvent } from "./funnel-analytics";

describe("captureFunnelEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPostHogClient.mockReturnValue({ capture: mockCapture });
    mockReadConsent.mockResolvedValue("granted");
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
  });

  it("identifies the user after an explicit grant, with the company group", async () => {
    await expect(
      captureFunnelEvent({
        event: "whatsapp_connected",
        userId: "user-1",
        workspaceId: "workspace-1",
        properties: { path: "embedded_signup", flow: undefined },
        insertId: "whatsapp_connected:abc",
      })
    ).resolves.toBe("captured");

    expect(mockGetCompanyIdForWorkspace).toHaveBeenCalledWith(
      { admin: true },
      "workspace-1"
    );
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "whatsapp_connected",
      properties: {
        path: "embedded_signup",
        funnel: true,
        workspace_id: "workspace-1",
        company_id: "company-1",
        $insert_id: "whatsapp_connected:abc",
      },
      groups: { company: "company-1" },
    });
  });

  it("counts an undecided visitor without a person profile", async () => {
    mockReadConsent.mockResolvedValue("pending");
    await captureFunnelEvent({
      event: "account_created",
      userId: "user-1",
      properties: { method: "email" },
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "account_created",
      properties: {
        method: "email",
        funnel: true,
        $process_person_profile: false,
      },
    });
    expect(mockGetCompanyIdForWorkspace).not.toHaveBeenCalled();
  });

  it.each(["denied", "unknown"])(
    "sends nothing when consent is %s",
    async consent => {
      mockReadConsent.mockResolvedValue(consent);
      await expect(
        captureFunnelEvent({ event: "campaign_queued", userId: "user-1" })
      ).resolves.toBe("skipped");
      expect(mockCapture).not.toHaveBeenCalled();
    }
  );

  it("uses an explicit consent without reading the request", async () => {
    await captureFunnelEvent({
      event: "scenario_created",
      userId: "user-1",
      companyId: "company-9",
      workspaceId: "workspace-1",
      consent: "granted",
    });
    expect(mockReadConsent).not.toHaveBeenCalled();
    expect(mockGetCompanyIdForWorkspace).not.toHaveBeenCalled();
    expect(mockCapture.mock.calls[0][0].groups).toEqual({
      company: "company-9",
    });
  });

  it("falls back to the company id as a personless distinct id", async () => {
    await captureFunnelEvent({
      event: "scenario_activated",
      workspaceId: "workspace-1",
    });
    expect(mockCapture.mock.calls[0][0]).toMatchObject({
      distinctId: "company-1",
      properties: { $process_person_profile: false },
    });
  });

  it("skips when PostHog is not configured and never throws", async () => {
    mockGetPostHogClient.mockReturnValue(null);
    await expect(
      captureFunnelEvent({ event: "template_submitted", userId: "user-1" })
    ).resolves.toBe("skipped");

    mockGetPostHogClient.mockReturnValue({
      capture: () => {
        throw new Error("network");
      },
    });
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      captureFunnelEvent({ event: "template_submitted", userId: "user-1" })
    ).resolves.toBe("skipped");
    consoleError.mockRestore();
  });
});
