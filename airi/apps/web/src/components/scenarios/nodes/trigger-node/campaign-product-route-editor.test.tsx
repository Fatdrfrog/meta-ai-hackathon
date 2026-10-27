/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import type {
  ScenarioAudienceOptions,
  ScenarioTriggerConfig,
} from "../../types";
import { CampaignProductRouteEditor } from "./campaign-product-route-editor";
import {
  buildMessageTriggerEditorModel,
  createMessageTriggerEditorFormatters,
} from "./message-trigger-editor-model";
import { installResizeObserver } from "@/test-support/dom-test-utils";

const audience = (
  overrides: Partial<ScenarioAudienceOptions> = {}
): ScenarioAudienceOptions => ({
  channels: [],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaReferralAds: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaCampaignLabels: [
    {
      id: "act_42:label-b",
      labelId: "label-b",
      name: "Very long product label that must stay readable in the picker",
      adAccountId: "act_42",
      adAccountName: "Main ads",
    },
  ],
  metaAdsDataStatus: { state: "complete", reasons: [] },
  ...overrides,
});

function renderEditor(
  options?: Partial<ScenarioAudienceOptions>,
  hasMetaAdsConnection = true
) {
  const onChange = jest.fn();
  const model = buildMessageTriggerEditorModel({
    triggerConfig: {},
    audienceOptions: audience(options),
    hasMetaAdsConnection,
    formatters: createMessageTriggerEditorFormatters("en"),
    t: (key, values) =>
      values ? `${key}(${Object.values(values).join(",")})` : key,
  });
  render(
    <CampaignProductRouteEditor
      product={model.product}
      onChange={onChange}
      t={(key, values) =>
        values ? `${key}(${Object.values(values).join(",")})` : key
      }
    />
  );
  return { onChange, model };
}

describe("campaign product route editor", () => {
  beforeAll(() => {
    installResizeObserver();
    Object.assign(window.HTMLElement.prototype, {
      hasPointerCapture: jest.fn(() => false),
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
      scrollIntoView: jest.fn(),
    });
  });

  it("keeps unused fallback inputs collapsed and shows the matching rule on demand", () => {
    const { onChange } = renderEditor();
    expect(
      screen.queryByText("triggerProductRouteHelp")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", {
        name: "triggerProductRouteNameFallbackLabel",
      })
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /triggerProductRouteNameFallbackLabel/,
      })
    );
    expect(
      screen.getByText("triggerProductRouteFallbackCondition")
    ).toBeVisible();
    expect(screen.getByText("triggerProductRouteVerifiedMeta")).toBeVisible();
    expect(
      screen.getByRole("textbox", {
        name: "triggerProductRouteNameFallbackLabel",
      })
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("supports label search and selection using only the keyboard", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();
    screen
      .getByRole("combobox", { name: "triggerProductRouteAddLabels" })
      .focus();
    await user.keyboard("{Enter}");
    const search = screen.getByRole("combobox", {
      name: "triggerProductRouteSearchLabels",
    });
    expect(search).toHaveFocus();
    await user.type(search, "readable");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({
      metaCampaignAdAccountId: "act_42",
      metaCampaignLabels: [
        {
          id: "label-b",
          name: "Very long product label that must stay readable in the picker",
        },
      ],
    });
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("combobox", { name: "triggerProductRouteAddLabels" })
    ).toHaveFocus();
  });

  it("marks missing saved labels and keeps saved fallback values visible", () => {
    const model = buildMessageTriggerEditorModel({
      triggerConfig: {
        metaCampaignAdAccountId: "act_42",
        metaCampaignLabels: [{ id: "gone", name: "Saved label" }],
        metaCampaignNameFallbacks: ["Spring sale"],
      },
      audienceOptions: audience(),
      hasMetaAdsConnection: true,
      formatters: createMessageTriggerEditorFormatters("en"),
      t: key => key,
    });
    const onChange = jest.fn();
    render(
      <CampaignProductRouteEditor
        product={model.product}
        t={key => key}
        onChange={onChange}
      />
    );
    expect(
      screen.getByText("triggerProductRouteSavedLabelUnavailable")
    ).toBeVisible();
    expect(screen.getByText("Spring sale")).toBeVisible();
    expect(
      screen.getByRole("textbox", {
        name: "triggerProductRouteNameFallbackLabel",
      })
    ).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("explains loading, disconnected, empty, partial, and error catalogs", () => {
    const { unmount } = render(
      <CampaignProductRouteEditor
        product={
          buildMessageTriggerEditorModel({
            triggerConfig: {},
            audienceOptions: audience({
              metaCampaignLabels: [],
              metaAdsDataStatus: undefined,
            }),
            hasMetaAdsConnection: true,
            formatters: createMessageTriggerEditorFormatters("en"),
            t: key => key,
          }).product
        }
        onChange={jest.fn()}
        t={key => key}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "triggerProductRouteLabelsLoading"
    );
    unmount();

    renderEditor(
      {
        metaCampaignLabels: [],
        metaAdsDataStatus: { state: "unavailable", reasons: ["not_connected"] },
      },
      false
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "triggerProductRouteLabelsDisconnected"
    );
  });

  it("adds a searched campaign label and an optional campaign name", () => {
    const { onChange } = renderEditor();
    fireEvent.click(
      screen.getByRole("combobox", { name: "triggerProductRouteAddLabels" })
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "triggerProductRouteSearchLabels" }),
      { target: { value: "missing label" } }
    );
    expect(
      screen.getByText("triggerProductRouteNoSearchResults")
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: "triggerProductRouteSearchLabels" }),
      { target: { value: "readable" } }
    );
    fireEvent.click(
      screen.getByText(
        "Very long product label that must stay readable in the picker"
      )
    );
    expect(onChange).toHaveBeenCalledWith({
      metaCampaignAdAccountId: "act_42",
      metaCampaignLabels: [
        {
          id: "label-b",
          name: "Very long product label that must stay readable in the picker",
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /triggerProductRouteNameFallbackLabel/,
      })
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "triggerProductRouteNameFallbackLabel",
      }),
      { target: { value: "  Spring sale " } }
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "triggerProductRouteNameFallbackAdd",
      })
    );
    expect(onChange).toHaveBeenLastCalledWith({
      metaCampaignNameFallbacks: ["Spring sale"],
    });
  });

  it("shows partial and error catalog states without hiding saved labels", () => {
    const partial = buildMessageTriggerEditorModel({
      triggerConfig: {
        metaCampaignAdAccountId: "act_42",
        metaCampaignLabels: [{ id: "saved", name: "Saved product" }],
      },
      audienceOptions: audience({
        metaAdsDataStatus: { state: "partial", reasons: ["provider_error"] },
      }),
      hasMetaAdsConnection: true,
      formatters: createMessageTriggerEditorFormatters("en"),
      t: key => key,
    });
    expect(partial.product.state).toBe("partial");
    expect(partial.product.labels.map(label => label.id)).toEqual([
      "label-b",
      "saved",
    ]);

    const failed = buildMessageTriggerEditorModel({
      triggerConfig: {},
      audienceOptions: audience({
        metaCampaignLabels: [],
        metaAdsDataStatus: {
          state: "unavailable",
          reasons: ["provider_error"],
        },
      }),
      hasMetaAdsConnection: true,
      formatters: createMessageTriggerEditorFormatters("en"),
      t: key => key,
    });
    expect(failed.product.state).toBe("error");
    expect(failed.product.warning).toBe("triggerProductRouteLabelsError");
  });

  it("keeps a chosen ad account after normalization and re-render", async () => {
    const user = userEvent.setup();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    function Harness() {
      const [config, setConfig] = useState<ScenarioTriggerConfig>({});
      const model = buildMessageTriggerEditorModel({
        triggerConfig: config,
        audienceOptions: audience({
          metaCampaignLabels: [
            {
              id: "act_42:label-a",
              labelId: "label-a",
              name: "Label A",
              adAccountId: "act_42",
              adAccountName: "Main ads",
            },
            {
              id: "act_99:label-b",
              labelId: "label-b",
              name: "Label B",
              adAccountId: "act_99",
              adAccountName: "Other ads",
            },
          ],
        }),
        hasMetaAdsConnection: true,
        formatters: createMessageTriggerEditorFormatters("en"),
        t: key => key,
      });
      return (
        <CampaignProductRouteEditor
          product={model.product}
          t={key => key}
          onChange={patch => {
            setConfig(current =>
              normalizeScenarioTriggerConfig({
                nodeData: {
                  kind: "trigger",
                  triggerConfig: { ...current, ...patch },
                },
              })
            );
          }}
        />
      );
    }

    render(<Harness />);
    const labelPicker = screen.getByRole("combobox", {
      name: "triggerProductRouteAddLabels",
    });
    expect(labelPicker).toBeDisabled();

    const accountPicker = screen
      .getAllByRole("combobox")
      .find(element => element !== labelPicker);
    if (!accountPicker) throw new Error("missing account picker");
    await user.click(accountPicker);
    await user.click(screen.getByRole("option", { name: "Main ads" }));

    expect(
      screen.getByRole("combobox", { name: "triggerProductRouteAddLabels" })
    ).toBeEnabled();
    expect(screen.getByText("Main ads")).toBeTruthy();
    await user.click(labelPicker);
    expect(
      screen.getByRole("dialog", { name: "triggerProductRouteLabel" })
    ).toBeVisible();
    const option = screen.getByRole("option", { name: "Label A" });
    expect(option).toHaveAttribute("aria-checked", "false");
    await user.click(option);
    expect(option).toHaveAttribute("aria-checked", "true");
    const search = screen.getByRole("combobox", {
      name: "triggerProductRouteSearchLabels",
    });
    await user.type(search, "Label A");
    expect(option).toHaveAttribute("aria-checked", "true");
    await user.click(option);
    expect(option).toHaveAttribute("aria-checked", "false");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
