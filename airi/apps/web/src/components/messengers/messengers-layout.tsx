"use client";

import { cn } from "@/lib/utils";
import {
  FileText,
  MessageSquareText,
  PackageSearch,
  QrCode,
  Rocket,
  Users,
  Workflow,
} from "lucide-react";
import { Route } from "next";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface MessengersLayoutProps {
  workspaceId: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

type MessengerNavItem = {
  href: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
};

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MessengersLayout({
  workspaceId,
  children,
  className,
  contentClassName,
}: MessengersLayoutProps) {
  const pathname = usePathname();
  const t = useTranslations("MessengersSection");

  const items: MessengerNavItem[] = [
    {
      href: `/panel/w/${workspaceId}/messengers/whatsapp-templates`,
      title: t("templates"),
      icon: FileText,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/whatsapp-flows`,
      title: t("flows"),
      icon: Workflow,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/whatsapp-welcome-sequences`,
      title: t("welcomeSequences"),
      icon: MessageSquareText,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/whatsapp-qr`,
      title: t("qrCodes"),
      icon: QrCode,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/whatsapp-subscribers`,
      title: t("subscribers"),
      icon: Users,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/catalog`,
      title: t("catalog"),
      icon: PackageSearch,
    },
    {
      href: `/panel/w/${workspaceId}/messengers/upgrade-messenger`,
      title: t("officialBadge"),
      icon: Rocket,
    },
  ];

  return (
    <div className={cn("flex h-full min-h-0", className)}>
      <aside className="hidden w-64 shrink-0 border-r bg-muted/20 lg:flex lg:flex-col">
        <div className="border-b px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("title")}
          </p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {items.map(item => {
            const isActive = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href as Route}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{item.title}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b bg-background px-4 py-3 lg:hidden">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("title")}
          </p>
          <nav className="flex gap-2 overflow-x-auto pb-1">
            {items.map(item => {
              const isActive = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
                    isActive
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {item.title}
                </Link>
              );
            })}
          </nav>
        </div>

        <div
          className={cn(
            "flex-1 min-h-0 overflow-auto p-3 sm:p-4 lg:p-6",
            contentClassName
          )}
        >
          {children}
        </div>
      </section>
    </div>
  );
}
