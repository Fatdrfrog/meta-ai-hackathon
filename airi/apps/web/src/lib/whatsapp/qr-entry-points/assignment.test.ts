import type { ScenarioFlowNode } from "@/components/scenarios/types";
import type { WhatsAppQrCodeRecord } from "@/models/whatsapp-qr-code";
import type { WhatsAppQrEntryPointRecord } from "@/models/whatsapp-qr-entry-point";

jest.mock("./indexes", () => ({
  assertWhatsAppQrUnassignedWritesEnabled: jest.fn(),
}));
jest.mock("./provider", () => ({
  createWhatsAppChatQr: jest.fn(),
  deleteWhatsAppChatQr: jest.fn(),
}));
jest.mock("./operation-store", () => ({
  hasActiveWhatsAppQrDeleteOperation: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/models/scenario", () => ({
  Scenario: {
    startSession: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));
jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock("@/models/whatsapp-qr-code", () => ({
  WhatsAppQrCode: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));

import { Scenario } from "@/models/scenario";
import { WhatsAppQrCode } from "@/models/whatsapp-qr-code";
import { WhatsAppQrEntryPoint } from "@/models/whatsapp-qr-entry-point";
import { assertWhatsAppQrUnassignedWritesEnabled } from "./indexes";
import { createWhatsAppChatQr, deleteWhatsAppChatQr } from "./provider";
import {
  assignWhatsAppQrEntryPoint,
  recoverDetachedWhatsAppQrEntryPoint,
  unassignWhatsAppQrEntryPoint,
  WhatsAppQrAssignmentError,
} from "./assignment";

const WORKSPACE_ID = "workspace-1";
const SCENARIO_A_ID = "64b000000000000000000001";
const SCENARIO_B_ID = "64b000000000000000000002";
const ENTRY_1 = "11111111-1111-4111-8111-111111111111";
const ENTRY_2 = "22222222-2222-4222-8222-222222222222";
const REVISION_A = "2026-08-10T10:00:00.000Z";
const REVISION_B = "2026-08-10T11:00:00.000Z";

type ScenarioRecord = {
  _id: string;
  workspaceId: string;
  name: string;
  status: "draft" | "active";
  nodes: ScenarioFlowNode[];
  updatedAt: Date;
  deletedAt: null;
};

type FakeState = {
  scenarios: ScenarioRecord[];
  entryPoints: WhatsAppQrEntryPointRecord[];
  codes: WhatsAppQrCodeRecord[];
};

let state: FakeState;
let scenarioWrites: string[];
let failNextScenarioWrite = false;
let failEntryPointUpdateFor: string | null = null;

const mockGate = jest.mocked(assertWhatsAppQrUnassignedWritesEnabled);
const mockStartSession = jest.mocked(Scenario.startSession);
const mockScenarioFindOne = jest.mocked(Scenario.findOne);
const mockScenarioFindOneAndUpdate = jest.mocked(Scenario.findOneAndUpdate);
const mockEntryPointFindOne = jest.mocked(WhatsAppQrEntryPoint.findOne);
const mockEntryPointFindOneAndUpdate = jest.mocked(
  WhatsAppQrEntryPoint.findOneAndUpdate
);
const mockEntryPointCreate = jest.mocked(WhatsAppQrEntryPoint.create);
const mockCodeFindOne = jest.mocked(WhatsAppQrCode.findOne);
const mockCodeFindOneAndUpdate = jest.mocked(WhatsAppQrCode.findOneAndUpdate);

function qrNode(id: string, entryPointId?: string): ScenarioFlowNode {
  return {
    id,
    type: "scenario",
    position: { x: 0, y: 0 },
    data: {
      kind: "trigger",
      triggerConfig: {
        entryPointType: "whatsapp_qr",
        ...(entryPointId ? { entryPointId } : {}),
      },
    },
  };
}

function scenario(params: {
  id: string;
  revision: string;
  status?: "draft" | "active";
  nodes: ScenarioFlowNode[];
}): ScenarioRecord {
  return {
    _id: params.id,
    workspaceId: WORKSPACE_ID,
    name: `Scenario ${params.id === SCENARIO_A_ID ? "A" : "B"}`,
    status: params.status ?? "draft",
    nodes: params.nodes,
    updatedAt: new Date(params.revision),
    deletedAt: null,
  };
}

function activeEntryPoint(params: {
  id: string;
  version?: number;
  scenarioId?: string;
  nodeId?: string;
  status?: "ACTIVE" | "DETACHED";
}): WhatsAppQrEntryPointRecord {
  return {
    entryPointId: params.id,
    workspaceId: WORKSPACE_ID,
    ...(params.scenarioId ? { scenarioId: params.scenarioId } : {}),
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    assignmentState:
      params.scenarioId && params.nodeId ? "assigned" : "unassigned",
    placementName: `QR ${params.id.slice(0, 4)}`,
    placementNameSearch: `qr ${params.id.slice(0, 4)}`,
    desiredMessage: "Hello",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    currentCodeId: `code-${params.id.slice(0, 4)}`,
    status: params.status ?? "ACTIVE",
    version: params.version ?? 3,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-09T00:00:00.000Z"),
  };
}

function currentCode(
  entryPoint: WhatsAppQrEntryPointRecord
): WhatsAppQrCodeRecord {
  return {
    codeId: entryPoint.currentCodeId!,
    workspaceId: WORKSPACE_ID,
    entryPointId: entryPoint.entryPointId,
    sourceId: entryPoint.sourceId!,
    wabaId: entryPoint.wabaId!,
    phoneNumberId: entryPoint.phoneNumberId!,
    referenceCode: "ABCDEFGHJK",
    providerCode: `provider-${entryPoint.entryPointId.slice(0, 4)}`,
    deepLink: "https://wa.me/message/ABCDEFGHJK",
    prefilledMessage: "Hello",
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 7,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-09T00:00:00.000Z"),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (Object.prototype.toString.call(expected) === "[object Date]") {
    return (
      Object.prototype.toString.call(actual) === "[object Date]" &&
      new Date(actual as Date).getTime() ===
        new Date(expected as Date).getTime()
    );
  }
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected)
  ) {
    const record = expected as Record<string, unknown>;
    if ("$exists" in record) return (actual !== undefined) === record.$exists;
    if ("$in" in record)
      return (record.$in as unknown[]).some(value => sameValue(actual, value));
  }
  return String(actual) === String(expected);
}

function matches(
  document: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  return Object.entries(filter).every(([key, expected]) =>
    sameValue(document[key], expected)
  );
}

function query<T>(resolve: () => T) {
  const chain = {
    session: jest.fn(),
    lean: jest.fn(async () => clone(resolve())),
  };
  chain.session.mockReturnValue(chain);
  return chain;
}

function applyUpdate<T extends Record<string, unknown>>(
  document: T,
  update: Record<string, Record<string, unknown>>
): void {
  for (const [key, value] of Object.entries(update.$set ?? {})) {
    document[key as keyof T] = clone(value) as T[keyof T];
  }
  for (const key of Object.keys(update.$unset ?? {})) {
    delete document[key as keyof T];
  }
  for (const [key, value] of Object.entries(update.$inc ?? {})) {
    document[key as keyof T] = (Number(document[key as keyof T]) +
      Number(value)) as T[keyof T];
  }
}

function installFakeDatabase(initial: FakeState): void {
  state = clone(initial);
  scenarioWrites = [];
  failNextScenarioWrite = false;
  failEntryPointUpdateFor = null;

  mockScenarioFindOne.mockImplementation(
    (filter: unknown) =>
      query(
        () =>
          state.scenarios.find(item =>
            matches(
              item as unknown as Record<string, unknown>,
              filter as Record<string, unknown>
            )
          ) ?? null
      ) as never
  );
  mockScenarioFindOneAndUpdate.mockImplementation(
    (filter: unknown, update: unknown) =>
      query(() => {
        if (failNextScenarioWrite) {
          failNextScenarioWrite = false;
          return null;
        }
        const item = state.scenarios.find(candidate =>
          matches(
            candidate as unknown as Record<string, unknown>,
            filter as Record<string, unknown>
          )
        );
        if (!item) return null;
        applyUpdate(
          item as unknown as Record<string, unknown>,
          update as Record<string, Record<string, unknown>>
        );
        scenarioWrites.push(item._id);
        return item;
      }) as never
  );
  mockEntryPointFindOne.mockImplementation(
    (filter: unknown) =>
      query(
        () =>
          state.entryPoints.find(item =>
            matches(
              item as unknown as Record<string, unknown>,
              filter as Record<string, unknown>
            )
          ) ?? null
      ) as never
  );
  mockEntryPointFindOneAndUpdate.mockImplementation(
    (filter: unknown, update: unknown) =>
      query(() => {
        const targetId = (filter as { entryPointId?: string }).entryPointId;
        if (targetId && failEntryPointUpdateFor === targetId) return null;
        const item = state.entryPoints.find(candidate =>
          matches(
            candidate as unknown as Record<string, unknown>,
            filter as Record<string, unknown>
          )
        );
        if (!item) return null;
        applyUpdate(
          item as unknown as Record<string, unknown>,
          update as Record<string, Record<string, unknown>>
        );
        return item;
      }) as never
  );
  mockEntryPointCreate.mockImplementation((documents: unknown) => {
    const values = Array.isArray(documents) ? documents : [documents];
    const created = values.map(value => ({
      ...(value as WhatsAppQrEntryPointRecord),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    state.entryPoints.push(...created);
    return Promise.resolve(clone(created)) as never;
  });
  mockCodeFindOne.mockImplementation(
    (filter: unknown) =>
      query(
        () =>
          state.codes.find(item =>
            matches(
              item as unknown as Record<string, unknown>,
              filter as Record<string, unknown>
            )
          ) ?? null
      ) as never
  );
  mockCodeFindOneAndUpdate.mockImplementation(
    (filter: unknown, update: unknown) =>
      query(() => {
        const item = state.codes.find(candidate =>
          matches(
            candidate as unknown as Record<string, unknown>,
            filter as Record<string, unknown>
          )
        );
        if (!item) return null;
        applyUpdate(
          item as unknown as Record<string, unknown>,
          update as Record<string, Record<string, unknown>>
        );
        return item;
      }) as never
  );

  mockStartSession.mockImplementation(
    async () =>
      ({
        withTransaction: async (operation: () => Promise<void>) => {
          const before = clone(state);
          try {
            await operation();
          } catch (error) {
            state = before;
            throw error;
          }
        },
        endSession: jest.fn(async () => undefined),
      }) as never
  );
}

function assignInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    entryPointId: ENTRY_1,
    expectedEntryPointVersion: 3,
    target: {
      scenarioId: SCENARIO_B_ID,
      nodeId: "target",
      expectedUpdatedAt: REVISION_B,
      expectedCurrentEntryPointId: null,
    },
    acknowledgeMove: false,
    acknowledgeReplacement: false,
    ...overrides,
  };
}

function expectAssignmentError(
  error: unknown,
  code: WhatsAppQrAssignmentError["code"]
) {
  expect(error).toBeInstanceOf(WhatsAppQrAssignmentError);
  expect((error as WhatsAppQrAssignmentError).code).toBe(code);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue();
});

describe("transactional WhatsApp QR assignment", () => {
  test("assigns a ready unassigned ACTIVE entry point to a draft QR node", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    const result = await assignWhatsAppQrEntryPoint(assignInput());

    expect(state.scenarios[0].nodes[0].data.triggerConfig?.entryPointId).toBe(
      ENTRY_1
    );
    expect(state.entryPoints[0]).toMatchObject({
      scenarioId: SCENARIO_B_ID,
      nodeId: "target",
      assignmentState: "assigned",
      version: 4,
    });
    expect(result).toMatchObject({
      entryPointId: ENTRY_1,
      entryPointVersion: 4,
      assignment: {
        scenarioId: SCENARIO_B_ID,
        nodeId: "target",
        scenarioName: "Scenario B",
        scenarioStatus: "draft",
      },
      targetScenario: {
        scenarioId: SCENARIO_B_ID,
        nodeId: "target",
        previousEntryPointId: null,
      },
    });
    expect(scenarioWrites).toEqual([SCENARIO_B_ID]);
    expect(createWhatsAppChatQr).not.toHaveBeenCalled();
    expect(deleteWhatsAppChatQr).not.toHaveBeenCalled();
  });

  test("returns an already committed desired state before stale-version rejection", async () => {
    const entryPoint = activeEntryPoint({
      id: ENTRY_1,
      version: 9,
      scenarioId: SCENARIO_B_ID,
      nodeId: "target",
    });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          status: "active",
          nodes: [qrNode("target", ENTRY_1)],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    const result = await assignWhatsAppQrEntryPoint(
      assignInput({ expectedEntryPointVersion: 1 })
    );

    expect(result.entryPointVersion).toBe(9);
    expect(result.assignment?.scenarioStatus).toBe("active");
    expect(scenarioWrites).toEqual([]);
  });

  test("rejects a stale target Scenario revision", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await assignWhatsAppQrEntryPoint(
      assignInput({
        target: {
          ...assignInput().target,
          expectedUpdatedAt: "2026-08-10T10:59:00.000Z",
        },
      })
    ).catch(error => expectAssignmentError(error, "VERSION_CONFLICT"));
    expect(
      state.scenarios[0].nodes[0].data.triggerConfig?.entryPointId
    ).toBeUndefined();
    expect(state.entryPoints[0].assignmentState).toBe("unassigned");
  });

  test("blocks pointer changes into an active target Scenario", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          status: "active",
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await assignWhatsAppQrEntryPoint(assignInput()).catch(error =>
      expectAssignmentError(error, "ACTIVE_SCENARIO_ASSIGNMENT")
    );
    expect(scenarioWrites).toEqual([]);
  });

  test("rejects an ACTIVE entry point whose current code is no longer ready", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [
        {
          ...currentCode(entryPoint),
          placementBindingState: "HISTORICAL",
        },
      ],
    });

    await expect(
      assignWhatsAppQrEntryPoint(assignInput())
    ).rejects.toMatchObject({ code: "ENTRY_POINT_NOT_READY" });
    expect(scenarioWrites).toEqual([]);
    expect(mockCodeFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("rejects a missing target Scenario at the transactional boundary", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await expect(
      assignWhatsAppQrEntryPoint(assignInput())
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(scenarioWrites).toEqual([]);
  });

  test("rejects a target Scenario owned by another workspace", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    installFakeDatabase({
      scenarios: [
        {
          ...scenario({
            id: SCENARIO_B_ID,
            revision: REVISION_B,
            nodes: [qrNode("target")],
          }),
          workspaceId: "workspace-foreign",
        },
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await expect(
      assignWhatsAppQrEntryPoint(assignInput())
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(scenarioWrites).toEqual([]);
  });

  test("rejects a target node that is not a WhatsApp QR trigger", async () => {
    const entryPoint = activeEntryPoint({ id: ENTRY_1 });
    const nonQrNode = {
      id: "target",
      type: "scenario",
      position: { x: 0, y: 0 },
      data: { kind: "action" },
    } as ScenarioFlowNode;
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [nonQrNode],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await expect(
      assignWhatsAppQrEntryPoint(assignInput())
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(scenarioWrites).toEqual([]);
  });

  test("requires explicit cross-Scenario move acknowledgement and source revision", async () => {
    const entryPoint = activeEntryPoint({
      id: ENTRY_1,
      scenarioId: SCENARIO_A_ID,
      nodeId: "source",
    });
    const initial = {
      scenarios: [
        scenario({
          id: SCENARIO_A_ID,
          revision: REVISION_A,
          nodes: [qrNode("source", ENTRY_1)],
        }),
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    };
    installFakeDatabase(initial);

    await assignWhatsAppQrEntryPoint(assignInput()).catch(error =>
      expectAssignmentError(error, "MOVE_ACKNOWLEDGEMENT_REQUIRED")
    );

    installFakeDatabase(initial);
    await assignWhatsAppQrEntryPoint(
      assignInput({ acknowledgeMove: true })
    ).catch(error => expectAssignmentError(error, "SOURCE_REVISION_REQUIRED"));

    installFakeDatabase(initial);
    const result = await assignWhatsAppQrEntryPoint(
      assignInput({
        acknowledgeMove: true,
        sourceExpectedUpdatedAt: REVISION_A,
      })
    );
    expect(
      state.scenarios[0].nodes[0].data.triggerConfig?.entryPointId
    ).toBeUndefined();
    expect(state.scenarios[1].nodes[0].data.triggerConfig?.entryPointId).toBe(
      ENTRY_1
    );
    expect(result.sourceScenario).toMatchObject({
      scenarioId: SCENARIO_A_ID,
      nodeId: "source",
    });
  });

  test("blocks a move and unassign from an active source Scenario", async () => {
    const entryPoint = activeEntryPoint({
      id: ENTRY_1,
      scenarioId: SCENARIO_A_ID,
      nodeId: "source",
    });
    const initial = {
      scenarios: [
        scenario({
          id: SCENARIO_A_ID,
          revision: REVISION_A,
          status: "active" as const,
          nodes: [qrNode("source", ENTRY_1)],
        }),
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    };
    installFakeDatabase(initial);
    await assignWhatsAppQrEntryPoint(
      assignInput({
        acknowledgeMove: true,
        sourceExpectedUpdatedAt: REVISION_A,
      })
    ).catch(error =>
      expectAssignmentError(error, "ACTIVE_SCENARIO_ASSIGNMENT")
    );

    installFakeDatabase(initial);
    await unassignWhatsAppQrEntryPoint({
      workspaceId: WORKSPACE_ID,
      entryPointId: ENTRY_1,
      expectedEntryPointVersion: 3,
      sourceExpectedUpdatedAt: REVISION_A,
    }).catch(error =>
      expectAssignmentError(error, "ACTIVE_SCENARIO_ASSIGNMENT")
    );
  });

  test("moves within one Scenario with one graph write", async () => {
    const entryPoint = activeEntryPoint({
      id: ENTRY_1,
      scenarioId: SCENARIO_A_ID,
      nodeId: "source",
    });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_A_ID,
          revision: REVISION_A,
          nodes: [qrNode("source", ENTRY_1), qrNode("target")],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [currentCode(entryPoint)],
    });

    await assignWhatsAppQrEntryPoint(
      assignInput({
        target: {
          scenarioId: SCENARIO_A_ID,
          nodeId: "target",
          expectedUpdatedAt: REVISION_A,
          expectedCurrentEntryPointId: null,
        },
      })
    );

    expect(scenarioWrites).toEqual([SCENARIO_A_ID]);
    expect(
      state.scenarios[0].nodes[0].data.triggerConfig?.entryPointId
    ).toBeUndefined();
    expect(state.scenarios[0].nodes[1].data.triggerConfig?.entryPointId).toBe(
      ENTRY_1
    );
  });

  test("requires exact replacement acknowledgement and unassigns the displaced resource", async () => {
    const selected = activeEntryPoint({ id: ENTRY_1 });
    const displaced = activeEntryPoint({
      id: ENTRY_2,
      version: 8,
      scenarioId: SCENARIO_B_ID,
      nodeId: "target",
    });
    const initial = {
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target", ENTRY_2)],
        }),
      ],
      entryPoints: [selected, displaced],
      codes: [currentCode(selected), currentCode(displaced)],
    };
    installFakeDatabase(initial);

    await assignWhatsAppQrEntryPoint(
      assignInput({
        target: {
          ...assignInput().target,
          expectedCurrentEntryPointId: ENTRY_2,
          expectedCurrentEntryPointVersion: 8,
        },
      })
    ).catch(error =>
      expectAssignmentError(error, "REPLACEMENT_ACKNOWLEDGEMENT_REQUIRED")
    );

    installFakeDatabase(initial);
    const result = await assignWhatsAppQrEntryPoint(
      assignInput({
        acknowledgeReplacement: true,
        target: {
          ...assignInput().target,
          expectedCurrentEntryPointId: ENTRY_2,
          expectedCurrentEntryPointVersion: 8,
        },
      })
    );
    expect(
      state.entryPoints.find(item => item.entryPointId === ENTRY_2)
    ).toMatchObject({
      assignmentState: "unassigned",
      version: 9,
    });
    expect(
      state.entryPoints.find(item => item.entryPointId === ENTRY_2)?.scenarioId
    ).toBeUndefined();
    expect(result.displacedEntryPoint).toEqual({
      entryPointId: ENTRY_2,
      version: 9,
    });
  });

  test("rolls back every graph and reverse projection when a transaction write loses CAS", async () => {
    const selected = activeEntryPoint({ id: ENTRY_1 });
    const displaced = activeEntryPoint({
      id: ENTRY_2,
      version: 8,
      scenarioId: SCENARIO_B_ID,
      nodeId: "target",
    });
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_B_ID,
          revision: REVISION_B,
          nodes: [qrNode("target", ENTRY_2)],
        }),
      ],
      entryPoints: [selected, displaced],
      codes: [currentCode(selected), currentCode(displaced)],
    });
    failEntryPointUpdateFor = ENTRY_1;

    await assignWhatsAppQrEntryPoint(
      assignInput({
        acknowledgeReplacement: true,
        target: {
          ...assignInput().target,
          expectedCurrentEntryPointId: ENTRY_2,
          expectedCurrentEntryPointVersion: 8,
        },
      })
    ).catch(error => expectAssignmentError(error, "VERSION_CONFLICT"));

    expect(state.scenarios[0].nodes[0].data.triggerConfig?.entryPointId).toBe(
      ENTRY_2
    );
    expect(state.entryPoints).toEqual([selected, displaced]);
  });

  test("unassigns without changing provider lifecycle, current code, or history", async () => {
    const entryPoint = activeEntryPoint({
      id: ENTRY_1,
      scenarioId: SCENARIO_A_ID,
      nodeId: "source",
    });
    const code = currentCode(entryPoint);
    const history = {
      ...code,
      codeId: "historical",
      placementBindingState: "HISTORICAL" as const,
    };
    installFakeDatabase({
      scenarios: [
        scenario({
          id: SCENARIO_A_ID,
          revision: REVISION_A,
          nodes: [qrNode("source", ENTRY_1)],
        }),
      ],
      entryPoints: [entryPoint],
      codes: [code, history],
    });

    const result = await unassignWhatsAppQrEntryPoint({
      workspaceId: WORKSPACE_ID,
      entryPointId: ENTRY_1,
      expectedEntryPointVersion: 3,
      sourceExpectedUpdatedAt: REVISION_A,
    });

    expect(state.entryPoints[0]).toMatchObject({
      status: "ACTIVE",
      sourceId: "source-1",
      currentCodeId: "code-1111",
      assignmentState: "unassigned",
      version: 4,
    });
    expect(state.codes).toEqual([code, history]);
    expect(result.assignment).toBeNull();
  });
});

describe("detached recovery", () => {
  test("recovers an absent provider tuple as unassigned DRAFT", async () => {
    const detached: WhatsAppQrEntryPointRecord = {
      entryPointId: ENTRY_1,
      workspaceId: WORKSPACE_ID,
      assignmentState: "unassigned",
      placementName: "Detached",
      placementNameSearch: "detached",
      status: "DETACHED",
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    installFakeDatabase({ scenarios: [], entryPoints: [detached], codes: [] });

    const result = await recoverDetachedWhatsAppQrEntryPoint({
      workspaceId: WORKSPACE_ID,
      entryPointId: ENTRY_1,
      expectedEntryPointVersion: 2,
    });

    expect(state.entryPoints[0]).toMatchObject({
      status: "DRAFT",
      assignmentState: "unassigned",
      version: 3,
    });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DETACHED",
        sourceId: { $exists: false },
        wabaId: { $exists: false },
        phoneNumberId: { $exists: false },
        currentCodeId: { $exists: false },
      }),
      expect.anything(),
      expect.anything()
    );
    expect(result.assignment).toBeNull();
  });

  test("recovers only a complete tuple with an exact healthy current code as unassigned ACTIVE", async () => {
    const detached = activeEntryPoint({
      id: ENTRY_1,
      version: 2,
      status: "DETACHED",
    });
    installFakeDatabase({
      scenarios: [],
      entryPoints: [detached],
      codes: [currentCode(detached)],
    });

    await recoverDetachedWhatsAppQrEntryPoint({
      workspaceId: WORKSPACE_ID,
      entryPointId: ENTRY_1,
      expectedEntryPointVersion: 2,
    });

    expect(state.entryPoints[0]).toMatchObject({
      status: "ACTIVE",
      assignmentState: "unassigned",
      version: 3,
    });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "DETACHED",
        sourceId: detached.sourceId,
        wabaId: detached.wabaId,
        phoneNumberId: detached.phoneNumberId,
        currentCodeId: detached.currentCodeId,
      }),
      expect.anything(),
      expect.anything()
    );
  });

  test.each(["partial tuple", "mismatched code"])(
    "keeps ambiguous detached state for %s",
    async kind => {
      const detached = activeEntryPoint({
        id: ENTRY_1,
        version: 2,
        status: "DETACHED",
      });
      if (kind === "partial tuple") delete detached.phoneNumberId;
      const code = currentCode(detached);
      if (kind === "mismatched code") code.routingState = "DISABLED";
      installFakeDatabase({
        scenarios: [],
        entryPoints: [detached],
        codes: [code],
      });

      await recoverDetachedWhatsAppQrEntryPoint({
        workspaceId: WORKSPACE_ID,
        entryPointId: ENTRY_1,
        expectedEntryPointVersion: 2,
      }).catch(error => expectAssignmentError(error, "DETACHED_STATE_INVALID"));

      expect(state.entryPoints[0].status).toBe("DETACHED");
      expect(state.entryPoints[0].version).toBe(2);
    }
  );
});

test("migration gating runs before a session or write is opened", async () => {
  mockGate.mockRejectedValueOnce(
    new Error("WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED")
  );

  await expect(assignWhatsAppQrEntryPoint(assignInput())).rejects.toThrow(
    "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
  );
  expect(mockStartSession).not.toHaveBeenCalled();
  expect(mockScenarioFindOne).not.toHaveBeenCalled();
  expect(mockEntryPointFindOne).not.toHaveBeenCalled();
});
