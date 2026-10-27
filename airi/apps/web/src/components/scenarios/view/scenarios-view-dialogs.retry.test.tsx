/**
 * @jest-environment jsdom
 */

// Its own file so the dialog's chunk starts cold.
import { act, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

jest.mock("./scenario-activation-impact-dialog", () => ({
  ScenarioActivationImpactDialog: ({ open }: { open: boolean }) => (
    <div data-testid="activation-impact" data-open={String(open)} />
  ),
}));
jest.mock("./scenarios-view-shell", () => ({
  ScenarioPendingConfirmationDialog: () => null,
}));

import { scenarioEditorChunks } from "../scenario-editor-chunks";
import { ScenariosViewDialogs } from "./scenarios-view-dialogs";

function dialogsProps(activationImpactOpen: boolean) {
  const dialog = (open: boolean) => ({ open, onOpenChange: jest.fn() });
  return {
    createTypeDialog: dialog(false),
    linkedFlowPreviewDialog: dialog(false),
    previewDrawer: dialog(false),
    activationImpactDialog: dialog(activationImpactOpen),
    airiCreateDialog: { open: false },
    revenuePlaybookDialog: { open: false },
    pendingConfirmationDialog: {},
  } as unknown as ComponentProps<typeof ScenariosViewDialogs>;
}

describe("ScenariosViewDialogs after a failed download", () => {
  it("keeps the page up and opens the dialog once the download is retried", async () => {
    jest.useFakeTimers();
    // React reports the failure its boundary caught.
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const load = jest.spyOn(
      scenarioEditorChunks.activationImpactDialog,
      "load"
    );
    load.mockRejectedValueOnce(new Error("Loading chunk failed"));
    try {
      render(<ScenariosViewDialogs {...dialogsProps(true)} />);
      await act(async () => undefined);
      expect(screen.queryByTestId("activation-impact")).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await act(async () => undefined);

      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("activation-impact").dataset.open).toBe("true");
    } finally {
      load.mockRestore();
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });
});
