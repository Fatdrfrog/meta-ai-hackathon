"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import type { FormattedRequest } from "@/features/panel/requests/formatting";
import {
  getNameInitials,
  isGroupLikeChatType,
} from "@/lib/conversation/display-name";
import { useTranslations } from "next-intl";
import { ConversationBackButton } from "./conversation-back-button";

interface ConversationSelectionPreviewProps {
  request?: FormattedRequest | null;
  onBack?: () => void;
}

export function ConversationSelectionPreview({
  request,
  onBack,
}: ConversationSelectionPreviewProps) {
  const t = useTranslations("ConversationDetailView");
  const displayName =
    request?.rename?.trim() ||
    request?.client ||
    (request?.channel === "telegram" && isGroupLikeChatType(request.chatType)
      ? t("unnamedGroup")
      : t("unnamedCustomer"));
  const loadingLabel = t("loadingRecentMessages");

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="conversation-selection-preview"
      aria-busy="true"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5 md:gap-3 md:p-4">
        <ConversationBackButton onBack={onBack} />
        {request ? (
          <>
            <Avatar className="size-8 shrink-0 border md:size-10">
              <AvatarImage src={request.avatarUrl} alt="" />
              <AvatarFallback className="text-xs md:text-sm">
                {getNameInitials(displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground md:text-base">
                {displayName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {request.source}
              </p>
            </div>
          </>
        ) : (
          <>
            <Skeleton className="size-8 rounded-full md:size-10" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-24 max-w-full" />
            </div>
          </>
        )}
      </div>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-2 md:p-4"
        role="status"
        aria-label={loadingLabel}
      >
        <p className="text-center text-xs text-muted-foreground">{loadingLabel}</p>
        {/* List summaries have no canonical direction, delivery or media data. */}
        <div className="mt-auto flex shrink-0 flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-14 w-3/4 rounded-2xl" />
          <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
          <Skeleton className="h-16 w-2/3 rounded-2xl" />
          <Skeleton className="ml-auto h-12 w-3/5 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
