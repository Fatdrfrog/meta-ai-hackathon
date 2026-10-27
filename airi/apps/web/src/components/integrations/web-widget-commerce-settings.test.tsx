/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import messages from "../../../messages/settings/integrations/en/page.json";
import { WebWidgetCommerceSettings } from "./web-widget-commerce-settings";

const mockMutate = jest.fn();
let mockData: Record<string, unknown> | undefined;
let mockError: Error | undefined;
const mockUseSWR = jest.fn();

jest.mock("swr", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSWR(...args),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    const commerce = (
      messages as unknown as {
        WebWidgetIntegration: { commerce: Record<string, unknown> };
      }
    ).WebWidgetIntegration.commerce;
    const value = key
      .split(".")
      .reduce<unknown>(
        (current, part) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[part]
            : undefined,
        commerce
      );
    if (typeof value !== "string") return key;
    return Object.entries(values ?? {}).reduce(
      (result, [name, replacement]) =>
        result.replace(`{${name}}`, replacement),
      value
    );
  },
}));

describe("web widget commerce settings", () => {
  const originalFetch = global.fetch;
  const originalClipboard = navigator.clipboard;
  const integrationProps = {
    workspaceId: "workspace-1",
    clientKey: "client-key-1",
    widgetUrl: "https://widget.airi.chat",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockError = undefined;
    mockData = {
      enabled: false,
      whatsappSourceId: "wa-1",
      shopifyShopDomain: null,
      hasWebhookSecret: false,
      hasShopifyWebhookSecret: false,
      whatsappSources: [{ id: "wa-1", name: "Store WhatsApp" }],
      webhookUrl: "https://airi.chat/api/commerce/source-1",
      shopifyWebhookUrl: "https://airi.chat/api/commerce/source-1/shopify",
      tildaWebhookUrl:
        "https://airi.chat/api/commerce/source-1/tilda?token=masked",
      lastEventAt: null,
      recentCarts: [],
    };
    mockUseSWR.mockImplementation(() => ({
      data: mockData,
      error: mockError,
      isLoading: !mockData && !mockError,
      mutate: mockMutate,
    }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("does not claim event readiness before the first storefront event", () => {
    render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Receiving events")).not.toBeInTheDocument();

    mockData = { ...mockData, enabled: true };
    const view = render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-2"
      />
    );
    expect(view.getByText("Waiting for first event")).toBeInTheDocument();
    expect(view.queryByText("Receiving events")).not.toBeInTheDocument();
  });

  it("shows the Shopify webhook only once a shop domain is set", () => {
    const configured = render(
      <WebWidgetCommerceSettings {...integrationProps} sourceId="source-1" />
    );
    expect(screen.getByLabelText("Shopify webhook URL")).toHaveValue(
      "https://airi.chat/api/commerce/source-1/shopify"
    );
    configured.unmount();

    mockData = { ...mockData, shopifyWebhookUrl: null };
    const view = render(
      <WebWidgetCommerceSettings {...integrationProps} sourceId="source-2" />
    );
    expect(view.queryByLabelText("Shopify webhook URL")).not.toBeInTheDocument();
  });

  it("requires a mapped WhatsApp source before recovery can be enabled", () => {
    mockData = {
      ...mockData,
      whatsappSourceId: null,
      whatsappSources: [],
    };
    render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    expect(screen.getByText(/Connect a WhatsApp source/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable cart recovery" })).toBeDisabled();
  });

  it("saves source mapping and Shopify credentials only after an explicit action", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...mockData,
        enabled: true,
        shopifyShopDomain: "store.myshopify.com",
        hasShopifyWebhookSecret: true,
      }),
    });
    render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    fireEvent.click(screen.getByRole("switch", { name: "Enable cart recovery" }));
    fireEvent.change(screen.getByLabelText("Shopify shop domain"), {
      target: { value: "store.myshopify.com" },
    });
    fireEvent.change(screen.getByLabelText("Shopify webhook signing secret"), {
      target: { value: "shopify-secret" },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save commerce settings" }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/sources/source-1/commerce",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            action: "save",
            enabled: true,
            whatsappSourceId: "wa-1",
            shopifyShopDomain: "store.myshopify.com",
            shopifyWebhookSecret: "shopify-secret",
          }),
        })
      )
    );
    expect(mockMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ webhookSecret: expect.anything() }),
      { revalidate: false }
    );
  });

  it("shows a rotated generic webhook secret once and copies credential URLs", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...mockData,
        hasWebhookSecret: true,
        webhookSecret: "one-time-secret",
      }),
    });
    render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Create signing secret" }));
    expect(await screen.findByLabelText("Webhook signing secret")).toHaveValue(
      "one-time-secret"
    );
    expect(mockMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ webhookSecret: expect.anything() }),
      { revalidate: false }
    );
    const tildaInput = screen.getByLabelText<HTMLInputElement>("Tilda webhook URL");
    const tildaCopy = tildaInput.parentElement?.querySelector("button");
    expect(tildaInput.value).toContain("?token=");
    expect(tildaCopy).not.toBeNull();
    fireEvent.click(tildaCopy!);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        tildaInput.value
      )
    );
  });

  it("has loading and error retry states", () => {
    mockData = undefined;
    const view = render(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading commerce settings");
    mockError = new Error("network");
    view.rerender(
      <WebWidgetCommerceSettings
        {...integrationProps}
        sourceId="source-1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockMutate).toHaveBeenCalled();
  });
});
