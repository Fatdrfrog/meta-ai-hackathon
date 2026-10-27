"use client";

import {
  AiriChatModal,
  preloadAiriChatModal,
} from "@/components/ai/airi-chat-modal";
import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { useSidebarModal } from "@/components/nav/layout-content";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { scheduleScenarioIdleTask } from "@/components/scenarios/scenario-lazy-chunk";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { WhatsAppBusinessUsernameNavAction } from "./whatsapp-business-username-nav-action";
import { WhatsAppHistorySyncNavStatus } from "./whatsapp-history-sync-nav-status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

import { CreditCard, Menu, Moon, Sparkles, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";

import { useEffect, useState } from "react";

const WorkspaceOnboardingNavHelper = dynamic(
  () =>
    import("@/components/nav/workspace-onboarding-nav-helper").then(
      module => module.WorkspaceOnboardingNavHelper
    ),
  {
    loading: () => null,
    ssr: false,
  }
);

interface SiteHeaderProps {
  workspaceId?: string;
}

export function SiteHeader({ workspaceId }: SiteHeaderProps) {
  const { setTheme } = useTheme();
  const tSiteHeader = useTranslations("SiteHeader");
  const { setOpen } = useSidebarModal();
  const pathname = usePathname();
  const [metaKey, setMetaKey] = useState("Cmd");
  const [airiChatOpen, setAiriChatOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { data: limits } = useCompanyLimits(workspaceId);
  const showUpgrade = Boolean(
    workspaceId &&
      limits?.subscriptionType &&
      limits.subscriptionType === "free"
  );

  const isAiriPage = pathname?.match(/\/panel\/w\/[^/]+\/airi\/?$/) !== null;
  // Entering /airi (the drawer's "View all" link, back/forward) closes the
  // drawer, so it does not reopen by itself after leaving the page.
  const [previousIsAiriPage, setPreviousIsAiriPage] = useState(isAiriPage);
  if (previousIsAiriPage !== isAiriPage) {
    setPreviousIsAiriPage(isAiriPage);
    if (isAiriPage) setAiriChatOpen(false);
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (
        typeof navigator !== "undefined" &&
        navigator.userAgent?.toLowerCase().includes("win")
      ) {
        setMetaKey("Ctrl");
      }
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!workspaceId || isAiriPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      const target =
        event.target instanceof Element ? event.target : document.activeElement;
      if (target?.closest("[data-scenario-stop-keyboard-propagation='true']")) {
        return;
      }
      event.preventDefault();
      setAiriChatOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAiriPage, workspaceId]);

  useEffect(() => {
    if (!workspaceId || isAiriPage) return;
    // Download the chat while the browser idles, so opening it rarely waits.
    return scheduleScenarioIdleTask(preloadAiriChatModal);
  }, [isAiriPage, workspaceId]);

  return (
    <header className="sticky top-0 z-50 shrink-0 border-b bg-background max-md:[&_[data-size=icon]]:size-[32px] max-md:[&_[data-size=icon]_svg]:size-[18px] max-md:[&_[data-size=sm]]:min-h-[32px] max-md:[&_[data-size=sm]]:gap-[8px] max-md:[&_[data-size=sm]]:px-[8px] max-md:[&_[data-size=sm]]:py-0">
      <div className="relative flex min-h-[48px] w-full min-w-0 items-center gap-[4px] px-[12px] py-[4px] sm:flex-wrap md:min-h-12 md:gap-2 md:px-4 lg:px-3">
        <div className="relative z-10 flex min-w-0 shrink-0 items-center gap-[4px] md:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 -ml-[4px] md:-ml-1 md:size-7"
            onClick={() => setOpen(true)}
          >
            <Menu className="size-4" />
            <span className="sr-only">{tSiteHeader("toggleSidebar")}</span>
          </Button>
          <KbdGroup className="hidden md:inline-flex">
            <Kbd>{metaKey}</Kbd>
            <span>+</span>
            <Kbd>B</Kbd>
          </KbdGroup>
          {workspaceId && !isAiriPage ? (
            <div className="hidden min-w-0 sm:block">
              <WorkspaceOnboardingNavHelper workspaceId={workspaceId} />
            </div>
          ) : null}
        </div>

        <div className="relative z-10 ml-auto flex min-w-0 flex-1 items-center justify-end gap-[4px] sm:min-w-[min(100%,20rem)] sm:flex-wrap md:gap-2">
          {workspaceId ? (
            <WhatsAppHistorySyncNavStatus workspaceId={workspaceId} />
          ) : null}
          {workspaceId ? (
            <WhatsAppBusinessUsernameNavAction
              key={workspaceId}
              workspaceId={workspaceId}
            />
          ) : null}
          {workspaceId && !isAiriPage ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="inline-flex size-8 rounded-lg border-0 bg-violet-100 text-violet-700 shadow-none hover:bg-violet-200 hover:text-violet-800 dark:bg-violet-500/25 dark:text-violet-100 dark:hover:bg-violet-500/35"
              title={tSiteHeader("openAiriChat")}
              aria-label={tSiteHeader("openAiriChat")}
              onPointerEnter={preloadAiriChatModal}
              onFocus={preloadAiriChatModal}
              onClick={() => setAiriChatOpen(true)}
            >
              <Sparkles className="size-4" />
            </Button>
          ) : null}
          {showUpgrade ? (
            <Button
              variant="secondary"
              size="sm"
              className="hidden h-8 shrink-0 px-2 sm:inline-flex sm:px-3"
              onClick={() => setUpgradeOpen(true)}
            >
              <CreditCard className="size-4" aria-hidden="true" />
              {tSiteHeader("upgrade")}
            </Button>
          ) : null}
          {workspaceId ? (
            <WorkspaceSwitcher currentWorkspaceId={workspaceId} />
          ) : null}
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-8 shrink-0">
                <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                <span className="sr-only">{tSiteHeader("toggleTheme")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setTheme("light")}>
                {tSiteHeader("lightTheme")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                {tSiteHeader("darkTheme")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                {tSiteHeader("systemTheme")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {workspaceId && !isAiriPage && airiChatOpen ? (
        <AiriChatModal
          workspaceId={workspaceId}
          open={airiChatOpen}
          onOpenChange={setAiriChatOpen}
        />
      ) : null}
      {workspaceId && limits ? (
        <PlanUpgradeDialog
          workspaceId={workspaceId}
          subscriptionType={limits.subscriptionType}
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
        />
      ) : null}
    </header>
  );
}
