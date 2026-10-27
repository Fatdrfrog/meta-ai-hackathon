import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { SettingsNav } from "@/components/settings/settings-nav";
import {
  getLocaleFromCookie,
  loadSettingsClientMessages,
} from "@/i18n/message-loader";
import { canAccessInternalLimits } from "@/lib/limits/internal-limits-access";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { Settings } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
  title: "Settings",
  description: "Workspace settings, team access, billing, and integrations.",
};

interface SettingsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}

export default async function SettingsLayout({
  children,
  params,
}: SettingsLayoutProps) {
  const [{ workspaceId }, t, locale] = await Promise.all([
    params,
    getTranslations("Settings"),
    getLocaleFromCookie(),
  ]);
  const [messages, canViewLimits, showOffices] = await Promise.all([
    loadSettingsClientMessages(locale),
    canAccessInternalLimits(workspaceId),
    isWorkspaceFeatureEnabled(workspaceId, "scenario_location_routing").catch(
      () => false
    ),
  ]);

  const sidebarNavItems = [
    {
      title: t("navIntegrations"),
      group: t("groupWorkspace"),
      href: `/panel/w/${workspaceId}/settings/integrations`,
    },
    {
      title: t("navApi"),
      group: t("groupWorkspace"),
      href: `/panel/w/${workspaceId}/settings/api`,
    },
    {
      title: t("navAiContext"),
      group: t("groupAiri"),
      href: `/panel/w/${workspaceId}/settings/ai-context`,
    },
    {
      title: t("navAiAgent"),
      group: t("groupAiri"),
      href: `/panel/w/${workspaceId}/settings/ai-agent`,
    },
    {
      title: t("navAiriLanguage"),
      group: t("groupAiri"),
      href: `/panel/w/${workspaceId}/settings/airi-language`,
    },
    {
      title: t("navTaxonomy"),
      group: t("groupReporting"),
      href: `/panel/w/${workspaceId}/settings/taxonomy`,
    },
    {
      title: t("navTeam"),
      group: t("groupWorkspace"),
      href: `/panel/w/${workspaceId}/settings/team`,
    },
    ...(showOffices
      ? [
          {
            title: t("navBusinessLocations"),
            group: t("groupWorkspace"),
            href: `/panel/w/${workspaceId}/settings/business-locations`,
          },
        ]
      : []),
    {
      title: t("navLtvConfiguration"),
      group: t("groupReporting"),
      href: `/panel/w/${workspaceId}/settings/ltv-config`,
    },
    {
      title: t("navProfile"),
      group: t("groupAccount"),
      href: `/panel/w/${workspaceId}/settings/profile`,
    },
    {
      title: t("navBilling"),
      group: t("groupAccount"),
      href: `/panel/w/${workspaceId}/settings/billing`,
    },
    ...(canViewLimits
      ? [
          {
            title: t("navLimits"),
            group: t("groupAccount"),
            href: `/panel/w/${workspaceId}/settings/limits`,
          },
        ]
      : []),
    {
      title: t("navWorkspaces"),
      group: t("groupWorkspace"),
      href: `/panel/w/${workspaceId}/settings/workspaces`,
    },
  ];

  return (
    <ScopedIntlProvider messages={messages}>
      <div className="flex h-full min-h-0 overflow-x-hidden">
        <aside className="hidden w-56 shrink-0 border-r lg:flex lg:flex-col">
          <div className="px-5 py-5">
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-base font-semibold tracking-tight">
                {t("title")}
              </h1>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-5">
            <SettingsNav items={sidebarNavItems} aria-label={t("title")} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="border-b px-4 py-3 lg:hidden">
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-base font-semibold tracking-tight">
                {t("title")}
              </h1>
            </div>
            <SettingsNav
              items={sidebarNavItems}
              className="mt-2"
              aria-label={t("title")}
            />
          </div>

          <main className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ScopedIntlProvider>
  );
}
