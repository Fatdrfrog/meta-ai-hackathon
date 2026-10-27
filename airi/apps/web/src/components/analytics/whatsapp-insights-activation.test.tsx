/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { WhatsAppInsightsActivation } from "./whatsapp-insights-activation";
import { installMatchMedia } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
}));

beforeAll(() => {
  installMatchMedia();
});

function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {ui}
    </SWRConfig>
  );
}

function mockApi(
  canManage: boolean,
  post?: { ok: boolean; status: number; body: unknown }
) {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? {
          ok: post?.ok ?? true,
          status: post?.status ?? 200,
          json: async () => post?.body ?? { outcome: "enabled" },
        }
      : { ok: true, status: 200, json: async () => ({ canManage }) }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const props = {
  workspaceId: "w",
  sourceId: "s1",
  accountName: "Main number",
};

beforeEach(() => jest.clearAllMocks());

test("members see who can enable insights and get no action", async () => {
  mockApi(false);
  renderWithSWR(<WhatsAppInsightsActivation {...props} />);
  expect(await screen.findByText("insights.adminOnly")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("owners confirm the permanent change before anything is sent to Meta", async () => {
  const fetchMock = mockApi(true);
  const onEnabled = jest.fn();
  renderWithSWR(
    <WhatsAppInsightsActivation {...props} onEnabled={onEnabled} />
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.enable" })
  );
  expect(
    await screen.findByText('insights.confirmTitle {"account":"Main number"}')
  ).toBeTruthy();
  expect(screen.getByText("insights.permanent")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false
  );

  fireEvent.click(screen.getByRole("button", { name: "insights.cancel" }));
  await waitFor(() =>
    expect(screen.queryByText("insights.permanent")).toBeNull()
  );
  expect(onEnabled).not.toHaveBeenCalled();
});

test("enabling posts the source, closes the dialog and refreshes the report", async () => {
  const fetchMock = mockApi(true);
  const onEnabled = jest.fn();
  renderWithSWR(
    <WhatsAppInsightsActivation {...props} onEnabled={onEnabled} />
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.enable" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.confirm" })
  );
  expect(await screen.findByText("insights.enabled")).toBeTruthy();
  expect(onEnabled).toHaveBeenCalledTimes(1);
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
  expect(post?.[0]).toBe("/api/workspaces/w/whatsapp/insights");
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ sourceId: "s1" });
});

test("an expired Meta token asks to reconnect instead of failing silently", async () => {
  mockApi(true, {
    ok: false,
    status: 409,
    body: { outcome: "permission_required" },
  });
  const onEnabled = jest.fn();
  renderWithSWR(
    <WhatsAppInsightsActivation {...props} onEnabled={onEnabled} />
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.enable" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.confirm" })
  );
  expect(await screen.findByText(/insights\.errors\.reconnect/)).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "insights.reconnect" })
      .getAttribute("href")
  ).toBe("/panel/w/w/settings/integrations?type=whatsapp&reconnect=1");
  expect(onEnabled).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "insights.confirm" })
  ).not.toBeNull();
});

test.each([
  [429, { outcome: "rate_limited" }, "insights.errors.busy"],
  // Meta refuses WhatsApp Business app accounts; reconnecting cannot help.
  [422, { outcome: "unsupported" }, "insights.errors.unsupported"],
  [403, { error: "forbidden" }, "insights.errors.forbidden"],
  [503, { outcome: "unavailable" }, "insights.errors.failed"],
])("maps HTTP %i to a clear message", async (status, body, message) => {
  mockApi(true, { ok: false, status, body });
  renderWithSWR(<WhatsAppInsightsActivation {...props} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.enable" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "insights.confirm" })
  );
  expect(await screen.findByText(message)).toBeTruthy();
});
