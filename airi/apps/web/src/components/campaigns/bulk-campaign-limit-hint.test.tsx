/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { BulkCampaignLimitHint } from "./bulk-campaign-limit-hint";

jest.mock("@/components/billing/plan-upgrade-dialog", () => ({
  PlanUpgradeDialog: ({ open, reason }: { open: boolean; reason?: string }) =>
    open ? <div role="dialog">upgrade {reason ?? "default"}</div> : null,
}));

const t = (key: string, values?: Record<string, string | number | Date>) =>
  `${key}:${values?.remaining ?? ""}`;
const freeLimit = {
  subscriptionType: "free" as const,
  bulkRecipientLimit: 500,
  bulkRecipientCount: 200,
  bulkRecipientsRemaining: 300,
};
const exhaustedLimit = {
  ...freeLimit,
  bulkRecipientCount: 500,
  bulkRecipientsRemaining: 0,
};

it("keeps remaining allowance quiet and makes exhausted allowance actionable", () => {
  const { rerender } = render(
    <BulkCampaignLimitHint limit={freeLimit} t={t} />
  );
  expect(screen.getByText("bulkLimit.freeRemaining:300")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(<BulkCampaignLimitHint limit={exhaustedLimit} t={t} />);
  expect(screen.getByRole("alert").textContent).toBe(
    "bulkLimit.freeExhausted:0"
  );
});

it("omits an unlimited-plan banner and never turns unavailable data into a success notice", () => {
  const { container, rerender } = render(
    <BulkCampaignLimitHint
      limit={{
        ...freeLimit,
        subscriptionType: "pro",
        bulkRecipientLimit: null,
      }}
      t={t}
    />
  );
  expect(container.textContent).toBe("");
  rerender(<BulkCampaignLimitHint limit={undefined} t={t} />);
  expect(container.textContent).toBe("");
  // Usage that could not be read is never shown as a full allowance.
  rerender(
    <BulkCampaignLimitHint
      limit={{
        ...freeLimit,
        bulkRecipientCount: null,
        bulkRecipientsRemaining: null,
      }}
      t={t}
    />
  );
  expect(container.textContent).toBe("");
});

it("says only the first recipients that fit will send, without blocking", () => {
  const values: Array<Record<string, string | number | Date> | undefined> = [];
  const recordingT = (
    key: string,
    params?: Record<string, string | number | Date>
  ) => {
    values.push(params);
    return t(key, params);
  };
  const { rerender } = render(
    <BulkCampaignLimitHint
      limit={freeLimit}
      t={recordingT}
      workspaceId="workspace-1"
      recipientCount={300}
    />
  );
  expect(screen.getByText("bulkLimit.freeRemaining:300")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();

  rerender(
    <BulkCampaignLimitHint
      limit={freeLimit}
      t={recordingT}
      workspaceId="workspace-1"
      recipientCount={10000}
    />
  );
  expect(screen.getByRole("status").textContent).toContain(
    "bulkLimit.freeTrimmed:300"
  );
  expect(values).toContainEqual({
    remaining: 300,
    limit: 500,
    used: 200,
    count: 10000,
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "bulkLimit.upgrade:" })
  ).toBeTruthy();
});

it("opens the plans dialog from a used-up allowance", () => {
  const { rerender } = render(
    <BulkCampaignLimitHint limit={freeLimit} t={t} workspaceId="workspace-1" />
  );
  expect(screen.queryByRole("button")).toBeNull();

  rerender(
    <BulkCampaignLimitHint
      limit={exhaustedLimit}
      t={t}
      workspaceId="workspace-1"
      id="limit-reason"
    />
  );
  expect(screen.getByRole("alert").id).toBe("limit-reason");
  fireEvent.click(screen.getByRole("button", { name: "bulkLimit.upgrade:" }));
  expect(screen.getByRole("dialog").textContent).toBe("upgrade default");
});

it("asks to reopen the workspace after the trial ends", () => {
  render(
    <BulkCampaignLimitHint
      limit={{ ...exhaustedLimit, trialExpired: true }}
      t={t}
      workspaceId="workspace-1"
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "bulkLimit.upgrade:" }));
  expect(screen.getByRole("dialog").textContent).toBe("upgrade trial_expired");
});
