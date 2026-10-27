/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ScenarioTriggerEditorNodeProps } from "../../view/node-enrichment/types";
import { CompactTriggerNode } from "./trigger-node-compact";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}: ${Object.values(values).join(", ")}` : key,
}));
jest.mock("../node-handlers", () => ({ NodeHandles: () => null }));
jest.mock("./whatsapp-qr-trigger-picker", () => ({
  WhatsAppQrTriggerPicker: () => (
    <div data-testid="whatsapp-qr-trigger-picker" />
  ),
}));

function props(): ScenarioTriggerEditorNodeProps {
  return {
    id: "trigger-1",
    type: "triggerNode",
    selected: true,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    selectable: true,
    deletable: true,
    draggable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: {
      kind: "trigger",
      uiNodeLabel: "Customer message",
      uiOnSelect: jest.fn(),
      uiOnPatch: jest.fn(),
      uiOnRemove: jest.fn(),
      uiOnTriggerConfigChange: jest.fn(),
      uiIsEditorExpanded: true,
      uiHasMetaAdsConnection: true,
      uiTriggerConfig: {
        messageMatchMode: "any",
        channelFilter: ["whatsapp"],
        onlyNewCustomers: true,
        metaCampaignAdAccountId: "act_1",
        metaCampaignLabels: [{ id: "label-1", name: "Electronics" }],
        metaCampaignNameFallbacks: ["Autumn"],
        metaReferralCampaignIds: ["campaign-1"],
      },
      uiAudienceOptions: {
        channels: ["whatsapp"],
        classificationCategories: [],
        funnelStages: [],
        internalLabels: [],
        customers: [],
        metaReferralAds: [],
        metaCampaignLabels: [],
        metaReferralAdSets: [],
        metaReferralCampaigns: [
          {
            id: "campaign-1",
            campaignId: "campaign-1",
            label: "Forte Market Electronics",
          },
        ],
      },
    },
  };
}

it("prioritizes named ad conditions and makes additional filters discoverable", () => {
  const value = props();
  render(<CompactTriggerNode {...value} />);
  const node = screen.getByTestId("scenario-trigger-node-compact");
  expect(node).toHaveTextContent("triggerAdMessage");
  expect(node).toHaveTextContent("Electronics");
  expect(node).toHaveTextContent("Forte Market Electronics");
  expect(node).toHaveTextContent("Autumn");
  expect(within(node).queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(
    within(node).getByRole("button", { name: "triggerMoreFilters: 1" })
  );
  expect(value.data.uiOnSelect).toHaveBeenCalledTimes(1);
  const edit = within(node).getByRole("button", { name: "triggerEditorTitle" });
  expect(edit).toHaveAttribute("data-scenario-node-settings", "trigger-1");
  // The legacy modal editor does not report its state on the card.
  expect(edit).toHaveAttribute("aria-haspopup", "dialog");
  expect(edit).not.toHaveAttribute("aria-expanded");
  fireEvent.click(edit);
  expect(value.data.uiOnSelect).toHaveBeenCalledTimes(2);
  expect(value.data.uiOnTriggerConfigChange).not.toHaveBeenCalled();
});

it("opens trigger settings from a Settings button when the settings panel is enabled", () => {
  const value = props();
  const onOpenSettings = jest.fn();
  value.data.uiUsesSettingsPanel = true;
  value.data.uiOnOpenSettings = onOpenSettings;
  value.data.uiIsEditorExpanded = false;
  const view = render(<CompactTriggerNode {...value} />);
  const settings = screen.getByRole("button", {
    name: "nodeSettingsOpenFor: triggerAdMessage",
  });
  expect(settings).toHaveTextContent("settings");
  expect(settings).toHaveAttribute("data-scenario-node-settings", "trigger-1");
  expect(settings).toHaveAttribute("aria-haspopup", "dialog");
  expect(settings).toHaveAttribute("aria-expanded", "false");
  expect(settings).not.toHaveAttribute("aria-controls");
  fireEvent.click(settings, { detail: 1 });
  expect(onOpenSettings).toHaveBeenLastCalledWith({ moveFocus: false });
  // Keyboard and assistive technology activate without a pointer click.
  fireEvent.click(settings, { detail: 0 });
  expect(onOpenSettings).toHaveBeenLastCalledWith({ moveFocus: true });
  expect(value.data.uiOnSelect).not.toHaveBeenCalled();

  view.rerender(
    <CompactTriggerNode
      {...value}
      data={{ ...value.data, uiIsEditorExpanded: true }}
    />
  );
  expect(settings).toHaveAttribute("aria-expanded", "true");
  expect(settings).toHaveAttribute(
    "aria-controls",
    "scenario-node-settings-panel"
  );
  expect(value.data.uiOnTriggerConfigChange).not.toHaveBeenCalled();
});

it("keeps saved campaign identity visible while its catalog is unavailable", () => {
  const value = props();
  value.data.uiAudienceOptions.metaReferralCampaigns = [];
  value.data.uiHasMetaAdsConnection = false;
  render(<CompactTriggerNode {...value} />);
  expect(screen.getByTestId("scenario-trigger-node-compact")).toHaveTextContent(
    "campaign-1"
  );
  expect(value.data.uiOnTriggerConfigChange).not.toHaveBeenCalled();
});

it("summarizes a business event draft without inheriting inactive message or ad filters", () => {
  const value = props();
  value.data.uiTriggerConfig = {
    ...value.data.uiTriggerConfig,
    entryPointType: "business_event",
    businessEvent: {
      integrationId: "forte",
      integrationName: "Forte Market",
      eventId: "order.updated",
      eventName: "Order updated",
      filters: [{ field: "status", operator: "equals", value: "shipped" }],
    },
  } as ScenarioTriggerEditorNodeProps["data"]["uiTriggerConfig"];
  render(<CompactTriggerNode {...value} />);
  const node = screen.getByTestId("scenario-trigger-node-compact");
  expect(node).toHaveTextContent("Forte Market");
  expect(node).toHaveTextContent("Order updated");
  expect(node).toHaveTextContent("status businessEventEquals shipped");
  expect(node).toHaveTextContent("businessEventDraftBadge");
  expect(node).not.toHaveTextContent("triggerAdMessage");
  expect(node).not.toHaveTextContent("Electronics");
  expect(node).not.toHaveTextContent("triggerAllChannels");
  expect(value.data.uiOnTriggerConfigChange).not.toHaveBeenCalled();
});

it("summarizes a selected WhatsApp QR by placement and leaves details to its picker", () => {
  const value = props();
  value.data.uiTriggerConfig = {
    entryPointType: "whatsapp_qr",
    entryPointId: "ep-1",
  };
  value.data.uiWhatsAppQrPicker = {
    selected: {
      entryPointId: "ep-1",
      placementName: "Front door",
      sourceId: "source-1",
      status: "DRAFT",
      hasCurrentCode: false,
      readiness: "draft",
      reconcilePending: false,
      version: 0,
    },
    selectedEntryPointId: "ep-1",
    selectionResolved: true,
    targetScenarioId: "scenario-1",
    targetNodeId: "trigger-1",
    targetScenarioName: "Scenario",
    managerHref: "/panel/w/workspace-1/messengers/whatsapp-qr",
    sourceLabels: { "source-1": "WhatsApp" },
    loading: false,
    error: null,
    busy: false,
    loadOptions: jest.fn(),
    onAssign: jest.fn(),
    onUnassign: jest.fn(),
    onRefresh: jest.fn(),
    onOpenScenario: jest.fn(),
  };
  render(<CompactTriggerNode {...value} />);
  const node = screen.getByTestId("scenario-trigger-node-compact");
  expect(node).toHaveTextContent("Front door");
  expect(node).not.toHaveTextContent("whatsappQrNoPlacement");
  expect(node).not.toHaveTextContent("whatsappQrNeedsCode");
  expect(
    within(node).getByTestId("whatsapp-qr-trigger-picker")
  ).toBeInTheDocument();
  expect(
    within(node).queryByTestId("scenario-trigger-node-settings")
  ).not.toBeInTheDocument();
});

it("shows an unassigned WhatsApp QR as missing its placement and code", () => {
  const value = props();
  value.data.uiTriggerConfig = { entryPointType: "whatsapp_qr" };
  render(<CompactTriggerNode {...value} />);
  const node = screen.getByTestId("scenario-trigger-node-compact");
  expect(node).toHaveTextContent("whatsappQrNoPlacement");
  expect(node).toHaveTextContent("whatsappQrNeedsCode");
  expect(
    within(node).queryByTestId("whatsapp-qr-trigger-picker")
  ).not.toBeInTheDocument();
});

it.each([
  { whatsappReferralSourcePlatforms: ["facebook"] },
  { whatsappReferralSourceTypes: ["post"] },
  { whatsappReferralSourceTypes: ["ad", "post"] },
])("does not call a general referral an ad message: %j", config => {
  const value = props();
  value.data.uiTriggerConfig = config;
  render(<CompactTriggerNode {...value} />);
  const node = screen.getByTestId("scenario-trigger-node-compact");
  expect(node).toHaveTextContent("Customer message");
  expect(node).not.toHaveTextContent("triggerAdMessage");
});
