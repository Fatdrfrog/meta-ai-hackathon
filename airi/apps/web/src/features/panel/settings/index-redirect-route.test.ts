import SettingsPage from "./index-redirect-route";

const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

describe("SettingsPage", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("uses integrations as the default settings page", async () => {
    await expect(
      SettingsPage({
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      })
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith(
      "/panel/w/workspace-1/settings/integrations"
    );
  });
});
