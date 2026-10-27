/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BulkCampaignReadiness } from "@icecore/scenario-contracts";
import messages from "../../../messages/analytics/en/page.json";
import {
  CampaignDispatchPlanCard,
  CampaignReadinessNotice,
} from "./campaign-dispatch-plan-card";

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      const text = key
        .split(".")
        .reduce<unknown>(
          (entry, part) => (entry as Record<string, unknown>)[part],
          messages.CampaignDispatchPlanCard
        ) as string;
      return text
        .replace(
          /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
          (_, name: string, one: string, other: string) =>
            (values[name] === 1 ? one : other).replace(
              /#/g,
              String(values[name])
            )
        )
        .replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
    },
  useFormatter: () => ({
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en", {
        timeZone: "UTC",
        ...options,
      }).format(value),
  }),
}));

jest.mock("./campaign-dispatch-live-status", () => ({
  CampaignDispatchPlanLiveStatus: () => <div>Live delivery counts</div>,
}));

jest.mock("@/components/billing/plan-upgrade-dialog", () => ({
  PlanUpgradeDialog: () => null,
}));

const ready: BulkCampaignReadiness = {
  state: "ready",
  checkedAt: "2026-09-16T10:00:00.000Z",
  remainingCapacity: null,
  reasons: [],
};
function Wrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

describe("CampaignReadinessNotice", () => {
  it("shows one plan status while retaining the separate failed template check", () => {
    const retry = jest.fn();
    render(
      <CampaignReadinessNotice
        workspaceId="workspace-free"
        companyLimits={{
          subscriptionType: "free",
          bulkRecipientExhausted: true,
          bulkRecipientCount: 500,
          bulkRecipientLimit: 500,
        }}
        readiness={ready}
        readinessError
        readinessErrorCode="template_lookup_unavailable"
        onRefreshReadiness={retry}
        reasonId="send-status"
      />
    );
    expect(
      screen
        .getByTestId("campaign-readiness")
        .getAttribute("data-readiness-state")
    ).toBe("plan_blocked");
    expect(screen.queryByText("Ready to send")).toBeNull();
    expect(screen.getByRole("button", { name: "View Pro plan" })).toBeTruthy();
    expect(
      screen.getByText("We couldn’t verify this template with WhatsApp.")
    ).toBeTruthy();
    expect(document.getElementById("send-status")).toBeTruthy();
    expect(screen.queryByText(/500\/500/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Usage details" }));
    expect(
      screen.getByText("Recipients sent: 500. Free allowance: 500 in total.")
    ).toBeTruthy();
  });

  it("forwards plan and other blockers through the shared card for every channel", () => {
    const { rerender } = render(
      <CampaignDispatchPlanCard
        preview={{ channel: "telegram", configured: true }}
        companyLimits={{
          subscriptionType: "free",
          conversationExhausted: true,
        }}
        workspaceId="workspace-free"
      />
    );
    expect(
      screen
        .getByTestId("campaign-readiness")
        .getAttribute("data-readiness-state")
    ).toBe("plan_blocked");
    rerender(
      <CampaignDispatchPlanCard
        preview={{ channel: "whatsapp", configured: true, readiness: ready }}
        sendBlockedElsewhere
        blockedMessage="Choose an approved template."
      />
    );
    expect(screen.queryByText("Ready to send")).toBeNull();
    expect(screen.getByText("Choose an approved template.")).toBeTruthy();
  });

  it("keeps missing Telegram credentials inside the single plan status", () => {
    render(
      <CampaignDispatchPlanCard
        preview={{ channel: "telegram", configured: false }}
        companyLimits={{
          subscriptionType: "free",
          conversationExhausted: true,
        }}
        workspaceId="workspace-free"
      />
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-readiness-state")).toBe("plan_blocked");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      status.contains(
        screen.getByText(
          messages.CampaignDispatchPlanCard.credentialsUnavailable
        )
      )
    ).toBe(true);
  });

  beforeEach(() => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    jest
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...resolvedOptions.call(this), timeZone: "Asia/Qyzylorda" };
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it("distinguishes ready, checking and unavailable without treating quality as capacity", () => {
    const refresh = jest.fn();
    const { rerender } = render(
      <CampaignReadinessNotice
        readiness={ready}
        onRefreshReadiness={refresh}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Ready to send")).toBeTruthy();
    expect(screen.queryByText(/remaining sending capacity/)).toBeNull();
    expect(screen.queryByText(/Checked Sep/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/remaining sending capacity/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender(
      <CampaignReadinessNotice
        readiness={ready}
        checkingReadiness
        onRefreshReadiness={refresh}
      />
    );
    expect(
      screen
        .getByTestId("campaign-readiness")
        .getAttribute("data-readiness-state")
    ).toBe("checking");
    expect(
      (
        screen.getByRole("button", {
          name: "Retry check",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    rerender(
      <CampaignReadinessNotice
        readiness={ready}
        readinessError
        onRefreshReadiness={refresh}
      />
    );
    expect(screen.getByText("Sending check unavailable")).toBeTruthy();
    expect(screen.queryByText("Ready to send")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it.each([
    "meta_rate_limited",
    "template_lookup_unavailable",
    "template_unavailable",
    "plan_unavailable",
  ] as const)("says why a check failed with %s", code => {
    const text = messages.CampaignDispatchPlanCard.readiness.errors[code];
    expect(text).toEqual(expect.any(String));
    render(
      <CampaignReadinessNotice
        readinessError
        readinessErrorCode={code}
        onRefreshReadiness={jest.fn()}
      />
    );
    // Retrying won't bring back a missing number, and a rate limit says when
    // to try again in its own line.
    expect(
      screen.getByText(
        code === "plan_unavailable"
          ? "Can't send yet"
          : code === "meta_rate_limited"
            ? "Can't check the send yet"
            : "Sending check unavailable"
      )
    ).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(
      screen.queryByText(
        messages.CampaignDispatchPlanCard.readiness.unavailableDescription
      )
    ).toBeNull();
  });

  it.each([["eligibility_lookup_failed"], [undefined]])(
    "falls back to the generic hint for the %s code",
    code => {
      const { rerender } = render(
        <CampaignReadinessNotice readinessError readinessErrorCode={code} />
      );
      expect(
        screen.getByText(
          messages.CampaignDispatchPlanCard.readiness.unavailableDescription
        )
      ).toBeTruthy();
      rerender(
        <CampaignReadinessNotice
          readinessError
          readinessErrorCode={code}
          checkingReadiness
        />
      );
      expect(
        screen.queryByText(
          messages.CampaignDispatchPlanCard.readiness.unavailableDescription
        )
      ).toBeNull();
    }
  );

  it("retains an independent missing-number fix alongside a template blocker", () => {
    render(
      <CampaignReadinessNotice
        workspaceId="workspace-1"
        blockedMessage="Couldn't load WhatsApp templates."
        readinessError
        readinessErrorCode="plan_unavailable"
      />
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Couldn't load WhatsApp templates.")).toBeTruthy();
    expect(
      screen.getByText(
        messages.CampaignDispatchPlanCard.readiness.errors.plan_unavailable
      )
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open WhatsApp settings" })
        .getAttribute("href")
    ).toBe("/panel/w/workspace-1/settings/integrations?integration=whatsapp");
  });

  it("retains an independent rate-limit deadline alongside a template blocker", () => {
    const now = new Date("2026-10-05T10:00:00Z").getTime();
    jest.useFakeTimers({ now });
    try {
      render(
        <CampaignReadinessNotice
          blockedMessage="Couldn't load WhatsApp templates."
          readinessError
          readinessErrorCode="meta_rate_limited"
          retryAt={now + 60_000}
          onRefreshReadiness={jest.fn()}
        />
      );
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(
        screen.getByText("Couldn't load WhatsApp templates.")
      ).toBeTruthy();
      expect(
        screen.getByText(
          messages.CampaignDispatchPlanCard.readiness.errors.meta_rate_limited
        )
      ).toBeTruthy();
      expect(
        screen.getByText(/^Try again after .+ \(Asia\/Qyzylorda\)\.$/)
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Retry check",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("says a missing WhatsApp number once, in a line Send can point at", () => {
    render(
      <CampaignDispatchPlanCard
        preview={{ configured: false, channel: "whatsapp" }}
        showReadiness
        readinessError
        readinessErrorCode="plan_unavailable"
        reasonId="readiness-reason"
        onRefreshReadiness={jest.fn()}
      />
    );
    const reason = screen.getByText(
      messages.CampaignDispatchPlanCard.readiness.errors.plan_unavailable
    );
    expect(document.getElementById("readiness-reason")?.contains(reason)).toBe(
      true
    );
    expect(screen.getByText("Can't send yet")).toBeTruthy();
    expect(
      screen.queryByText(
        messages.CampaignDispatchPlanCard.credentialsUnavailable
      )
    ).toBeNull();
  });

  it("links a missing WhatsApp number to Integrations when the workspace is known", () => {
    const { rerender } = render(
      <CampaignDispatchPlanCard
        workspaceId="workspace-1"
        preview={{ configured: false, channel: "whatsapp" }}
        showReadiness
        readinessError
        readinessErrorCode="plan_unavailable"
        onRefreshReadiness={jest.fn()}
      />
    );
    const link = screen.getByRole("link", { name: "Open WhatsApp settings" });
    expect(link.getAttribute("href")).toBe(
      "/panel/w/workspace-1/settings/integrations?integration=whatsapp"
    );
    expect(link.getAttribute("target")).toBeNull();

    rerender(
      <CampaignDispatchPlanCard
        preview={{ configured: false, channel: "whatsapp" }}
        showReadiness
        readinessError
        readinessErrorCode="plan_unavailable"
        onRefreshReadiness={jest.fn()}
      />
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers no link for a failure nothing can be opened to fix", () => {
    render(
      <CampaignReadinessNotice
        workspaceId="workspace-1"
        readinessError
        readinessErrorCode="meta_rate_limited"
      />
    );
    expect(screen.queryByTestId("campaign-readiness-fixes")).toBeNull();
  });

  it("keeps Refresh disabled while a send is in flight", () => {
    const refresh = jest.fn();
    const { rerender } = render(
      <CampaignReadinessNotice
        readiness={ready}
        onRefreshReadiness={refresh}
        refreshDisabled
      />
    );
    const button = () =>
      screen.getByRole("button", { name: "Recheck" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    rerender(
      <CampaignReadinessNotice readiness={ready} onRefreshReadiness={refresh} />
    );
    expect(button().disabled).toBe(false);
  });

  it("keeps Refresh disabled until the server's retry time", async () => {
    const now = new Date("2026-10-05T10:00:00Z").getTime();
    jest.useFakeTimers({ now });
    try {
      const refresh = jest.fn();
      render(
        <CampaignDispatchPlanCard
          preview={{ configured: true, channel: "whatsapp", readiness: ready }}
          showReadiness
          readinessError
          readinessErrorCode="meta_rate_limited"
          retryAt={now + 60_000}
          onRefreshReadiness={refresh}
        />
      );
      const button = () =>
        screen.getByRole("button", {
          name: "Retry check",
        }) as HTMLButtonElement;
      expect(
        screen.getByText(
          messages.CampaignDispatchPlanCard.readiness.errors.meta_rate_limited
        )
      ).toBeTruthy();
      // The server's retry time can be minutes away, so say when.
      const retryHint = /^Try again after .+ \(Asia\/Qyzylorda\)\.$/;
      expect(screen.getByText(retryHint)).toBeTruthy();
      expect(button().disabled).toBe(true);
      fireEvent.click(button());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(59_999);
      });
      expect(button().disabled).toBe(true);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(button().disabled).toBe(false);
      expect(screen.queryByText(retryHint)).toBeNull();
      fireEvent.click(button());
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("says when to try again after a rate limit once, with the date", () => {
    const now = new Date("2026-10-05T10:00:00Z").getTime();
    jest.useFakeTimers({ now });
    try {
      render(
        <CampaignReadinessNotice
          readinessError
          readinessErrorCode="meta_rate_limited"
          retryAt={now + 3 * 60 * 60_000}
          onRefreshReadiness={jest.fn()}
        />
      );
      const notice = screen.getByTestId("campaign-readiness");
      expect(screen.getByText("Can't check the send yet")).toBeTruthy();
      expect(notice.textContent?.match(/try again/gi)).toHaveLength(1);
      // A cooldown can last hours, so the time keeps its date.
      expect(notice.textContent).toContain("Oct 5, 2026");
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows Meta restrictions and exact local hold counts with localized eligibility time", () => {
    render(
      <CampaignReadinessNotice
        readiness={{
          ...ready,
          state: "blocked",
          reasons: [
            { code: "meta_sender_restricted", providerCode: "131048" },
            {
              code: "contact_frequency_limit",
              affectedRecipientCount: 84,
              eligibleRecipientCount: 27,
              nextEligibleAt: "2026-09-17T10:15:00.000Z",
            },
          ],
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Can't send yet")).toBeTruthy();
    expect(screen.getByText(/WhatsApp has restricted sending/)).toBeTruthy();
    expect(screen.queryByText(/131048/)).toBeNull();
    expect(
      screen.getByText(/84 recipients were contacted too recently/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Sep 17, 2026, 3:15 PM \(Asia\/Qyzylorda\)/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/131048/)).toBeTruthy();
    expect(
      screen.getByText(/Checked Sep 16, 2026, 3:00 PM \(Asia\/Qyzylorda\)/)
    ).toBeTruthy();
  });

  it("opens WhatsApp Manager once for Meta restrictions, in a new tab", () => {
    render(
      <CampaignReadinessNotice
        workspaceId="workspace-1"
        readiness={{
          ...ready,
          state: "blocked",
          reasons: [
            { code: "meta_sender_restricted" },
            { code: "meta_business_limit" },
            { code: "contact_frequency_limit", affectedRecipientCount: 3 },
            { code: "meta_billing" },
          ],
        }}
      />,
      { wrapper: Wrapper }
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("Open WhatsApp Manager");
    expect(links[0].getAttribute("href")).toBe(
      "https://business.facebook.com/wa/manage/"
    );
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("sends a disconnected number back to Integrations", () => {
    render(
      <CampaignReadinessNotice
        workspaceId="workspace-1"
        readiness={{
          ...ready,
          state: "blocked",
          reasons: [{ code: "meta_disconnected" }, { code: "meta_billing" }],
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual([
      "Open WhatsApp settings",
      "Open WhatsApp Manager",
    ]);
  });

  it("does not display an unknown readiness as ready or promise a missing cooldown deadline", () => {
    const { rerender } = render(<CampaignReadinessNotice />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText("Sending check unavailable")).toBeTruthy();
    rerender(
      <CampaignReadinessNotice
        readiness={{
          ...ready,
          state: "blocked",
          reasons: [
            {
              code: "contact_frequency_limit",
              affectedRecipientCount: 2,
              nextEligibleAt: null,
            },
          ],
        }}
      />
    );
    expect(
      screen.getByText(
        messages.CampaignDispatchPlanCard.readiness.cooldownUnknown
      )
    ).toBeTruthy();
  });

  it("never shows a green ready next to a send with nobody left", () => {
    render(
      <CampaignDispatchPlanCard
        preview={{ configured: true, channel: "whatsapp", readiness: ready }}
        readiness={ready}
        allExcluded
        onRefreshReadiness={jest.fn()}
      />,
      { wrapper: Wrapper }
    );
    const notice = screen.getByTestId("campaign-readiness");
    expect(notice.getAttribute("data-readiness-state")).toBe("noRecipients");
    expect(notice.className).toContain("border-amber-200");
    expect(screen.getByText("No recipients to send to")).toBeTruthy();
    expect(screen.queryByText("Ready to send")).toBeNull();
  });

  it("asks only for recipients once a message is chosen", () => {
    const { rerender } = render(<CampaignReadinessNotice awaitingAudience />, {
      wrapper: Wrapper,
    });
    expect(
      screen.getByText("Choose a message and add recipients")
    ).toBeTruthy();

    rerender(
      <CampaignDispatchPlanCard
        preview={{ configured: true, channel: "whatsapp", readiness: ready }}
        awaitingAudience
        messageSelected
        onRefreshReadiness={jest.fn()}
      />
    );
    expect(screen.getByText("Add recipients")).toBeTruthy();
    expect(
      screen
        .getByTestId("campaign-readiness")
        .getAttribute("data-readiness-state")
    ).toBe("awaitingAudience");
  });

  it("keeps the next draft checks and live delivery counts without internal dispatch details", () => {
    render(
      <CampaignDispatchPlanCard
        preview={{ configured: true, channel: "whatsapp", readiness: ready }}
        queuedDispatch={{
          total: 111,
          status: "completed",
          workflowId: "internal-workflow-id",
        }}
        showReadiness
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Ready to send")).toBeTruthy();
    expect(screen.getByText("111 recipients")).toBeTruthy();
    expect(screen.getByText("Live delivery counts")).toBeTruthy();
    expect(screen.queryByText("internal-workflow-id")).toBeNull();
    expect(screen.queryByText("Payload staging")).toBeNull();
  });

  it.each([
    { channel: "whatsapp", configured: false },
    { channel: "whatsapp", configured: true },
    { channel: "telegram", configured: false },
    { channel: "email", configured: false },
  ] as const)(
    "offers retry instead of reconnecting for a $channel check failure with configured=$configured",
    ({ channel, configured }) => {
      const refresh = jest.fn();
      const { rerender } = render(
        <CampaignDispatchPlanCard
          preview={{ channel, configured, readiness: ready, error: "HTTP 503" }}
          previewError
          showReadiness={channel === "whatsapp"}
          onRefreshPreview={refresh}
          onRefreshReadiness={channel === "whatsapp" ? refresh : undefined}
        />
      );
      expect(screen.getAllByText("Sending check unavailable")).toHaveLength(1);
      expect(
        screen.queryByText(
          messages.CampaignDispatchPlanCard.credentialsUnavailable
        )
      ).toBeNull();
      expect(screen.queryByText("Ready to send")).toBeNull();
      expect(screen.queryByText("HTTP 503")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
      expect(refresh).toHaveBeenCalledTimes(1);

      rerender(
        <CampaignDispatchPlanCard
          preview={{ channel, configured: false }}
          showReadiness={false}
          onRefreshPreview={refresh}
        />
      );
      expect(
        screen.getByText(
          messages.CampaignDispatchPlanCard.credentialsUnavailable
        )
      ).toBeTruthy();
      expect(screen.queryByText("Sending check unavailable")).toBeNull();
    }
  );

  it("does not show worker pacing or phone quality as user-facing send controls", () => {
    render(
      <CampaignDispatchPlanCard
        preview={{
          configured: true,
          channel: "whatsapp",
          readiness: ready,
          batchPlan: {
            batchSize: 20,
            delayMs: 250,
            ratePerSecond: 80,
            rateSource: "meta_phone_throughput",
          },
          whatsappMeta: {
            sourceId: "source-1",
            phoneNumberId: "internal-phone-id",
            detailsSource: "meta_phone_details",
            qualityRating: "GREEN",
            throughputLevel: "STANDARD",
          },
        }}
      />
    );
    expect(screen.getByText("Ready to send")).toBeTruthy();
    for (const label of [
      "Batch size",
      "Delay",
      "Rate",
      "Throughput",
      "Payload staging",
      "Workflow",
      "GREEN",
      "internal-phone-id",
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
