"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { scheduleLastVisitedPageRecord } from "./last-visited-page-schedule";

export function LastVisitedPageRecorder() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastRecordedRouteRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname?.startsWith("/panel/w/")) {
      return;
    }

    const query = searchParams.toString();
    const routeKey = query ? `${pathname}?${query}` : pathname;
    if (lastRecordedRouteRef.current === routeKey) {
      return;
    }

    // Deferred so it does not compete with the page's first requests; a
    // newer navigation cancels it before it is sent.
    return scheduleLastVisitedPageRecord(() => {
      lastRecordedRouteRef.current = routeKey;
      void fetch("/api/users/last-visited-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Prefer path over full href so localhost/dev origins still persist.
        body: JSON.stringify({ path: routeKey }),
        keepalive: true,
      }).catch(() => undefined);
    });
  }, [pathname, searchParams]);

  return null;
}
