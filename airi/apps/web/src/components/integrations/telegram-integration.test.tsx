/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSource } from "@/app/actions";
import { TelegramIntegration } from "./telegram-integration";
import type { Source } from "@/types/supabase";

jest.mock("@/app/actions", () => ({
  createTelegramSource: jest.fn(),
  updateSource: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace-1" }),
  useRouter: () => ({ refresh: jest.fn() }),
}));

describe("TelegramIntegration", () => {
  const connectedSource = (enabled?: unknown) =>
    ({
      id: "telegram-source-1",
      type: "telegram",
      workspace_id: "workspace-1",
      credentials: {
        has_bot_token: true,
        bot_username: "airi_bot",
        ...(enabled === undefined ? {} : { ai_reactions_enabled: enabled }),
      },
    }) as Source;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(updateSource).mockResolvedValue({ success: true });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("/api/telegram/validate-token")) {
        return {
          ok: true,
          json: async () => ({
            valid: true,
            botInfo: { username: "new_bot", first_name: "New bot" },
          }),
        } as Response;
      }

      if (url.includes("/api/sources/telegram/set-webhook")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            isConfigured: true,
            webhookInfo: {
              url: "https://app.airi.chat/api/telegram/webhook",
              pending_update_count: 0,
            },
          }),
        } as Response;
      }

      if (url.includes("/api/sources/telegram/telegram-source-1/subscribers")) {
        return {
          ok: true,
          json: async () => ({
            total: 5,
            subscribers: [],
            latestImport: {
              status: "completed",
              totalRows: 5,
              validRows: 5,
              invalidRows: 0,
              duplicateRows: 0,
              insertedRows: 5,
              updatedRows: 0,
              completedAt: "2026-06-23T00:00:00.000Z",
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }) as jest.Mock;
  });

  it.each([undefined, false, "true"])(
    "keeps AI reactions off unless the stored setting is true (%s)",
    async enabled => {
      render(<TelegramIntegration source={connectedSource(enabled)} />);

      expect(
        await screen.findByRole("switch", { name: "aiReactions.title" })
      ).not.toBeChecked();
      expect(screen.getByText("aiReactions.description")).toBeInTheDocument();
    }
  );

  it("saves the AI reaction setting without resubmitting credentials", async () => {
    const user = userEvent.setup();
    render(<TelegramIntegration source={connectedSource()} />);
    const toggle = await screen.findByRole("switch", {
      name: "aiReactions.title",
    });

    await user.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    expect(updateSource).toHaveBeenCalledWith("telegram-source-1", {
      credentials: { ai_reactions_enabled: true },
    });
  });

  it("restores the saved value and shows a recoverable error when saving fails", async () => {
    jest.mocked(updateSource).mockResolvedValue({ error: "Save failed" });
    const user = userEvent.setup();
    render(<TelegramIntegration source={connectedSource(true)} />);
    const toggle = await screen.findByRole("switch", {
      name: "aiReactions.title",
    });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(await screen.findByText("aiReactions.saveFailed")).toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
  });

  it("disables reaction changes while a save is pending", async () => {
    let finishSave!: (result: { success: true }) => void;
    jest.mocked(updateSource).mockReturnValue(
      new Promise(resolve => {
        finishSave = resolve;
      })
    );
    const user = userEvent.setup();
    render(<TelegramIntegration source={connectedSource()} />);
    const toggle = await screen.findByRole("switch", {
      name: "aiReactions.title",
    });

    await user.click(toggle);
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("aiReactions.saving");

    finishSave({ success: true });
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it("keeps the setting disabled in the integration preview", async () => {
    render(
      <TelegramIntegration
        source={connectedSource(true)}
        connectionActionsDisabled
      />
    );

    expect(
      await screen.findByRole("switch", { name: "aiReactions.title" })
    ).toBeDisabled();
  });

  it("never fills the token field for a connected bot", async () => {
    render(<TelegramIntegration source={connectedSource()} />);

    expect(
      await screen.findByText("botConfiguration.alreadyConnected.title")
    ).toBeInTheDocument();
    expect(
      screen.getByText("botConfiguration.replaceTokenHint")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("botConfiguration.tokenLabel")).toHaveValue(
      ""
    );
    expect(
      screen.queryByText("botConfiguration.createBot.title")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "botConfiguration.saveButton" })
    ).not.toBeInTheDocument();
  });

  it("replaces the token with a newly validated one and clears the field", async () => {
    const user = userEvent.setup();
    render(<TelegramIntegration source={connectedSource()} />);
    const input = await screen.findByLabelText("botConfiguration.tokenLabel");

    await user.type(input, "456:new");
    await user.click(
      screen.getByRole("button", { name: "botConfiguration.validateButton" })
    );
    await user.click(
      await screen.findByRole("button", {
        name: "botConfiguration.saveButton",
      })
    );

    expect(updateSource).toHaveBeenCalledWith("telegram-source-1", {
      credentials: { bot_token: "456:new", bot_username: "new_bot" },
    });
    await waitFor(() => expect(input).toHaveValue(""));
    // The new bot's webhook is checked again, not the old bot's status kept.
    const webhookChecks = jest
      .mocked(global.fetch)
      .mock.calls.filter(([url]) =>
        String(url).includes("/api/sources/telegram/set-webhook?sourceId=")
      );
    expect(webhookChecks.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the bot setup steps until a token is saved", async () => {
    render(
      <TelegramIntegration
        source={
          {
            id: "telegram-source-1",
            type: "telegram",
            workspace_id: "workspace-1",
            credentials: { has_bot_token: false, ai_reactions_enabled: false },
          } as Source
        }
      />
    );

    expect(
      await screen.findByText("botConfiguration.createBot.title")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("botConfiguration.replaceTokenHint")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "aiReactions.title" })
    ).not.toBeInTheDocument();
  });

  it("shows subscriber import/export controls for a connected bot", async () => {
    const source = {
      id: "telegram-source-1",
      type: "telegram",
      workspace_id: "workspace-1",
      credentials: {
        has_bot_token: true,
        bot_username: "airi_bot",
      },
    } as Source;

    render(<TelegramIntegration source={source} workspaceId="workspace-1" />);

    expect(await screen.findByText("Subscribers")).toBeInTheDocument();
    expect(screen.getByText("CSV in/out. Same bot only.")).toBeInTheDocument();
    expect(await screen.findByText("5")).toBeInTheDocument();
    expect(screen.getByText("completed / 5 ok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/sources/telegram/telegram-source-1/subscribers?workspaceId=workspace-1&limit=10"
      )
    );
  });
});
