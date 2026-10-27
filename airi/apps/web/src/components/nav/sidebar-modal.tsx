"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarProvider } from "@/components/ui/sidebar";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

const AppSidebarContent = dynamic(
  () =>
    import("@/components/nav/app-sidebar-content").then(
      module => module.AppSidebarContent
    ),
  {
    loading: () => null,
    ssr: false,
  }
);

interface SidebarModalProps {
  workspaceId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SidebarModal({
  workspaceId,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: SidebarModalProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = openProp ?? uncontrolledOpen;
  const pathname = usePathname();
  const t = useTranslations("Sidebar");
  const onOpenChangeRef = useRef(onOpenChangeProp);
  const prevPathnameRef = useRef(pathname);

  // Keep ref updated
  useEffect(() => {
    onOpenChangeRef.current = onOpenChangeProp;
  }, [onOpenChangeProp]);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(newOpen);
      }
      onOpenChangeRef.current?.(newOpen);
    },
    [isControlled]
  );

  // Close modal when navigating to a new page
  useEffect(() => {
    if (prevPathnameRef.current !== pathname && open) {
      queueMicrotask(() => handleOpenChange(false));
    }
    prevPathnameRef.current = pathname;
  }, [handleOpenChange, pathname, open]);

  // Handle Cmd+B (Mac) or Ctrl+B (Windows/Linux) keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "b" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        handleOpenChange(!open);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleOpenChange, open]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="left"
        className="w-[16rem] p-0 sm:max-w-[16rem] [&>button]:hidden bg-sidebar/95 backdrop-blur-md border-r border-sidebar-border data-[state=open]:duration-200 data-[state=closed]:duration-200"
      >
        <SheetTitle className="sr-only">{t("mobileSidebarTitle")}</SheetTitle>
        <SheetDescription className="sr-only">
          {t("mobileSidebarDescription")}
        </SheetDescription>
        <SidebarProvider defaultOpen={true} enableShortcut={false}>
          <div className="flex h-full w-full flex-col">
            <AppSidebarContent workspaceId={workspaceId} />
          </div>
        </SidebarProvider>
      </SheetContent>
    </Sheet>
  );
}
