import { canManageEmailProvider } from "./provider-auth";

describe("email provider administration", () => {
  it("allows workspace admins", () => {
    expect(canManageEmailProvider("admin")).toBe(true);
  });

  it.each(["manager", "owner", "member", null])("rejects %s", role => {
    expect(canManageEmailProvider(role)).toBe(false);
  });
});
