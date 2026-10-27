import type { ScenarioFlowSaveStatus } from "./use-scenario-flow-controller";

/** The editor's save state a QR assignment depends on. */
export type WhatsAppQrAssignmentSaveState = {
  scenarioId: string | null;
  loadingFlow: boolean;
  saveStatus: ScenarioFlowSaveStatus;
  isDirty: boolean;
  hasSaveConflict: boolean;
  scenarioStatus: "draft" | "active";
};

/**
 * Throws why the QR assignment of a trigger cannot change yet. The QR picker
 * maps these messages to its disabled reasons.
 */
export function assertWhatsAppQrAssignmentReady(
  state: WhatsAppQrAssignmentSaveState & {
    nodeId: string;
    expectedUpdatedAt: string | null;
    updatedAtScenarioId: string | null;
    saveInFlight: boolean;
  }
): void {
  if (
    !state.scenarioId ||
    !state.nodeId ||
    state.updatedAtScenarioId !== state.scenarioId ||
    !state.expectedUpdatedAt
  ) {
    throw new Error("Save the Scenario before changing its QR assignment");
  }
  if (state.loadingFlow || state.saveInFlight || state.saveStatus !== "saved") {
    throw new Error("Wait for the Scenario save to finish");
  }
  if (state.isDirty || state.hasSaveConflict) {
    throw new Error("Save the Scenario before changing its QR assignment");
  }
  if (state.scenarioStatus !== "draft") {
    throw new Error(
      "Deactivate the Scenario before changing its QR assignment"
    );
  }
}
