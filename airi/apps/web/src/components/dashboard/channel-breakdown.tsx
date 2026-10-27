"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ChannelDataItem } from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";
import { createDashboardFormatters } from "./dashboard-formatters";

export type { ChannelDataItem };

function formatChannelLabel(
  channel: string,
  t: (key: string) => string
): string {
  const normalized = channel.toLowerCase();
  if (normalized === "telegram") return t("telegram");
  if (normalized === "whatsapp") return t("whatsapp");
  return channel;
}

export function ChannelBreakdown({
  data,
  insight,
}: {
  data: ChannelDataItem[];
  insight: string;
}) {
  const locale = useLocale();
  const t = useTranslations("ChannelBreakdown");
  const { integer } = createDashboardFormatters(locale);
  const channels: string[] = [];
  const channelSet = new Set<string>();
  const categories = new Map<string, Map<string, number>>();
  const channelTotals = new Map<string, number>();

  for (const item of data || []) {
    if (
      !item.category ||
      !item.channel ||
      !Number.isFinite(item.count) ||
      item.count <= 0
    ) {
      continue;
    }
    if (!channelSet.has(item.channel)) {
      channelSet.add(item.channel);
      channels.push(item.channel);
    }
    let counts = categories.get(item.category);
    if (!counts) {
      counts = new Map<string, number>();
      categories.set(item.category, counts);
    }
    counts.set(item.channel, (counts.get(item.channel) ?? 0) + item.count);
    channelTotals.set(
      item.channel,
      (channelTotals.get(item.channel) ?? 0) + item.count
    );
  }

  if (channels.length === 0 || categories.size === 0) return null;

  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <Table>
          <TableCaption className="sr-only">{t("description")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("category")}</TableHead>
              {channels.map(channel => (
                <TableHead
                  className="max-w-48 whitespace-normal break-words text-center"
                  key={channel}
                  title={channel}
                >
                  {formatChannelLabel(channel, t)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from(categories, ([category, counts]) => (
              <TableRow key={category}>
                <TableCell
                  className="max-w-64 whitespace-normal break-words font-medium"
                  title={category}
                >
                  {category}
                </TableCell>
                {channels.map(channel => (
                  <TableCell className="text-center tabular-nums" key={channel}>
                    {integer(counts.get(channel) ?? 0)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          {categories.size > 1 ? (
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">{t("total")}</TableCell>
                {channels.map(channel => (
                  <TableCell className="text-center tabular-nums" key={channel}>
                    {integer(channelTotals.get(channel) ?? 0)}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </CardContent>
      {insight ? (
        <CardFooter className="min-w-0">
          <p className="min-w-0 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{t("insight")}</span>{" "}
            <span className="break-words">{insight}</span>
          </p>
        </CardFooter>
      ) : null}
    </Card>
  );
}
