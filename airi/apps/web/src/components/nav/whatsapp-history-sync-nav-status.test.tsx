/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { WhatsAppHistorySyncNavStatus } from "./whatsapp-history-sync-nav-status";

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      const messages = require("../../../messages/en.json").WhatsAppHistorySync;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        messages[key] ?? key
      );
    },
}));

describe("WhatsAppHistorySyncNavStatus", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("shows active history sync status and links to WhatsApp integration settings", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          history_sync: {
            requested_at: new Date().toISOString(),
            status: "in_progress",
            last_progress: 42,
          },
        },
      }),
    } as Response);

    render(<WhatsAppHistorySyncNavStatus workspaceId="workspace-1" />);

    const link = await screen.findByRole("link", {
      name: "WhatsApp history: Receiving WhatsApp history",
    });

    expect(link).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?integration=whatsapp"
    );
    expect(screen.getByText("Receiving WhatsApp history")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("hides terminal history sync status from the navbar", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          history_sync: {
            requested_at: new Date().toISOString(),
            status: "completed",
            last_progress: 100,
          },
        },
      }),
    } as Response);

    render(<WhatsAppHistorySyncNavStatus workspaceId="workspace-1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("hides stale requested history sync status from the navbar", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-07T00:00:00.000Z"));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          history_sync: {
            requested_at: "2026-05-02T15:59:47.701Z",
            request_id: "782F6722D44E038636",
            range_days: 180,
          },
        },
      }),
    } as Response);

    render(<WhatsAppHistorySyncNavStatus workspaceId="workspace-1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
