"use client";

import { ScenariosWorkspaceSkeleton } from "@/components/scenarios/scenarios-workspace-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PanelShellSkeleton } from "@/features/panel/shared/shell/panel-shell-skeleton";
import { usePathname } from "next/navigation";

const WORKSPACE_PAGE_PATH = /^\/panel\/w\/[^/]+(?:\/|$)/;
const SCENARIOS_PAGE_PATH = /^\/panel\/w\/[^/]+\/scenarios\/?$/;

export default function PanelLoadingView() {
  const pathname = usePathname() ?? "";

  // A hard load of a workspace page waits here for the workspace layout.
  // Show the panel's frame so the real header and page skeleton replace it
  // in place.
  if (WORKSPACE_PAGE_PATH.test(pathname)) {
    return (
      <PanelShellSkeleton>
        {SCENARIOS_PAGE_PATH.test(pathname) ? (
          <ScenariosWorkspaceSkeleton />
        ) : undefined}
      </PanelShellSkeleton>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen">
      <Spinner />
    </div>
  );
}
