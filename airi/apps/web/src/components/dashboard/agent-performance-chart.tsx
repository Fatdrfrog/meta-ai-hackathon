import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AgentPerformance } from "@/types/performance";
import { useLocale, useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  createPerformanceFormatters,
  type PerformanceTranslator,
} from "./performance-localization";

export function AgentPerformanceChart({
  data,
  teamAverage,
}: {
  data: AgentPerformance[];
  teamAverage?: number | null;
}) {
  const locale = useLocale();
  const rootT = useTranslations("PerformancePage");
  const t = useTranslations("PerformancePage.performanceChart");
  const formatters = createPerformanceFormatters(
    locale,
    rootT as unknown as PerformanceTranslator
  );
  const chartConfig = {
    overall_qa_score: {
      label: t("qaScore"),
      color: "var(--chart-2)",
    },
    conversation_count: {
      label: t("scoredConversations"),
      color: "var(--muted-foreground)",
    },
  } satisfies ChartConfig;

  if (data.length === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex h-[300px] flex-col items-center justify-center text-center">
          <p className="text-2xl font-bold">{t("singleAgentTitle")}</p>
          <p className="mt-2 text-muted-foreground">
            {t("singleAgentDescription")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[320px] min-w-0 w-full"
        >
          <BarChart
            data={data}
            margin={{ top: 10, right: 16, bottom: 0, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="name"
              tickLine={false}
              tickMargin={8}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              fontSize={12}
              tickLine={false}
              axisLine={false}
              domain={[0, 10]}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) => {
                    if (name === "overall_qa_score") {
                      return (
                        <div className="flex w-full items-center justify-between gap-3">
                          <span className="text-muted-foreground">
                            {t("qaScore")}
                          </span>
                          <span className="font-medium">
                            {formatters.scoreOutOfTen(Number(value))}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t("conversationsShort", {
                              count: item.payload.conversation_count,
                              value: formatters.number(
                                item.payload.conversation_count
                              ),
                            })}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
              }
            />
            {teamAverage !== null && teamAverage !== undefined ? (
              <ReferenceLine
                y={teamAverage}
                stroke="var(--chart-3)"
                strokeDasharray="4 4"
                label={{
                  value: t("teamAverage", {
                    value: formatters.number(teamAverage),
                  }),
                  position: "insideTopRight",
                  fill: "var(--chart-3)",
                  fontSize: 11,
                }}
              />
            ) : null}
            <ReferenceLine
              y={8}
              stroke="var(--chart-3)"
              strokeDasharray="4 4"
              label={{
                value: t("target", { value: formatters.number(8) }),
                position: "insideTopLeft",
                fill: "var(--chart-3)",
                fontSize: 11,
              }}
            />
            <Bar
              dataKey="overall_qa_score"
              fill="var(--color-overall_qa_score)"
              radius={8}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
