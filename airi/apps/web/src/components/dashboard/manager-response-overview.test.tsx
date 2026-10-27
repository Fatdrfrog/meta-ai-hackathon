/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { DashboardManagerPerformance } from "@/types/dashboard";
import { ManagerResponseOverview } from "./manager-response-overview";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) =>
    (key: string, values?: Record<string, number | string>) => {
      const messages: Record<string, string> = {
        "DashboardPage.managerResponse.title": "Manager response overview",
        "DashboardPage.managerResponse.description":
          "First human reply after the first customer message.",
        "DashboardPage.managerResponse.table.manager": "Manager",
        "DashboardPage.managerResponse.table.handled": "Handled",
        "DashboardPage.managerResponse.table.medianFirstResponse":
          "Median first response",
        "DashboardPage.managerResponse.table.p90": "P90",
        "DashboardPage.managerResponse.table.replies": "Replies",
        "DashboardPage.managerResponse.help.ariaLabel": `What ${values?.metric ?? "metric"} means`,
        "DashboardPage.managerResponse.help.medianFirstResponse":
          "Half of first replies were faster than this time.",
        "DashboardPage.managerResponse.help.p90":
          "90% of first replies happened at or under this time.",
        "DashboardPage.managerResponse.genericManager": "manager",
        "DashboardClientPage.showInactiveManagers": "Show inactive managers",
        "SectionCards.duration.missing": "—",
        "SectionCards.duration.lessThanMinute": "less than a minute",
        "SectionCards.duration.minutes": `${values?.value} min`,
        "SectionCards.duration.hours": `${values?.value} hr`,
        "SectionCards.duration.days": `${values?.value} day`,
      };
      return messages[`${namespace}.${key}`] ?? key;
    },
}));

jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

function manager(
  id: string,
  name: string,
  conversations: number,
  firstResponseCount: number
): DashboardManagerPerformance {
  return {
    id,
    name,
    email: `${id}@example.com`,
    role: "manager",
    conversations,
    open: 0,
    inProgress: 0,
    resolved: conversations,
    firstResponseCount,
    medianFirstResponseSeconds: firstResponseCount > 0 ? 120 : null,
    averageFirstResponseSeconds: firstResponseCount > 0 ? 180 : null,
    p90FirstResponseSeconds: firstResponseCount > 0 ? 300 : null,
  };
}

describe("ManagerResponseOverview", () => {
  it("hides inactive managers by the canonical predicate and reveals them on request", () => {
    render(
      <ManagerResponseOverview
        managers={[
          manager("active", "Aida Active", 3, 0),
          manager("replied", "Bek Replied", 0, 1),
          manager("inactive", "Dana Inactive", 0, 0),
        ]}
      />
    );

    expect(screen.getByText("Aida Active")).toBeTruthy();
    expect(screen.getByText("Bek Replied")).toBeTruthy();
    expect(screen.queryByText("Dana Inactive")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show inactive managers" })
    );
    expect(screen.getByText("Dana Inactive")).toBeTruthy();
  });

  it("retains the reveal control when every manager is inactive", () => {
    render(
      <ManagerResponseOverview
        managers={[
          manager("inactive-1", "Inactive One", 0, 0),
          manager("inactive-2", "Inactive Two", 0, 0),
        ]}
      />
    );

    expect(screen.queryByText("Inactive One")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show inactive managers" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show inactive managers" })
    );
    expect(screen.getByText("Inactive One")).toBeTruthy();
    expect(screen.getByText("Inactive Two")).toBeTruthy();
  });

  it("keeps full manager names accessible and gives the table a caption", () => {
    const longName =
      "A very long manager name that must remain available to assistive technology";
    render(
      <ManagerResponseOverview
        managers={[manager("long", longName, 12_345, 10)]}
      />
    );

    expect(
      screen.getByRole("table", {
        name: "First human reply after the first customer message.",
      })
    ).toBeTruthy();
    expect(screen.getByText(longName).getAttribute("title")).toBe(longName);
    expect(
      screen.getByRole("button", {
        name: /What Median first response means/,
      })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /What P90 means/ })).toBeTruthy();
    expect(
      screen.getAllByText((_, element) => element?.textContent === "12,345")
        .length
    ).toBeGreaterThan(0);
  });

  it("returns no card when no managers exist", () => {
    expect(
      render(<ManagerResponseOverview managers={[]} />).container.firstChild
    ).toBeNull();
  });
});
