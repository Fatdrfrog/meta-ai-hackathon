/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import messages from "../../../../../messages/settings/api/en/page.json";
import { CustomerApiSettings } from "./customer-api-settings";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const catalog = jest.requireActual(
      "../../../../../messages/settings/api/en/page.json"
    ).CustomerApiSettings;
    const value = key
      .split(".")
      .reduce(
        (current: Record<string, unknown>, part: string) =>
          current[part] as Record<string, unknown>,
        catalog
      ) as unknown as string;
    return value.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
      String(values?.[name] ?? name)
    );
  },
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

const key = {
  id: "key-1",
  name: "Orders",
  key_prefix: "sk_prefix",
  permissions: {
    read: true,
    write: false,
    conversations: true,
    analytics: true,
  },
  is_active: true,
  expires_at: null,
  last_used_at: null,
  created_at: "2026-10-03T00:00:00Z",
  rate_limit_per_minute: 60,
};
const webhook = {
  id: "hook-1",
  url: "https://example.com/hook",
  events: ["message.received"],
  description: "Order events",
  is_active: true,
  created_at: "2026-10-03T00:00:00Z",
  last_triggered_at: null,
  total_deliveries: 0,
  successful_deliveries: 0,
  failed_deliveries: 0,
};
const mockFetch = jest.fn();
const response = (data: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => data,
});

function setup() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CustomerApiSettings workspaceId="workspace-1" />
    </SWRConfig>
  );
}

beforeEach(() => {
  installResizeObserver();
  installMatchMedia();
  mockFetch.mockReset();
  global.fetch = mockFetch;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return response(
        url.endsWith("api-keys")
          ? { apiKey: key, secret: "sk_test_once" }
          : { webhook, secret: "whsec_test_once" }
      );
    if (init?.method === "DELETE")
      return response({ apiKey: { ...key, is_active: false } });
    if (init?.method === "PATCH")
      return response({
        webhook: { ...webhook, ...JSON.parse(init.body as string) },
        secret: "whsec_rotated_once",
      });
    if (url.includes("/deliveries")) return response({ deliveries: [] });
    return response(
      url.endsWith("api-keys")
        ? { apiKeys: [] }
        : {
            webhooks: [],
            supportedEvents: ["message.received", "message.status_updated"],
          }
    );
  });
});

test("creates a scoped key and removes its one-time secret after closing", async () => {
  setup();
  await screen.findByText("No API keys yet.");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Orders" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  expect(await screen.findByDisplayValue("sk_test_once")).toBeInTheDocument();
  const create = mockFetch.mock.calls.find(
    ([, init]) => init.method === "POST"
  );
  expect(JSON.parse(create![1].body)).toMatchObject({
    name: "Orders",
    permissions: {
      read: true,
      write: false,
      conversations: true,
      analytics: true,
    },
  });
  expect(
    screen.getByRole("button", { name: "Copy secret" })
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByDisplayValue("sk_test_once")).not.toBeInTheDocument()
  );
  expect(screen.getByText("sk_prefix…")).toBeInTheDocument();
});

test("a one-time secret is retained when switching tabs during key creation", async () => {
  setup();
  await screen.findByText("No API keys yet.");
  let complete!: (value: unknown) => void;
  mockFetch.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve;
      })
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Orders" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  await waitFor(() => expect(complete).toBeDefined());
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Webhooks" }), {
    button: 0,
    ctrlKey: false,
  });
  await act(async () => {
    complete(response({ apiKey: key, secret: "sk_tab_switch_once" }));
  });
  expect(
    await screen.findByDisplayValue("sk_tab_switch_once")
  ).toBeInTheDocument();
});

test("permission badges report effective scopes rather than legacy scope flags", async () => {
  mockFetch.mockImplementation(async (url: string) =>
    response(
      url.endsWith("api-keys")
        ? {
            apiKeys: [
              {
                ...key,
                permissions: {
                  read: false,
                  write: true,
                  conversations: true,
                  analytics: true,
                },
              },
            ],
          }
        : { webhooks: [], supportedEvents: [] }
    )
  );
  setup();
  await screen.findByText("sk_prefix…");
  expect(
    screen.queryByText("Read conversations", { exact: true })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Read analytics", { exact: true })
  ).not.toBeInTheDocument();
});

test("requires explicit confirmation to revoke and updates only after success", async () => {
  mockFetch.mockResolvedValueOnce(response({ apiKeys: [key] }));
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  expect(
    mockFetch.mock.calls.some(([, init]) => init.method === "DELETE")
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText("Revoked")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled();
});

test("does not show a false empty state when loading fails", async () => {
  mockFetch.mockResolvedValue(response({}, false));
  setup();
  expect(
    (await screen.findAllByText(messages.CustomerApiSettings.loadError)).length
  ).toBeGreaterThan(0);
  expect(screen.queryByText("No API keys yet.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create API key" })).toBeDisabled();
});

test("expiry uses the end of the browser's local date", async () => {
  setup();
  await screen.findByText("No API keys yet.");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Orders" },
  });
  fireEvent.change(screen.getByLabelText("Expiry date"), {
    target: { value: "2027-02-15" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  await screen.findByDisplayValue("sk_test_once");
  const create = mockFetch.mock.calls.find(
    ([, init]) => init.method === "POST"
  );
  expect(JSON.parse(create![1].body).expires_at).toBe(
    new Date("2027-02-15T23:59:59.999").toISOString()
  );
});

test("shows a localized validation reason without exposing unknown server errors", async () => {
  setup();
  await screen.findByText("No API keys yet.");
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 400,
    json: async () => ({ error: "Expiry must be in the future" }),
  });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Orders" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  expect(
    await screen.findByText(messages.CustomerApiSettings.expiryError)
  ).toBeInTheDocument();
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 500,
    json: async () => ({ error: "secret database diagnostic" }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  expect(
    await screen.findByText(messages.CustomerApiSettings.actionError)
  ).toBeInTheDocument();
  expect(
    screen.queryByText("secret database diagnostic")
  ).not.toBeInTheDocument();
});

test("a failed mutation preserves the form and never claims a key was created", async () => {
  setup();
  await screen.findByText("No API keys yet.");
  mockFetch.mockResolvedValueOnce(response({}, false));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Orders" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
  expect(
    await screen.findByText(messages.CustomerApiSettings.actionError)
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Orders");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("creates a webhook with selected events and a one-time signing secret", async () => {
  setup();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Webhooks" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No webhook endpoints yet.");
  fireEvent.change(screen.getByLabelText("Endpoint URL"), {
    target: { value: "https://example.com/hook" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));
  expect(
    await screen.findByDisplayValue("whsec_test_once")
  ).toBeInTheDocument();
  const create = mockFetch.mock.calls.find(
    ([url, init]) => url.endsWith("webhooks") && init.method === "POST"
  );
  expect(JSON.parse(create![1].body)).toMatchObject({
    events: ["message.received", "message.status_updated"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByText("Order events")).toBeInTheDocument();
});

test("edits, disables and rotates a webhook without exposing the stored secret", async () => {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH")
      return response({
        webhook: { ...webhook, ...JSON.parse(init.body as string) },
        ...(JSON.parse(init.body as string).rotate_secret
          ? { secret: "whsec_rotated_once" }
          : {}),
      });
    return response(
      url.endsWith("api-keys")
        ? { apiKeys: [] }
        : {
            webhooks: [webhook],
            supportedEvents: ["message.received", "message.status_updated"],
          }
    );
  });
  setup();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Webhooks" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Endpoint URL")).toHaveValue(webhook.url);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  expect(await screen.findByText("Disabled")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByDisplayValue("whsec_rotated_once")
  ).toBeInTheDocument();
});
