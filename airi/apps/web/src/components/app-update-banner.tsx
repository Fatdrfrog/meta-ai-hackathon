"use client";

import { cn } from "@/lib/utils";
import {
  APP_REFRESH_QUERY_PARAM,
  reloadToLatestAppVersion,
} from "@/lib/app-version-reload";
import { Button } from "@/components/ui/button";
import { RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

const VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;

type AppVersionResponse = {
  version?: unknown;
};

type AppUpdateBannerProps = {
  currentVersion: string;
};

async function fetchLatestVersion() {
  const response = await fetch("/api/app-version", {
    cache: "no-store",
    headers: {
      "cache-control": "no-cache",
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as AppVersionResponse;

  return typeof payload.version === "string" ? payload.version : null;
}

export function AppUpdateBanner({ currentVersion }: AppUpdateBannerProps) {
  const t = useTranslations("AppUpdateBanner");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);

    if (!url.searchParams.has(APP_REFRESH_QUERY_PARAM)) {
      return;
    }

    url.searchParams.delete(APP_REFRESH_QUERY_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  useEffect(() => {
    let cancelled = false;

    const applyVersion = (nextVersion: string | null) => {
      if (cancelled || !nextVersion) {
        return;
      }

      if (nextVersion === currentVersion) {
        setAvailableVersion(null);
        return;
      }

      if (nextVersion === dismissedVersion) {
        return;
      }

      setAvailableVersion(nextVersion);
    };

    const checkForUpdate = async () => {
      try {
        applyVersion(await fetchLatestVersion());
      } catch {
        // Network hiccups should not interrupt the current session.
      }
    };

    void checkForUpdate();

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void checkForUpdate();
      }
    }, VERSION_POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkForUpdate();
      }
    };

    const handlePageShow = () => {
      void checkForUpdate();
    };

    window.addEventListener("focus", handleVisibilityChange);
    window.addEventListener("online", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityChange);
      window.removeEventListener("online", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentVersion, dismissedVersion]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await reloadToLatestAppVersion();
  };

  if (!availableVersion) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed bottom-0 left-3 z-[60] sm:left-4"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
      }}
    >
      <div
        aria-live="polite"
        className="pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-4 duration-300"
      >
        <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-full border border-primary/15 bg-background/95 p-1 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.55)] backdrop-blur-md supports-[backdrop-filter]:bg-background/80 sm:max-w-none">
          <div className="flex min-w-0 items-center gap-2 rounded-full pl-1.5 pr-1">
            <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </div>

            <p className="max-w-40 truncate text-sm font-medium text-foreground sm:max-w-none">
              {t("updateReady")}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void handleRefresh();
              }}
              disabled={isRefreshing}
              className="h-8 rounded-full border-primary/20 bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-none hover:bg-primary/90 hover:text-primary-foreground dark:bg-primary dark:text-primary-foreground"
            >
              {isRefreshing ? t("refreshing") : t("refresh")}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                setDismissedVersion(availableVersion);
                setAvailableVersion(null);
              }}
              disabled={isRefreshing}
              className="size-8 rounded-full text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              aria-label={t("dismiss")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
