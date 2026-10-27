/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn(async () => undefined);
const mockInspect = jest.fn();
const mockCreateMissing = jest.fn(async (_indexNames: string[]) => undefined);
const mockDropLegacy = jest.fn(async (_indexName: string) => undefined);

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));

jest.mock("./indexes", () => ({
  WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME:
    "whatsapp_qr_entry_point_active_placement_unique",
  inspectWhatsAppQrEntryPointIndexes: () => mockInspect(),
  createMissingWhatsAppQrEntryPointIndexes: (indexNames: string[]) =>
    mockCreateMissing(indexNames),
  dropLegacyWhatsAppQrEntryPointAssignmentIndex: (indexName: string) =>
    mockDropLegacy(indexName),
}));

import { runWhatsAppQrEntryPointIndexMigration } from "./index-migration";

const pendingState = {
  desiredIndexesVerified: false,
  legacyIndexPresent: true,
  missingOrInvalidIndexNames: [
    "whatsapp_qr_entry_point_assignment_unique_v2",
    "whatsapp_qr_entry_point_migration_scan_v1",
    "whatsapp_qr_scenario_migration_scan_v1",
  ],
};

const createdState = {
  desiredIndexesVerified: true,
  legacyIndexPresent: true,
  missingOrInvalidIndexNames: [],
};

const readyState = {
  desiredIndexesVerified: true,
  legacyIndexPresent: false,
  missingOrInvalidIndexNames: [],
};

describe("WhatsApp QR entry-point authored index migration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateMissing.mockResolvedValue(undefined);
    mockDropLegacy.mockResolvedValue(undefined);
  });

  it("reports an exact dry-run create, verify, and legacy-drop plan without writes", async () => {
    mockInspect.mockResolvedValue(pendingState);

    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: false })
    ).resolves.toEqual({
      apply: false,
      ready: false,
      create: pendingState.missingOrInvalidIndexNames,
      verify: pendingState.missingOrInvalidIndexNames,
      drop: ["whatsapp_qr_entry_point_active_placement_unique"],
    });
    expect(mockCreateMissing).not.toHaveBeenCalled();
    expect(mockDropLegacy).not.toHaveBeenCalled();
  });

  it("creates and re-verifies all desired indexes before dropping the exact legacy name", async () => {
    mockInspect
      .mockResolvedValueOnce(pendingState)
      .mockResolvedValueOnce(createdState)
      .mockResolvedValueOnce(readyState);

    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).resolves.toMatchObject({ apply: true, ready: true });

    expect(mockCreateMissing).toHaveBeenCalledWith(
      pendingState.missingOrInvalidIndexNames
    );
    expect(mockInspect).toHaveBeenCalledTimes(3);
    expect(mockDropLegacy).toHaveBeenCalledWith(
      "whatsapp_qr_entry_point_active_placement_unique"
    );
    expect(mockInspect.mock.invocationCallOrder[1]).toBeLessThan(
      mockDropLegacy.mock.invocationCallOrder[0]
    );
  });

  it("is idempotent when every desired index is verified and legacy is absent", async () => {
    mockInspect.mockResolvedValue(readyState);

    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).resolves.toEqual({
      apply: true,
      ready: true,
      create: [],
      verify: [],
      drop: [],
    });
    expect(mockCreateMissing).not.toHaveBeenCalled();
    expect(mockDropLegacy).not.toHaveBeenCalled();
  });

  it("accepts IndexNotFound for the exact legacy drop and verifies readiness", async () => {
    mockInspect
      .mockResolvedValueOnce(createdState)
      .mockResolvedValueOnce(createdState)
      .mockResolvedValueOnce(readyState);
    mockDropLegacy.mockRejectedValueOnce({
      code: 27,
      codeName: "IndexNotFound",
    });

    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).resolves.toMatchObject({ ready: true });
  });

  it("fails closed when the final post-drop inspection is still not ready", async () => {
    mockInspect
      .mockResolvedValueOnce(createdState)
      .mockResolvedValueOnce(createdState)
      .mockResolvedValueOnce(createdState);

    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).rejects.toThrow("index migration did not reach readiness");

    expect(mockDropLegacy).toHaveBeenCalledWith(
      "whatsapp_qr_entry_point_active_placement_unique"
    );
    expect(mockInspect).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown create, verify, and legacy-drop failures", async () => {
    mockInspect.mockResolvedValueOnce(pendingState);
    mockCreateMissing.mockRejectedValueOnce(new Error("create denied"));
    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).rejects.toThrow("create denied");

    mockInspect.mockResolvedValueOnce(pendingState);
    mockCreateMissing.mockResolvedValueOnce(undefined);
    mockInspect.mockResolvedValueOnce(pendingState);
    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).rejects.toThrow("desired indexes were not verified");

    mockInspect.mockResolvedValueOnce(createdState);
    mockInspect.mockResolvedValueOnce(createdState);
    mockDropLegacy.mockRejectedValueOnce(new Error("drop denied"));
    await expect(
      runWhatsAppQrEntryPointIndexMigration({ apply: true })
    ).rejects.toThrow("drop denied");
  });
});
