export const LOGIN_HREF = "/login";
export const START_FREE_HREF = "/login?tab=signup";
export const PANEL_ENTRY_HREF = "/panel";

export type LandingHeaderViewer = {
  isAuthenticated: boolean;
  panelHref?: string;
  hasKnownAccount?: boolean;
};

type LandingHeaderCookie = {
  name: string;
  value?: string | null;
};

type LandingHeaderUser = {
  id: string;
};

type LandingPrimaryActionLabel = "openWorkspace" | "signIn" | "startFree";

export function hasSupabaseAuthCookie(
  cookies: readonly LandingHeaderCookie[] | null | undefined
) {
  return Boolean(
    cookies?.some(
      cookie =>
        Boolean(cookie.value) &&
        cookie.name.startsWith("sb-") &&
        cookie.name.includes("-auth-token")
    )
  );
}

export function buildLandingHeaderViewer({
  user,
  hasKnownAccountCookie,
}: {
  user: LandingHeaderUser | null;
  hasKnownAccountCookie: boolean;
}): LandingHeaderViewer {
  if (!user) {
    return {
      isAuthenticated: false,
      hasKnownAccount: hasKnownAccountCookie || undefined,
    };
  }

  return {
    isAuthenticated: true,
    hasKnownAccount: true,
    panelHref: PANEL_ENTRY_HREF,
  };
}

export function getLandingPrimaryAction(viewer?: LandingHeaderViewer): {
  href: string;
  label: LandingPrimaryActionLabel;
} {
  if (viewer?.isAuthenticated) {
    return {
      href: viewer.panelHref || PANEL_ENTRY_HREF,
      label: "openWorkspace",
    };
  }

  if (viewer?.hasKnownAccount) {
    return {
      href: LOGIN_HREF,
      label: "signIn",
    };
  }

  return {
    href: START_FREE_HREF,
    label: "startFree",
  };
}

export async function getLandingHeaderViewer({
  cookies,
  getUser,
}: {
  cookies: readonly LandingHeaderCookie[] | null | undefined;
  getUser: () => Promise<LandingHeaderUser | null>;
}): Promise<LandingHeaderViewer> {
  const hasKnownAccountCookie = hasSupabaseAuthCookie(cookies);

  if (!hasKnownAccountCookie) {
    return buildLandingHeaderViewer({
      user: null,
      hasKnownAccountCookie: false,
    });
  }

  const user = await getUser();

  if (!user) {
    return buildLandingHeaderViewer({
      user: null,
      hasKnownAccountCookie,
    });
  }

  return buildLandingHeaderViewer({
    user,
    hasKnownAccountCookie,
  });
}
