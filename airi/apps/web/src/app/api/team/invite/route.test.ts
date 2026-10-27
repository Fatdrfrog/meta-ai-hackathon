const mockCreateClient = jest.fn();
const mockInviteUserByEmail = jest.fn();
const mockEnsureCompanySeatCapacity = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockFrom = jest.fn();
let mockRole: string | null;

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
    auth: {
      admin: {
        inviteUserByEmail: (...args: unknown[]) =>
          mockInviteUserByEmail(...args),
      },
    },
  },
}));
jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanySeatCapacity: (...args: unknown[]) =>
    mockEnsureCompanySeatCapacity(...args),
  buildCompanySeatLimitExceededResponse: () =>
    Response.json({ error: "seat limit exceeded" }, { status: 402 }),
}));
jest.mock("@/lib/supabase/company-users", () => ({
  ...jest.requireActual("@/lib/supabase/company-users"),
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));
jest.mock("@/lib/analytics", () => ({ trackCompanyEvent: jest.fn() }));

import { verifyTeamInviteToken } from "@/lib/auth/team-invite-link";
import { POST as inviteByEmail } from "./route";
import { POST as inviteByLink } from "../invite-link/route";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const companyId = "11111111-1111-4111-8111-111111111111";
const inviterId = "33333333-3333-4333-8333-333333333333";
let requestCounter = 0;
function request(body: unknown) {
  return new Request("https://www.airi.chat/api/team/invite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `test-request-${++requestCounter}`,
    },
    body: JSON.stringify(body),
  }) as never;
}
function query() {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.maybeSingle.mockImplementation(async () => ({
    data: mockRole ? { workspace_id: workspaceId, role: mockRole } : null,
    error: null,
  }));
  return builder;
}

describe("team invitation issuance", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_INVITE_LINK_SECRET = "test-invite-secret";
    mockRole = "admin";
    mockFrom.mockImplementation(query);
    mockCreateClient.mockResolvedValue({
      from: mockFrom,
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: inviterId, email: "admin@example.com" } },
          error: null,
        })),
      },
    });
    mockInviteUserByEmail.mockResolvedValue({ error: null });
    mockEnsureCompanySeatCapacity.mockResolvedValue({ allowed: true });
    mockGetCompanyIdForWorkspace.mockResolvedValue(companyId);
  });
  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
  });

  it.each(["owner", "member", "manager", null])(
    "rejects email invitations from %s",
    async role => {
      mockRole = role;
      expect(
        (
          await inviteByEmail(
            request({ workspaceId, email: "client@example.com" })
          )
        ).status
      ).toBe(403);
      expect(mockInviteUserByEmail).not.toHaveBeenCalled();
    }
  );
  it.each(["owner", "member", "manager", null])(
    "rejects shareable invite links from %s",
    async role => {
      mockRole = role;
      expect((await inviteByLink(request({ workspaceId }))).status).toBe(403);
    }
  );
  it("requires an explicit workspace for email invitations", async () => {
    expect(
      (await inviteByEmail(request({ email: "client@example.com" }))).status
    ).toBe(400);
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });
  it.each(["admin"])(
    "issues a signed email-bound invitation as %s",
    async role => {
      mockRole = role;
      expect(
        (
          await inviteByEmail(
            request({ workspaceId, email: "Client@Example.com" })
          )
        ).status
      ).toBe(200);
      const [email, options] = mockInviteUserByEmail.mock.calls[0];
      expect(email.toLowerCase()).toBe("client@example.com");
      expect(typeof options.data.team_invite_token).toBe("string");
      expect(
        verifyTeamInviteToken(options.data.team_invite_token)
      ).toMatchObject({
        valid: true,
        payload: {
          companyId,
          workspaceId,
          inviterId,
          email: "client@example.com",
        },
      });
    }
  );
  it("binds the existing-account fallback link to the requested email", async () => {
    mockInviteUserByEmail.mockResolvedValue({
      error: { status: 422, message: "User already registered" },
    });
    const response = await inviteByEmail(
      request({ workspaceId, email: "client@example.com" })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery).toBe("manual_link");
    const token = new URL(body.manualInviteUrl).searchParams.get("token")!;
    expect(verifyTeamInviteToken(token)).toMatchObject({
      valid: true,
      payload: {
        companyId,
        workspaceId,
        inviterId,
        email: "client@example.com",
      },
    });
  });
  it("issues a shareable link without an email restriction for an admin", async () => {
    const response = await inviteByLink(request({ workspaceId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const token = new URL(body.inviteUrl).searchParams.get("token")!;
    expect(verifyTeamInviteToken(token)).toMatchObject({
      valid: true,
      payload: { companyId, workspaceId, inviterId },
    });
    expect(verifyTeamInviteToken(token).payload).not.toHaveProperty("email");
  });
});
