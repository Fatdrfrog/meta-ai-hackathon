"use client";

import { Badge } from "@/components/ui/badge";
import { AlertCircle, Check, Clock3, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";

/**
 * Save status type for KB editors
 */
export type SaveStatus = "saved" | "saving" | "error" | "unsaved";

export interface SaveStatusBadgeProps {
  /** Current save status */
  status: SaveStatus;
  /** Use compact mode (icon only) */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get icon component for save status
 */
function SaveStatusIcon({ status }: { status: SaveStatus }) {
  switch (status) {
    case "saving":
      return <Loader2 className="h-4 w-4 animate-spin" />;
    case "saved":
      return <Check className="h-4 w-4 text-green-600" />;
    case "error":
      return <AlertCircle className="h-4 w-4 text-red-600" />;
    case "unsaved":
      return <Clock3 className="h-4 w-4 text-amber-600" />;
    default:
      return null;
  }
}

/**
 * Reusable save status badge for KB editors
 * Shows save state with appropriate icon and text
 */
export const SaveStatusBadge = memo(function SaveStatusBadge({
  status,
  compact = false,
  className = "",
}: SaveStatusBadgeProps) {
  const t = useTranslations("KnowledgeBase.articleEditor.saveStatus");

  const getStatusText = () => {
    switch (status) {
      case "saving":
        return t("saving");
      case "saved":
        return t("saved");
      case "error":
        return t("error");
      case "unsaved":
        return t("unsaved");
      default:
        return "";
    }
  };

  const getVariant = (): "outline" | "destructive" | "secondary" => {
    if (status === "error") return "destructive";
    return "outline";
  };

  const getBorderClass = () => {
    if (status === "error") return "border-destructive text-destructive";
    return "";
  };

  if (compact) {
    return (
      <div className={`flex items-center ${className}`}>
        <SaveStatusIcon status={status} />
      </div>
    );
  }

  return (
    <Badge
      variant={getVariant()}
      className={`flex items-center gap-1.5 ${getBorderClass()} ${className}`}
    >
      <SaveStatusIcon status={status} />
      <span className="text-xs">{getStatusText()}</span>
    </Badge>
  );
});
