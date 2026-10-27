/** Marks a reload the app triggered; the update banner strips it afterwards. */
export const APP_REFRESH_QUERY_PARAM = "__airi_refresh";

async function clearRuntimeCaches() {
  if (!("caches" in window)) {
    return;
  }

  const cacheKeys = await window.caches.keys();

  await Promise.allSettled(
    cacheKeys.map(cacheKey => window.caches.delete(cacheKey))
  );
}

/** Loads the newest deployment, optionally at a different URL on this site. */
export async function reloadToLatestAppVersion(target?: URL) {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();

      await Promise.all(
        registrations.map(async registration => {
          try {
            await registration.update();
          } catch {
            // If there is no service worker, a normal full reload is enough.
          }
        })
      );
    }

    await clearRuntimeCaches();
  } finally {
    const url = target ?? new URL(window.location.href);
    url.searchParams.set(APP_REFRESH_QUERY_PARAM, Date.now().toString());
    window.location.replace(url.toString());
  }
}
