"use client";

import { RequestRowSkeleton } from "@/components/requests/request-row-skeleton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Skeleton } from "@/components/ui/skeleton";

const MOBILE_REQUEST_SKELETON_KEYS = [
  "mobile-request-skeleton-1",
  "mobile-request-skeleton-2",
  "mobile-request-skeleton-3",
  "mobile-request-skeleton-4",
  "mobile-request-skeleton-5",
  "mobile-request-skeleton-6",
  "mobile-request-skeleton-7",
  "mobile-request-skeleton-8",
  "mobile-request-skeleton-9",
  "mobile-request-skeleton-10",
] as const;

const DESKTOP_REQUEST_SKELETON_KEYS = [
  "desktop-request-skeleton-1",
  "desktop-request-skeleton-2",
  "desktop-request-skeleton-3",
  "desktop-request-skeleton-4",
  "desktop-request-skeleton-5",
  "desktop-request-skeleton-6",
  "desktop-request-skeleton-7",
  "desktop-request-skeleton-8",
] as const;

export default function RequestsLoading() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 relative h-full">
        <div className="md:hidden flex flex-col h-full w-full bg-background">
          <div className="border-b h-[56px] flex items-center px-3">
            <div className="flex-1 flex gap-2 items-center">
              <Skeleton className="w-24 h-8" />
              <Skeleton className="flex-1 h-8" />
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {MOBILE_REQUEST_SKELETON_KEYS.map(key => (
              <RequestRowSkeleton key={key} />
            ))}
          </div>
        </div>

        <ResizablePanelGroup
          direction="horizontal"
          className="h-full hidden md:flex"
        >
          <ResizablePanel defaultSize={40} minSize={15} className="border-r">
            <div className="flex flex-col h-full w-full bg-background">
              <div className="border-b h-[60px] flex items-center px-1">
                <div className="flex-1 flex gap-2 justify-center items-center p-1.5">
                  <Skeleton className="w-[140px] h-8" />
                  <Skeleton className="flex-1 h-8" />
                </div>
              </div>

              <div className="flex-1 overflow-hidden p-0 m-0">
                {DESKTOP_REQUEST_SKELETON_KEYS.map(key => (
                  <RequestRowSkeleton key={key} />
                ))}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize={60}>
            <div className="flex flex-col h-full w-full bg-background/50">
              <div className="w-full border-b bg-muted/20 whitespace-nowrap overflow-hidden h-[60px]">
                <div className="flex items-center gap-2 h-full px-4">
                  <Skeleton className="h-[44px] w-32 rounded-xl" />
                  <Skeleton className="h-[44px] w-40 rounded-xl" />
                  <Skeleton className="h-[44px] w-36 rounded-xl" />
                </div>
              </div>

              <div className="flex-1 p-6 space-y-4">
                <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-50">
                  <div className="rounded-full bg-muted p-6">
                    <Skeleton className="h-12 w-12 rounded-full" />
                  </div>
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-64" />
                </div>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
