/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { installMatchMedia } from "@/test-support/dom-test-utils";
import { BulkCampaignSendSummaryDialog } from "./bulk-campaign-send-summary-dialog";

jest.mock("next-intl", () =>
  jest
    .requireActual("@/test-support/next-intl-test-utils")
    .createCatalogNextIntlMock(
      jest.requireActual("../../../messages/analytics/en/page.json")
    )
);

const { createCatalogNextIntlMock } = jest.requireActual(
  "@/test-support/next-intl-test-utils"
);
const t = createCatalogNextIntlMock(
  jest.requireActual("../../../messages/analytics/en/page.json")
).useTranslations("MultiChannelCampaignBuilder");

const summary = {
  message: "spring_offer",
  sender: "+7 700 000 00 00",
  recipientCount: 248,
  skippedByReason: {
    marketing_opt_out: 3,
    prior_failure: 0,
    service_window: 1,
  },
};

describe("BulkCampaignSendSummaryDialog", () => {
  beforeEach(() => {
    installMatchMedia();
  });

  it("lists the message, sender, recipients and who is left out", () => {
    render(
      <BulkCampaignSendSummaryDialog
        summary={summary}
        t={t}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />
    );

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Send this campaign?")).toBeInTheDocument();
    expect(within(dialog).getByText("spring_offer")).toBeInTheDocument();
    expect(within(dialog).getByText("+7 700 000 00 00")).toBeInTheDocument();
    expect(
      screen.getByTestId("bulk-campaign-send-summary-recipients")
    ).toHaveTextContent("248 recipients");
    const skipped = screen.getByTestId("bulk-campaign-send-summary-skipped");
    expect(skipped).toHaveTextContent("Left out");
    // Nothing is sent yet, so the result list's "Not sent" title stays out.
    expect(skipped).not.toHaveTextContent("Not sent");
    expect(skipped).toHaveTextContent("Marketing opt-out3");
    expect(skipped).toHaveTextContent("Service window1");
    expect(skipped).not.toHaveTextContent("Prior failure");
  });

  it("leaves out the skipped section and sender when there are none", () => {
    render(
      <BulkCampaignSendSummaryDialog
        summary={{ message: "Text message", recipientCount: 1 }}
        t={t}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />
    );
    expect(
      screen.queryByTestId("bulk-campaign-send-summary-skipped")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Sent from")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("bulk-campaign-send-summary-recipients")
    ).toHaveTextContent("1 recipient");
  });

  it("says when the list runs over the daily limit", () => {
    render(
      <BulkCampaignSendSummaryDialog
        summary={{
          ...summary,
          overflowPlan: {
            recipientCount: 1500,
            dailyLimit: 1000,
            exceedsDailyLimit: true,
            firstWaveCount: 1000,
            queuedCount: 500,
            waveCount: 2,
            lastWaveAt: null,
          },
        }}
        t={t}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />
    );
    expect(
      screen.getByText(/Daily limit is 1000\. 1000 send now, and 500 wait/)
    ).toBeInTheDocument();
  });

  it("sends only from the confirm button", () => {
    const onConfirm = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <BulkCampaignSendSummaryDialog
        summary={summary}
        t={t}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Send campaign" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("returns focus to Send after closing", async () => {
    const dialogProps = { t, onOpenChange: jest.fn(), onConfirm: jest.fn() };
    const { rerender } = render(
      <>
        <button type="button">Send to 248 recipients</button>
        <BulkCampaignSendSummaryDialog summary={null} {...dialogProps} />
      </>
    );
    const send = screen.getByRole("button", { name: "Send to 248 recipients" });
    send.focus();

    rerender(
      <>
        <button type="button">Send to 248 recipients</button>
        <BulkCampaignSendSummaryDialog summary={summary} {...dialogProps} />
      </>
    );
    expect(document.activeElement).not.toBe(send);

    rerender(
      <>
        <button type="button">Send to 248 recipients</button>
        <BulkCampaignSendSummaryDialog summary={null} {...dialogProps} />
      </>
    );
    // Radix restores focus on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(send));
  });

  it("focuses the element the caller names, even when focus left Send", async () => {
    const dialogProps = { t, onOpenChange: jest.fn(), onConfirm: jest.fn() };
    const { rerender } = render(
      <>
        <button type="button">Send</button>
        <BulkCampaignSendSummaryDialog summary={summary} {...dialogProps} />
      </>
    );
    // The open dialog hides the page from the accessibility tree.
    const send = screen.getByRole("button", { name: "Send", hidden: true });
    rerender(
      <>
        <button type="button">Send</button>
        <BulkCampaignSendSummaryDialog
          summary={null}
          returnFocusTo={() => send}
          {...dialogProps}
        />
      </>
    );
    await waitFor(() => expect(document.activeElement).toBe(send));
  });

  it("renders nothing without a summary", () => {
    render(
      <BulkCampaignSendSummaryDialog
        summary={null}
        t={t}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
