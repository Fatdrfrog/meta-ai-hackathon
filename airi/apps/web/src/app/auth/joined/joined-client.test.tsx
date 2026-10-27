/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JoinedClient } from "./joined-client";

const replaceMock = jest.fn();
const getUserMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
    },
  }),
}));

describe("JoinedClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1", email: "client@example.com" } },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, workspaceId: "workspace-1" }),
    }) as never;
  });

  it("shows one explicit accept action with invite context for signed-in users", async () => {
    render(
      <JoinedClient
        token="invite-token"
        inviteContext={{
          status: "valid",
          workspaceId: "workspace-1",
          companyName: "Boutique",
          workspaceName: "Boutique Support",
          expiresAtIso: "2026-06-01T00:00:00.000Z",
        }}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "Join Boutique" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You are signed in. Accept the invite to finish joining this workspace."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Accept invite" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("accepts the invite and skips company registration", async () => {
    render(
      <JoinedClient
        token="invite-token"
        inviteContext={{
          status: "valid",
          workspaceId: "workspace-1",
          companyName: "Boutique",
          expiresAtIso: "2026-06-01T00:00:00.000Z",
        }}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept invite" })
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/team/invite-link/accept",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ token: "invite-token" }),
        })
      );
      expect(replaceMock).toHaveBeenCalledWith("/panel/w/workspace-1/airi");
    });
  });
});
