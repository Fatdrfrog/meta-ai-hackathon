import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import type { AgentPerformance } from "@/types/performance";
import { cn } from "@/lib/utils";

import {
  createPerformanceFormatters,
  type PerformanceFormatters,
  type PerformanceTranslator,
} from "./performance-localization";

export type Agent = AgentPerformance;

interface AgentLeaderboardProps {
  data: Agent[];
}

function getScoreBadgeVariant(
  score: number
): "default" | "secondary" | "destructive" | "outline" {
  if (score >= 8) return "default";
  if (score >= 6) return "secondary";
  if (score >= 4) return "outline";
  return "destructive";
}

function TrendIndicator({
  trend,
  direction,
  formatters,
}: {
  trend: number | null | undefined;
  direction: "up" | "down" | "stable" | null | undefined;
  formatters: PerformanceFormatters;
}) {
  if (trend === null || trend === undefined) return null;

  const absValue = formatters.number(Math.abs(trend));

  if (direction === "up") {
    return (
      <span className="inline-flex items-center text-xs text-chart-2 ml-1">
        +{absValue}
      </span>
    );
  }
  if (direction === "down") {
    return (
      <span className="inline-flex items-center text-xs text-destructive ml-1">
        -{absValue}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-xs text-muted-foreground ml-1">
      {formatters.number(trend)}
    </span>
  );
}

function ScoreBreakdown({
  scores,
  formatters,
  dimensionT,
}: {
  scores: Agent["scores"];
  formatters: PerformanceFormatters;
  dimensionT: PerformanceTranslator;
}) {
  if (!scores) return null;

  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">{dimensionT("empathy")}:</span>
        <span className="font-medium">{formatters.number(scores.empathy)}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">{dimensionT("clarity")}:</span>
        <span className="font-medium">{formatters.number(scores.clarity)}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">
          {dimensionT("scriptAdherence")}:
        </span>
        <span className="font-medium">
          {formatters.number(scores.scriptAdherence)}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">
          {dimensionT("resolution")}:
        </span>
        <span className="font-medium">
          {formatters.number(scores.resolution)}
        </span>
      </div>
    </div>
  );
}

export function AgentLeaderboard({ data }: AgentLeaderboardProps) {
  const locale = useLocale();
  const rootT = useTranslations("PerformancePage");
  const t = useTranslations("PerformancePage.leaderboard");
  const dimensionT = useTranslations("PerformancePage.dimensions");
  const formatters = createPerformanceFormatters(
    locale,
    rootT as unknown as PerformanceTranslator
  );

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-sm">{t("emptyTitle")}</p>
            <p className="text-xs mt-1">{t("emptyDescription")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t("title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>{t("agent")}</TableHead>
                <TableHead className="text-right">
                  {t("dialogsProcessed")}
                </TableHead>
                <TableHead className="text-right hidden md:table-cell">
                  {t("qaCoverage")}
                </TableHead>
                <TableHead className="text-right hidden xl:table-cell">
                  {t("avgResponse")}
                </TableHead>
                <TableHead className="text-right">{t("avgQaScore")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((agent, index) => {
                const scoreBadgeVariant = getScoreBadgeVariant(
                  agent.overall_qa_score
                );
                return (
                  <motion.tr
                    key={agent.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="border-b transition-colors hover:bg-muted/50"
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center justify-center">
                        <span className="text-muted-foreground">
                          {index + 1}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar className="h-8 w-8 shrink-0">
                          <AvatarImage src={agent.avatar_url || undefined} />
                          <AvatarFallback className="text-xs">
                            {agent.name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 truncate font-medium">
                          {agent.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className="font-mono">
                        {formatters.number(agent.conversation_count)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right hidden md:table-cell">
                      <Badge variant="outline" className="font-mono">
                        {formatters.percent(agent.qa_coverage_rate)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right hidden xl:table-cell">
                      <span className="text-sm text-muted-foreground">
                        {formatters.duration(agent.avg_response_time_sec)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="inline-flex items-center cursor-help">
                            <Badge
                              variant={scoreBadgeVariant}
                              className={cn(
                                "font-bold",
                                scoreBadgeVariant === "default" && "bg-chart-2",
                                scoreBadgeVariant === "secondary" &&
                                  "bg-chart-3/15 text-chart-3"
                              )}
                            >
                              {formatters.scoreOutOfTen(agent.overall_qa_score)}
                            </Badge>
                            <TrendIndicator
                              trend={agent.trend}
                              direction={agent.trend_direction}
                              formatters={formatters}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="w-64">
                          <p className="font-semibold mb-2">
                            {t("scoreBreakdown")}
                          </p>
                          <ScoreBreakdown
                            scores={agent.scores}
                            formatters={formatters}
                            dimensionT={
                              dimensionT as unknown as PerformanceTranslator
                            }
                          />
                          <div className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                            <p>
                              {t("qaCoverage")}:{" "}
                              {formatters.percent(agent.qa_coverage_rate)}
                            </p>
                            <p>
                              {t("avgResponse")}:{" "}
                              {formatters.duration(agent.avg_response_time_sec)}
                            </p>
                            <p>
                              {t("csat")}:{" "}
                              {agent.avg_csat !== null
                                ? formatters.scoreOutOfFive(agent.avg_csat)
                                : rootT("duration.missing")}
                            </p>
                            <p>
                              {t("lowQaConversations")}:{" "}
                              {formatters.number(
                                agent.low_qa_conversation_count
                              )}
                            </p>
                          </div>
                          {agent.trend !== null &&
                            agent.trend !== undefined && (
                              <p className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                                {t("previousPeriodComparison", {
                                  value: formatters.signedNumber(agent.trend),
                                })}
                              </p>
                            )}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </motion.tr>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
