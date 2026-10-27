/**
 * @jest-environment node
 */

const LEGACY_INDEX_NAME = "whatsapp_qr_entry_point_active_placement_unique";
const entryPointIndexes = jest.fn();
const entryPointCreateIndex = jest.fn();
const entryPointDropIndex = jest.fn();
const scenarioIndexes = jest.fn();
const scenarioCreateIndex = jest.fn();

const ENTRY_POINT_MODEL_INDEXES = [
  {
    key: { entryPointId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_entry_point_id_unique",
    },
  },
  {
    key: { workspaceId: 1, scenarioId: 1, nodeId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_entry_point_assignment_unique_v2",
      partialFilterExpression: {
        scenarioId: { $type: "string" },
        nodeId: { $type: "string" },
      },
    },
  },
  {
    key: { workspaceId: 1, sourceId: 1, status: 1, updatedAt: -1 },
    options: {
      background: true,
      name: "whatsapp_qr_entry_point_workspace_source_status_updated",
    },
  },
  {
    key: { workspaceId: 1, _id: 1 },
    options: {
      background: true,
      name: "whatsapp_qr_entry_point_migration_scan_v1",
    },
  },
] as const;

const SCENARIO_SCAN_INDEX = {
  key: { workspaceId: 1, _id: 1 },
  options: {
    background: true,
    name: "whatsapp_qr_scenario_migration_scan_v1",
  },
} as const;

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/models/whatsapp-qr-entry-point", () => ({
  WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME:
    "whatsapp_qr_entry_point_assignment_unique_v2",
  WHATSAPP_QR_ENTRY_POINT_INDEXES: [
    {
      key: { entryPointId: 1 },
      options: {
        background: true,
        unique: true,
        name: "whatsapp_qr_entry_point_id_unique",
      },
    },
    {
      key: { workspaceId: 1, scenarioId: 1, nodeId: 1 },
      options: {
        background: true,
        unique: true,
        name: "whatsapp_qr_entry_point_assignment_unique_v2",
        partialFilterExpression: {
          scenarioId: { $type: "string" },
          nodeId: { $type: "string" },
        },
      },
    },
    {
      key: { workspaceId: 1, sourceId: 1, status: 1, updatedAt: -1 },
      options: {
        background: true,
        name: "whatsapp_qr_entry_point_workspace_source_status_updated",
      },
    },
    {
      key: { workspaceId: 1, _id: 1 },
      options: {
        background: true,
        name: "whatsapp_qr_entry_point_migration_scan_v1",
      },
    },
  ],
  WhatsAppQrEntryPoint: {
    collection: {
      indexes: (...args: unknown[]) => entryPointIndexes(...args),
      createIndex: (...args: unknown[]) => entryPointCreateIndex(...args),
      dropIndex: (...args: unknown[]) => entryPointDropIndex(...args),
    },
  },
}));

jest.mock("@/models/scenario", () => ({
  WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX: {
    key: { workspaceId: 1, _id: 1 },
    options: {
      background: true,
      name: "whatsapp_qr_scenario_migration_scan_v1",
    },
  },
  Scenario: {
    collection: {
      indexes: (...args: unknown[]) => scenarioIndexes(...args),
      createIndex: (...args: unknown[]) => scenarioCreateIndex(...args),
    },
  },
}));

import {
  assertWhatsAppQrUnassignedWritesEnabled,
  ensureWhatsAppQrEntryPointIndexes,
  WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME,
  WHATSAPP_QR_MANAGER_INDEX_SPECS,
} from "./indexes";
import { runWhatsAppQrEntryPointIndexMigration } from "./index-migration";

function installedIndex(
  key: Record<string, number>,
  options: Record<string, unknown> & { name: string }
): Record<string, unknown> & { name: string } {
  return { key, ...options };
}

function desiredEntryPointIndexes() {
  return [
    ...ENTRY_POINT_MODEL_INDEXES.map(spec =>
      installedIndex(spec.key, spec.options)
    ),
    ...WHATSAPP_QR_MANAGER_INDEX_SPECS.map(([name, key]) =>
      installedIndex(key, { name, collation: { locale: "simple" } })
    ),
  ];
}

function desiredEntryPointIndexesWithCanonicalSimpleCollation() {
  return [
    ...ENTRY_POINT_MODEL_INDEXES.map(spec =>
      installedIndex(spec.key, spec.options)
    ),
    ...WHATSAPP_QR_MANAGER_INDEX_SPECS.map(([name, key]) =>
      installedIndex(key, { name })
    ),
  ];
}

describe("WhatsApp QR entry-point indexes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entryPointCreateIndex.mockResolvedValue("ok");
    scenarioCreateIndex.mockResolvedValue("ok");
    entryPointDropIndex.mockResolvedValue(undefined);
    entryPointIndexes.mockResolvedValue([
      ...desiredEntryPointIndexes(),
      {
        name: LEGACY_INDEX_NAME,
        key: { workspaceId: 1, scenarioId: 1, nodeId: 1 },
        unique: true,
      },
    ]);
    scenarioIndexes.mockResolvedValue([
      installedIndex(SCENARIO_SCAN_INDEX.key, SCENARIO_SCAN_INDEX.options),
    ]);
  });

  it("declares the exact eight simple-collation Manager query indexes", () => {
    expect(WHATSAPP_QR_MANAGER_INDEX_SPECS).toEqual([
      [
        "whatsapp_qr_manager_list_base_v1",
        { workspaceId: 1, updatedAt: -1, entryPointId: 1 },
      ],
      [
        "whatsapp_qr_manager_list_source_v1",
        { workspaceId: 1, sourceId: 1, updatedAt: -1, entryPointId: 1 },
      ],
      [
        "whatsapp_qr_manager_list_status_v1",
        { workspaceId: 1, status: 1, updatedAt: -1, entryPointId: 1 },
      ],
      [
        "whatsapp_qr_manager_list_assignment_v1",
        {
          workspaceId: 1,
          assignmentState: 1,
          updatedAt: -1,
          entryPointId: 1,
        },
      ],
      [
        "whatsapp_qr_manager_search_base_v1",
        { workspaceId: 1, placementNameSearch: 1, entryPointId: 1 },
      ],
      [
        "whatsapp_qr_manager_search_source_v1",
        {
          workspaceId: 1,
          sourceId: 1,
          placementNameSearch: 1,
          entryPointId: 1,
        },
      ],
      [
        "whatsapp_qr_manager_search_status_v1",
        {
          workspaceId: 1,
          status: 1,
          placementNameSearch: 1,
          entryPointId: 1,
        },
      ],
      [
        "whatsapp_qr_manager_search_assignment_v1",
        {
          workspaceId: 1,
          assignmentState: 1,
          placementNameSearch: 1,
          entryPointId: 1,
        },
      ],
    ]);
    expect(WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME).toBe(
      "whatsapp_qr_entry_point_assignment_unique_v2"
    );
  });

  it("creates and verifies desired indexes without dropping the legacy index", async () => {
    await expect(ensureWhatsAppQrEntryPointIndexes()).resolves.toBeUndefined();

    expect(entryPointCreateIndex).toHaveBeenCalledTimes(12);
    for (const [name, key] of WHATSAPP_QR_MANAGER_INDEX_SPECS) {
      expect(entryPointCreateIndex).toHaveBeenCalledWith(key, {
        background: true,
        name,
        collation: { locale: "simple" },
      });
    }
    expect(scenarioCreateIndex).toHaveBeenCalledWith(
      SCENARIO_SCAN_INDEX.key,
      SCENARIO_SCAN_INDEX.options
    );
    expect(entryPointDropIndex).not.toHaveBeenCalled();
  });

  it("treats Mongo's omitted persisted collation as requested simple collation", async () => {
    entryPointIndexes.mockResolvedValue(
      desiredEntryPointIndexesWithCanonicalSimpleCollation()
    );

    await expect(ensureWhatsAppQrEntryPointIndexes()).resolves.toBeUndefined();
    await expect(
      assertWhatsAppQrUnassignedWritesEnabled()
    ).resolves.toBeUndefined();
    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).resolves.toMatchObject({ ready: true, create: [], verify: [] });
  });

  it("blocks only unassigned QR writes until desired indexes exist and legacy is absent", async () => {
    await expect(ensureWhatsAppQrEntryPointIndexes()).resolves.toBeUndefined();
    await expect(assertWhatsAppQrUnassignedWritesEnabled()).rejects.toThrow(
      "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
    );

    entryPointIndexes.mockResolvedValue(desiredEntryPointIndexes());
    await expect(
      assertWhatsAppQrUnassignedWritesEnabled()
    ).resolves.toBeUndefined();

    entryPointIndexes.mockResolvedValue([]);
    await expect(assertWhatsAppQrUnassignedWritesEnabled()).rejects.toThrow(
      "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
    );
  });

  it("rejects a desired index whose persisted definition does not match", async () => {
    entryPointIndexes.mockResolvedValue(
      desiredEntryPointIndexes().map(index =>
        index.name === WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME
          ? { ...index, unique: false }
          : index
      )
    );

    await expect(ensureWhatsAppQrEntryPointIndexes()).rejects.toThrow(
      WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME
    );
  });

  it("rejects a non-simple persisted collation for a Manager index", async () => {
    const indexName = WHATSAPP_QR_MANAGER_INDEX_SPECS[0][0];
    entryPointIndexes.mockResolvedValue(
      desiredEntryPointIndexes().map(index =>
        index.name === indexName
          ? { ...index, collation: { locale: "en" } }
          : index
      )
    );

    await expect(ensureWhatsAppQrEntryPointIndexes()).rejects.toThrow(
      indexName
    );
    await expect(assertWhatsAppQrUnassignedWritesEnabled()).rejects.toThrow(
      "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
    );
    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).rejects.toThrow("desired indexes were not verified");
    expect(entryPointDropIndex).not.toHaveBeenCalled();
  });

  it.each([
    ["unique", { unique: true }],
    [
      "partial filter",
      { partialFilterExpression: { status: { $type: "string" } } },
    ],
    ["collation", { collation: { locale: "simple" } }],
  ])(
    "rejects an unexpected %s option in startup, write-gate, and migration verification",
    async (_label, unexpectedOption) => {
      const indexName =
        "whatsapp_qr_entry_point_workspace_source_status_updated";
      entryPointIndexes.mockResolvedValue(
        desiredEntryPointIndexes().map(index =>
          index.name === indexName ? { ...index, ...unexpectedOption } : index
        )
      );

      await expect(ensureWhatsAppQrEntryPointIndexes()).rejects.toThrow(
        indexName
      );
      await expect(assertWhatsAppQrUnassignedWritesEnabled()).rejects.toThrow(
        "WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED"
      );
      await expect(
        runWhatsAppQrEntryPointIndexMigration({ apply: true })
      ).rejects.toThrow("desired indexes were not verified");
      expect(entryPointDropIndex).not.toHaveBeenCalled();
    }
  );
});
