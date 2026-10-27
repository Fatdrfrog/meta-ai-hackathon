const STALE_SELECTION_PARAMS = [
  "error",
  "error_details",
  "new",
  "reconnect",
  "requires_reconnect",
  "warning",
  "warning_details",
];

interface BuildIntegrationSelectionUrlInput {
  pathname: string;
  currentSearch: string;
  integrationId: string | null;
}

export function getSelectedIntegrationId(
  searchParams: Pick<URLSearchParams, "get"> | null | undefined
) {
  const explicitIntegrationId = searchParams?.get("integration");
  if (explicitIntegrationId) return explicitIntegrationId;

  const activeType = searchParams?.get("type");
  return activeType && activeType !== "all" ? activeType : null;
}

export function buildIntegrationSelectionUrl({
  pathname,
  currentSearch,
  integrationId,
}: BuildIntegrationSelectionUrlInput) {
  const params = new URLSearchParams(currentSearch);

  STALE_SELECTION_PARAMS.forEach(param => params.delete(param));

  if (integrationId !== "whatsapp") {
    params.delete("whatsapp_mode");
  }

  if (integrationId) {
    params.delete("type");
    params.set("integration", integrationId);
  } else {
    params.delete("integration");
    params.delete("type");
  }

  const search = params.toString();

  return {
    href: search ? `${pathname}?${search}` : pathname,
    search,
  };
}
