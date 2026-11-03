/** @jest-environment node */

const mockRequireConfigured = jest.fn();
const mockStartOrAttach = jest.fn();

jest.mock("./workflow-start", () => ({
  requireTemporalConfigured: (...args: unknown[]) =>
    mockRequireConfigured(...args),
  resolveTemporalMediaTaskQueue: (queue: string) =>
    process.env.AIRI_MEDIA_TASK_QUEUE || queue,
  startOrAttachWorkflow: (...args: unknown[]) => mockStartOrAttach(...args),
}));

import { startProductAdWorkflow } from "./product-ad";

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AIRI_MEDIA_TASK_QUEUE;
  mockStartOrAttach.mockResolvedValue({
    workflowId: "product-ad:ad-1:r1",
    taskQueue: "airi-media",
    duplicate: false,
  });
});

describe("startProductAdWorkflow", () => {
  it("starts one run per render on the media queue, with the contract's input", async () => {
    await startProductAdWorkflow({
      workspaceId: "workspace-1",
      adId: "ad-1",
      renderNo: 1,
      mode: "make",
    });

    expect(mockRequireConfigured).toHaveBeenCalledWith(
      "Temporal is not configured for product ads"
    );
    expect(mockStartOrAttach).toHaveBeenCalledWith({
      workflowType: "productAdWorkflow",
      workflowId: "product-ad:ad-1:r1",
      taskQueue: "airi-media",
      args: [
        {
          contractVersion: 1,
          workspaceId: "workspace-1",
          adId: "ad-1",
          renderNo: 1,
          mode: "make",
        },
      ],
    });
  });

  it("gives an edit's render its own id, on the configured media queue", async () => {
    process.env.AIRI_MEDIA_TASK_QUEUE = "airi-media-canary";

    await startProductAdWorkflow({
      workspaceId: "workspace-1",
      adId: "ad-1",
      renderNo: 3,
      mode: "render",
    });

    expect(mockStartOrAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "product-ad:ad-1:r3",
        taskQueue: "airi-media-canary",
        args: [expect.objectContaining({ renderNo: 3, mode: "render" })],
      })
    );
  });

  it("refuses to start without Temporal", async () => {
    mockRequireConfigured.mockImplementation(() => {
      throw new Error("Temporal is not configured for product ads");
    });

    await expect(
      startProductAdWorkflow({
        workspaceId: "workspace-1",
        adId: "ad-1",
        renderNo: 1,
        mode: "make",
      })
    ).rejects.toThrow("Temporal is not configured for product ads");
    expect(mockStartOrAttach).not.toHaveBeenCalled();
  });
});
