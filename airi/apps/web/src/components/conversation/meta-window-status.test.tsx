/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import React from "react";
import { MetaWindowStatus } from "./meta-window-status";

jest.mock("next-intl", () => {
  const messages = jest.requireActual(
    "../../../messages/conversations/en/page.json"
  ).ConversationDetailView as Record<string, string>;
  const translate = (key: string, values?: Record<string, unknown>) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
      values && name in values ? String(values[name]) : match
    );
  translate.rich = translate;
  return {
    useLocale: () => "en",
    useTranslations: () => translate,
  };
});

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

const expiredWindow = {
  isWithinWindow: false,
  hoursRemaining: 0,
  lastCustomerMessageAt: "2026-07-07T08:00:00.000Z",
};

describe("MetaWindowStatus", () => {
  it("renders expired WhatsApp window action without redundant description", () => {
    render(
      <MetaWindowStatus
        conversationId="conversation-1"
        channel="whatsapp"
        windowInfo={expiredWindow}
      />
    );

    expect(
      screen.getByText("WhatsApp 24-hour messaging window expired.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "You can only send approved template messages or wait for the customer to message again."
      )
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send Template" })
    ).toBeInTheDocument();
  });

  it.each([
    {
      state: "approved",
      humanAgent: { supported: true, enabled: true },
      description: /Manual Human Agent reply is available/,
    },
    {
      state: "past its 7-day window",
      humanAgent: {
        supported: true,
        enabled: false,
        reason: "human_agent_window_expired",
      },
      description: /allowed only within 7 days/,
    },
    {
      state: "not approved",
      humanAgent: { supported: false, enabled: false },
      description: /Human Agent is not approved for this Meta app yet/,
    },
  ])(
    "explains an expired Instagram window when Human Agent is $state",
    ({ humanAgent, description }) => {
      render(
        <MetaWindowStatus
          conversationId="conversation-1"
          channel="instagram"
          windowInfo={expiredWindow}
          humanAgent={humanAgent}
        />
      );

      expect(
        screen.getByText("Instagram 24-hour messaging window expired.")
      ).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Send Template" })
      ).not.toBeInTheDocument();
    }
  );
});
