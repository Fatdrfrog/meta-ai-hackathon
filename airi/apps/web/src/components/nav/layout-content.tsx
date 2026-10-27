"use client";

import { SidebarModal } from "@/components/nav/sidebar-modal";
import { createContext, ReactNode, useContext, useMemo, useState } from "react";

interface SidebarContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export function useSidebarModal() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebarModal must be used within LayoutContent");
  }
  return context;
}

interface LayoutContentProps {
  children: ReactNode;
  workspaceId: string;
}

export function LayoutContent({ children, workspaceId }: LayoutContentProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarContextValue = useMemo(
    () => ({ open: sidebarOpen, setOpen: setSidebarOpen }),
    [sidebarOpen]
  );

  return (
    <SidebarContext.Provider value={sidebarContextValue}>
      <div className="flex h-svh w-full flex-col">
        <SidebarModal
          workspaceId={workspaceId}
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
        />
        <div className="flex flex-1 flex-col overflow-hidden min-h-0">
          {children}
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
