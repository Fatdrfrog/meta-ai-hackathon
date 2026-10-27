/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "node:util";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRealtime } from "@/hooks/use-realtime";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { toast } from "sonner";
import useSWR from "swr";
import { ConversationSales } from "./conversation-sales";

jest.mock("swr", () => jest.fn());
jest.mock("@/hooks/use-realtime", () => ({ useRealtime: jest.fn() }));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const suggestion = {
  messageId: "message-1",
  kind: "receipt",
  amount: 45000,
  currency: "KZT",
  occurredAt: "2026-09-10T10:00:00.000Z",
  conversionId: null,
};

describe("ConversationSales", () => {
  const originalFetch = global.fetch;
  const mutate = jest.fn();
  const viewMessage = jest.fn();
  const bind = jest.fn();
  const unbind = jest.fn();
  const renderSales = () =>
    render(
      <ConversationSales
        presentation="info"
        conversationId="conversation-1"
        workspaceId="workspace-1"
        onViewMessage={viewMessage}
      />
    );

  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    viewMessage.mockReturnValue(true);
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [suggestion],
        defaultCurrency: "KZT",
        transactionIdSupported: true,
      },
      error: undefined,
      isLoading: false,
      mutate,
    });
    (useRealtime as jest.Mock).mockReturnValue({ channel: { bind, unbind } });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  it("reviews evidence and records only the merchant's edited amount after confirmation", async () => {
    renderSales();
    expect(screen.queryByText(/needsConfirmation/)).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "viewMessage" }));
    expect(viewMessage).toHaveBeenCalledWith("message-1");
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "reviewPayment" }));
    expect(
      screen.getByText("paymentConfirmationDescription")
    ).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "saleAmount" })).toHaveValue(
      45000
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "saleAmount" }), {
      target: { value: "42000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual({
      conversationId: "conversation-1",
      conversionType: "sale",
      conversionValue: 42000,
      currency: "KZT",
      metadata: {},
      paymentEvidenceMessageId: "message-1",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("opens and edits sales with the real realtime hook without resubscribing", () => {
    Object.assign(globalThis, { TextDecoder, TextEncoder });
    (useRealtime as jest.Mock).mockImplementation(
      jest.requireActual("@/hooks/use-realtime").useRealtime
    );
    global.fetch = jest.fn(() => new Promise(() => {}));
    render(
      <ConversationSales
        presentation="info"
        conversationId="507f1f77bcf86cd799439011"
        workspaceId="123e4567-e89b-12d3-a456-426614174000"
        onViewMessage={viewMessage}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "recordSale" }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "120" },
    });

    expect(screen.getByRole("spinbutton")).toHaveValue(120);
    expect(screen.getByRole("button", { name: "confirmSale" })).toBeEnabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/realtime/token?workspaceId=123e4567-e89b-12d3-a456-426614174000",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("explains how to find a source outside loaded history", () => {
    viewMessage.mockReturnValue(false);
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "viewMessage" }));
    expect(toast.info).toHaveBeenCalledWith("sourceMessageNotLoaded");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("requires a positive amount for manual sales and uses the workspace currency", async () => {
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: "recordSale" }));
    expect(screen.getByRole("button", { name: "confirmSale" })).toBeDisabled();
    for (const value of ["0", "-1", "100000000", "1.234"]) {
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
      expect(
        screen.getByRole("button", { name: "confirmSale" })
      ).toBeDisabled();
    }
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    ).toEqual({
      conversationId: "conversation-1",
      conversionType: "sale",
      conversionValue: 99.5,
      currency: "KZT",
      metadata: {},
    });
  });

  it("leaves an unidentified amount blank and falls back to workspace currency", () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [{ ...suggestion, amount: null, currency: null }],
        defaultCurrency: "KZT",
      },
      mutate,
    });
    renderSales();
    expect(screen.queryByText(/amountUnknown/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "reviewPayment" }));
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
    expect(
      screen.getByRole("combobox", { name: "currency" })
    ).toHaveTextContent("KZT");
    expect(screen.getByRole("button", { name: "confirmSale" })).toBeDisabled();
  });

  it("shows confirmed evidence without a second confirmation action", () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [{ ...suggestion, conversionId: "conversion-1" }],
        defaultCurrency: "KZT",
      },
      mutate,
    });
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    expect(screen.getByText("saleRecorded")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "reviewPayment" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/needsConfirmation/)).not.toBeInTheDocument();
  });

  it("preserves corrections after a failed save and prevents duplicate clicks while saving", async () => {
    let finish!: (response: { ok: boolean }) => void;
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "reviewPayment" }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    expect(screen.getByRole("button", { name: "tracking" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "tracking" }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(123);
    expect(toast.error).toHaveBeenCalledWith("toast.error");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("loads only suggestions and refreshes on this conversation's classification-ready event", () => {
    const result = renderSales();
    expect((useSWR as jest.Mock).mock.calls[0][0]).toContain(
      "paymentSuggestionsOnly=true"
    );
    expect(useRealtime).toHaveBeenCalledWith({
      kind: "workspace",
      workspaceId: "workspace-1",
    });
    const refresh = bind.mock.calls.find(
      ([name]) => name === "conversation.row.changed"
    )?.[1];
    refresh({
      conversationId: "other",
      eventId: "classification-ready:revision-1",
    } as RealtimeEventEnvelope);
    refresh({
      conversationId: "conversation-1",
      eventId: "message-1",
    } as RealtimeEventEnvelope);
    expect(mutate).not.toHaveBeenCalled();
    refresh({
      conversationId: "conversation-1",
      eventId: "classification-ready:revision-1",
    } as RealtimeEventEnvelope);
    expect(mutate).toHaveBeenCalledTimes(1);
    result.unmount();
    expect(unbind).toHaveBeenCalledWith("conversation.row.changed", refresh);
  });

  it("offers retry after a load error and keeps manual entry available in an empty conversation", () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: undefined,
      error: new Error("failed"),
      mutate,
    });
    const { rerender } = renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("paymentsError");
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByRole("button", { name: "recordSale" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "recordSale" }));
    expect(
      screen.getByRole("combobox", { name: "currency" })
    ).toHaveTextContent("USD");
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    (useSWR as jest.Mock).mockReturnValue({
      data: { paymentSuggestions: [], defaultCurrency: "KZT" },
      mutate,
    });
    rerender(
      <ConversationSales
        presentation="info"
        conversationId="conversation-1"
        workspaceId="workspace-1"
        onViewMessage={viewMessage}
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "recordSale" })).toBeEnabled();
  });

  it("waits for the initial currency load before enabling manual entry", () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      mutate,
    });
    renderSales();
    expect(screen.getByRole("button", { name: "recordSale" })).toBeDisabled();
  });

  it("requires the provider payment reference when the sales webhook is enabled", async () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [suggestion],
        defaultCurrency: "KZT",
        transactionIdRequired: true,
      },
      mutate,
    });
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "reviewPayment" }));
    expect(screen.getByRole("button", { name: "confirmSale" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("transactionIdRequired"), {
      target: { value: "  kaspi-payment-123  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    ).toMatchObject({
      transactionId: "kaspi-payment-123",
      paymentEvidenceMessageId: "message-1",
    });
  });

  it("preserves the sale and requests a reference when the webhook was enabled after loading", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ code: "transaction_id_required" }),
    });
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: /paymentSuggestions/ }));
    fireEvent.click(screen.getByRole("button", { name: "reviewPayment" }));
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "transactionIdMissing"
    );
    expect(screen.getByRole("spinbutton")).toHaveValue(45000);
    expect(screen.getByLabelText("transactionIdRequired")).toBeRequired();
    expect(screen.getByRole("button", { name: "confirmSale" })).toBeDisabled();
  });

  it("keeps the reference field out of sales on channels that do not support it", async () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [],
        defaultCurrency: "KZT",
        transactionIdSupported: false,
        transactionIdRequired: false,
      },
      mutate,
    });
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: "recordSale" }));
    expect(screen.queryByLabelText("transactionId")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("transactionIdRequired")
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "25000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    ).not.toHaveProperty("transactionId");
  });

  it("reveals the required reference after a failed suggestions load", async () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: undefined,
      error: new Error("failed"),
      mutate,
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ code: "transaction_id_required" }),
    });
    renderSales();
    fireEvent.click(screen.getByRole("button", { name: "recordSale" }));
    expect(screen.queryByLabelText("transactionId")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "confirmSale" }));
    expect(
      await screen.findByLabelText("transactionIdRequired")
    ).toBeRequired();
    expect(screen.getByRole("spinbutton")).toHaveValue(99);
  });

  it("keeps desktop sales behind one icon and opens the chosen event from its submenu", async () => {
    (useSWR as jest.Mock).mockImplementation(key => ({
      data: Array.isArray(key)
        ? { runs: [] }
        : {
            paymentSuggestions: [suggestion],
            defaultCurrency: "KZT",
            transactionIdSupported: true,
          },
      mutate,
    }));
    render(
      <ConversationSales
        conversationId="conversation-1"
        workspaceId="workspace-1"
        onViewMessage={viewMessage}
      />
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText("recordSale")).not.toBeInTheDocument();
    expect(screen.queryByText(/needsConfirmation/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "salesActions" }), {
      key: "Enter",
    });
    const submenu = await screen.findByRole("menuitem", {
      name: "recordEvent",
    });
    fireEvent.keyDown(submenu, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "events.service_scheduled" })
    );
    const eventDialog = await screen.findByRole("dialog", {
      name: "recordEvent",
    });
    expect(
      within(eventDialog).getByRole("combobox", { name: "eventType" })
    ).toHaveTextContent("events.service_scheduled");
    expect(within(eventDialog).getByLabelText("dueDate")).toBeRequired();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("opens manual entry from the compact menu and omits unsupported event triggers", async () => {
    (useSWR as jest.Mock).mockReturnValue({
      data: {
        paymentSuggestions: [],
        defaultCurrency: "KZT",
        transactionIdSupported: false,
      },
      mutate,
    });
    render(
      <ConversationSales
        conversationId="conversation-1"
        workspaceId="workspace-1"
        onViewMessage={viewMessage}
      />
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "salesActions" }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "recordSale" })
    );
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
    expect(screen.queryByText("recordEvent")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "currency" })
    ).toHaveTextContent("KZT");
  });
});
