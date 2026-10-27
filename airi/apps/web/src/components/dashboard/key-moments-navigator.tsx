"use client";

import { Badge } from "@/components/ui/badge";
import type { KeyMoment } from "@icecore/shared/types/models";
import {
  Lightbulb,
  MessageCircleWarning,
  ThumbsDown,
  ThumbsUp,
  GitMerge,
} from "lucide-react";
import { useTranslations } from "next-intl";

// Определяем иконки для разных типов ключевых моментов
const momentIcons: { [key: string]: React.ReactNode } = {
  price_inquiry: <Lightbulb size={14} className="mr-1.5" />,
  objection: <MessageCircleWarning size={14} className="mr-1.5" />,
  positive_feedback: <ThumbsUp size={14} className="mr-1.5" />,
  negative_feedback: <ThumbsDown size={14} className="mr-1.5" />,
  upsell_attempt: <GitMerge size={14} className="mr-1.5" />,
};

interface KeyMomentsNavigatorProps {
  moments: KeyMoment[];
  onMomentClick: (messageId: string) => void;
}

export function KeyMomentsNavigator({
  moments,
  onMomentClick,
}: KeyMomentsNavigatorProps) {
  const t = useTranslations("KeyMomentsNavigator");

  if (!moments || moments.length === 0) {
    return null;
  }

  return (
    <div className="py-4">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-3 text-muted-foreground">
        {t("title")}
      </h3>
      <div className="flex flex-wrap gap-2">
        {moments.map((moment, index) => (
          <Badge
            key={index}
            variant="outline"
            className="cursor-pointer hover:bg-accent transition-colors py-1 px-3"
            onClick={() => onMomentClick(String(moment.message_ref))}
          >
            {momentIcons[moment.type] || (
              <Lightbulb size={14} className="mr-1.5" />
            )}
            {t(
              moment.type as
                | "price_inquiry"
                | "objection"
                | "positive_feedback"
                | "negative_feedback"
                | "upsell_attempt"
            )}
          </Badge>
        ))}
      </div>
    </div>
  );
}
