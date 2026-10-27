"use client";

import { createClient } from "@/lib/supabase/client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  BarChart3,
  Book,
  HelpCircle,
  ImageIcon,
  LayoutList,
  Mail,
  Megaphone,
  MessageSquare,
  Package,
  Palette,
  RouteIcon,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";

import { shouldShowEmailAutomationNav } from "@/components/nav/app-sidebar-email-nav";
import { CompanyLimitStatus } from "@/components/nav/company-limit-status";
import { IntentPrefetchLink } from "@/components/nav/intent-prefetch-link";
import { NavMain } from "@/components/nav/nav-main";
import { NavSecondary } from "@/components/nav/nav-secondary";
import { NavUser } from "@/components/nav/nav-user";
import { WorkspaceOnboardingHelper } from "@/components/nav/workspace-onboarding-helper";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  fetchProductsAccess,
  productsAccessUrl,
} from "@/components/products/products-client";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import Image from "next/image";
import useSWR from "swr";

import AiriBlackIcon from "../assets/logo_short_black.svg";
import AiriWhiteIcon from "../assets/logo_short_white.svg";

type UserProfile = {
  name: string;
  email: string;
  avatar: string | null;
};

export function AppSidebarContent({ workspaceId }: { workspaceId: string }) {
  const { theme } = useTheme();
  const tAppSidebar = useTranslations("AppSidebar");
  const pathname = usePathname();
  const supabase = createClient();

  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasWebWidget, setHasWebWidget] = useState(false);
  const [hasEmailAutomation, setHasEmailAutomation] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const fetchUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        setUser({
          name:
            user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            user.email ||
            tAppSidebar("defaultUserName"),
          email: user.email!,
          avatar: user.user_metadata?.avatar_url || null,
        });
      }
      setIsLoading(false);
    };
    fetchUser();
  }, [supabase.auth, tAppSidebar]);

  useEffect(() => {
    const controller = new AbortController();

    const checkConnectedSources = async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/integrations`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (!response.ok) {
          setHasWebWidget(false);
          setHasEmailAutomation(false);
          return;
        }
        const payload = (await response.json()) as {
          sources?: Array<{ type?: string }>;
          emailProviderConnected?: boolean;
          emailSources?: unknown[];
        };
        const sourceTypes = new Set(
          (payload.sources ?? []).map(source => source.type)
        );

        setHasWebWidget(sourceTypes.has("web_widget"));
        setHasEmailAutomation(shouldShowEmailAutomationNav(payload));
      } catch {
        if (controller.signal.aborted) return;
        setHasWebWidget(false);
        setHasEmailAutomation(false);
      }
    };
    checkConnectedSources();
    return () => controller.abort();
  }, [workspaceId]);

  // Products is for admins behind a workspace flag; the server decides both.
  // Cached per workspace, so reopening the phone menu shows it at once
  // instead of it appearing late and pushing the items below it down.
  const { data: hasProducts = false } = useSWR(
    productsAccessUrl(workspaceId),
    fetchProductsAccess,
    { revalidateOnFocus: false }
  );

  const navMain = [
    {
      title: tAppSidebar("airiChat"),
      url: `/panel/w/${workspaceId}/airi`,
      icon: Sparkles,
    },
    {
      title: tAppSidebar("requests"),
      url: `/panel/w/${workspaceId}/requests`,
      icon: LayoutList,
    },
    {
      title: tAppSidebar("knowledgeBase"),
      url: `/panel/w/${workspaceId}/kb`,
      icon: Book,
    },
    {
      title: tAppSidebar("scenarios"),
      url: `/panel/w/${workspaceId}/scenarios`,
      icon: RouteIcon,
    },
    {
      title: tAppSidebar("bulkCampaigns"),
      url: `/panel/w/${workspaceId}/bulk-campaigns`,
      icon: Megaphone,
    },
    {
      title: tAppSidebar("customers"),
      url: `/panel/w/${workspaceId}/leads`,
      icon: Users,
    },
    ...(hasProducts
      ? [
          {
            title: PRODUCTS_COPY.navLabel,
            url: `/panel/w/${workspaceId}/products`,
            icon: Package,
          },
        ]
      : []),
    ...(hasEmailAutomation
      ? [
          {
            title: tAppSidebar("email"),
            url: `/panel/w/${workspaceId}/email`,
            icon: Mail,
          },
        ]
      : []),
    {
      title: tAppSidebar("messengers.title"),
      url: `/panel/w/${workspaceId}/messengers/whatsapp-templates`,
      icon: MessageSquare,
    },
    {
      title: tAppSidebar("analytics.title"),
      url: `/panel/w/${workspaceId}/analytics`,
      icon: BarChart3,
    },
    {
      title: tAppSidebar("assets"),
      url: `/panel/w/${workspaceId}/assets`,
      icon: ImageIcon,
    },
  ];

  const navOnboarding = hasWebWidget
    ? [
        {
          title: tAppSidebar("widget.analytics"),
          url: `/panel/w/${workspaceId}/widget-analytics`,
          icon: BarChart3,
          prefetch: false,
        },
        {
          title: tAppSidebar("widget.branding"),
          url: `/panel/w/${workspaceId}/widget-branding`,
          icon: Palette,
          prefetch: false,
        },
      ]
    : [];

  const navSecondary = [
    {
      title: tAppSidebar("integrations"),
      url: `/panel/w/${workspaceId}/settings/integrations`,
      icon: Settings,
    },
    {
      title: tAppSidebar("help"),
      url: `/panel/w/${workspaceId}/help`,
      icon: HelpCircle,
    },
  ];

  if (!mounted) return null;

  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <IntentPrefetchLink href={`/panel/w/${workspaceId}/airi` as Route}>
              <Image
                src={theme === "dark" ? AiriWhiteIcon : AiriBlackIcon}
                alt="Airi.chat"
                height={25}
                width={25}
              />
            </IntentPrefetchLink>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} pathname={pathname} />
        <WorkspaceOnboardingHelper workspaceId={workspaceId} />
        <CompanyLimitStatus workspaceId={workspaceId} />

        {navOnboarding.length > 0 && (
          <NavSecondary
            items={navOnboarding}
            className="mt-4"
            pathname={pathname}
            groupLabel={tAppSidebar("widget.title")}
          />
        )}
        <NavSecondary
          items={navSecondary}
          className="mt-auto"
          pathname={pathname}
          groupLabel={tAppSidebar("settings")}
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} isLoading={isLoading} workspaceId={workspaceId} />
      </SidebarFooter>
    </>
  );
}
