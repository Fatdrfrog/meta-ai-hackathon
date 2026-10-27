"use client";

import { ANALYTICS_SURFACE_CLASS } from "@/components/analytics/analytics-surface";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface AnalyticsLayoutProps {
  workspaceId: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

function isActivePath(pathname: string, href: string, exact = false): boolean {
  return pathname === href || (!exact && pathname.startsWith(`${href}/`));
}

export function AnalyticsLayout({
  workspaceId,
  children,
  className,
  contentClassName,
}: AnalyticsLayoutProps) {
  const pathname = usePathname();
  const t = useTranslations("DashboardClientPage.board");
  const items = [
    { path: "analytics", label: "dashboards", exact: true },
    { path: "analytics/outcomes", label: "outcomes" },
    { path: "dashboard", label: "conversations" },
    { path: "analytics/bulk", label: "campaigns" },
    { path: "analytics/llm", label: "ai" },
    { path: "performance", label: "performance" },
    { path: "widget-analytics", label: "widget" },
  ] as const;

  return (
    <div
      className={cn(
        "analytics-brand-theme isolate flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        className
      )}
    >
      <nav
        aria-label={t("title")}
        className="relative z-20 flex shrink-0 gap-5 overflow-x-auto border-b bg-background px-4 sm:gap-6 sm:px-6 lg:px-8"
      >
        {items.map(item => {
          const href = `/panel/w/${workspaceId}/${item.path}`;
          const active =
            isActivePath(pathname, href, "exact" in item && item.exact) ||
            (item.label === "campaigns" &&
              pathname === `/panel/w/${workspaceId}/bulk-campaigns`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              prefetch={false}
              className={cn(
                "flex min-h-12 shrink-0 items-center border-b-2 px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              {t(`nav.${item.label}`)}
            </Link>
          );
        })}
      </nav>
      <div
        data-analytics-content
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-muted/15 px-4 py-5 sm:px-6 sm:py-6 lg:px-8",
          ANALYTICS_SURFACE_CLASS,
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
