import connectDB from "@/lib/mongoose";
import {
  WhatsAppQrEntryPoint,
  WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME,
  WHATSAPP_QR_ENTRY_POINT_INDEXES,
} from "@/models/whatsapp-qr-entry-point";
import {
  Scenario,
  WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX,
} from "@/models/scenario";

type IndexKey = Record<string, 1 | -1>;
type IndexOptions = {
  background?: boolean;
  unique?: boolean;
  name: string;
  partialFilterExpression?: Record<string, unknown>;
  collation?: { locale: "simple" };
};
type IndexSpec = { key: IndexKey; options: IndexOptions };
type PersistedIndex = {
  key?: Record<string, unknown>;
  name?: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  collation?: Record<string, unknown>;
};

export { WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME };
export const WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME =
  "whatsapp_qr_entry_point_active_placement_unique";

export const WHATSAPP_QR_MANAGER_INDEX_SPECS = [
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
] as const;

function entryPointIndexSpecs(): IndexSpec[] {
  return [
    ...(WHATSAPP_QR_ENTRY_POINT_INDEXES as readonly IndexSpec[]),
    ...WHATSAPP_QR_MANAGER_INDEX_SPECS.map(([name, key]) => ({
      key: key as IndexKey,
      options: {
        background: true,
        name,
        collation: { locale: "simple" as const },
      },
    })),
  ];
}

function allDesiredIndexSpecs(): Array<
  IndexSpec & { owner: "entryPoint" | "scenario" }
> {
  return [
    ...entryPointIndexSpecs().map(spec => ({
      ...spec,
      owner: "entryPoint" as const,
    })),
    {
      ...(WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX as IndexSpec),
      owner: "scenario" as const,
    },
  ];
}

function sameRecord(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchesCollation(
  actual: PersistedIndex["collation"],
  expected: IndexOptions["collation"]
): boolean {
  if (actual === undefined && sameRecord(expected, { locale: "simple" })) {
    return true;
  }
  return sameRecord(actual, expected);
}

function matchesIndex(actual: PersistedIndex | undefined, spec: IndexSpec) {
  if (!actual || actual.name !== spec.options.name) return false;
  if (!sameRecord(actual.key, spec.key)) return false;
  if ((actual.unique === true) !== (spec.options.unique === true)) return false;
  if (
    !sameRecord(
      actual.partialFilterExpression,
      spec.options.partialFilterExpression
    )
  ) {
    return false;
  }
  if (!matchesCollation(actual.collation, spec.options.collation)) {
    return false;
  }
  return true;
}

export type WhatsAppQrEntryPointIndexInspection = {
  desiredIndexesVerified: boolean;
  legacyIndexPresent: boolean;
  missingOrInvalidIndexNames: string[];
};

export async function inspectWhatsAppQrEntryPointIndexes(): Promise<WhatsAppQrEntryPointIndexInspection> {
  const [entryPointIndexes, scenarioIndexes] = await Promise.all([
    WhatsAppQrEntryPoint.collection.indexes() as Promise<PersistedIndex[]>,
    Scenario.collection.indexes() as Promise<PersistedIndex[]>,
  ]);
  const missingOrInvalidIndexNames = allDesiredIndexSpecs()
    .filter(spec => {
      const indexes =
        spec.owner === "entryPoint" ? entryPointIndexes : scenarioIndexes;
      return !matchesIndex(
        indexes.find(index => index.name === spec.options.name),
        spec
      );
    })
    .map(spec => spec.options.name);
  return {
    desiredIndexesVerified: missingOrInvalidIndexNames.length === 0,
    legacyIndexPresent: entryPointIndexes.some(
      index =>
        index.name === WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME
    ),
    missingOrInvalidIndexNames,
  };
}

export async function createMissingWhatsAppQrEntryPointIndexes(
  indexNames: readonly string[]
): Promise<void> {
  const requested = new Set(indexNames);
  for (const spec of allDesiredIndexSpecs()) {
    if (!requested.has(spec.options.name)) continue;
    const collection =
      spec.owner === "entryPoint"
        ? WhatsAppQrEntryPoint.collection
        : Scenario.collection;
    await collection.createIndex(spec.key, spec.options);
  }
}

export async function dropLegacyWhatsAppQrEntryPointAssignmentIndex(
  indexName: string
): Promise<void> {
  if (indexName !== WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME) {
    throw new Error("Refusing to drop an unknown WhatsApp QR index");
  }
  await WhatsAppQrEntryPoint.collection.dropIndex(
    WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME
  );
}

export async function ensureWhatsAppQrEntryPointIndexes(): Promise<void> {
  await connectDB();
  const desired = allDesiredIndexSpecs();
  await createMissingWhatsAppQrEntryPointIndexes(
    desired.map(spec => spec.options.name)
  );
  const inspection = await inspectWhatsAppQrEntryPointIndexes();
  if (!inspection.desiredIndexesVerified) {
    throw new Error(
      `WhatsApp QR desired index verification failed: ${inspection.missingOrInvalidIndexNames.join(", ")}`
    );
  }
}

export async function assertWhatsAppQrUnassignedWritesEnabled(): Promise<void> {
  await connectDB();
  const inspection = await inspectWhatsAppQrEntryPointIndexes();
  if (!inspection.desiredIndexesVerified || inspection.legacyIndexPresent) {
    throw new Error("WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED");
  }
}
