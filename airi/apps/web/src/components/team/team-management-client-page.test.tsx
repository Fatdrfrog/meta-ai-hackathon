/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import messages from "../../../messages/settings/team/en/page.json";
import type { TeamMembers } from "@/types/supabase";
import { TeamManagementClientPage } from "./team-management-client-page";
import { toast } from "sonner";

const mockLimits = jest.fn();
const mockRefresh = jest.fn();
const mockFetch = jest.fn();
jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => mockLimits(),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock("@/components/limits/free-plan-upsell", () => ({
  getFreePlanUpsellLink: () => null,
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const value = key
      .split(".")
      .reduce(
        (current: unknown, part) =>
          (current as Record<string, unknown>)?.[part],
        messages.TeamManagementClientPage
      ) as string;
    return (
      value?.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? "")
      ) ?? key
    );
  },
}));

const member: TeamMembers[number] = {
  id: "membership-1",
  user_id: "user-1",
  email: "name@example.com",
  role: "manager",
  users: null,
};
function view(members: TeamMembers = [], role = "admin") {
  return render(
    <TeamManagementClientPage
      initialMembers={members}
      workspaceId="workspace-1"
      currentUserId="admin-1"
      currentRole={role}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLimits.mockReturnValue({
    data: { seatExhausted: false },
    mutate: jest.fn(),
  });
  global.fetch = mockFetch;
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, delivery: "email" }),
  });
});

it("shows names from object-shaped joined user profiles", () => {
  view([
    {
      ...member,
      users: { id: "user-1", full_name: "Joined Profile", avatar_url: null },
    },
  ] as unknown as TeamMembers);
  expect(screen.getByText("Joined Profile")).toBeInTheDocument();
  expect(screen.getByText(member.email)).toBeInTheDocument();
});

it("keeps invitation controls in the empty state and submits with Enter through a form", async () => {
  view();
  expect(
    screen.getByText("No members yet. Invite a teammate above.")
  ).toBeInTheDocument();
  const email = screen.getByLabelText("Invite teammate");
  fireEvent.change(email, { target: { value: "new@example.com" } });
  fireEvent.submit(email.closest("form")!);
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/team/invite",
      expect.objectContaining({
        body: JSON.stringify({
          email: "new@example.com",
          workspaceId: "workspace-1",
        }),
      })
    )
  );
  await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
});

it("does not offer role or removal controls to managers", () => {
  view([member], "manager");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Actions for name@example.com" })
  ).not.toBeInTheDocument();
});

it.each(["owner", "member", "manager"])(
  "does not offer invitations or pending-invite actions to %s",
  role => {
    view([{ ...member, user_id: null }] as unknown as TeamMembers, role);
    expect(screen.queryByLabelText("Invite teammate")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invite link" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Actions for name@example.com" })
    ).not.toBeInTheDocument();
  }
);

it("offers management of admins and managers while protecting the acting admin", () => {
  view([
    member,
    {
      ...member,
      id: "other-admin-membership",
      role: "admin",
      user_id: "other-admin-1",
      email: "other-admin@example.com",
    },
    {
      ...member,
      id: "admin-membership",
      role: "admin",
      user_id: "admin-1",
      email: "admin@example.com",
    },
  ]);
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Actions for name@example.com" })
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Actions for other-admin@example.com" })
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Actions for admin@example.com" })
  ).not.toBeInTheDocument();
});

it("reports unavailable seats without falsely calling a paid plan free or linking to internal limits", () => {
  mockLimits.mockReturnValue({
    data: { seatExhausted: true, subscriptionType: "pro" },
    mutate: jest.fn(),
  });
  view();
  expect(
    screen.getByText("Your plan has no available seats.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
  expect(screen.queryByText(/free plan/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("distinguishes an ended trial from exhausted seats", () => {
  mockLimits.mockReturnValue({
    data: {
      seatExhausted: false,
      trialExpired: true,
      lockedCapabilities: ["team_invites"],
    },
    mutate: jest.fn(),
  });
  view();
  expect(
    screen.getByText(
      "Your trial has ended. Review your plan to invite teammates."
    )
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Your plan has no available seats.")
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
});

it("keeps the email for retry instead of announcing a malformed invitation response as success", async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
  view();
  const email = screen.getByLabelText("Invite teammate");
  fireEvent.change(email, { target: { value: "new@example.com" } });
  fireEvent.submit(email.closest("form")!);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Failed to send invitation")
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(email).toHaveValue("new@example.com");
});

it("shows the join URL when clipboard access fails and removes the temporary copy field", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ inviteUrl: "https://example.com/join" }),
  });
  document.execCommand = jest.fn(() => false);
  view();
  fireEvent.click(screen.getByRole("button", { name: "Invite link" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Copy and share this join link.")).toHaveValue(
      "https://example.com/join"
    )
  );
  expect(document.querySelector("textarea")).toBeNull();
});
