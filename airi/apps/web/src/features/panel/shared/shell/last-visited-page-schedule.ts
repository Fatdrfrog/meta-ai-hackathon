/**
 * How long a page settles before its visit is recorded. Opening a page fires
 * its own data requests first; the record is not urgent and only the page the
 * user stays on matters.
 */
export const LAST_VISITED_PAGE_RECORD_DELAY_MS = 1_500;

/**
 * Runs `record` once after `delayMs`, or straight away when the page is
 * hidden or unloaded first, so a quick tab close still keeps the visit.
 * Returns a cancel function for a newer navigation.
 */
export function scheduleLastVisitedPageRecord(
  record: () => void,
  delayMs = LAST_VISITED_PAGE_RECORD_DELAY_MS
): () => void {
  let pending = true;
  let timeoutId = 0;

  const cancel = () => {
    pending = false;
    window.clearTimeout(timeoutId);
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", flushWhenHidden);
  };
  function flush() {
    if (!pending) return;
    cancel();
    record();
  }
  function flushWhenHidden() {
    if (document.visibilityState === "hidden") flush();
  }

  timeoutId = window.setTimeout(flush, delayMs);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flushWhenHidden);
  return cancel;
}
