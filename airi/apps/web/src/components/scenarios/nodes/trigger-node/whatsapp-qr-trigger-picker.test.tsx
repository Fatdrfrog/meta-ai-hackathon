/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  WhatsAppQrTriggerPicker,
  type WhatsAppQrTriggerPickerProps,
} from "./whatsapp-qr-trigger-picker";

jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

test("names the QR picker in both empty and selected states", () => {
  const props: WhatsAppQrTriggerPickerProps = {
    selected: null,
    selectedEntryPointId: null,
    selectionResolved: true,
    targetScenarioId: "scenario-1",
    targetNodeId: "trigger-1",
    targetScenarioName: "Store notifications",
    managerHref: "/panel/w/test/messengers/whatsapp-qr",
    sourceLabels: {},
    loading: false,
    error: null,
    busy: false,
    loadOptions: jest.fn(),
    onAssign: jest.fn(),
    onUnassign: jest.fn(),
    onRefresh: jest.fn(),
    onOpenScenario: jest.fn(),
  };
  const { rerender } = render(<WhatsAppQrTriggerPicker {...props} />);
  expect(
    screen.getByRole("combobox", { name: "whatsappQrPickerChoose" })
  ).toBeInTheDocument();

  rerender(
    <WhatsAppQrTriggerPicker
      {...props}
      selectedEntryPointId="qr-1"
      selected={{
        entryPointId: "qr-1",
        placementName: "Store entrance",
        status: "ACTIVE",
        hasCurrentCode: true,
        readiness: "ready",
        reconcilePending: false,
        version: 1,
      }}
    />
  );
  expect(
    screen.getByRole("combobox", { name: "whatsappQrPickerChange" })
  ).toBeInTheDocument();
});
