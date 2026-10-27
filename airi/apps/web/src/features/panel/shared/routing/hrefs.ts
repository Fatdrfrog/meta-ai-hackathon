export const PANEL_WORKSPACE_DEFAULT_PATH = "airi";

function stringifyQuery(
  query?: URLSearchParams | Record<string, string | undefined> | string
): string {
  if (!query) {
    return "";
  }

  if (typeof query === "string") {
    return query.replace(/^\?/, "");
  }

  if (query instanceof URLSearchParams) {
    return query.toString();
  }

  return new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  ).toString();
}

export function panelWorkspaceHref(
  workspaceId: string,
  path = PANEL_WORKSPACE_DEFAULT_PATH
) {
  return `/panel/w/${encodeURIComponent(workspaceId)}/${path.replace(/^\/+/, "")}`;
}

export function panelWorkspaceAiriHref(
  workspaceId: string,
  query?: URLSearchParams | Record<string, string | undefined> | string
) {
  const href = panelWorkspaceHref(workspaceId, "airi");
  const queryString = stringifyQuery(query);
  return queryString ? `${href}?${queryString}` : href;
}

export function panelSettingsHref(workspaceId: string, path = "integrations") {
  return panelWorkspaceHref(
    workspaceId,
    `settings/${path.replace(/^\/+/, "")}`
  );
}

/**
 * Where a brand-new workspace connects its first channel: Settings ›
 * Integrations with WhatsApp preselected. `new=true` keeps the onboarding
 * toast; `integration` (not `type`) selects without filtering the list.
 */
export function panelConnectWhatsAppOnboardingHref(workspaceId: string) {
  return `${panelSettingsHref(workspaceId)}?new=true&integration=whatsapp`;
}
