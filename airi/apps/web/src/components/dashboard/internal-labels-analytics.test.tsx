/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import type { InternalLabelAnalytics } from "@/types/dashboard";

import {
  hasInternalLabelData,
  InternalLabelsAnalyticsSection,
} from "./internal-labels-analytics";

jest.mock("next-intl", () => ({
  useLocale: () => "ru",
  useTranslations:
    () => (key: string, values?: Record<string, number | string>) => {
      const count = Number(values?.count ?? 0);
      const plural = (one: string, few: string, many: string) =>
        count % 10 === 1 && count % 100 !== 11
          ? one
          : [2, 3, 4].includes(count % 10) &&
              ![12, 13, 14].includes(count % 100)
            ? few
            : many;
      const messages: Record<string, string> = {
        title: "Внутренние метки",
        description:
          "Метки рабочей области по объёму обращений и состоянию обработки.",
        labeled: `${values?.percent} с метками`,
        "tiles.tagged": "С метками",
        "tiles.unlabeled": "Без метки",
        "tiles.uniqueLabels": "Уникальные метки",
        "tiles.topLabels": "Основные метки",
        coverageDetail: `${values?.percent} обращений`,
        noLabelAttached: "Внутренняя метка не назначена",
        assignmentCount: `${values?.countValue} ${plural("назначение", "назначения", "назначений")}`,
        shownBelow: "Показаны в таблице ниже",
        "table.label": "Метка",
        "table.conversations": "Обращения",
        "table.open": "Открыто",
        "table.inProgress": "В работе",
        "table.closed": "Закрыто",
        "table.responded": "С ответом",
        "table.latest": "Последнее",
        view: "Открыть",
      };

      return messages[key] ?? key;
    },
}));

function buildData(totalAssignments = 5): InternalLabelAnalytics {
  return {
    taggedConversations: 1_234,
    unlabeledConversations: 10,
    uniqueLabels: 2,
    totalAssignments,
    availableLabels: ["VIP / KEEP"],
    topLabels: [
      {
        label: "VIP / KEEP",
        conversations: 1_234,
        open: 2,
        inProgress: 3,
        closed: 4,
        responded: 5,
        latestAt: "2026-07-31",
      },
    ],
  };
}

describe("InternalLabelsAnalyticsSection", () => {
  it("uses one visibility predicate for both the owner and tab composition", () => {
    const visible = buildData();
    const empty = { ...buildData(), taggedConversations: 0 };

    expect(hasInternalLabelData(visible)).toBe(true);
    expect(hasInternalLabelData(empty)).toBe(false);
    expect(
      render(
        <InternalLabelsAnalyticsSection
          data={empty}
          workspaceId="workspace-keep"
        />
      ).container.firstChild
    ).toBeNull();
  });

  it("renders localized Russian labels, counts, dates, and actions", () => {
    render(
      <InternalLabelsAnalyticsSection
        data={buildData()}
        workspaceId="workspace-keep"
      />
    );

    expect(screen.getByText("Внутренние метки")).toBeTruthy();
    expect(
      screen.getByText(
        "Метки рабочей области по объёму обращений и состоянию обработки."
      )
    ).toBeTruthy();
    expect(screen.getByText("С метками")).toBeTruthy();
    expect(
      screen.getAllByText((_, element) => element?.textContent === "1 234")
        .length
    ).toBeGreaterThan(0);
    expect(screen.getByText("31 июл.")).toBeTruthy();
    expect(screen.getByText("Метка")).toBeTruthy();
    expect(screen.getByText("В работе")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Открыть" }).getAttribute("href")
    ).toContain("internalLabel=VIP+%2F+KEEP");
    expect(screen.getByText("VIP / KEEP")).toBeTruthy();
  });

  it.each([
    [1, "1 назначение"],
    [2, "2 назначения"],
    [5, "5 назначений"],
  ])("renders the Russian assignment count for %i", (count, expected) => {
    render(
      <InternalLabelsAnalyticsSection
        data={buildData(count)}
        workspaceId="workspace-keep"
      />
    );

    expect(screen.getByText(expected)).toBeTruthy();
  });
});
