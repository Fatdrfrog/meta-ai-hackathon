import { hasPendingInviteMetadata } from "./invite-metadata";

it("routes a pending signed invite to proof verification without requiring editable destination hints", () => {
  expect(
    hasPendingInviteMetadata({ team_invite_token: "pending-signed-proof" })
  ).toBe(true);
});
it("routes legacy invites to the fail-closed processor for a reissue message", () => {
  expect(
    hasPendingInviteMetadata({
      company_id: "company-1",
      workspace_id: "workspace-1",
    })
  ).toBe(true);
});
it.each([
  undefined,
  null,
  {},
  { team_invite_token: "" },
  { team_invite_token: 1 },
])("does not route ordinary metadata as an invitation: %j", metadata => {
  expect(hasPendingInviteMetadata(metadata)).toBe(false);
});
