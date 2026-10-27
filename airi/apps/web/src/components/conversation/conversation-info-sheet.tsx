"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { PopulatedMessage } from "@/types/models";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazy, Suspense, type ReactNode } from "react";
import type { ConversationInfoDetails } from "./conversation-info-view-model";

const ConversationInfo = lazy(() =>
  import("./conversation-info").then(module => ({
    default: module.ConversationInfo,
  }))
);

type ConversationInfoSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ConversationInfoDetails;
  conversationId: string;
  messages?: PopulatedMessage[];
  messageTotal?: number;
  onMomentClick: (id: string) => void;
  actions?: ReactNode;
  isLoading?: boolean;
  hasError?: boolean;
  onRetry?: () => void;
};

export function ConversationInfoSheet({
  open,
  onOpenChange,
  details,
  conversationId,
  messages,
  messageTotal,
  onMomentClick,
  actions,
  isLoading,
  hasError,
  onRetry,
}: ConversationInfoSheetProps) {
  const t = useTranslations("ConversationDetailView");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="h-dvh w-full max-w-full gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,520px)] [&>button]:z-50 [&>button]:rounded-md [&>button]:bg-background/80"
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b px-4 py-3 pr-12">
          <SheetTitle className="text-base">
            {t("conversationDetails")}
          </SheetTitle>
        </SheetHeader>
        {hasError ? (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs text-destructive"
          >
            <span>{t("info.loadError")}</span>
            {onRetry ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRetry}
                disabled={isLoading}
              >
                {t("info.retry")}
              </Button>
            ) : null}
          </div>
        ) : isLoading ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("info.loading")}
          </div>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                <span role={isLoading ? undefined : "status"}>
                  {t("info.loading")}
                </span>
              </div>
            }
          >
            <ConversationInfo
              details={details}
              conversationId={conversationId}
              messages={messages}
              messageTotal={messageTotal}
              onMomentClick={onMomentClick}
              actions={actions}
            />
          </Suspense>
        </div>
      </SheetContent>
    </Sheet>
  );
}
