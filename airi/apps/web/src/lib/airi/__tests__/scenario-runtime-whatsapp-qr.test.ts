/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockScenarioFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockQuickReplyFind = jest.fn();
const mockLogScenarioTriggerEvaluations = jest.fn();
const mockResolveWhatsAppQrScenarioAnchor = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

jest.mock("@/models/quick-reply", () => ({
  QuickReply: {
    find: (...args: unknown[]) => mockQuickReplyFind(...args),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-trigger-logging", () => ({
  logScenarioTriggerEvaluations: (...args: unknown[]) =>
    mockLogScenarioTriggerEvaluations(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/runtime", () => ({
  resolveWhatsAppQrScenarioAnchor: (...args: unknown[]) =>
    mockResolveWhatsAppQrScenarioAnchor(...args),
}));

import { resolveActiveScenarioRuntime } from "@/lib/airi/scenario/scenario-runtime";
import { makeClientMessageTriggerNode } from "@/lib/scenarios/__tests__/scenario-trigger-fixtures";

function createSelectSortLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function createSelectLeanQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

const QR_SCENARIO_ID = "507f1f77bcf86cd799439011";
const CATCH_ALL_ID = "507f191e810c19729de860eb";

function createQrScenario() {
  return {
    _id: QR_SCENARIO_ID,
    name: "QR Door",
    priority: 10,
    matchingRole: "default" as const,
    entryPolicy: "once_per_conversation" as const,
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    nodes: [
      {
        id: "qr-trigger",
        data: makeClientMessageTriggerNode({
          triggerConfig: {
            enabled: true,
            entryPointType: "whatsapp_qr",
            messageMatchMode: "exact",
            keywordPattern: "never-match-this",
          },
        }),
      },
      {
        id: "qr-action",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "qr anchored reply",
        },
      },
    ],
    edges: [{ source: "qr-trigger", target: "qr-action" }],
  };
}

function createCatchAllScenario() {
  return {
    _id: CATCH_ALL_ID,
    name: "Catch all",
    priority: 999,
    matchingRole: "fallback" as const,
    entryPolicy: "repeatable" as const,
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    nodes: [
      {
        id: "catch-trigger",
        data: makeClientMessageTriggerNode({
          triggerConfig: { enabled: true, messageMatchMode: "any" },
        }),
      },
      {
        id: "catch-action",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "catch all reply",
        },
      },
    ],
    edges: [{ source: "catch-trigger", target: "catch-action" }],
  };
}

function getLoggedScenarioEvaluations() {
  return mockLogScenarioTriggerEvaluations.mock.calls.flatMap(
    call => ((call[0] as unknown[]) || []) as Record<string, unknown>[]
  );
}

describe("scenario runtime WhatsApp QR anchoring", () => {
  it.each(["forced", "qr-anchor"])(
    "never dispatches a business-event draft through %s ingress",
    async mode => {
      const base = createQrScenario();
      const scenario = {
        ...base,
        _id: "507f1f77bcf86cd799439012",
        nodes: base.nodes.map(node =>
          node.id === "qr-trigger"
            ? {
                ...node,
                data: {
                  kind: "trigger",
                  triggerConfig: {
                    entryPointType: "business_event",
                    enabled: true,
                    businessEvent: { integrationId: "forte-market" },
                  },
                },
              }
            : node
        ),
      };
      mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(scenario));
      mockScenarioFind.mockReturnValue(createSelectSortLeanQuery([scenario]));
      if (mode === "qr-anchor")
        mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
          kind: "anchored",
          effectiveText: "hello",
          scenarioId: scenario._id,
          nodeId: "qr-trigger",
          entryPointId: "entry-1",
          codeId: "code-1",
          referencePresent: true,
        });
      const result = await resolveActiveScenarioRuntime({
        workspaceId: "workspace-1",
        conversation: { _id: "conv-1", sourceId: "source-1" } as never,
        channel: "whatsapp",
        triggerMessageText: "hello",
        ...(mode === "forced"
          ? {
              forcedScenarioId: scenario._id,
              forcedTriggerNodeId: "qr-trigger",
              skipTriggerMatch: true,
            }
          : {}),
      });
      expect(result.runtime).toBeNull();
    }
  );
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockLogScenarioTriggerEvaluations.mockResolvedValue(undefined);
    mockQuickReplyFind.mockReturnValue(createSelectSortLeanQuery([]));
    mockMessageFind.mockReturnValue(createSelectSortLeanQuery([]));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "none",
      effectiveText: "hello",
    });
  });

  it("does not call QR resolve when conversation has no sourceId", async () => {
    mockScenarioFind.mockReturnValue(
      createSelectSortLeanQuery([createCatchAllScenario()])
    );
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(null));

    await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "hello\n[Ref: 01234-ABCDE]",
    });

    expect(mockResolveWhatsAppQrScenarioAnchor).not.toHaveBeenCalled();
  });

  it("anchors QR scenario ahead of catch-all using effective text", async () => {
    const qrScenario = createQrScenario();
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(qrScenario));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "anchored",
      effectiveText: "Need help",
      scenarioId: QR_SCENARIO_ID,
      nodeId: "qr-trigger",
      entryPointId: "entry-1",
      codeId: "code-1",
      referencePresent: true,
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "Need help\n[Ref: 01234-ABCDE]",
    });

    expect(mockResolveWhatsAppQrScenarioAnchor).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      messageText: "Need help\n[Ref: 01234-ABCDE]",
    });
    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(result.runtime?.scenarioId).toBe(QR_SCENARIO_ID);
    expect(result.runtime?.actionReplyText).toBe("qr anchored reply");

    const logs = getLoggedScenarioEvaluations();
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: QR_SCENARIO_ID,
          result: "winner",
          matched: true,
          meta: expect.objectContaining({
            qrAnchored: true,
            entryPointType: "whatsapp_qr",
            qrIngress: { anchored: true },
          }),
        }),
      ])
    );
  });

  it("fail-closes QR without falling through to catch-all", async () => {
    mockScenarioFind.mockReturnValue(
      createSelectSortLeanQuery([createCatchAllScenario(), createQrScenario()])
    );
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(null));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "fail_closed",
      effectiveText: "Need help",
      reason: "unknown_reference",
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "Need help\n[Ref: 01234-ABCDE]",
    });

    expect(result.runtime).toBeNull();
    expect(mockScenarioFind).not.toHaveBeenCalled();
    const logs = getLoggedScenarioEvaluations();
    expect(logs).toEqual([
      expect.objectContaining({
        result: "trigger_mismatch",
        mismatchReason: "unknown_reference",
        matched: false,
        meta: expect.objectContaining({
          entryPointType: "whatsapp_qr",
          qrIngress: { anchored: false, reason: "unknown_reference" },
        }),
      }),
    ]);
  });

  it("leaves ordinary matching unchanged when QR kind is none", async () => {
    mockScenarioFind.mockReturnValue(
      createSelectSortLeanQuery([createCatchAllScenario()])
    );
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(null));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "none",
      effectiveText: "hello",
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "hello",
    });

    expect(result.runtime?.scenarioId).toBe(CATCH_ALL_ID);
    expect(result.runtime?.actionReplyText).toBe("catch all reply");
  });

  it("honors entryPolicy once_per_conversation for QR anchors", async () => {
    const qrScenario = createQrScenario();
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(qrScenario));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "anchored",
      effectiveText: "Need help",
      scenarioId: QR_SCENARIO_ID,
      nodeId: "qr-trigger",
      entryPointId: "entry-1",
      codeId: "code-1",
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "Need help\n[Ref: 01234-ABCDE]",
      scenarioState: {
        startedScenarios: [
          {
            scenarioId: QR_SCENARIO_ID,
            scenarioName: "QR Door",
            startedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    });

    expect(result.runtime).toBeNull();
    const logs = getLoggedScenarioEvaluations();
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: QR_SCENARIO_ID,
          result: "blocked",
          mismatchReason: "blocked_by_once_per_conversation",
        }),
      ])
    );
  });

  it("fail-closes invalid QR ingress before a forced scenario can run", async () => {
    const forced = createCatchAllScenario();
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(forced));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "fail_closed",
      effectiveText: "Need help",
      reason: "unknown_reference",
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "Need help\n[Ref: 01234-ABCDE]",
      forcedScenarioId: CATCH_ALL_ID,
    });

    expect(result.runtime).toBeNull();
    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(getLoggedScenarioEvaluations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "__whatsapp_qr_fail_closed__",
          mismatchReason: "unknown_reference",
        }),
      ])
    );
  });

  it("fail-closes invalid QR ingress before a locked scenario can run", async () => {
    const locked = createCatchAllScenario();
    mockScenarioFindOne.mockReturnValue(createSelectLeanQuery(locked));
    mockResolveWhatsAppQrScenarioAnchor.mockResolvedValue({
      kind: "fail_closed",
      effectiveText: "Need help",
      reason: "unknown_reference",
    });

    const result = await resolveActiveScenarioRuntime({
      workspaceId: "workspace-1",
      conversation: { _id: "conv-1", sourceId: "source-1" } as never,
      channel: "whatsapp",
      triggerMessageText: "Need help\n[Ref: 01234-ABCDE]",
      scenarioState: {
        lockedScenarioId: CATCH_ALL_ID,
        lockedScenarioName: "Catch all",
        currentActionNodeId: "catch-action",
      },
    });

    expect(mockScenarioFind).not.toHaveBeenCalled();
    expect(result.runtime).toBeNull();
    expect(result.whatsappQrTrace).toEqual({
      referencePresent: true,
      outcome: "fail_closed",
      reasonCode: "unknown_reference",
    });
  });
});
