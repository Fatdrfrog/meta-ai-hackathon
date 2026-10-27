"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  Bot,
  GitBranch,
  MessageSquareQuote,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ScenarioGuidedCreateKind } from "./scenario-guided-create";

type ScenarioCreateTypeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (kind: ScenarioGuidedCreateKind) => void;
  onSelectRevenuePlaybook?: () => void;
};

export function ScenarioCreateTypeDialog({
  open,
  onOpenChange,
  onSelect,
  onSelectRevenuePlaybook,
}: ScenarioCreateTypeDialogProps) {
  const t = useTranslations("Scenarios");
  const options: Array<{
    kind: ScenarioGuidedCreateKind;
    title: string;
    description: string;
    icon: typeof GitBranch;
    tone: string;
  }> = [
    {
      kind: "entry",
      title: t("createTypeEntryTitle"),
      description: t("createTypeEntryDesc"),
      icon: Bot,
      tone: "bg-primary/10 text-primary",
    },
    {
      kind: "keyword",
      title: t("createTypeKeywordTitle"),
      description: t("createTypeKeywordDesc"),
      icon: MessageSquareQuote,
      tone: "bg-sky-500/10 text-sky-700",
    },
    {
      kind: "fallback",
      title: t("createTypeFallbackTitle"),
      description: t("createTypeFallbackDesc"),
      icon: ShieldAlert,
      tone: "bg-rose-500/10 text-rose-700",
    },
    {
      kind: "blank",
      title: t("createTypeBlankTitle"),
      description: t("createTypeBlankDesc"),
      icon: GitBranch,
      tone: "bg-muted text-foreground",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("createTypeDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("createTypeDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-3">
          {onSelectRevenuePlaybook && (
            <button
              type="button"
              onClick={onSelectRevenuePlaybook}
              className="flex h-full flex-col items-start gap-3 rounded-xl border-2 border-primary/20 bg-primary/5 p-5 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <TrendingUp className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {t("revenuePlaybooks.entryTitle")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("revenuePlaybooks.entryDescription")}
                </p>
              </div>
            </button>
          )}
          {options.map(option => {
            const Icon = option.icon;

            return (
              <button
                key={option.kind}
                type="button"
                className={cn(
                  "flex h-full flex-col items-start gap-3 rounded-xl border-2 border-transparent p-5 text-left transition-[background-color,border-color,box-shadow]",
                  "bg-muted/30 hover:border-primary/40 hover:shadow-md"
                )}
                onClick={() => onSelect(option.kind)}
              >
                <div
                  className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-lg",
                    option.tone
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{option.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {option.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
