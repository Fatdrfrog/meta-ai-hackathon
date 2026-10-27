"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { RequestsPlanGate } from "@/features/panel/requests/data-projection";
import { type FormattedRequest as RequestItem } from "@/features/panel/requests/formatting";
import {
  parseRequestsListQuery,
  requestsListQuerySignature,
} from "@/features/panel/requests/list-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./chat-panel";
import { DialogListPanel } from "./dialog-list-panel";
import { updateUrlWithoutNavigation } from "./dialog-list-panel-url";

function getMessageSearchQuery(
  searchParams: Pick<URLSearchParams, "get">
): string | null {
  const searchType = searchParams.get("searchType");
  const searchQuery = searchParams.get("searchQuery")?.trim();
  return searchType === "message_within_chat" && searchQuery
    ? searchQuery
    : null;
}

function findRequestPreview(
  requests: RequestItem[],
  conversationId: string | null | undefined
): RequestItem | null {
  if (!conversationId) {
    return null;
  }
  return requests.find(request => request.id === conversationId) ?? null;
}

interface RequestsMasterDetailLayoutProps {
  workspaceId: string;
  initialRequests: RequestItem[];
  initialAvailableChannels: string[];
  initialAvailableCategories?: string[];
  initialHasMore: boolean;
  initialPlanGate?: RequestsPlanGate | null;
  shouldHydrateFromApiOnMount?: boolean;
  initialRenderNowMs: number;
  initialConversationId?: string;
  initialHighlightedMessageId?: string;
  hasConfiguredSources?: boolean | Promise<boolean>;
}

export function RequestsMasterDetailLayout({
  workspaceId,
  initialRequests,
  initialAvailableChannels,
  initialAvailableCategories,
  initialHasMore,
  initialPlanGate,
  shouldHydrateFromApiOnMount = false,
  initialRenderNowMs,
  initialConversationId,
  initialHighlightedMessageId,
  hasConfiguredSources = true,
}: RequestsMasterDetailLayoutProps) {
  const t = useTranslations("ConversationDetailView");
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const listRegionRef = useRef<HTMLDivElement>(null);
  const detailRegionRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasMobileDetailRef = useRef(false);
  const urlConversation = searchParams.get("conversation");
  const urlMessageSearchQuery = getMessageSearchQuery(searchParams);
  const initialActiveConversationId =
    urlConversation || initialConversationId || null;
  const listQueryKey = useMemo(
    () => requestsListQuerySignature(parseRequestsListQuery(searchParams)),
    [searchParams]
  );
  const dialogListKey = `${workspaceId}:${listQueryKey}`;
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(initialActiveConversationId);
  const [activeMessageSearchQuery, setActiveMessageSearchQuery] = useState<
    string | null
  >(urlMessageSearchQuery);
  const [activeRequestPreview, setActiveRequestPreview] =
    useState<RequestItem | null>(() =>
      findRequestPreview(initialRequests, initialActiveConversationId)
    );

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const nextConversationId = params.get("conversation");
      const nextMessageSearchQuery = getMessageSearchQuery(params);
      setActiveConversationId(nextConversationId);
      setActiveMessageSearchQuery(nextMessageSearchQuery);
      setActiveRequestPreview(prev =>
        prev?.id === nextConversationId
          ? prev
          : findRequestPreview(initialRequests, nextConversationId)
      );
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [initialRequests]);

  const handleSelectConversation = useCallback(
    (
      id: string,
      options?: {
        messageSearchQuery?: string | null;
        requestPreview?: RequestItem | null;
      }
    ) => {
      setActiveConversationId(id);
      setActiveMessageSearchQuery(options?.messageSearchQuery ?? null);
      setActiveRequestPreview(options?.requestPreview ?? null);
    },
    []
  );

  const handleBackToList = useCallback(() => {
    setActiveConversationId(null);
    setActiveMessageSearchQuery(null);
    setActiveRequestPreview(null);
    if (!isMobile) return;

    const params = new URLSearchParams(window.location.search);
    params.delete("conversation");
    params.delete("message");
    const query = params.toString();
    updateUrlWithoutNavigation(
      query ? `${window.location.pathname}?${query}` : window.location.pathname
    );
  }, [isMobile]);

  const showMobileDetailView = Boolean(activeConversationId);
  const listIsHidden = isMobile && showMobileDetailView;
  const detailIsHidden = isMobile && !showMobileDetailView;

  useEffect(() => {
    if (listIsHidden) {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        listRegionRef.current?.contains(focused)
      ) {
        returnFocusRef.current = focused;
      }
      // Focus the stable region so a lazy-loading detail never strands keyboard
      // or screen-reader focus in the now-inert list or opens the soft keyboard.
      if (!detailRegionRef.current?.contains(focused)) {
        detailRegionRef.current?.focus({ preventScroll: true });
      }
    } else if (isMobile && wasMobileDetailRef.current) {
      const previous = returnFocusRef.current;
      const target = previous?.isConnected
        ? previous
        : listRegionRef.current?.querySelector<HTMLElement>("button, input");
      target?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    }
    wasMobileDetailRef.current = listIsHidden;
  }, [isMobile, listIsHidden]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <ResizablePanelGroup
        direction="horizontal"
        className="relative h-full max-md:block"
      >
        <ResizablePanel
          defaultSize={40}
          minSize={15}
          className="min-h-0 overflow-hidden border-r max-md:absolute max-md:inset-0 max-md:w-full max-md:border-r-0"
        >
          <div
            ref={listRegionRef}
            data-testid="requests-list-region"
            className="h-full min-h-0"
            aria-hidden={listIsHidden}
            inert={listIsHidden ? true : undefined}
          >
            <DialogListPanel
              key={dialogListKey}
              workspaceId={workspaceId}
              requests={initialRequests}
              initialAvailableChannels={initialAvailableChannels}
              initialAvailableCategories={initialAvailableCategories}
              initialHasMore={initialHasMore}
              initialPlanGate={initialPlanGate}
              shouldHydrateFromApiOnMount={shouldHydrateFromApiOnMount}
              initialRenderNowMs={initialRenderNowMs}
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              isMobile={isMobile}
              hasConfiguredSources={hasConfiguredSources}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle className="max-md:hidden" />

        <ResizablePanel
          defaultSize={60}
          className={cn(
            "min-h-0 overflow-hidden max-md:absolute max-md:inset-0 max-md:z-50 max-md:w-full max-md:bg-background",
            !showMobileDetailView &&
              "max-md:pointer-events-none max-md:invisible"
          )}
        >
          <div
            ref={detailRegionRef}
            data-testid="requests-detail-region"
            className="h-full min-h-0 outline-none"
            role="region"
            aria-label={
              activeRequestPreview?.rename?.trim() ||
              activeRequestPreview?.client ||
              t("conversationDetails")
            }
            tabIndex={-1}
            aria-hidden={detailIsHidden}
            inert={detailIsHidden ? true : undefined}
          >
            <ChatPanel
              conversationId={activeConversationId}
              workspaceId={workspaceId}
              initialHighlightedMessageId={initialHighlightedMessageId}
              searchQuery={activeMessageSearchQuery}
              requestPreview={activeRequestPreview}
              onBack={isMobile ? handleBackToList : undefined}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
