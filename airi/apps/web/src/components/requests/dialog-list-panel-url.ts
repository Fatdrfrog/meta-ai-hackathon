export function buildConversationSelectionUrl({
  currentSearchParams,
  conversationId,
  pathname,
  messageSearchQuery,
}: {
  currentSearchParams: string;
  conversationId: string;
  pathname: string;
  messageSearchQuery?: string | null;
}): string {
  const params = new URLSearchParams(currentSearchParams);
  params.set("conversation", conversationId);

  const normalizedMessageSearchQuery = messageSearchQuery?.trim();
  if (normalizedMessageSearchQuery) {
    params.set("searchType", "message_within_chat");
    params.set("searchQuery", normalizedMessageSearchQuery);
  } else {
    params.delete("searchType");
    params.delete("searchQuery");
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Updates the address bar without a Next router navigation. Keeps the current
 * history state when the browser accepts it and retries with none otherwise.
 */
export function updateUrlWithoutNavigation(nextUrl: string, push = false) {
  const write = (state: unknown) =>
    push
      ? window.history.pushState(state, "", nextUrl)
      : window.history.replaceState(state, "", nextUrl);
  try {
    write(window.history.state ?? null);
  } catch {
    write(null);
  }
}
