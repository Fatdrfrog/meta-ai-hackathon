import {
  buildLandingHeaderViewer,
  getLandingHeaderViewer,
  getLandingPrimaryAction,
  hasSupabaseAuthCookie,
} from "./landing-header-viewer";

describe("landing header viewer", () => {
  it("treats Supabase auth cookies as a known account signal", () => {
    expect(
      hasSupabaseAuthCookie([
        { name: "NEXT_LOCALE", value: "en" },
        { name: "sb-project-ref-auth-token.0", value: "token" },
      ])
    ).toBe(true);
  });

  it("marks unauthenticated auth-cookie visitors as known accounts", () => {
    expect(
      buildLandingHeaderViewer({
        user: null,
        hasKnownAccountCookie: true,
      })
    ).toEqual({
      isAuthenticated: false,
      hasKnownAccount: true,
    });
  });

  it("uses panel entry navigation for authenticated visitors", () => {
    expect(
      buildLandingHeaderViewer({
        user: { id: "user_1" },
        hasKnownAccountCookie: true,
      })
    ).toEqual({
      isAuthenticated: true,
      hasKnownAccount: true,
      panelHref: "/panel",
    });
  });

  it("uses sign in as the primary action for known unauthenticated visitors", () => {
    expect(
      getLandingPrimaryAction({
        isAuthenticated: false,
        hasKnownAccount: true,
      })
    ).toEqual({
      href: "/login",
      label: "signIn",
    });
  });

  it("uses workspace entry as the primary action for authenticated visitors", () => {
    expect(
      getLandingPrimaryAction({
        isAuthenticated: true,
        panelHref: "/panel",
      })
    ).toEqual({
      href: "/panel",
      label: "openWorkspace",
    });
  });

  it("uses signup as the primary action for unknown visitors", () => {
    expect(getLandingPrimaryAction()).toEqual({
      href: "/login?tab=signup",
      label: "startFree",
    });
  });

  it("does not resolve Supabase user state when no auth cookie exists", async () => {
    const getUser = jest.fn(async () => ({ id: "user_1" }));

    await expect(
      getLandingHeaderViewer({
        cookies: [],
        getUser,
      })
    ).resolves.toEqual({
      isAuthenticated: false,
      hasKnownAccount: undefined,
    });

    expect(getUser).not.toHaveBeenCalled();
  });
});
