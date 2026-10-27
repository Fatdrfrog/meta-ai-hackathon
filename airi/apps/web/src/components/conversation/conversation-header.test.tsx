/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import { ConversationHeader } from "./conversation-header";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === "handoffBannerTitle") {
      return "Handoff active";
    }

    if (key === "handoffBannerAssignedAt" && values?.time) {
      return `Active since ${values.time}`;
    }

    return key;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarImage: () => null,
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button type="button" onClick={() => onCheckedChange(!checked)}>
      {checked ? "on" : "off"}
    </button>
  ),
}));

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

jest.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => (
    <textarea {...props} />
  ),
}));

describe("ConversationHeader", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as jest.Mock;
  });

  it("shows the handoff indicator time and hides it when the bot is enabled", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const handoffStartedAt = new Date(2026, 3, 20, 10, 30, 0);

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled={false}
        airiCoachEnabled
        handoff={{ startedAt: handoffStartedAt }}
      />
    );

    expect(screen.getByLabelText("Handoff active")).toBeInTheDocument();
    expect(
      screen.getByText(`Active since ${handoffStartedAt.toLocaleString()}`)
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "off" })[0]);

    await waitFor(() => {
      expect(screen.queryByLabelText("Handoff active")).not.toBeInTheDocument();
    });
  });

  it("toggles scenario automation independently from the bot", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled
        airiScenariosEnabled={false}
        airiCoachEnabled
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "off" })[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/conversations/conv_1/airi",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ scenario_enabled: true }),
        })
      );
    });
  });

  it("enables the bot without the retired assign field", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled={false}
        airiScenariosEnabled
        airiCoachEnabled
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "off" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/conversations/conv_1/airi",
        expect.objectContaining({
          body: JSON.stringify({ bot_enabled: true }),
        })
      );
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("toasts.botEnabled");
    });
  });

  it("names a failed toggle once and restores the switch and coach state", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const onCoachToggle = jest.fn();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Workspace bot is off" }),
      });

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        onCoachToggle={onCoachToggle}
        airiBotEnabled
        airiScenariosEnabled
        airiCoachEnabled={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "off" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "toasts.failedToToggleAiriCoach"
      );
    });
    expect(onCoachToggle.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByRole("button", { name: "off" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "on" })[0]);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "toasts.failedToToggleAiriBot: Workspace bot is off"
      );
    });
    expect(screen.getAllByRole("button", { name: "on" })).toHaveLength(2);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("opens conversation info directly from the overflow button", () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const onOpenInfo = jest.fn();

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled
        airiScenariosEnabled={false}
        airiCoachEnabled
        onOpenInfo={onOpenInfo}
      />
    );

    fireEvent.click(screen.getByLabelText("showInfo"));

    expect(onOpenInfo).toHaveBeenCalledTimes(1);
  });

  it("shows an active quick-note icon and saves note edits", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const onQuickNoteChange = jest.fn();

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled
        airiScenariosEnabled={false}
        airiCoachEnabled
        quickNote="VIP customer"
        onQuickNoteChange={onQuickNoteChange}
      />
    );

    const noteButton = screen.getAllByLabelText("quickNote")[0];
    expect(noteButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(noteButton);
    expect(screen.getByText("quickNoteTitle")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("quickNoteTextarea"), {
      target: { value: "Call back after lunch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "saveQuickNote" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/conversations/conv_1/quick-note",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ note: "Call back after lunch" }),
        })
      );
    });
    await waitFor(() => {
      expect(onQuickNoteChange).toHaveBeenCalledWith("Call back after lunch");
    });
    expect(mutate).toHaveBeenCalled();
  });

  it("clears the quick note and restores it when saving fails", async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const onQuickNoteChange = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Nope" }),
    });

    render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled
        airiScenariosEnabled={false}
        airiCoachEnabled
        quickNote="Keep this"
        onQuickNoteChange={onQuickNoteChange}
      />
    );

    fireEvent.click(screen.getAllByLabelText("quickNote")[0]);
    fireEvent.click(screen.getByRole("button", { name: "clearQuickNote" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/conversations/conv_1/quick-note",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ note: null }),
        })
      );
    });
    expect(onQuickNoteChange).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("renders a single quick-note control without duplicate compact mobile action", () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const { container } = render(
      <ConversationHeader
        conversationTitle="Alice"
        conversationSubtitle="3 messages"
        conversationId="conv_1"
        mutate={mutate}
        airiBotEnabled
        airiScenariosEnabled={false}
        airiCoachEnabled
      />
    );

    const noteButtons = Array.from(
      container.querySelectorAll('button[aria-label="quickNote"]')
    );

    expect(noteButtons).toHaveLength(1);
    expect(noteButtons.some(button => button.textContent === "")).toBe(true);
    expect(screen.queryByText("quickNoteShort")).not.toBeInTheDocument();
  });

  it("reuses header state and handlers for controls placed inside Info", async () => {
    function HeaderWithInfo() {
      const [enabled, setEnabled] = React.useState(false);
      return (
        <ConversationHeader
          conversationTitle="Alice"
          conversationSubtitle="3 messages"
          conversationId="conv_1"
          mutate={async () => {
            setEnabled(true);
          }}
          airiBotEnabled={enabled}
          airiScenariosEnabled
          airiCoachEnabled
          renderInfo={controls => (
            <section aria-label="info-actions">{controls}</section>
          )}
        />
      );
    }
    render(<HeaderWithInfo />);
    const info = screen.getByRole("region", { name: "info-actions" });
    fireEvent.click(within(info).getByRole("button", { name: "off" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        within(info).queryByRole("button", { name: "off" })
      ).not.toBeInTheDocument()
    );
    expect(screen.getAllByRole("button", { name: "on" })).toHaveLength(6);
    fireEvent.click(within(info).getByRole("button", { name: "quickNote" }));
    expect(screen.getByLabelText("quickNoteTextarea")).toBeInTheDocument();
  });
});
