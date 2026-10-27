// Browsers word a fetch that never completes differently: Chrome says "Failed
// to fetch" when no response arrived and "network error" when the response
// body was cut off; Safari says "Load failed" or "The network connection was
// lost."; Firefox says "NetworkError when attempting to fetch resource."
const FETCH_NETWORK_ERROR_MESSAGE =
  /^(?:failed to fetch|network ?error\b|load failed|the network connection was lost)/i;

/** True for the TypeError a browser throws when a request fails on the network. */
export function isFetchNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "TypeError" &&
    FETCH_NETWORK_ERROR_MESSAGE.test(error.message)
  );
}
