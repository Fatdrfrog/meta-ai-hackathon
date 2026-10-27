"use client";

import { KBAdminSidebar } from "@/components/kb/kb-admin-sidebar";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { PanelLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface KBLayoutProps {
  children: React.ReactNode;
}

export default function KBLayout({ children }: KBLayoutProps) {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const t = useTranslations("KnowledgeBase");
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Detect mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // On mobile, show only content (sidebar can be toggled)
  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {sidebarCollapsed ? (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-2 px-2"
            onClick={() => setSidebarCollapsed(false)}
            aria-label={t("adminTree.openTree") || t("title")}
          >
            <PanelLeft className="h-4 w-4" />
            <span className="text-sm">{t("title")}</span>
          </Button>
        </div>
      ) : (
        <div className="border-b flex-shrink-0">
          <KBAdminSidebar
            workspaceId={workspaceId}
            onCollapse={() => setSidebarCollapsed(true)}
            isMobile
          />
        </div>
      )}
        <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
      </div>
    );
  }

  // Desktop: Show both panels side-by-side with resizable layout
  // Each panel scrolls independently (like Notion)
  return (
    <div className="flex flex-col h-full overflow-hidden min-h-0">
      <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
        <ResizablePanel
          defaultSize={22}
          minSize={18}
          maxSize={35}
          className="border-r flex flex-col overflow-hidden min-h-0"
        >
          <KBAdminSidebar workspaceId={workspaceId} />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={78}
          className="flex flex-col overflow-hidden min-h-0"
        >
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
