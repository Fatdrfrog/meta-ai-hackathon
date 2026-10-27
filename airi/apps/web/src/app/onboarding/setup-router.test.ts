import { resolveSetupRouterRedirect } from "./setup-router";

describe("resolveSetupRouterRedirect", () => {
  it("sends unauthenticated visitors to login", () => {
    expect(
      resolveSetupRouterRedirect({
        user: null,
        firstWorkspaceId: null,
      })
    ).toBe("/login");
  });

  it("processes pending invites before self-signup setup", () => {
    expect(
      resolveSetupRouterRedirect({
        user: {
          user_metadata: {
            company_id: "company-1",
            workspace_id: "workspace-1",
          },
        },
        firstWorkspaceId: null,
      })
    ).toBe("/auth/confirm/process-invite");
  });

  it("sends self-signup users without complete setup to the setup wizard", () => {
    expect(
      resolveSetupRouterRedirect({
        user: { user_metadata: { name: "OAuth Name" } },
        firstWorkspaceId: null,
      })
    ).toBe("/setup");
  });

  it("sends existing workspace users without full_name to the setup wizard", () => {
    expect(
      resolveSetupRouterRedirect({
        user: { user_metadata: { name: "OAuth Name" } },
        firstWorkspaceId: "workspace-1",
      })
    ).toBe("/setup");
  });

  it("sends setup-complete users to Airi chat without forcing optional integrations", () => {
    expect(
      resolveSetupRouterRedirect({
        user: { user_metadata: { full_name: "Ada Lovelace" } },
        firstWorkspaceId: "workspace-1",
      })
    ).toBe("/panel/w/workspace-1/airi");
  });
});
