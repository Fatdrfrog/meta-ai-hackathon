/**
 * @jest-environment jsdom
 */

import {
  fetchScenarioById,
  updateScenarioRequest,
} from "@/lib/scenarios/client/crud";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import { act, renderHook } from "@testing-library/react";
import type { ScenarioFlowNode } from "../types";
import { useScenarioFlowController } from "./use-scenario-flow-controller";
import { scenarioDocument } from "./scenario-controller-test-utils";

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/lib/scenarios/client/crud", () => ({
  ...jest.requireActual("@/lib/scenarios/client/crud"),
  fetchScenarioById: jest.fn(),
  updateScenarioRequest: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/client", () => ({
  attachWhatsAppFlowProviderReference: jest.fn(),
  provisionWhatsAppFlow: jest.fn(),
}));
jest.mock("../scenario-editor-chunks", () =>
  jest
    .requireActual("./scenario-controller-test-utils")
    .scenarioEditorChunksMock()
);

const mockFetchScenarioById = jest.mocked(fetchScenarioById);
const mockUpdateScenarioRequest = jest.mocked(updateScenarioRequest);

const REVISION = "2026-01-01T00:00:00.000Z";
const DURABLE = "gcs://media/cards/1.png";
const SIGNED = "https://storage.example/cards/1.png?signature=1";

function cardNode(url: string, id = "card-1"): ScenarioFlowNode {
  return {
    id,
    type: "actionNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "whatsapp_service_message",
      actionWhatsAppServiceMessage: {
        message: {
          type: "carousel",
          body: "Pick one",
          cards: [
            {
              body: "Card",
              media: {
                url,
                bucket: "media",
                path: "cards/1.png",
                mediaType: "image",
              },
            },
          ],
        },
      },
    },
  } as unknown as ScenarioFlowNode;
}

function detail(url: string, pending: boolean, id = "media-1") {
  const scenario = scenarioDocument(id, { nodes: [cardNode(url)] });
  return {
    scenario,
    metadata: {
      linkedConditionParentCountByNodeId: {},
      ...(pending ? { mediaDisplayUrlsPending: true } : {}),
    },
  };
}

function cardUrl(node: ScenarioFlowNode | undefined) {
  return (
    node?.data as unknown as {
      actionWhatsAppServiceMessage: {
        message: { cards: Array<{ media: { url: string } }> };
      };
    }
  ).actionWhatsAppServiceMessage.message.cards[0]?.media.url;
}

const setEntryPriorityInput = jest.fn();
const setScenarios = jest.fn();
const onScenarioDocumentConfirmed = jest.fn();
const t = (key: string) => key;

type Props = {
  activeScenarioId: string;
  initialScenarioDetail?: PromiseLike<InitialScenarioDetail | null> | null;
};

function renderController(initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useScenarioFlowController({
        workspaceId: "workspace-1",
        activeScenarioId: props.activeScenarioId,
        activeScenario: {
          _id: props.activeScenarioId,
          name: props.activeScenarioId,
          description: "",
          status: "draft",
          mode: "conversation",
          timezone: null,
          priority: 0,
          matchingRole: "default",
          entryPolicy: "repeatable",
          nodeCount: 1,
          edgeCount: 0,
          createdAt: REVISION,
          updatedAt: REVISION,
        },
        activeScenarioName: props.activeScenarioId,
        activeScenarioDescription: "",
        activeScenarioStatus: "draft",
        entryPriorityInput: "0",
        setEntryPriorityInput,
        setScenarios,
        onScenarioDocumentConfirmed,
        t,
        initialScenarioDetail: props.initialScenarioDetail,
      }),
    { initialProps }
  );
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe("media shown after deferred signing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows signed media once a later read has it, without saving or marking changes", async () => {
    mockFetchScenarioById
      .mockResolvedValueOnce(detail(DURABLE, true) as never)
      .mockResolvedValueOnce(detail(DURABLE, true) as never)
      .mockResolvedValueOnce(detail(SIGNED, false) as never);
    const { result } = renderController({ activeScenarioId: "media-1" });
    await advance(0);
    expect(cardUrl(result.current.nodes[0])).toBe(DURABLE);
    const loadedNodes = result.current.nodes;

    await advance(1500);
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
    expect(mockFetchScenarioById).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scenarioId: "media-1",
        mediaSigning: "deferred",
      })
    );
    expect(result.current.nodes).toBe(loadedNodes);

    await advance(3000);
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(3);
    expect(cardUrl(result.current.nodes[0])).toBe(SIGNED);
    expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(result.current.saveStatus).toBe("saved");
    expect(result.current.canUndoGraphChange).toBe(false);

    // Nothing is due to save, and the reads have stopped.
    await advance(30_000);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(3);
  });

  it("treats the page's own read the same way", async () => {
    mockFetchScenarioById.mockResolvedValueOnce(detail(SIGNED, false) as never);
    const { result } = renderController({
      activeScenarioId: "media-1",
      initialScenarioDetail: Promise.resolve({
        scenarioId: "media-1",
        loadedAt: Date.now(),
        response: JSON.parse(JSON.stringify(detail(DURABLE, true))),
      }),
    });
    await advance(0);
    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    expect(cardUrl(result.current.nodes[0])).toBe(DURABLE);

    await advance(1500);
    expect(cardUrl(result.current.nodes[0])).toBe(SIGNED);
  });

  it("keeps media the user replaced before the signed read arrived", async () => {
    const replaced = "gcs://media/cards/replacement.png";
    mockFetchScenarioById
      .mockResolvedValueOnce(detail(DURABLE, true) as never)
      .mockResolvedValueOnce(detail(SIGNED, false) as never);
    const { result } = renderController({ activeScenarioId: "media-1" });
    await advance(0);

    act(() => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [
          {
            ...cardNode(replaced),
            data: {
              ...cardNode(replaced).data,
            },
          },
        ],
        history: "record",
      }));
    });
    await advance(1500);

    expect(cardUrl(result.current.nodes[0])).toBe(replaced);
    // Undo restores the loaded card with its signed media, not the durable ref.
    act(() => {
      result.current.undoGraphChange();
    });
    expect(cardUrl(result.current.nodes[0])).toBe(SIGNED);
  });

  it("stops reading again after a switch to another scenario", async () => {
    mockFetchScenarioById
      .mockResolvedValueOnce(detail(DURABLE, true) as never)
      .mockResolvedValueOnce(detail(DURABLE, false, "media-2") as never);
    const { rerender } = renderController({ activeScenarioId: "media-1" });
    await advance(0);

    rerender({ activeScenarioId: "media-2" });
    await advance(0);
    await advance(30_000);

    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
    expect(mockFetchScenarioById).toHaveBeenLastCalledWith(
      expect.objectContaining({ scenarioId: "media-2" })
    );
  });

  it("leaves a running save alone, and the next save sends the signed media", async () => {
    // Its own scenario: the revisions its saves confirm stay out of the
    // other tests' page reads.
    const id = "media-save";
    mockFetchScenarioById
      .mockResolvedValueOnce(detail(DURABLE, true, id) as never)
      .mockResolvedValueOnce(detail(SIGNED, false, id) as never);
    let finishSave!: (value: unknown) => void;
    mockUpdateScenarioRequest.mockReturnValueOnce(
      new Promise(resolve => {
        finishSave = resolve;
      }) as never
    );
    const { result } = renderController({ activeScenarioId: id });
    await advance(0);

    act(() => moveCard(result.current.graphEditor, 40));
    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.flushScenario();
    });
    expect(result.current.saveStatus).toBe("saving");

    await advance(1500);
    expect(cardUrl(result.current.nodes[0])).toBe(SIGNED);
    expect(result.current.saveStatus).toBe("saving");

    await act(async () => {
      finishSave({
        ...detail(DURABLE, false, id).scenario,
        updatedAt: "2026-01-01T00:00:01.000Z",
      });
      await saved;
    });
    // The display update was not an edit: nothing is left to save.
    expect(result.current.saveStatus).toBe("saved");

    mockUpdateScenarioRequest.mockResolvedValueOnce({
      ...detail(SIGNED, false, id).scenario,
      updatedAt: "2026-01-01T00:00:02.000Z",
    } as never);
    act(() => moveCard(result.current.graphEditor, 80));
    await advance(3000);

    const sentNodes = mockUpdateScenarioRequest.mock.calls.map(
      ([request]) => request.nodes as ScenarioFlowNode[]
    );
    expect(sentNodes.map(nodes => cardUrl(nodes[0]))).toEqual([
      DURABLE,
      SIGNED,
    ]);
  });

  it.each([
    ["finished", (finish: Settle) => finish.resolve()],
    ["failed", (finish: Settle) => finish.reject(new Error("offline"))],
  ])(
    "shows a step's signed media once its running upload %s",
    async (_label, settleUpload) => {
      mockFetchScenarioById
        .mockResolvedValueOnce(detail(DURABLE, true) as never)
        .mockResolvedValueOnce(detail(SIGNED, false) as never);
      const { result } = renderController({ activeScenarioId: "media-1" });
      await advance(0);
      const { upload, finish } = startUpload(result.current);

      await advance(1500);
      expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
      expect(cardUrl(result.current.nodes[0])).toBe(DURABLE);

      await act(async () => {
        settleUpload(finish);
        await upload.catch(() => undefined);
      });
      await advance(0);
      expect(cardUrl(result.current.nodes[0])).toBe(SIGNED);
      expect(result.current.saveStatus).toBe("saved");
    }
  );

  it("keeps the media a finished upload put in place of the loaded ref", async () => {
    const uploaded = "https://cdn.example/uploaded.png";
    mockFetchScenarioById
      .mockResolvedValueOnce(detail(DURABLE, true) as never)
      .mockResolvedValueOnce(detail(SIGNED, false) as never);
    const { result } = renderController({ activeScenarioId: "media-1" });
    await advance(0);
    const { upload, finish } = startUpload(result.current);
    await advance(1500);

    await act(async () => {
      finish.resolve();
      await upload;
      // The media field applies the upload's result as soon as it has it.
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [cardNode(uploaded)],
        history: "record",
      }));
    });
    await advance(0);

    expect(cardUrl(result.current.nodes[0])).toBe(uploaded);
  });
});

type Settle = { resolve: () => void; reject: (error: Error) => void };

function startUpload(controller: {
  trackNodeMediaOperation: <T>(nodeId: string, run: Promise<T>) => Promise<T>;
}) {
  const finish = {} as Settle;
  let upload!: Promise<void>;
  act(() => {
    upload = controller.trackNodeMediaOperation(
      "card-1",
      new Promise<void>((resolve, reject) => {
        finish.resolve = resolve;
        finish.reject = reject;
      })
    );
  });
  return { upload, finish };
}

function moveCard(
  graphEditor: ReturnType<typeof useScenarioFlowController>["graphEditor"],
  x: number
) {
  graphEditor.edit(graph => ({
    ...graph,
    nodes: graph.nodes.map(node => ({ ...node, position: { x, y: 0 } })),
    history: "record",
  }));
}
