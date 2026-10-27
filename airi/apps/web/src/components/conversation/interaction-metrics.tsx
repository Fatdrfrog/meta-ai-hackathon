"use client";

import type { InteractionMetrics } from "@icecore/shared/types/models";
import { useTranslations } from "next-intl";

export function InteractionMetricsSection({
  metrics,
}: {
  metrics: InteractionMetrics;
}) {
  const t = useTranslations("ConversationDetailView");
  return (
    <div className="grid grid-cols-3 gap-4 text-center">
      <div>
        <p className="text-xs text-muted-foreground">{t("talkRatio")}</p>
        <p className="text-2xl font-bold">{metrics.talk_ratio || "N/A"}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("avgResponseTime")}</p>
        <p className="text-2xl font-bold">
          {metrics.agent_response_time_avg_sec || "N/A"}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">
          {t("customerQuestions")}
        </p>
        <p className="text-2xl font-bold">
          {metrics.customer_question_count || "N/A"}
        </p>
      </div>
    </div>
  );
}
