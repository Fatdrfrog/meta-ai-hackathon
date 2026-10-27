/** @jest-environment jsdom */
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import messages from "../../../messages/analytics/en/page.json";
import panelMessages from "../../../messages/panel/en/page.json";
import { JourneyAnalytics } from "./journey-analytics";

jest.mock("@/components/dashboard/dashboard-board-controller", () => ({
  OutcomesBoardController: ({
    children,
  }: {
    children: (props: unknown) => React.ReactNode;
  }) =>
    children({
      cards: [
        { id: "acquisition", width: 4, height: 1 },
        { id: "delivery", width: 4, height: 1 },
      ],
      editing: false,
      onCardsChange: () => {},
      toolbar: null,
    }),
}));
jest.mock("@/components/dashboard/dashboard-board-grid", () => ({
  DashboardBoardGrid: ({
    cards,
    renderCard,
  }: {
    cards: Array<{ id: string }>;
    renderCard: (id: string) => React.ReactNode;
  }) => (
    <div>
      {cards.map(card => (
        <div key={card.id}>{renderCard(card.id)}</div>
      ))}
    </div>
  ),
}));
const mockSWR = jest.fn();
jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSWR(...args),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) =>
    (key: string, values: Record<string, string | number> = {}) => {
      let result: unknown =
        namespace === "SectionCards"
          ? panelMessages.SectionCards
          : messages.AnalyticsOutcomes;
      for (const part of key.split("."))
        result = (result as Record<string, unknown>)[part];
      if (typeof result !== "string")
        throw new Error(`Missing analytics translation: ${key}`);
      return result.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
    },
}));
jest.mock("@/components/analytics/charts/LineChart", () => ({
  LineChart: () => null,
}));

const entryDates = /Entry dates:/;
function calendarKeys() {
  return mockSWR.mock.calls
    .map(([key]) => key as string | null)
    .filter(
      (key): key is string =>
        key !== null &&
        (key.includes("/acquisition?") ||
          key.includes("/whatsapp?") ||
          key.includes("/api/dashboard?"))
    );
}

// A browser that is not on UTC, whatever zone the test machine runs in.
const BROWSER_ZONE = "Asia/Almaty";
const RealDateTimeFormat = Intl.DateTimeFormat;
const inBrowserZone = (options?: Intl.DateTimeFormatOptions) => ({
  timeZone: BROWSER_ZONE,
  ...options,
});
beforeAll(() => {
  Intl.DateTimeFormat = new Proxy(RealDateTimeFormat, {
    apply: (target, _self, [locales, options]) =>
      new target(locales, inBrowserZone(options)),
    construct: (target, [locales, options]) =>
      new target(locales, inBrowserZone(options)),
  });
});
afterAll(() => {
  Intl.DateTimeFormat = RealDateTimeFormat;
});

beforeEach(() => {
  mockSWR.mockReset();
  mockSWR.mockImplementation(() => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(),
  }));
});

it("renders calendar dates only after hydration, in the browser time zone", async () => {
  const element = (
    <JourneyAnalytics workspaceId="workspace" memberId="member" />
  );
  // The server cannot know the browser zone: no dates and no dated requests.
  const html = renderToString(element);
  expect(html).not.toMatch(entryDates);
  expect(calendarKeys()).toEqual([]);

  mockSWR.mockClear();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const recoverable = jest.fn();
  await act(async () => {
    hydrateRoot(container, element, { onRecoverableError: recoverable });
  });
  expect(recoverable).not.toHaveBeenCalled();
  expect(container.textContent).toMatch(entryDates);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(zone).toBe(BROWSER_ZONE);
  const keys = calendarKeys();
  expect(keys.some(key => key.includes("/acquisition?"))).toBe(true);
  // WhatsApp delivery days are calendar days too: never an extra UTC request.
  expect(keys.some(key => key.includes("/whatsapp?"))).toBe(true);
  expect(keys.filter(key => /timezone=UTC\b/i.test(key))).toEqual([]);
  for (const key of keys)
    expect(
      new URL(key, "http://localhost").searchParams.get(
        key.includes("/api/dashboard?") ? "timezone" : "timeZone"
      )
    ).toBe(zone);
  container.remove();
});
