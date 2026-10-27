const mockCapture = jest.fn();
const mockIdentify = jest.fn();

jest.mock("./posthog/server", () => ({
  getPostHogClient: () => ({ capture: mockCapture, identify: mockIdentify }),
}));
jest.mock("./posthog/client", () => ({
  loadPostHogClient: jest.fn(),
}));

import {
  trackCompanyEvent,
  trackOnboardingLifecycleEvent,
  trackUserRegistration,
  trackUserSignIn,
  trackWorkspaceCreated,
} from "./analytics";

describe("server analytics consent gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("identifies and captures after an explicit grant", () => {
    trackUserRegistration(
      "user-1",
      "company-1",
      "workspace-1",
      "admin",
      "self_signup",
      "owner@example.com",
      "Owner",
      { consent: "granted" }
    );

    expect(mockIdentify).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: "user-1" })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user-1",
        event: "sign up",
        properties: expect.not.objectContaining({
          $process_person_profile: false,
        }),
      })
    );
  });

  it("counts an undecided visitor without identifying them", () => {
    trackUserSignIn(
      "user-1",
      "company-1",
      "workspace-1",
      "email_password",
      "owner@example.com",
      { consent: "pending" }
    );

    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sign in",
        properties: expect.objectContaining({
          $process_person_profile: false,
        }),
      })
    );
  });

  it.each(["denied", "unknown"] as const)(
    "sends nothing when consent is %s",
    consent => {
      trackWorkspaceCreated("company-1", "workspace-1", "Shop", "user-1", {
        consent,
      });
      trackUserRegistration(
        "user-1",
        "company-1",
        "workspace-1",
        "manager",
        "invite",
        undefined,
        undefined,
        { consent }
      );
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    }
  );

  it("keeps company-keyed events out of person profiles", () => {
    trackCompanyEvent("source_connected", {}, "company-1", "workspace-1");
    trackCompanyEvent(
      "team_invite_link_joined",
      { user_id: "user-1" },
      "company-1"
    );

    expect(mockCapture.mock.calls[0][0]).toMatchObject({
      distinctId: "company-1",
      properties: { $process_person_profile: false },
    });
    expect(mockCapture.mock.calls[1][0].properties).not.toHaveProperty(
      "$process_person_profile"
    );
  });

  it("keeps the wizard's own source as signup_source", () => {
    trackOnboardingLifecycleEvent(
      "company-1",
      "workspace-1",
      "onboarding_step_completed",
      "workspace_created",
      { source: "self_signup", has_website: true }
    );

    expect(mockCapture.mock.calls[0][0].properties).toMatchObject({
      step_id: "workspace_created",
      source: "setup_wizard",
      signup_source: "self_signup",
      has_website: true,
    });
  });
});
