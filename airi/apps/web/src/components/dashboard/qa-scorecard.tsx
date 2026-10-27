"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentPerformanceScorecard } from "@icecore/shared/types/models";
import { Check, ShieldAlert, Smile, TrendingUp } from "lucide-react";
import { useTranslations } from "next-intl";

const ScoreCircle = ({
  score,
  label,
  icon,
}: {
  score: number;
  label: string;
  icon: React.ReactNode;
}) => {
  const circumference = 2 * Math.PI * 20;
  const strokeDashoffset = circumference - (score / 10) * circumference;

  let colorClass = "text-muted-foreground";
  if (score >= 8) colorClass = "text-green-500";
  else if (score >= 5) colorClass = "text-yellow-500";
  else if (score > 0) colorClass = "text-red-500";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-col items-center gap-2">
            <div className="relative flex items-center justify-center">
              <svg
                className="w-20 h-20 transform -rotate-90"
                viewBox="0 0 44 44"
              >
                <circle
                  className="text-muted/20"
                  strokeWidth="4"
                  stroke="currentColor"
                  fill="transparent"
                  r="20"
                  cx="22"
                  cy="22"
                />
                <circle
                  className={colorClass}
                  strokeWidth="4"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="transparent"
                  r="20"
                  cx="22"
                  cy="22"
                  style={{ transition: "stroke-dashoffset 0.5s ease-out" }}
                />
              </svg>
              <div className={`absolute ${colorClass}`}>{icon}</div>
            </div>
            <span className="text-xl font-bold">{score}/10</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export const QaScorecard = ({
  scorecard,
}: {
  scorecard: AgentPerformanceScorecard;
}) => {
  const t = useTranslations("QaScorecard");

  if (!scorecard) return null;

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 text-center">
        <ScoreCircle
          score={scorecard.empathy_score}
          label={t("empathy")}
          icon={<Smile size={24} />}
        />
        <ScoreCircle
          score={scorecard.clarity_score}
          label={t("clarity")}
          icon={<Check size={24} />}
        />
        <ScoreCircle
          score={scorecard.script_adherence_score}
          label={t("scriptAdherence")}
          icon={<ShieldAlert size={24} />}
        />
        <ScoreCircle
          score={scorecard.resolution_efficiency_score}
          label={t("resolutionEfficiency")}
          icon={<TrendingUp size={24} />}
        />
      </CardContent>
    </Card>
  );
};
