"use client";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, Instagram, MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ConnectedSources } from "./product-context-state";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";
import { buildWhatsAppHistorySyncSummary } from "@/lib/whatsapp/history-sync/status";

const CARD_CLASSNAME =
  "space-y-3 rounded-2xl border-[3px] border-foreground bg-background p-5 shadow-[4px_4px_0px_#000000] dark:shadow-[4px_4px_0px_rgba(255,255,255,0.15)]";
const HEADER_CLASSNAME =
  "flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between";
const BADGE_CLASSNAME =
  "max-w-full shrink whitespace-normal rounded-full border-2 border-foreground bg-[#cfffe1] px-2.5 py-0.5 text-left text-xs font-bold leading-tight text-emerald-800 shadow-[2px_2px_0px_#000000] hover:bg-[#cfffe1] dark:bg-emerald-950/60 dark:text-emerald-300 dark:shadow-[2px_2px_0px_rgba(255,255,255,0.15)]";
const TOGGLE_CLASSNAME =
  "flex cursor-pointer items-start gap-3 text-sm font-bold leading-relaxed text-foreground transition-colors hover:text-primary";

type ProductConnectedSourcesProps = {
  connected: ConnectedSources;
  includeInstagram: boolean;
  includeWhatsapp: boolean;
  whatsappHistoryEligible: boolean;
  whatsappHistoryRequested: boolean;
  whatsappHistorySync?: WhatsAppHistorySyncState | null;
  onIncludeInstagramChange(value: boolean): void;
  onIncludeWhatsappChange(value: boolean): void;
};

export function ProductConnectedSources({
  connected,
  includeInstagram,
  includeWhatsapp,
  whatsappHistoryEligible,
  whatsappHistoryRequested,
  whatsappHistorySync,
  onIncludeInstagramChange,
  onIncludeWhatsappChange,
}: ProductConnectedSourcesProps) {
  const t = useTranslations("OnboardingProductStep");
  const historyT = useTranslations("WhatsAppHistorySync");
  const historySummary = buildWhatsAppHistorySyncSummary(whatsappHistorySync);

  return (
    <>
      {connected.instagram ? (
        <div className={CARD_CLASSNAME}>
          <div className={HEADER_CLASSNAME}>
            <div className="flex min-w-0 items-center gap-2">
              <Instagram className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 break-words text-sm font-bold text-foreground">
                {t("instagramLabel")}
              </span>
            </div>
            <Badge className={BADGE_CLASSNAME}>
              <CheckCircle2 className="h-3 w-3 stroke-[3px]" />
              {t("instagramConnected")}
            </Badge>
          </div>
          <label className={TOGGLE_CLASSNAME}>
            <Checkbox
              checked={includeInstagram}
              onCheckedChange={value =>
                onIncludeInstagramChange(Boolean(value))
              }
              className="mt-0.5 rounded-md border-2 border-foreground shadow-[1px_1px_0px_#000000] data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
            />
            <span className="min-w-0 flex-1 break-words">
              {t("instagramInclude")}
            </span>
          </label>
        </div>
      ) : null}

      {connected.whatsapp ? (
        <div className={CARD_CLASSNAME}>
          <div className={HEADER_CLASSNAME}>
            <div className="flex min-w-0 items-center gap-2">
              <MessageCircle className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 break-words text-sm font-bold text-foreground">
                {t("whatsappLabel")}
              </span>
            </div>
            <Badge className={BADGE_CLASSNAME}>
              <CheckCircle2 className="h-3 w-3 stroke-[3px]" />
              {t("whatsappConnected")}
            </Badge>
          </div>
          <p className="break-words text-xs text-muted-foreground">
            {t("whatsappHelp")}
          </p>
          <label className={TOGGLE_CLASSNAME}>
            <Checkbox
              checked={includeWhatsapp}
              onCheckedChange={value => onIncludeWhatsappChange(Boolean(value))}
              className="mt-0.5 rounded-md border-2 border-foreground shadow-[1px_1px_0px_#000000] data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
            />
            <span className="min-w-0 flex-1 break-words">
              {whatsappHistoryEligible
                ? t("whatsappIncludeHistory")
                : t("whatsappIncludeCloud")}
            </span>
          </label>
          {whatsappHistoryEligible && whatsappHistoryRequested ? (
            <div
              className="space-y-1 text-xs font-semibold text-muted-foreground"
              aria-live="polite"
            >
              <p>{historyT(historySummary.titleKey)}</p>
              <p>{historyT(historySummary.descriptionKey)}</p>
              {historySummary.countsVerified ? (
                <p>
                  {historyT("savedCount", {
                    count: historySummary.synchronizedCount ?? 0,
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
