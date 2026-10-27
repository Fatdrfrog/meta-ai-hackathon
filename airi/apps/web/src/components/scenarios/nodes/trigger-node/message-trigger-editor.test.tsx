/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type {
  ScenarioAudienceOptions,
  ScenarioTriggerConfig,
} from "../../types";
import { MessageTriggerEditor } from "./message-trigger-editor";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
}));

const audience: ScenarioAudienceOptions = {
  channels: ["whatsapp"],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaCampaignLabels: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaReferralAds: [],
  metaAdsDataStatus: { state: "complete", reasons: [] },
};

function Harness({
  initial = {},
  onChange,
  unavailable = false,
}: {
  initial?: ScenarioTriggerConfig;
  onChange: jest.Mock;
  unavailable?: boolean;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <MessageTriggerEditor
      triggerConfig={config}
      audienceOptions={
        unavailable
          ? {
              ...audience,
              metaAdsDataStatus: {
                state: "unavailable",
                reasons: ["access_unavailable"],
              },
            }
          : audience
      }
      hasMetaAdsConnection={!unavailable}
      onChange={delta => {
        onChange(delta);
        setConfig(current => ({ ...current, ...delta }));
      }}
    />
  );
}

describe("message trigger optional filters", () => {
  beforeAll(() => {
    Object.assign(window.HTMLElement.prototype, {
      scrollIntoView: jest.fn(),
      hasPointerCapture: jest.fn(() => false),
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    });
    installResizeObserver();
  });

  it("starts with channels and Add filter without changing configuration", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    expect(
      screen.getByRole("button", { name: "actionSourceWhatsApp" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "triggerAddFilter" })
    ).toBeVisible();
    expect(
      screen.queryByText("triggerMessageMatchMode")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("triggerProductRouteLabel")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("triggerMetaExactFilterLabel")
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reveals a message filter from the keyboard without persisting an empty rule", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole("button", { name: "triggerAddFilter" }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("menuitem", { name: "triggerFilterMessage" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("triggerMessageMatchMode")).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reopens every saved rule even when the Meta catalog is unavailable", () => {
    const onChange = jest.fn();
    const view = render(<Harness onChange={onChange} initial={{}} />);
    view.unmount();
    render(
      <Harness
        onChange={onChange}
        unavailable
        initial={{
          onlyNewCustomers: true,
          messageMatchMode: "exact",
          keywordPattern: "Order status",
          metaCampaignAdAccountId: "act_42",
          metaCampaignLabels: [{ id: "saved-label", name: "Electronics" }],
          metaCampaignNameFallbacks: ["spring"],
          metaReferralCampaignIds: ["saved-campaign"],
        }}
      />
    );
    expect(screen.getByDisplayValue("Order status")).toBeVisible();
    expect(screen.getByText("triggerFilterCustomers")).toBeVisible();
    expect(screen.getByText("Electronics")).toBeVisible();
    expect(screen.getByText("spring")).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "triggerMetaExactFilterLabel" })
    ).toHaveTextContent("saved-campaign");
    expect(screen.queryByText("triggerMetaFilterAnd")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    [
      "triggerFilterMessage",
      {
        messageMatchMode: "any",
        keywordPattern: "",
        keywordMatchMode: "contains",
      },
    ],
    ["triggerFilterCustomers", { onlyNewCustomers: false }],
    [
      "triggerFilterCampaignRouting",
      {
        metaCampaignAdAccountId: undefined,
        metaCampaignLabels: undefined,
        metaCampaignNameFallbacks: undefined,
      },
    ],
    [
      "triggerFilterSpecificAd",
      {
        metaReferralCampaignIds: [],
        metaReferralAdSetIds: [],
        metaReferralSourceIds: [],
        whatsappReferralSourceTypes: [],
        whatsappReferralSourcePlatforms: [],
      },
    ],
  ])(
    "removes only %s and keeps independent filters intact",
    (name, expected) => {
      const onChange = jest.fn();
      render(
        <Harness
          onChange={onChange}
          initial={{
            channelFilter: ["whatsapp"],
            onlyNewCustomers: true,
            messageMatchMode: "contains",
            keywordPattern: "hello",
            keywordMatchMode: "regex",
            metaCampaignAdAccountId: "act_42",
            metaCampaignLabels: [{ id: "label", name: "Electronics" }],
            metaCampaignNameFallbacks: ["spring"],
            metaReferralCampaignIds: ["campaign"],
          }}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: `triggerRemoveFilter(${name})` })
      );
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expected);
      expect(
        screen.queryByRole("button", { name: `triggerRemoveFilter(${name})` })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "actionSourceWhatsApp" })
      ).toHaveAttribute("aria-pressed", "true");
    }
  );

  it("adds the new-customer restriction intentionally and offers each filter only once", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "triggerAddFilter" }));
    await user.click(
      screen.getByRole("menuitem", { name: "triggerFilterCustomers" })
    );
    expect(onChange).toHaveBeenCalledWith({ onlyNewCustomers: true });
    await user.click(screen.getByRole("button", { name: "triggerAddFilter" }));
    expect(
      within(screen.getByRole("menu")).queryByText("triggerFilterCustomers")
    ).not.toBeInTheDocument();
  });

  it("shows saved referral criteria that the single-item picker cannot represent", () => {
    const onChange = jest.fn();
    render(
      <Harness
        onChange={onChange}
        initial={{
          whatsappReferralSourcePlatforms: ["facebook"],
          whatsappReferralSourceTypes: ["post"],
        }}
      />
    );
    expect(
      screen.getByRole("combobox", { name: "triggerMetaExactFilterLabel" })
    ).toHaveTextContent("triggerMetaSavedFilters");
    expect(screen.getByText("Facebook")).toBeVisible();
    expect(
      screen.getByText("triggerSummaryWhatsAppReferralTypes(post)")
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps every saved campaign ID visible without reducing it to the first selection", () => {
    const onChange = jest.fn();
    render(
      <Harness
        onChange={onChange}
        initial={{ metaReferralCampaignIds: ["one", "two"] }}
      />
    );
    expect(
      screen.getByText("triggerSummaryMetaCampaignNamed(one, two)")
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reflects an external undo of the new-customer flag after adding it", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const props = {
      audienceOptions: audience,
      hasMetaAdsConnection: true,
      onChange,
    };
    const view = render(<MessageTriggerEditor {...props} triggerConfig={{}} />);
    await user.click(screen.getByRole("button", { name: "triggerAddFilter" }));
    await user.click(
      screen.getByRole("menuitem", { name: "triggerFilterCustomers" })
    );
    view.rerender(
      <MessageTriggerEditor
        {...props}
        triggerConfig={{ onlyNewCustomers: true }}
      />
    );
    expect(screen.getByText("triggerFilterCustomers")).toBeVisible();
    view.rerender(
      <MessageTriggerEditor
        {...props}
        triggerConfig={{ onlyNewCustomers: false }}
      />
    );
    expect(
      screen.queryByText("triggerFilterCustomers")
    ).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
