"use client";

import { useMemo, useState, useTransition } from "react";
import useSWR from "swr";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { buildWorkspaceSwitchPath } from "@/features/panel/shared/routing";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type WorkspaceItem = {
  id: string;
  name: string;
  company_id?: string;
  role?: string;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
};

export function WorkspaceSwitcher({
  currentWorkspaceId,
}: {
  currentWorkspaceId: string;
}) {
  const pathname = usePathname();
  const { prefetch, push } = useRouter();
  const t = useTranslations("Workspaces");
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(
    null
  );
  const [isRoutePending, startRouteTransition] = useTransition();

  const { data, isLoading: loading } = useSWR("/api/workspaces", fetcher, {
    revalidateOnFocus: false,
  });
  const items = useMemo(
    () => (data?.workspaces ?? []) as WorkspaceItem[],
    [data?.workspaces]
  );

  const current = useMemo(
    () => items.find(i => i.id === currentWorkspaceId),
    [items, currentWorkspaceId]
  );

  const activePendingWorkspaceId =
    pendingWorkspaceId && pendingWorkspaceId !== currentWorkspaceId
      ? pendingWorkspaceId
      : null;
  const pendingWorkspace = useMemo(
    () => items.find(i => i.id === activePendingWorkspaceId),
    [items, activePendingWorkspaceId]
  );
  const isSwitching = Boolean(activePendingWorkspaceId) || isRoutePending;
  const isBusy = loading || isSwitching;
  const buttonLabel =
    pendingWorkspace?.name || current?.name || t("selectWorkspace");

  const buildHref = (targetId: string): string =>
    buildWorkspaceSwitchPath(pathname, targetId);

  const recordLastUsed = async (workspaceId: string) => {
    try {
      await fetch("/api/workspaces/last-used", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
        keepalive: true,
      });
    } catch {}
  };

  const prefetchWorkspace = (href: string) => {
    try {
      prefetch(href);
    } catch {}
  };

  const switchWorkspace = (workspaceId: string, href: string) => {
    if (workspaceId === currentWorkspaceId) return;

    setPendingWorkspaceId(workspaceId);
    void recordLastUsed(workspaceId);
    startRouteTransition(() => {
      push(href);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          aria-busy={isBusy}
          className="h-auto min-h-8 min-w-0 max-w-[7rem] shrink justify-start gap-2 px-2 text-left whitespace-nowrap sm:max-w-[min(14rem,50vw)] sm:flex-[1_1_100px] sm:px-3"
        >
          {isBusy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          <span className="truncate">{buttonLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t("workspaces")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map(w => {
          const href = buildHref(w.id);
          return (
            <DropdownMenuItem
              key={w.id}
              disabled={isSwitching || w.id === currentWorkspaceId}
              className="justify-between"
              onPointerEnter={() => prefetchWorkspace(href)}
              onFocus={() => prefetchWorkspace(href)}
              onSelect={() => {
                switchWorkspace(w.id, href);
              }}
            >
              <span className="truncate">{w.name}</span>
              {activePendingWorkspaceId === w.id ? (
                <Loader2
                  className="ml-auto size-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={`/panel/w/${currentWorkspaceId}/settings/workspaces`}>
            {t("manageWorkspaces")}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
