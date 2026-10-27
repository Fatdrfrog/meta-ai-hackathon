/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { BulkCampaignAudienceComposer } from "./bulk-campaign-audience-composer";

jest.mock("./campaign-recipient-picker", () => ({
  CampaignRecipientPicker: () => <div data-testid="campaign-recipient-picker" />,
}));

jest.mock("./telegram-audience-selector", () => ({
  TelegramAudienceSelector: () => (
    <div data-testid="telegram-audience-selector" />
  ),
}));

const picker = {
  workspaceId: "workspace-1",
  channel: "whatsapp" as const,
  recipients: [],
  onRecipientsChange: jest.fn(),
};

describe("BulkCampaignAudienceComposer", () => {
  it("renders the recipient picker without telegram when no telegram props are given", () => {
    render(<BulkCampaignAudienceComposer picker={picker} />);

    expect(screen.getByTestId("bulk-campaign-audience-composer")).toBeTruthy();
    expect(screen.getByTestId("campaign-recipient-picker")).toBeTruthy();
    expect(screen.queryByTestId("telegram-audience-selector")).toBeNull();
  });

  it("renders telegram, known-audience note, and a hidden picker", () => {
    render(
      <BulkCampaignAudienceComposer
        hideRecipientPicker
        knownAudienceNote={<p>known-note</p>}
        telegram={{
          audienceMode: "manual",
          onAudienceModeChange: jest.fn(),
          onSourceChange: jest.fn(),
          selectedSourceId: "bot-1",
          sources: [{ id: "bot-1" }],
          subscriberCount: 3,
        }}
        picker={picker}
      />
    );

    expect(screen.getByTestId("telegram-audience-selector")).toBeTruthy();
    expect(screen.getByText("known-note")).toBeTruthy();
    expect(
      screen.getByTestId("campaign-recipient-picker").parentElement?.className
    ).toContain("hidden");
  });
});
