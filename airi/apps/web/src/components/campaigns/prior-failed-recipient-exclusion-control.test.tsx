/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { PriorFailedRecipientExclusionControl } from "./prior-failed-recipient-exclusion-control";
import type { BulkCampaignEligibilityPreviewState } from "./use-bulk-campaign-recipient-eligibility-preview";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: string | number }) =>
    values?.count !== undefined ? `${key}:${values.count}` : key,
}));

const onChange = jest.fn();
const onRetry = jest.fn();

const IDLE: BulkCampaignEligibilityPreviewState = {
  state: "idle",
  canSubmit: true,
};
const LOADING: BulkCampaignEligibilityPreviewState = {
  state: "loading",
  canSubmit: false,
  retry: jest.fn(),
};
const FAILED: BulkCampaignEligibilityPreviewState = {
  state: "error",
  canSubmit: false,
  error: "Recipient eligibility unavailable",
  retry: jest.fn(),
};

function ready({
  excluded = 0,
  allExcluded = false,
}: {
  excluded?: number;
  allExcluded?: boolean;
}): BulkCampaignEligibilityPreviewState {
  const requestedTotal = Math.max(excluded, 1);
  const acceptedTotal = allExcluded ? 0 : requestedTotal - excluded;
  return {
    state: "ready",
    canSubmit: !allExcluded,
    retry: jest.fn(),
    preview: {
      state: "ready",
      evaluatedAt: "2026-10-05T12:00:00.000Z",
      requestedTotal,
      acceptedTotal,
      uniqueRecipients: { requested: requestedTotal, accepted: acceptedTotal },
      skippedByReason: excluded > 0 ? { prior_failure: excluded } : {},
      warnings: { missingMarketingConsent: 0 },
      allExcluded,
      readiness: {
        state: "ready",
        checkedAt: "2026-10-05T12:00:00.000Z",
        remainingCapacity: null,
        reasons: [],
      },
    },
  };
}

describe("PriorFailedRecipientExclusionControl", () => {
  beforeEach(() => {
    onChange.mockReset();
    onRetry.mockReset();
  });

  it("discloses optional filtering without hiding the filter state", () => {
    const { container } = render(
      <PriorFailedRecipientExclusionControl
        value={false}
        supported
        eligibility={IDLE}
        onChange={onChange}
      />
    );

    const control = screen.getByTestId("prior-failed-recipient-exclusion-control");
    expect(control).toBeTruthy();
    expect(control.className).toMatch(/flex-wrap|min-w-0/);
    expect(container.firstElementChild?.className).toMatch(/flex-wrap|min-w-0/);
    expect(screen.queryByRole("switch")).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "recipientFilters recipientFiltersOff",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const switchEl = screen.getByRole("switch", {
      name: "excludePriorFailedBulkSendsLabel",
    });
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    expect(switchEl).not.toHaveProperty("disabled", true);
    expect(screen.getByText("excludePriorFailedBulkSendsHint")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a supported on switch", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={IDLE}
        onChange={onChange}
      />
    );

    expect(screen.getByText("recipientFiltersActive")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /recipientFilters/ }));
    expect(
      screen
        .getByRole("switch", { name: "excludePriorFailedBulkSendsLabel" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("shows loading copy while an enabled preview is in flight", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={LOADING}
        onChange={onChange}
      />
    );

    expect(screen.getByText("priorFailedBulkSendsLoading")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the ready excluded count", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={ready({ excluded: 12 })}
        onChange={onChange}
      />
    );

    expect(
      screen.getByText("priorFailedBulkSendsExcludedInline:12")
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the excluded count in the header once the check is ready", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={ready({ excluded: 3 })}
        onChange={onChange}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "recipientFilters recipientFiltersExcluded:3",
      })
    ).toBeTruthy();
    expect(screen.queryByText("recipientFiltersActive")).toBeNull();
  });

  it("shows no excluded count when the check skipped nobody for prior failures", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={ready({})}
        onChange={onChange}
      />
    );

    expect(screen.getByText("recipientFiltersActive")).toBeTruthy();
    expect(screen.queryByText(/priorFailedBulkSendsExcludedInline/)).toBeNull();
  });

  it("does not blame the filter for an empty list while it is off", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value={false}
        supported
        eligibility={ready({ allExcluded: true })}
        onChange={onChange}
      />
    );

    expect(screen.queryByText("priorFailedBulkSendsAllExcluded")).toBeNull();
  });

  it("leaves a failed check to the readiness notice when no retry is passed", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={FAILED}
        onChange={onChange}
      />
    );

    expect(
      screen.queryByText("priorFailedBulkSendsLookupUnavailable")
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "priorFailedBulkSendsRetry" })
    ).toBeNull();
  });

  it("shows all-excluded copy when every recipient is excluded", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={ready({ excluded: 4, allExcluded: true })}
        onChange={onChange}
      />
    );

    expect(screen.getByText("priorFailedBulkSendsAllExcluded")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows an error with retry", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={FAILED}
        onChange={onChange}
        onRetry={onRetry}
      />
    );

    expect(
      screen.getByText("priorFailedBulkSendsLookupUnavailable")
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "priorFailedBulkSendsRetry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["loading", "error"] as const)("does not attribute %s audience checks to a disabled optional filter", previewState => {
    render(
      <PriorFailedRecipientExclusionControl
        value={false}
        supported
        eligibility={previewState === "loading" ? LOADING : FAILED}
        onChange={onChange}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByText("priorFailedBulkSendsLoading")).toBeNull();
    expect(screen.queryByText("priorFailedBulkSendsLookupUnavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "priorFailedBulkSendsRetry" })).toBeNull();
  });

  it("disables an unsupported switch and shows the disabled reason", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value={false}
        supported={false}
        eligibility={IDLE}
        disabledReason="priorFailedBulkSendsUnsupported"
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /recipientFilters/ }));
    const switchEl = screen.getByRole("switch", {
      name: "excludePriorFailedBulkSendsLabel",
    }) as HTMLButtonElement;
    expect(switchEl.disabled).toBe(true);
    expect(screen.getByText("priorFailedBulkSendsUnsupported")).toBeTruthy();
    fireEvent.click(switchEl);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("activates the supported switch from the keyboard Space key", () => {
    render(
      <PriorFailedRecipientExclusionControl
        value={false}
        supported
        eligibility={IDLE}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /recipientFilters/ }));
    const switchEl = screen.getByRole("switch", {
      name: "excludePriorFailedBulkSendsLabel",
    });
    switchEl.focus();
    fireEvent.keyDown(switchEl, { key: " ", code: "Space" });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("wraps on a mobile width and keeps long translated text from overflowing", () => {
    const longHint =
      "Исключить получателей с ошибкой последней массовой доставки и очень длинным пояснением которое должно переноситься без горизонтального переполнения";
    const { container } = render(
      <PriorFailedRecipientExclusionControl
        value
        supported
        eligibility={ready({ excluded: 1000000 })}
        onChange={onChange}
        labels={{
          label: "Исключить получателей с ошибкой последней массовой доставки",
          hint: longHint,
          excluded: "{count} получателей будут исключены из этой кампании.",
        }}
      />
    );

    const root = screen.getByTestId("prior-failed-recipient-exclusion-control");
    expect(root.className).toMatch(/min-w-0/);
    fireEvent.click(screen.getByRole("button", { name: /recipientFilters/ }));
    const copy = container.querySelector("[data-slot='exclusion-copy']");
    expect(copy?.className).toMatch(/min-w-0/);
    expect(copy?.className).toMatch(/break-words|whitespace-normal/);
  });

  it("keeps switch ids unique when more than one control is on the page", () => {
    render(
      <>
        <PriorFailedRecipientExclusionControl
          switchId="exclude-prior-failed-a"
          value={false}
          supported
          eligibility={IDLE}
          onChange={onChange}
        />
        <PriorFailedRecipientExclusionControl
          switchId="exclude-prior-failed-b"
          value
          supported
          eligibility={IDLE}
          onChange={onChange}
        />
      </>
    );

    screen.getAllByRole("button", { name: /recipientFilters/ }).forEach(trigger => fireEvent.click(trigger));
    const switches = screen.getAllByRole("switch", {
      name: "excludePriorFailedBulkSendsLabel",
    });
    expect(switches.map(el => el.id)).toEqual([
      "exclude-prior-failed-a",
      "exclude-prior-failed-b",
    ]);
  });
});
