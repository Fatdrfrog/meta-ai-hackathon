import { panelWorkspaceAiriHref, panelWorkspaceHref } from "./hrefs";
import { normalizeWhatsAppQrEntryPointUuid } from "@/lib/whatsapp/qr-entry-points/normalization";

export const LAST_VISITED_PAGE_MAX_PATH_LENGTH = 2048;

const allowedOrigins = new Set(["https://airi.chat", "https://www.airi.chat"]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const singleSegmentRoutes = new Set([
  "analytics",
  "airi",
  "assets",
  "bulk-campaigns",
  "contacts",
  "customers",
  "leads",
  "dashboard",
  "email",
  "help",
  "onboarding",
  "performance",
  "requests",
  "scenarios",
  "taxonomies",
  "widget-analytics",
  "widget-branding",
]);

const exactNestedRoutes = new Set([
  "analytics/bulk",
  "analytics/llm",
  "analytics/outcomes",
  "help/telegram",
  "help/telegram-business",
  "help/whatsapp-business",
  "kb",
  "kb/settings",
  "messengers/catalog",
  "messengers/catalogue",
  "messengers/upgrade-messenger",
  "messengers/whatsapp-flows",
  "messengers/whatsapp-subscribers",
  "messengers/whatsapp-templates",
  "messengers/whatsapp-welcome-sequences",
  "messengers/whatsapp-qr",
  "settings",
  "settings/ai-agent",
  "settings/ai-context",
  "settings/ai-context/sources",
  "settings/airi-language",
  "settings/billing",
  // Behind a workspace flag; with it off the page redirects to Settings.
  "settings/business-locations",
  "settings/integrations",
  "settings/integrations/whatsapp/select",
  "settings/ltv-config",
  "settings/profile",
  "settings/taxonomy",
  "settings/team",
  "settings/workspaces",
]);

type LastVisitedPageOk = {
  ok: true;
  path: string;
  workspaceId: string;
};

type LastVisitedPageRejected = {
  ok: false;
  reason:
    | "invalid_url"
    | "invalid_origin"
    | "invalid_path"
    | "invalid_workspace"
    | "path_too_long"
    | "unknown_route";
};

export type LastVisitedPageValidation =
  | LastVisitedPageOk
  | LastVisitedPageRejected;

function reject(
  reason: LastVisitedPageRejected["reason"]
): LastVisitedPageRejected {
  return { ok: false, reason };
}

export function isAllowedLastVisitedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function isSafeDynamicSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(".") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function repairEncodedQueryInPath(url: URL): URL {
  if (url.search || !/%3f/i.test(url.pathname)) {
    return url;
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return url;
  }

  const queryStart = decodedPathname.indexOf("?");
  if (queryStart <= 0) {
    return url;
  }

  const pathname = decodedPathname.slice(0, queryStart);
  if (!pathname.endsWith("/requests")) {
    return url;
  }

  const repaired = new URL(url.toString());
  repaired.pathname = pathname;
  repaired.search = decodedPathname.slice(queryStart);
  return repaired;
}

function normalizeSearchParams(
  routePath: string,
  searchParams: URLSearchParams
): string {
  if (routePath !== "requests") {
    return "";
  }

  const normalized = new URLSearchParams();
  for (const key of ["conversation", "message"]) {
    const value = searchParams.get(key)?.trim();
    if (value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) {
      normalized.set(key, value);
    }
  }

  const query = normalized.toString();
  return query ? `?${query}` : "";
}

function normalizePanelRouteSegments(
  workspaceId: string,
  routeSegments: string[],
  searchParams: URLSearchParams
): LastVisitedPageValidation {
  if (routeSegments.length === 0) {
    return {
      ok: true,
      workspaceId,
      path: panelWorkspaceAiriHref(workspaceId),
    };
  }

  if (routeSegments.some(segment => !isSafeDynamicSegment(segment))) {
    return reject("invalid_path");
  }

  const routePath = routeSegments.join("/");
  if (singleSegmentRoutes.has(routePath) || exactNestedRoutes.has(routePath)) {
    const query = normalizeSearchParams(routePath, searchParams);
    return {
      ok: true,
      workspaceId,
      path: `${panelWorkspaceHref(workspaceId, routePath)}${query}`,
    };
  }

  if (
    routeSegments.length === 3 &&
    routeSegments[0] === "messengers" &&
    routeSegments[1] === "whatsapp-qr"
  ) {
    const entryPointId = normalizeWhatsAppQrEntryPointUuid(routeSegments[2]);
    if (!entryPointId) return reject("unknown_route");
    return {
      ok: true,
      workspaceId,
      path: panelWorkspaceHref(
        workspaceId,
        `messengers/whatsapp-qr/${entryPointId}`
      ),
    };
  }

  if (
    routeSegments.length === 2 &&
    routeSegments[0] === "kb" &&
    isSafeDynamicSegment(routeSegments[1])
  ) {
    return {
      ok: true,
      workspaceId,
      path: panelWorkspaceHref(workspaceId, `kb/${routeSegments[1]}`),
    };
  }

  return reject("unknown_route");
}

function normalizePanelUrl(url: URL): LastVisitedPageValidation {
  if (url.pathname.length > LAST_VISITED_PAGE_MAX_PATH_LENGTH) {
    return reject("path_too_long");
  }

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/") ||
    /\.[a-z0-9]{1,12}$/i.test(url.pathname)
  ) {
    return reject("invalid_path");
  }

  const decodedSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeSegment);

  if (decodedSegments.some(segment => segment === null)) {
    return reject("invalid_path");
  }

  const segments = decodedSegments as string[];
  if (segments[0] !== "panel" || segments[1] !== "w") {
    return reject("invalid_path");
  }

  const workspaceId = segments[2];
  if (!workspaceId || !isUuid(workspaceId)) {
    return reject("invalid_workspace");
  }

  const routeSegments = segments.slice(3);
  const result = normalizePanelRouteSegments(
    workspaceId,
    routeSegments,
    url.searchParams
  );

  if (result.ok && result.path.length > LAST_VISITED_PAGE_MAX_PATH_LENGTH) {
    return reject("path_too_long");
  }

  return result;
}

export function normalizeLastVisitedHref(
  href: string
): LastVisitedPageValidation {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return reject("invalid_url");
  }

  if (!isAllowedLastVisitedOrigin(url.origin)) {
    return reject("invalid_origin");
  }

  return normalizePanelUrl(url);
}

export function normalizeStoredLastVisitedPath(
  path: string
): LastVisitedPageValidation {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return reject("invalid_path");
  }

  let url: URL;
  try {
    url = new URL(path, "https://airi.chat");
  } catch {
    return reject("invalid_url");
  }

  return normalizePanelUrl(repairEncodedQueryInPath(url));
}

export function getWorkspaceIdFromPanelPath(path: string): string | null {
  const result = normalizeStoredLastVisitedPath(path);
  return result.ok ? result.workspaceId : null;
}

/**
 * Build a cross-workspace navigation target that only preserves routes which
 * exist for every workspace. Dynamic ids (kb article, conversation query) stay
 * behind so switching companies/workspaces cannot land on notFound().
 */
export function buildWorkspaceSwitchPath(
  pathname: string | null | undefined,
  targetWorkspaceId: string
): string {
  if (!pathname?.startsWith("/panel/w/")) {
    return panelWorkspaceAiriHref(targetWorkspaceId);
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "panel" || segments[1] !== "w" || !segments[2]) {
    return panelWorkspaceAiriHref(targetWorkspaceId);
  }

  const routeSegments = segments.slice(3);
  if (routeSegments.length === 0) {
    return panelWorkspaceAiriHref(targetWorkspaceId);
  }

  if (routeSegments.some(segment => !isSafeDynamicSegment(segment))) {
    return panelWorkspaceAiriHref(targetWorkspaceId);
  }

  const routePath = routeSegments.join("/");
  if (singleSegmentRoutes.has(routePath) || exactNestedRoutes.has(routePath)) {
    return panelWorkspaceHref(targetWorkspaceId, routePath);
  }

  if (routeSegments[0] === "kb") {
    return panelWorkspaceHref(targetWorkspaceId, "kb");
  }

  if (
    routeSegments.length === 3 &&
    routeSegments[0] === "messengers" &&
    routeSegments[1] === "whatsapp-qr" &&
    normalizeWhatsAppQrEntryPointUuid(routeSegments[2])
  ) {
    return panelWorkspaceHref(targetWorkspaceId, "messengers/whatsapp-qr");
  }

  return panelWorkspaceAiriHref(targetWorkspaceId);
}
