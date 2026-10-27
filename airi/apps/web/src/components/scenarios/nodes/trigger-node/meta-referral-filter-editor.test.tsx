/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ScenarioAudienceOptions,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../../types";
import { MetaReferralFilterEditor } from "./meta-referral-filter-editor";
import {
  buildMessageTriggerEditorModel,
  createMessageTriggerEditorFormatters,
  type MessageTriggerProductCatalogState,
} from "./message-trigger-editor-model";
import { installResizeObserver } from "@/test-support/dom-test-utils";

const t: TranslateFn = (key, values) =>
  values ? `${key}(${Object.values(values).join(",")})` : key;

function renderEditor({
  config = {},
  audience = {},
  hasConnection = true,
  catalogState,
}: {
  config?: ScenarioTriggerConfig;
  audience?: Partial<ScenarioAudienceOptions>;
  hasConnection?: boolean;
  catalogState?: MessageTriggerProductCatalogState;
} = {}) {
  const onChange = jest.fn();
  const model = buildMessageTriggerEditorModel({
    triggerConfig: config,
    audienceOptions: {
      channels: [],
      classificationCategories: [],
      funnelStages: [],
      internalLabels: [],
      customers: [],
      metaCampaignLabels: [],
      metaReferralCampaigns: [
        { id: "campaign:1", campaignId: "1", label: "Autumn campaign" },
      ],
      metaReferralAdSets: [
        {
          id: "adset:2",
          adSetId: "2",
          label: "Home appliances",
          campaignName: "Autumn campaign",
        },
      ],
      metaReferralAds: [
        {
          id: "ad:3",
          sourceId: "3",
          sourceType: "ad",
          label: "Special offer",
          adSetName: "Home appliances",
        },
      ],
      metaAdsDataStatus: { state: "complete", reasons: [] },
      ...audience,
    },
    hasMetaAdsConnection: hasConnection,
    formatters: createMessageTriggerEditorFormatters("en"),
    t,
  });
  render(
    <MetaReferralFilterEditor
      meta={model.meta}
      catalogState={catalogState}
      onChange={onChange}
      t={t}
    />
  );
  return { onChange, model };
}

function openPicker() {
  fireEvent.click(
    screen.getByRole("combobox", { name: "triggerMetaExactFilterLabel" })
  );
}

describe("Meta referral filter editor", () => {
  beforeAll(() => {
    Object.assign(window.HTMLElement.prototype, {
      scrollIntoView: jest.fn(),
      hasPointerCapture: jest.fn(() => false),
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    });
    installResizeObserver();
  });

  it("uses a purpose label without a technical AND connector", () => {
    renderEditor();
    expect(screen.getByText("triggerMetaExactFilterLabel")).toBeVisible();
    expect(screen.queryByText("triggerMetaFilterAnd")).not.toBeInTheDocument();
    expect(screen.getByText("triggerMetaNoFilter")).toBeVisible();
    expect(
      screen.queryByText("triggerMetaExactFilterHelp")
    ).not.toBeInTheDocument();
  });

  it.each([
    ["metaReferralCampaignIds", "1", "triggerMetaCampaignScope"],
    ["metaReferralAdSetIds", "2", "triggerMetaAdSetScope"],
    ["metaReferralSourceIds", "3", "triggerMetaAdScope"],
  ])(
    "identifies the selected %s scope before opening the picker",
    (field, id, scope) => {
      renderEditor({ config: { [field]: [id] } });
      expect(screen.getByText(scope)).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
  );

  it("searches option metadata and opens the exact campaign picker with the keyboard", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    const trigger = screen.getByRole("combobox", {
      name: "triggerMetaExactFilterLabel",
    });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const search = screen.getByRole("combobox", { name: "triggerMetaSearch" });
    expect(search).toHaveFocus();
    await user.type(search, "Autumn campaign");
    expect(
      screen.getByRole("option", { name: /Home appliances/ })
    ).toBeVisible();
    await user.click(screen.getByRole("option", { name: /^Autumn campaign/ }));
    expect(onChange).toHaveBeenCalledWith({
      metaReferralCampaignIds: ["1"],
      metaReferralAdSetIds: [],
      metaReferralSourceIds: [],
      whatsappReferralSourceTypes: [],
      whatsappReferralSourcePlatforms: [],
    });
    expect(
      screen.queryByRole("combobox", { name: "triggerMetaSearch" })
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each([
    ["Home appliances", "metaReferralAdSetIds", "2"],
    ["Special offer", "metaReferralSourceIds", "3"],
  ])("selects %s without changing product routing", (label, key, id) => {
    const { onChange } = renderEditor();
    openPicker();
    fireEvent.click(
      screen.getByRole("option", { name: new RegExp(`^${label}`) })
    );
    const patch = onChange.mock.calls[0][0];
    expect(patch[key]).toEqual([id]);
    expect(patch).not.toHaveProperty("metaCampaignLabels");
    expect(patch).not.toHaveProperty("metaCampaignNameFallbacks");
    expect(patch).not.toHaveProperty("metaCampaignAdAccountId");
  });

  it("clears only the ad filter and preserves saved product rules", () => {
    const config: ScenarioTriggerConfig = {
      metaReferralCampaignIds: ["1"],
      metaCampaignAdAccountId: "act_42",
      metaCampaignLabels: [{ id: "label1", name: "Electronics" }],
      metaCampaignNameFallbacks: ["electronics"],
    };
    const { onChange } = renderEditor({ config });
    openPicker();
    fireEvent.click(
      screen.getByRole("option", { name: "triggerMetaNoFilter" })
    );
    expect({ ...config, ...onChange.mock.calls[0][0] }).toEqual({
      ...config,
      metaReferralCampaignIds: [],
      metaReferralAdSetIds: [],
      metaReferralSourceIds: [],
      whatsappReferralSourceTypes: [],
      whatsappReferralSourcePlatforms: [],
    });
  });

  it("preserves available and saved missing options during a partial load", () => {
    renderEditor({
      config: { metaReferralCampaignIds: ["saved-99"] },
      hasConnection: false,
      catalogState: "partial",
      audience: {
        metaAdsDataStatus: {
          state: "partial",
          reasons: ["access_unavailable"],
        },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "triggerMetaCatalogPartial"
    );
    openPicker();
    expect(
      screen.getByRole("option", { name: /^Autumn campaign/ })
    ).toBeEnabled();
    expect(
      screen.getByRole("option", {
        name: /triggerMetaFallbackCampaign\(saved-99\)/,
      })
    ).toBeEnabled();
  });

  it("supports keyboard search, empty results and Escape without patching", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    openPicker();
    const search = screen.getByRole("combobox", { name: "triggerMetaSearch" });
    await user.type(search, "nothing matches this");
    expect(screen.getByText("triggerMetaNoResults")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "triggerMetaExactFilterLabel" })
    ).toHaveFocus();
  });

  it("selects a searched ad using Enter", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    openPicker();
    await user.type(
      screen.getByRole("combobox", { name: "triggerMetaSearch" }),
      "Special offer"
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({
      metaReferralCampaignIds: [],
      metaReferralAdSetIds: [],
      metaReferralSourceIds: ["3"],
      whatsappReferralSourceTypes: [],
      whatsappReferralSourcePlatforms: [],
    });
  });

  it("distinguishes loading from an empty catalog without disabling reset", () => {
    renderEditor({
      catalogState: "loading",
      audience: {
        metaReferralCampaigns: [],
        metaReferralAdSets: [],
        metaReferralAds: [],
        metaAdsDataStatus: undefined,
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "triggerMetaCatalogLoading"
    );
    openPicker();
    expect(
      screen.getByRole("option", { name: "triggerMetaNoFilter" })
    ).toBeEnabled();
    expect(
      screen.queryByText("triggerMetaNoCampaigns")
    ).not.toBeInTheDocument();
  });
});
