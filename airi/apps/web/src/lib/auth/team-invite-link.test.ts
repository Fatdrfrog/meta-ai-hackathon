import crypto from "crypto";
import {
  createTeamInviteToken,
  verifyTeamInviteToken,
} from "./team-invite-link";

const input = {
  companyId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  inviterId: "33333333-3333-4333-8333-333333333333",
};
const secret = "test-invite-secret";
function sign(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

describe("team invite tokens", () => {
  const previousSecret = process.env.TEAM_INVITE_LINK_SECRET;
  beforeEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = secret;
    jest.useFakeTimers().setSystemTime(new Date("2026-10-03T00:00:00Z"));
  });
  afterEach(() => {
    process.env.TEAM_INVITE_LINK_SECRET = previousSecret;
    jest.useRealTimers();
  });

  it("signs a normalized recipient email for email invitations", () => {
    const { token } = createTeamInviteToken({
      ...input,
      email: " Client@Example.com ",
    } as Parameters<typeof createTeamInviteToken>[0]);
    expect(verifyTeamInviteToken(token)).toMatchObject({
      valid: true,
      payload: { ...input, email: "client@example.com" },
    });
  });
  it("keeps generic team links shareable", () => {
    const { token } = createTeamInviteToken(input);
    expect(verifyTeamInviteToken(token)).toMatchObject({
      valid: true,
      payload: input,
    });
    expect(verifyTeamInviteToken(token).payload).not.toHaveProperty("email");
  });
  it("rejects extra token segments", () => {
    const { token } = createTeamInviteToken(input);
    expect(verifyTeamInviteToken(`${token}.extra`).valid).toBe(false);
  });
  it("rejects changes to the signed destination", () => {
    const { token } = createTeamInviteToken(input);
    const [encoded, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    payload.workspaceId = "55555555-5555-4555-8555-555555555555";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    expect(verifyTeamInviteToken(forged).valid).toBe(false);
  });
  it.each([
    { workspaceId: "not-a-uuid" },
    { companyId: "not-a-uuid" },
    { inviterId: "not-a-uuid" },
    { iat: 1790985600.5 },
    { iat: 1790989200 },
    { exp: 1790985500 },
    { email: "" },
    { email: "not-an-email" },
  ])("rejects signed malformed claims: %j", override => {
    const token = sign({
      v: 1,
      ...input,
      iat: 1790985600,
      exp: 1790989200,
      ...override,
    });
    expect(verifyTeamInviteToken(token).valid).toBe(false);
  });
  it("rejects expired tokens", () => {
    const token = sign({ v: 1, ...input, iat: 1790899200, exp: 1790985600 });
    expect(verifyTeamInviteToken(token)).toMatchObject({
      valid: false,
      reason: "Invite link has expired",
    });
  });
});
