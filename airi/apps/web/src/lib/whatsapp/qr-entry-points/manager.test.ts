/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockEntryPointFind = jest.fn();
const mockEntryPointFindOne = jest.fn();
const mockEntryPointFindOneAndUpdate = jest.fn();
const mockEntryPointSave = jest.fn();
const mockCodeFind = jest.fn();
const mockOperationFind = jest.fn();
const mockOperationExists = jest.fn();
const mockScenarioFind = jest.fn();
const mockAssertUnassignedWrites = jest.fn();
const mockEntryPointConstruct = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WhatsAppQrEntryPoint: Object.assign(
    function MockWhatsAppQrEntryPoint(value: Record<string, unknown>) {
      mockEntryPointConstruct(value);
      return {
        ...value,
        save: () => mockEntryPointSave(value),
      };
    },
    {
      find: (...args: unknown[]) => mockEntryPointFind(...args),
      findOne: (...args: unknown[]) => mockEntryPointFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockEntryPointFindOneAndUpdate(...args),
    }
  ),
}));

jest.mock("@/models/whatsapp-qr-code", () => ({
  WhatsAppQrCode: {
    find: (...args: unknown[]) => mockCodeFind(...args),
  },
}));

jest.mock("@/models/whatsapp-qr-operation", () => ({
  WhatsAppQrOperation: {
    find: (...args: unknown[]) => mockOperationFind(...args),
    exists: (...args: unknown[]) => mockOperationExists(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
  },
}));

jest.mock("./indexes", () => ({
  assertWhatsAppQrUnassignedWritesEnabled: (...args: unknown[]) =>
    mockAssertUnassignedWrites(...args),
}));

import {
  createUnassignedWhatsAppQrDraftEntryPoint,
  listWhatsAppQrEntryPoints,
  patchManagedWhatsAppQrEntryPoint,
  WhatsAppQrManagerError,
} from "./manager";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";

function leanQuery<T>(value: T) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function selectedLeanQuery<T>(value: T) {
  const lean = jest.fn().mockResolvedValue(value);
  const select = jest.fn().mockReturnValue({ lean });
  return { query: { select }, select, lean };
}

function managerFindQuery<T>(value: T) {
  const lean = jest.fn().mockResolvedValue(value);
  const limit = jest.fn().mockReturnValue({ lean });
  const collation = jest.fn().mockReturnValue({ limit });
  const hint = jest.fn().mockReturnValue({ collation });
  const sort = jest.fn().mockReturnValue({ hint });
  return { query: { sort }, sort, hint, collation, limit, lean };
}

function entryPoint(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    entryPointId: ENTRY_ID,
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    assignmentState: "assigned",
    placementName: "Store front",
    placementNameSearch: "store front",
    desiredMessage: "Hello",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    currentCodeId: "code-1",
    status: "ACTIVE",
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("WhatsApp QR Manager domain", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockAssertUnassignedWrites.mockResolvedValue(undefined);
    mockCodeFind.mockReturnValue(selectedLeanQuery([]).query);
    mockOperationFind.mockReturnValue(selectedLeanQuery([]).query);
    mockOperationExists.mockResolvedValue(null);
    mockScenarioFind.mockReturnValue(selectedLeanQuery([]).query);
  });

  it("lists in stable updatedAt-descending order and batches all enrichments", async () => {
    const rows = [
      entryPoint(),
      entryPoint({
        entryPointId: "22222222-2222-4222-8222-222222222222",
        updatedAt: new Date("2026-08-09T12:00:00.000Z"),
      }),
    ];
    const managerQuery = managerFindQuery(rows);
    const codeQuery = selectedLeanQuery([
      {
        codeId: "code-1",
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        providerCode: "CODE1",
        deepLink: "https://wa.me/message/CODE1",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
      },
      {
        codeId: "code-other-tenant",
        workspaceId: "workspace-2",
        entryPointId: ENTRY_ID,
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
      },
    ]);
    const operationQuery = selectedLeanQuery([
      {
        operationId: "operation-1",
        workspaceId: "workspace-1",
        entryPointId: "22222222-2222-4222-8222-222222222222",
        status: "RUNNING",
      },
    ]);
    const scenarioQuery = selectedLeanQuery([
      {
        _id: "scenario-1",
        workspaceId: "workspace-1",
        name: "Welcome",
        status: "active",
        updatedAt: new Date("2026-08-08T12:00:00.000Z"),
      },
      {
        _id: "scenario-1",
        workspaceId: "workspace-2",
        name: "Secret",
        status: "active",
        updatedAt: NOW,
      },
    ]);
    mockEntryPointFind.mockReturnValue(managerQuery.query);
    mockCodeFind.mockReturnValue(codeQuery.query);
    mockOperationFind.mockReturnValue(operationQuery.query);
    mockScenarioFind.mockReturnValue(scenarioQuery.query);

    const result = await listWhatsAppQrEntryPoints({
      workspaceId: "workspace-1",
      limit: 2,
    });

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          entryPointId: ENTRY_ID,
          readiness: "ready",
          currentCode: {
            codeId: "code-1",
            deepLink: "https://wa.me/message/CODE1",
            placementBindingState: "CURRENT",
            routingState: "ENABLED",
            providerState: "ACTIVE",
          },
          reconcilePending: false,
          assignment: {
            scenarioId: "scenario-1",
            nodeId: "node-1",
            scenarioName: "Welcome",
            scenarioStatus: "active",
            scenarioUpdatedAt: "2026-08-08T12:00:00.000Z",
          },
        }),
        expect.objectContaining({
          entryPointId: "22222222-2222-4222-8222-222222222222",
          readiness: "reconciling",
          reconcilePending: true,
        }),
      ],
      nextCursor: null,
    });
    expect(mockEntryPointFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(managerQuery.sort).toHaveBeenCalledWith({
      updatedAt: -1,
      entryPointId: 1,
    });
    expect(managerQuery.hint).toHaveBeenCalledWith(
      "whatsapp_qr_manager_list_base_v1"
    );
    expect(managerQuery.limit).toHaveBeenCalledWith(3);
    expect(mockCodeFind).toHaveBeenCalledTimes(1);
    expect(mockCodeFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      codeId: { $in: ["code-1"] },
    });
    expect(mockOperationFind).toHaveBeenCalledTimes(1);
    expect(mockOperationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: {
        $in: [ENTRY_ID, "22222222-2222-4222-8222-222222222222"],
      },
      status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
    });
    expect(mockScenarioFind).toHaveBeenCalledTimes(1);
    expect(mockScenarioFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      _id: { $in: ["scenario-1"] },
      deletedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("Secret");
    expect(result.items[1]).not.toHaveProperty("currentCode");
  });

  it("returns a search cursor that is isolated from list and facet filters", async () => {
    const rows = [
      entryPoint(),
      entryPoint({
        entryPointId: "22222222-2222-4222-8222-222222222222",
        placementName: "Store rear",
        placementNameSearch: "store rear",
      }),
    ];
    const firstQuery = managerFindQuery(rows);
    mockEntryPointFind.mockReturnValue(firstQuery.query);

    const first = await listWhatsAppQrEntryPoints({
      workspaceId: "workspace-1",
      query: "STORE",
      sourceId: "source-1",
      limit: 1,
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(firstQuery.hint).toHaveBeenCalledWith(
      "whatsapp_qr_manager_search_source_v1"
    );
    expect(firstQuery.sort).toHaveBeenCalledWith({
      placementNameSearch: 1,
      entryPointId: 1,
    });
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        limit: 1,
        cursor: first.nextCursor!,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        query: "STORE",
        status: "ACTIVE",
        limit: 1,
        cursor: first.nextCursor!,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([0, 51, 1.5])("rejects an out-of-bounds limit %p", async limit => {
    await expect(
      listWhatsAppQrEntryPoints({ workspaceId: "workspace-1", limit })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mockEntryPointFind).not.toHaveBeenCalled();
  });

  it("rejects multiple facets and malformed cursors before querying Mongo", async () => {
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        status: "ACTIVE",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        cursor: "not-base64-json",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mockEntryPointFind).not.toHaveBeenCalled();
  });

  it("rejects noncanonical list cursor tuples before querying Mongo", async () => {
    const cursorEntryPointId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockEntryPointFind.mockReturnValue(
      managerFindQuery([
        entryPoint({ entryPointId: cursorEntryPointId }),
        entryPoint({
          entryPointId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          updatedAt: new Date("2026-08-09T12:00:00.000Z"),
        }),
      ]).query
    );
    const first = await listWhatsAppQrEntryPoints({
      workspaceId: "workspace-1",
      limit: 1,
    });
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8")
    );
    const encode = (sort: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...decoded, sort })).toString("base64url");
    const uppercaseUuid = encode({
      ...decoded.sort,
      entryPointId: cursorEntryPointId.toUpperCase(),
    });
    const noncanonicalTimestamp = encode({
      ...decoded.sort,
      updatedAt: "2026-08-10T12:00:00Z",
    });
    mockEntryPointFind.mockClear();

    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        limit: 1,
        cursor: uppercaseUuid,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        limit: 1,
        cursor: noncanonicalTimestamp,
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mockEntryPointFind).not.toHaveBeenCalled();
  });

  it("rejects noncanonical or out-of-prefix search cursor keys before querying Mongo", async () => {
    mockEntryPointFind.mockReturnValue(
      managerFindQuery([
        entryPoint({ placementNameSearch: "store front" }),
        entryPoint({
          entryPointId: "22222222-2222-4222-8222-222222222222",
          placementName: "Store rear",
          placementNameSearch: "store rear",
        }),
      ]).query
    );
    const first = await listWhatsAppQrEntryPoints({
      workspaceId: "workspace-1",
      query: "STORE",
      limit: 1,
    });
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8")
    );
    const encode = (placementNameSearch: string) =>
      Buffer.from(
        JSON.stringify({
          ...decoded,
          sort: { ...decoded.sort, placementNameSearch },
        })
      ).toString("base64url");
    mockEntryPointFind.mockClear();

    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        query: "STORE",
        limit: 1,
        cursor: encode("Store front"),
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        query: "STORE",
        limit: 1,
        cursor: encode("road"),
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mockEntryPointFind).not.toHaveBeenCalled();
  });

  it("creates an unassigned draft idempotently for an exact stable-UUID replay", async () => {
    const input = {
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
      placementName: "Store front",
      desiredMessage: "Hello",
    };
    mockEntryPointSave.mockResolvedValueOnce({
      ...entryPoint({
        scenarioId: undefined,
        nodeId: undefined,
        assignmentState: "unassigned",
        currentCodeId: undefined,
        sourceId: undefined,
        status: "DRAFT",
        version: 0,
      }),
    });
    mockEntryPointSave.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: 11000 })
    );
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(
        entryPoint({
          scenarioId: undefined,
          nodeId: undefined,
          assignmentState: "unassigned",
          currentCodeId: undefined,
          sourceId: undefined,
          status: "DRAFT",
          version: 0,
        })
      )
    );

    await expect(
      createUnassignedWhatsAppQrDraftEntryPoint(input)
    ).resolves.toMatchObject({ entryPointId: ENTRY_ID, version: 0 });
    await expect(
      createUnassignedWhatsAppQrDraftEntryPoint(input)
    ).resolves.toMatchObject({ entryPointId: ENTRY_ID, version: 0 });
    expect(mockAssertUnassignedWrites).toHaveBeenCalledTimes(2);
    expect(mockEntryPointConstruct).toHaveBeenCalledWith({
      entryPointId: ENTRY_ID,
      workspaceId: "workspace-1",
      assignmentState: "unassigned",
      placementName: "Store front",
      placementNameSearch: "store front",
      desiredMessage: "Hello",
      status: "DRAFT",
      version: 0,
    });
    expect(mockEntryPointFindOne).toHaveBeenCalledWith({
      entryPointId: ENTRY_ID,
    });
  });

  it("conflicts when a duplicate UUID replay changes tenant, name, or message", async () => {
    mockEntryPointSave.mockRejectedValue(
      Object.assign(new Error("duplicate"), { code: 11000 })
    );
    mockEntryPointFindOne.mockReturnValue(
      leanQuery(
        entryPoint({
          workspaceId: "workspace-2",
          scenarioId: undefined,
          nodeId: undefined,
          assignmentState: "unassigned",
          status: "DRAFT",
          version: 0,
        })
      )
    );

    await expect(
      createUnassignedWhatsAppQrDraftEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        placementName: "Changed",
        desiredMessage: "Changed",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([
    "11111111-1111-0111-8111-111111111111",
    "11111111-1111-6111-8111-111111111111",
    "not-a-uuid",
  ])("rejects non-v1-v5 entry-point ids: %s", async entryPointId => {
    await expect(
      createUnassignedWhatsAppQrDraftEntryPoint({
        workspaceId: "workspace-1",
        entryPointId,
        placementName: "Store front",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mockEntryPointSave).not.toHaveBeenCalled();
  });

  it("rejects active desired-message edits and preserves exact version CAS", async () => {
    mockEntryPointFindOne.mockReturnValueOnce(
      leanQuery(entryPoint({ status: "ACTIVE", version: 3 }))
    );

    await expect(
      patchManagedWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        expectedVersion: 3,
        desiredMessage: "New message",
      })
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/apply_message/),
    });
    expect(mockEntryPointFindOneAndUpdate).not.toHaveBeenCalled();

    mockEntryPointFindOne.mockReturnValueOnce(
      leanQuery(entryPoint({ status: "DRAFT", version: 3 }))
    );
    mockEntryPointFindOneAndUpdate.mockReturnValueOnce(
      leanQuery(
        entryPoint({ placementName: "New", status: "DRAFT", version: 4 })
      )
    );
    await expect(
      patchManagedWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        expectedVersion: 3,
        placementName: "New",
      })
    ).resolves.toMatchObject({ placementName: "New", version: 4 });
    expect(mockEntryPointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        version: 3,
        status: { $in: ["DRAFT", "ACTIVE"] },
      },
      {
        $set: { placementName: "New", placementNameSearch: "new" },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    );
  });

  it("connects before the cold PATCH pre-read", async () => {
    const calls: string[] = [];
    mockConnectDB.mockImplementationOnce(async () => {
      calls.push("connect");
    });
    mockEntryPointFindOne.mockImplementationOnce(() => {
      calls.push("findOne");
      return leanQuery(entryPoint({ status: "ACTIVE", version: 3 }));
    });

    await expect(
      patchManagedWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: ENTRY_ID,
        expectedVersion: 3,
        desiredMessage: "New message",
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toEqual(["connect", "findOne"]);
  });

  it("uses a stable Manager error contract", () => {
    expect(new WhatsAppQrManagerError("INVALID_INPUT", "bad")).toMatchObject({
      code: "INVALID_INPUT",
      message: "bad",
    });
  });
});
