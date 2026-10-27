/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { BulkCampaignOverflowQueuePlan } from "@/lib/campaign/bulk-campaign-overflow-queue";
import { BulkCampaignOverflowQueueDialog } from "./bulk-campaign-overflow-queue-dialog";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const plan: BulkCampaignOverflowQueuePlan = {
  recipientCount: 2_500,
  dailyLimit: 1_000,
  exceedsDailyLimit: true,
  waveCount: 3,
  firstWaveCount: 1_000,
  queuedCount: 1_500,
  lastWaveAt: "2026-10-07T09:00:00.000Z",
};

beforeEach(() => {
  // The alert dialog asks useIsMobile for the viewport.
  installMatchMedia();
});

function translate(
  key: string,
  values?: Record<string, string | number | Date>
) {
  return values ? `${key}:${JSON.stringify(values)}` : key;
}

it("builds its copy from the caller's namespace and the plan", () => {
  const t = jest.fn(translate);
  const onConfirm = jest.fn();
  render(
    <BulkCampaignOverflowQueueDialog
      plan={plan}
      t={t}
      onOpenChange={jest.fn()}
      onConfirm={onConfirm}
    />
  );

  expect(screen.getByText("overflowQueue.title")).toBeTruthy();
  expect(t).toHaveBeenCalledWith("overflowQueue.description", {
    recipientCount: 2_500,
    dailyLimit: 1_000,
    firstWaveCount: 1_000,
    queuedCount: 1_500,
    lastWaveAt: new Date(plan.lastWaveAt!).toLocaleString(),
  });
  expect(
    screen.getByRole("button", { name: "overflowQueue.cancel" })
  ).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: "overflowQueue.confirm" })
  );
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("passes an empty last wave when the plan has no queued waves", () => {
  const t = jest.fn(translate);
  render(
    <BulkCampaignOverflowQueueDialog
      plan={{ ...plan, lastWaveAt: null }}
      t={t}
      onOpenChange={jest.fn()}
      onConfirm={jest.fn()}
    />
  );

  expect(t).toHaveBeenCalledWith(
    "overflowQueue.description",
    expect.objectContaining({ lastWaveAt: "" })
  );
});

it("stays closed without a plan", () => {
  render(
    <BulkCampaignOverflowQueueDialog
      plan={null}
      t={translate}
      onOpenChange={jest.fn()}
      onConfirm={jest.fn()}
    />
  );

  expect(screen.queryByText("overflowQueue.title")).toBeNull();
});
