/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { WebhookDeliverySummary } from "@/lib/customer-api/contracts";
import { WebhookDeliveries } from "./webhook-deliveries";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const catalog = jest.requireActual(
      "../../../../../messages/settings/api/en/page.json"
    ).CustomerApiSettings;
    return catalog[key].replace(/\{(\w+)\}/g, (_match: string, name: string) =>
      String(values?.[name] ?? name)
    );
  },
  useFormatter: () => ({ dateTime: () => "Oct 7, 2026" }),
}));

const delivery: WebhookDeliverySummary = {
  id: "delivery-1",
  event_type: "message.received",
  response_status: null,
  error_message: null,
  attempt_number: 2,
  delivered_at: null,
  created_at: "2026-10-07T10:00:00Z",
  next_retry_at: "2026-10-07T10:00:30Z",
};
const mockFetch = jest.fn();
const response = (deliveries: WebhookDeliverySummary[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ deliveries }),
});

function setup(onClose = jest.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <WebhookDeliveries
        url="/api/workspaces/workspace-1/webhooks/hook-1/deliveries?limit=20"
        onClose={onClose}
      />
    </SWRConfig>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch;
});

test.each([
  "Webhook host lookup timed out",
  "getaddrinfo ENOTFOUND receiver.example.com",
  "certificate has expired",
])("shows the transport failure reason: %s", async reason => {
  mockFetch.mockResolvedValue(
    response([{ ...delivery, error_message: reason }])
  );
  setup();

  expect(await screen.findByText(reason)).toBeInTheDocument();
  expect(screen.getByText("Not delivered")).toBeInTheDocument();
  expect(screen.getByText(/Attempt 2/)).toBeInTheDocument();
});

test("renders a long receiver error as text without executing markup", async () => {
  const reason = `<img src=x onerror=alert(1)>${"host".repeat(100)}: lookup failed`;
  mockFetch.mockResolvedValue(
    response([{ ...delivery, error_message: reason }])
  );
  const view = setup();

  expect(await screen.findByText(reason)).toBeInTheDocument();
  expect(view.container.querySelector("img")).toBeNull();
});

test("keeps the HTTP failure status beside a distinct failure reason", async () => {
  mockFetch.mockResolvedValue(
    response([
      {
        ...delivery,
        response_status: 503,
        error_message: "Receiver maintenance in progress",
      },
    ])
  );
  setup();

  expect(
    await screen.findByText("Receiver maintenance in progress")
  ).toBeInTheDocument();
  expect(screen.getByText("Not delivered · HTTP 503")).toBeInTheDocument();
});

test("does not repeat an HTTP error already shown in the status", async () => {
  mockFetch.mockResolvedValue(
    response([{ ...delivery, response_status: 503, error_message: "HTTP 503" }])
  );
  setup();

  expect(
    await screen.findByText("Not delivered · HTTP 503")
  ).toBeInTheDocument();
  expect(
    screen.queryByText("HTTP 503", { exact: true })
  ).not.toBeInTheDocument();
});

test("successful delivery shows its status without a stale error", async () => {
  mockFetch.mockResolvedValue(
    response([
      {
        ...delivery,
        response_status: 200,
        delivered_at: "2026-10-07T10:00:01Z",
        error_message: "Previous attempt timed out",
      },
    ])
  );
  setup();

  expect(await screen.findByText("Delivered · HTTP 200")).toBeInTheDocument();
  expect(
    screen.queryByText("Previous attempt timed out")
  ).not.toBeInTheDocument();
});

test("empty history can refresh into a populated history", async () => {
  mockFetch.mockResolvedValueOnce(response([]));
  mockFetch.mockResolvedValueOnce(
    response([{ ...delivery, error_message: "Connection timed out" }])
  );
  setup();

  expect(
    await screen.findByText("No delivery attempts yet.")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Connection timed out")).toBeInTheDocument();
  expect(
    screen.queryByText("No delivery attempts yet.")
  ).not.toBeInTheDocument();
});

test("loading disables refresh and keeps the close action available", () => {
  mockFetch.mockImplementation(() => new Promise(() => {}));
  const onClose = jest.fn();
  setup(onClose);

  expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText("No delivery attempts yet.")
  ).not.toBeInTheDocument();
});

test("a failed history request shows a load error and recovers on refresh", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 500,
    json: async () => ({ error: "private database diagnostic" }),
  });
  mockFetch.mockResolvedValueOnce(response([]));
  setup();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load API settings. Refresh to retry."
  );
  expect(
    screen.queryByText("private database diagnostic")
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("No delivery attempts yet.")
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByText("No delivery attempts yet.")
  ).toBeInTheDocument();
});
