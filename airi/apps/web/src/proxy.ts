import { getPanelEntryRedirectPath } from "@/features/panel/shared/routing";
import { pickLocaleFromAcceptLanguage } from "@/i18n/accept-language";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import {
  buildSupabaseAuthErrorRedirectPath,
  hasSupabaseAuthErrorSearchParams,
} from "@/lib/auth/supabase-auth-error-params";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import { AIRI_PRODUCT_KB_COMPANY_SLUG } from "@/lib/airi-product-context";
import { resolveKbCustomDomainCompanySlug } from "@/lib/kb/custom-domain";
import { hasSupabaseAuthCookie } from "@/lib/landing/landing-header-viewer";
import { PRIVATE_ROBOTS_DISALLOW_PATHS } from "@/lib/public-seo";
import { updateSessionWithUser } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Locale-prefixed URLs redirect to their unprefixed path. Uzbek is no longer
// an interface locale, but its old links keep redirecting.
const localePrefixes = ["en", "ru", "kz", "uz"] as const;

const credentialProbePaths = new Set([
  "/api/config",
  "/api/env",
  "/appsettings.json",
  "/config.json",
  "/firebase-adminsdk.json",
  "/firebase.json",
  "/gcp-credentials.json",
  "/key.json",
  "/keyfile.json",
  "/secrets.json",
  "/service-account.json",
  "/account.json",
]);

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isCredentialProbePath(pathname: string): boolean {
  const normalized = decodePathname(pathname).toLowerCase();
  return (
    credentialProbePaths.has(normalized) ||
    normalized === "/actuator/env" ||
    normalized.startsWith("/.env")
  );
}

function normalizePathname(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const firstSegment = segments[0];

  if (
    firstSegment &&
    localePrefixes.includes(firstSegment as (typeof localePrefixes)[number])
  ) {
    const nextPath = segments.slice(1).join("/");
    return nextPath ? `/${nextPath}` : "/";
  }

  return pathname;
}

function isPanelPath(pathname: string): boolean {
  return pathname === "/panel" || pathname.startsWith("/panel/");
}

export function applyInternalRedirectPath(url: URL, redirectPath: string): URL {
  const target = new URL(redirectPath, "https://airi.chat");
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = "";
  return url;
}

export function getLoginRedirectPath(pathname: string, search = ""): string {
  const nextPath = getSafeAuthReturnPath(`${pathname}${search}`);
  if (!nextPath) {
    return "/login";
  }

  return `/login?next=${encodeURIComponent(nextPath)}`;
}

export function getCanonicalPanelPathWithDecodedQuery(
  pathname: string
): { pathname: string; search: string } | null {
  if (!/%3f/i.test(pathname)) {
    return null;
  }

  const decodedPathname = decodePathname(pathname);
  const queryStart = decodedPathname.indexOf("?");
  if (queryStart <= 0) {
    return null;
  }

  const canonicalPathname = decodedPathname.slice(0, queryStart);
  if (!isPanelPath(canonicalPathname)) {
    return null;
  }
  if (!canonicalPathname.endsWith("/requests")) {
    return null;
  }

  return {
    pathname: canonicalPathname,
    search: decodedPathname.slice(queryStart),
  };
}

// A customer's public knowledge base on an airi.chat URL (/<slug>/kb[/...]),
// as opposed to airi.chat's own help center.
export function isCustomerKnowledgeBasePath(pathname: string): boolean {
  const match = /^\/([^/]+)\/kb(?:\/|$)/.exec(pathname);
  return Boolean(match && match[1] !== AIRI_PRODUCT_KB_COMPANY_SLUG);
}

const LOCALE_COOKIE = "NEXT_LOCALE";

// robots.txt keeps these app pages out of search, so they can follow the
// browser's language without changing what search engines index.
const BROWSER_LOCALE_PATHS = PRIVATE_ROBOTS_DISALLOW_PATHS.filter(
  path => !path.startsWith("/api")
).map(path => path.replace(/\/$/, ""));

function isBrowserLocalePath(pathname: string): boolean {
  return BROWSER_LOCALE_PATHS.some(
    path => pathname === path || pathname.startsWith(`${path}/`)
  );
}

// Until a visitor picks a language, app pages follow their browser's (ru/kz),
// so they don't reach for a page translator, which breaks React. A valid
// NEXT_LOCALE cookie always wins.
export function getBrowserLocaleToSeed(
  req: NextRequest,
  pathname: string
): Locale | null {
  const current = req.cookies.get(LOCALE_COOKIE)?.value;
  if ((current && isLocale(current)) || !isBrowserLocalePath(pathname)) {
    return null;
  }

  const locale = pickLocaleFromAcceptLanguage(
    req.headers.get("accept-language")
  );
  return locale && locale !== DEFAULT_LOCALE ? locale : null;
}

// Client-side navigation keeps the root layout, whose messages and <html lang>
// would stay in the old locale while the page switches. Next's router reloads
// the whole page when a navigation gets a non-RSC response, and that page load
// seeds the locale everywhere at once. Next strips its own router headers
// (rsc, ...) before the proxy runs, so the browser's Fetch Metadata tells a
// router fetch or prefetch from a page load: only page loads use "navigate".
function isInPageFetch(req: NextRequest): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  return req.method === "GET" && mode !== null && mode !== "navigate";
}

export default async function middleware(req: NextRequest) {
  const seededLocale = getBrowserLocaleToSeed(
    req,
    normalizePathname(req.nextUrl.pathname)
  );
  if (!seededLocale) {
    return routeRequest(req, false);
  }

  if (isInPageFetch(req)) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The request cookie reaches this render; the response cookie keeps it for
  // the session. Session-scoped, so it never outlives an explicit choice.
  req.cookies.set(LOCALE_COOKIE, seededLocale);
  const response = await routeRequest(req, true);
  response.cookies.set(LOCALE_COOKIE, seededLocale, {
    path: "/",
    sameSite: "lax",
  });
  return response;
}

async function routeRequest(req: NextRequest, localeSeeded: boolean) {
  if (isCredentialProbePath(req.nextUrl.pathname)) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  const host = req.headers.get("host") || "";
  const isCustomDomain =
    !host.includes("airi.chat") &&
    !host.includes("localhost") &&
    !host.includes("127.0.0.1");

  if (isCustomDomain && req.nextUrl.pathname.startsWith("/kb/")) {
    try {
      const companySlug = await resolveKbCustomDomainCompanySlug(host);
      if (companySlug) {
        const url = req.nextUrl.clone();
        const pathParts = url.pathname.split("/").filter(Boolean);
        if (pathParts[0] === "kb") {
          url.pathname = `/${companySlug}/${pathParts.join("/")}`;
          return NextResponse.rewrite(url);
        }
      }
    } catch (error) {
      console.error("[Middleware] Custom domain error:", error);
    }
  }

  const path = req.nextUrl.pathname;
  const normalizedPath = normalizePathname(path);

  // Canonicalize locale-prefixed URLs to non-prefixed URLs.
  // Example: /ru/login -> /login
  if (normalizedPath !== path) {
    const url = req.nextUrl.clone();
    url.pathname = normalizedPath;
    return NextResponse.redirect(url, 308);
  }

  const isRoot = normalizedPath === "/";
  const isPanel = isPanelPath(normalizedPath);
  const isTeamApiRoute = normalizedPath.startsWith("/api/team/");

  // Handle auth callback redirect before anything else (no session needed)
  if (isRoot && req.nextUrl.searchParams.has("code")) {
    const code = req.nextUrl.searchParams.get("code");
    const url = req.nextUrl.clone();
    url.pathname = "/auth/callback";
    url.search = `?code=${encodeURIComponent(code!)}`;
    return NextResponse.redirect(url);
  }

  // Supabase OAuth/PKCE failures land on Site URL with error_* params.
  // Redirect away so the polluted URL never sticks in browser history.
  if (isRoot && hasSupabaseAuthErrorSearchParams(req.nextUrl.searchParams)) {
    const redirectPath = buildSupabaseAuthErrorRedirectPath(
      req.nextUrl.searchParams,
      {
        hasAuthCookie: hasSupabaseAuthCookie(req.cookies.getAll()),
      }
    );
    const url = req.nextUrl.clone();
    applyInternalRedirectPath(url, redirectPath);
    return NextResponse.redirect(url);
  }

  // Customers' knowledge bases stay reachable on airi.chat but out of its
  // search results. Their own custom domains are rewritten above and keep
  // whatever indexing the customer wants.
  if (!isCustomDomain && isCustomerKnowledgeBasePath(normalizedPath)) {
    const response = NextResponse.next();
    response.headers.set("X-Robots-Tag", "noindex, follow");
    return response;
  }

  // Public routes: skip updateSession to avoid unnecessary Supabase API calls.
  // Team APIs are an exception: they are excluded from the catch-all matcher's
  // "api" negative lookahead, so we match `/api/team/*` explicitly below and
  // refresh the session here. Otherwise invite/revoke can see an expired access
  // token while the panel page (which always runs updateSession) still looks fine.
  if (!isPanel && !isTeamApiRoute) {
    // Forward the request so a seeded locale cookie reaches this render.
    return localeSeeded
      ? NextResponse.next({ request: req })
      : NextResponse.next();
  }

  // Verify once and reuse this request's client for panel access checks.
  const session = await updateSessionWithUser(req);
  const { supabase: authClient, user } = session;

  // Return any session redirect before applying panel routing.
  if (
    session.response.status === 302 ||
    session.response.status === 307 ||
    session.response.status === 308
  ) {
    return session.response;
  }

  // Team API only: never apply panel redirects or RLS checks — just forward refreshed cookies
  if (isTeamApiRoute && !isPanel) {
    return session.response;
  }

  const attachSupabaseSession = (response: NextResponse) => {
    session.response.cookies.getAll().forEach(cookie => {
      response.cookies.set(cookie.name, cookie.value, {
        path: cookie.path,
        domain: cookie.domain,
        maxAge: cookie.maxAge,
        expires: cookie.expires,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
      });
    });
    for (const header of ["cache-control", "expires", "pragma"]) {
      const value = session.response.headers.get(header);
      if (value !== null) response.headers.set(header, value);
    }
    return response;
  };

  const canonicalPanelPath =
    isPanel && getCanonicalPanelPathWithDecodedQuery(normalizedPath);
  if (canonicalPanelPath) {
    const url = req.nextUrl.clone();
    applyInternalRedirectPath(
      url,
      `${canonicalPanelPath.pathname}${canonicalPanelPath.search}`
    );
    return attachSupabaseSession(NextResponse.redirect(url, 308));
  }

  const redirectTo = (pathname: string) => {
    const url = req.nextUrl.clone();
    applyInternalRedirectPath(url, pathname);
    return attachSupabaseSession(NextResponse.redirect(url));
  };

  const hasWorkspaceAccess = async (userId: string, workspaceId: string) => {
    const { data: access, error } = await authClient
      .from("company_users")
      .select("user_id")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    return !error && !!access;
  };

  if (isPanel) {
    if (!user) {
      return redirectTo(
        getLoginRedirectPath(normalizedPath, req.nextUrl.search)
      );
    }

    const parts = normalizedPath.split("/").filter(Boolean);

    if (parts.length === 1) {
      try {
        const redirectPath = await getPanelEntryRedirectPath(authClient, user);
        if (!redirectPath) {
          return redirectTo("/onboarding");
        }

        return redirectTo(redirectPath);
      } catch {
        return redirectTo("/onboarding");
      }
    }

    if (parts[1] === "w" && parts[2]) {
      const workspaceId = parts[2];

      try {
        const access = await hasWorkspaceAccess(user.id, workspaceId);
        if (!access) {
          // Authenticated multi-company users may hit a stale workspace URL
          // from history/last-visited. Send them through panel entry instead
          // of login so they land in a workspace they still belong to.
          return redirectTo("/panel");
        }
      } catch {
        return redirectTo("/panel");
      }
    }
  }

  return session.response;
}

export const config = {
  matcher: [
    "/api/config",
    "/api/env",
    "/actuator/env",
    "/.env",
    "/.env.backup",
    "/.env.bak",
    "/.env.development",
    "/.env.local",
    "/.env.production",
    "/account.json",
    "/appsettings.json",
    "/config.json",
    "/firebase-adminsdk.json",
    "/firebase.json",
    "/gcp-credentials.json",
    "/key.json",
    "/keyfile.json",
    "/secrets.json",
    "/service-account.json",
    "/panel/:path*",
    "/(en|ru|kz|uz)/panel/:path*",
    "/api/team/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
