const mockEmitCrmBoardChangedRealtimeEvent = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/realtime/server", () => ({
  emitCrmBoardChangedRealtimeEvent: (...args: unknown[]) =>
    mockEmitCrmBoardChangedRealtimeEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { notifyCrmBoardChanged } from "./board-realtime";

describe("notifyCrmBoardChanged", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmitCrmBoardChangedRealtimeEvent.mockResolvedValue(undefined);
  });

  it("emits the CRM board invalidation", async () => {
    await notifyCrmBoardChanged({
      workspaceId: "workspace-1",
      reason: "stage_moved",
      customerId: "customer-1",
      stageKey: "qualified",
    });

    expect(mockEmitCrmBoardChangedRealtimeEvent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      reason: "stage_moved",
      customerId: "customer-1",
      stageKey: "qualified",
    });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("does not fail the CRM write when realtime emit fails", async () => {
    mockEmitCrmBoardChangedRealtimeEvent.mockRejectedValue(
      new Error("pubsub down")
    );

    await expect(
      notifyCrmBoardChanged({
        workspaceId: "workspace-1",
        reason: "pipeline_saved",
      })
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      "[CRM] Failed to emit board realtime event",
      expect.any(Error),
      expect.objectContaining({
        event: "crm.board.changed_failed",
        workspaceId: "workspace-1",
        reason: "pipeline_saved",
      })
    );
  });
});
