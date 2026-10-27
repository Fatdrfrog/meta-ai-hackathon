"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";

export function ConversationBackButton({ onBack }: { onBack?: () => void }) {
  const t = useTranslations("ConversationDetailView");

  if (!onBack) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onBack}
      className="size-[44px] shrink-0 transition-transform active:scale-90 md:size-8"
      aria-label={t("backToConversations")}
    >
      <ChevronLeft className="size-4" aria-hidden />
    </Button>
  );
}
