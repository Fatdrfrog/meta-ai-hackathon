/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

import { ConversationActivityHeatmap } from "./conversation-activity-heatmap";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const labels: Record<string, string> = {
      conversationActivityTitle: "Busy hours",
      conversationActivityDescription: "Times shown in {timeZone}",
      conversationActivityPeakLabel: "Peak:",
      conversationActivityPeakValue: "{day}, {hour} ({count} messages)",
      conversationActivityTotal: "{count} messages",
      conversationActivityEmpty: "No activity",
      conversationActivityGridLabel: "Activity grid",
      conversationActivityCellLabel: "{day}, {hour}: {count} messages",
      conversationActivityLegendLow: "Low",
      conversationActivityLegendHigh: "High",
      conversationActivityDayMon: "Mon",
      conversationActivityDayTue: "Tue",
      conversationActivityDayWed: "Wed",
      conversationActivityDayThu: "Thu",
      conversationActivityDayFri: "Fri",
      conversationActivityDaySat: "Sat",
      conversationActivityDaySun: "Sun",
    };

    return Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      labels[key] ?? key
    );
  },
}));

describe("ConversationActivityHeatmap", () => {
  it("renders busiest hour and accessible hourly cells", () => {
    render(
      <ConversationActivityHeatmap
        data={[
          { dayOfWeek: 2, hour: 9, count: 4 },
          { dayOfWeek: 3, hour: 14, count: 9 },
        ]}
        timeZone="Asia/Qyzylorda"
      />
    );

    expect(screen.getByText("Busy hours")).toBeTruthy();
    expect(screen.getByText("Tue, 14:00-15:00 (9 messages)")).toBeTruthy();
    expect(screen.getByText("13 messages")).toBeTruthy();
    expect(screen.getByLabelText("Tue, 14:00-15:00: 9 messages")).toBeTruthy();
  });

  it("shows an empty state when there is no activity", () => {
    render(<ConversationActivityHeatmap data={[]} timeZone="Asia/Qyzylorda" />);

    expect(screen.getByText("No activity")).toBeTruthy();
  });
});
