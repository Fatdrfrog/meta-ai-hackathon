/**
 * @jest-environment node
 */

import { Types } from "mongoose";

import {
  WhatsAppQrEntryPoint,
  WHATSAPP_QR_ENTRY_POINT_INDEXES,
} from "./whatsapp-qr-entry-point";

function entryPoint(overrides: Record<string, unknown> = {}) {
  return new WhatsAppQrEntryPoint({
    entryPointId: "entry-1",
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    assignmentState: "assigned",
    placementName: "Store front",
    placementNameSearch: "store front",
    desiredMessage: "Welcome",
    status: "DRAFT",
    version: 0,
    ...overrides,
  });
}

describe("WhatsAppQrEntryPoint", () => {
  afterEach(() => jest.restoreAllMocks());
  it("uses a bounded strict placement contract with CAS version state", () => {
    expect(WhatsAppQrEntryPoint.collection.collectionName).toBe(
      "whatsapp_qr_entry_points"
    );
    expect(WhatsAppQrEntryPoint.schema.get("strict")).toBe("throw");
    expect(WhatsAppQrEntryPoint.schema.get("versionKey")).toBe(false);
    expect(WhatsAppQrEntryPoint.schema.path("status")?.options.enum).toEqual([
      "DRAFT",
      "ACTIVE",
      "DETACHED",
    ]);
    expect(entryPoint().validateSync()).toBeUndefined();
    expect(
      entryPoint({
        scenarioId: undefined,
        nodeId: undefined,
        assignmentState: "unassigned",
        placementNameSearch: "store front",
      }).validateSync()
    ).toBeUndefined();
    expect(
      entryPoint({
        scenarioId: undefined,
        nodeId: undefined,
        assignmentState: "unassigned",
        placementNameSearch: "store front",
        status: "ACTIVE",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        currentCodeId: "code-1",
      }).validateSync()
    ).toBeUndefined();
    expect(
      entryPoint({
        scenarioId: undefined,
        nodeId: undefined,
        assignmentState: undefined,
        placementNameSearch: "store front",
      }).validateSync()
    ).toBeDefined();
    expect(
      entryPoint({ scenarioId: "scenario-1", nodeId: undefined }).validateSync()
    ).toBeDefined();
    expect(
      entryPoint({ assignmentState: "unassigned" }).validateSync()
    ).toBeDefined();
    expect(
      entryPoint({ placementNameSearch: undefined }).validateSync()
    ).toBeDefined();
    expect(entryPoint({ status: "ACTIVE" }).validateSync()).toBeDefined();
    expect(
      entryPoint({
        status: "ACTIVE",
        sourceId: "source-1",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        currentCodeId: "code-1",
      }).validateSync()
    ).toBeUndefined();
    expect(entryPoint({ sourceId: "source-1" }).validateSync()).toBeDefined();
    expect(
      entryPoint({ placementName: "x".repeat(121) }).validateSync()?.errors
        .placementName
    ).toBeDefined();
    expect(
      entryPoint({ desiredMessage: "x".repeat(121) }).validateSync()?.errors
        .desiredMessage
    ).toBeDefined();
    expect(
      entryPoint({ version: -1 }).validateSync()?.errors.version
    ).toBeDefined();
    expect(
      entryPoint({ nodeId: "x".repeat(257) }).validateSync()?.errors.nodeId
    ).toBeDefined();
    expect(() => entryPoint({ unknown: "nope" })).toThrow(/strict mode/i);
  });

  it("requires CAS versioning for draft edits and paired scenario moves", async () => {
    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const filter = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
    };
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $set: {
            placementName: "New",
            placementNameSearch: "new",
            desiredMessage: "Hi",
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $set: {
            scenarioId: "scenario-2",
            nodeId: "node-2",
            assignmentState: "assigned",
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $unset: { scenarioId: 1, nodeId: 1 },
          $set: { assignmentState: "unassigned" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        { $set: { scenarioId: "scenario-2" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $unset: { scenarioId: 1 },
          $set: { assignmentState: "unassigned" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/paired/i);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $unset: { scenarioId: 1, nodeId: 1 },
          $set: { assignmentState: "assigned" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/assignment/i);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $set: { scenarioId: "scenario-2", nodeId: "node-2" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/assignment/i);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        {
          $set: { placementName: "New" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/search/i);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        { entryPointId: "entry-1" },
        {
          $set: { placementName: "New", placementNameSearch: "new" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("rejects generic CAS bypasses before the collection write", async () => {
    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const filter = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
    };
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        { $unset: { desiredMessage: 1 }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        { entryPointId: "entry-1" },
        { $unset: { desiredMessage: 1 }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        { $set: { placementName: "New", placementNameSearch: "new" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    await expect(
      WhatsAppQrEntryPoint.updateMany(
        filter,
        { $set: { placementName: "New" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrEntryPoint.replaceOne(filter, entryPoint().toObject(), {
        runValidators: true,
      }).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        [{ $set: { placementName: "New" } }] as never,
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        filter,
        { $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/durable field change/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects upserts before incomplete assignment projections reach the collection", async () => {
    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);

    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          entryPointId: "entry-upsert",
          workspaceId: "workspace-1",
          version: 0,
        },
        {
          $setOnInsert: {
            entryPointId: "entry-upsert",
            workspaceId: "workspace-1",
          },
          $inc: { version: 1 },
        },
        {
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: false,
        }
      ).exec()
    ).rejects.toThrow(/upsert/i);

    expect(write).not.toHaveBeenCalled();
  });

  it("requires lifecycle binding proof for activation and replacement", async () => {
    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const absent = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
      sourceId: { $exists: false },
      wabaId: { $exists: false },
      phoneNumberId: { $exists: false },
      currentCodeId: { $exists: false },
    };
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        absent,
        {
          $set: {
            status: "ACTIVE",
            sourceId: "source",
            wabaId: "waba",
            phoneNumberId: "phone",
            currentCodeId: "code",
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        { entryPointId: "entry-1", workspaceId: "workspace-1", version: 0 },
        { $set: { currentCodeId: "code-2" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/replacement/);
    const exactBinding = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
      status: "ACTIVE",
      sourceId: "source",
      wabaId: "waba",
      phoneNumberId: "phone",
      currentCodeId: "code",
    };
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        exactBinding,
        { $set: { currentCodeId: "code-2" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    for (const currentCodeId of ["", "   ", null, 1] as const)
      await expect(
        WhatsAppQrEntryPoint.updateOne(
          exactBinding,
          { $set: { currentCodeId }, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow(/replacement/);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        { ...exactBinding, status: "DETACHED" },
        { $set: { status: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          entryPointId: "entry-1",
          workspaceId: "workspace-1",
          version: 0,
          status: "DETACHED",
          sourceId: { $exists: false },
          wabaId: { $exists: false },
          phoneNumberId: { $exists: false },
          currentCodeId: { $exists: false },
        },
        { $set: { status: "DRAFT" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          entryPointId: "entry-1",
          workspaceId: "workspace-1",
          version: 0,
          status: "ACTIVE",
          sourceId: { $type: "string" },
          wabaId: { $type: "string" },
          phoneNumberId: { $type: "string" },
          currentCodeId: { $type: "string" },
        },
        { $set: { status: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/activation/);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          entryPointId: "entry-1",
          workspaceId: "workspace-1",
          version: 0,
          status: "ACTIVE",
          sourceId: { $type: "string" },
          wabaId: { $type: "string" },
          phoneNumberId: { $type: "string" },
          currentCodeId: { $type: "string" },
        },
        { $set: { currentCodeId: "code-2" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/replacement/);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          entryPointId: "entry-1",
          workspaceId: "workspace-1",
          version: 0,
          status: "ACTIVE",
          sourceId: "source",
          wabaId: "waba",
          phoneNumberId: "phone",
        },
        { $set: { currentCodeId: "code-2" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/replacement/);
    expect(entryPoint({ status: "DETACHED" }).validateSync()).toBeUndefined();
    expect(
      entryPoint({ status: "DETACHED", sourceId: "source" }).validateSync()
    ).toBeDefined();
    expect(
      entryPoint({
        status: "DETACHED",
        sourceId: "source",
        wabaId: "waba",
        phoneNumberId: "phone",
      }).validateSync()
    ).toBeDefined();
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("rejects incomplete activation and irreversible binding mutations", async () => {
    const absent = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
      sourceId: { $exists: false },
      wabaId: { $exists: false },
      phoneNumberId: { $exists: false },
      currentCodeId: { $exists: false },
    };
    for (const missing of [
      "sourceId",
      "wabaId",
      "phoneNumberId",
      "currentCodeId",
    ] as const) {
      const set: Record<string, string> = {
        status: "ACTIVE",
        sourceId: "source",
        wabaId: "waba",
        phoneNumberId: "phone",
        currentCodeId: "code",
      };
      delete set[missing];
      await expect(
        WhatsAppQrEntryPoint.updateOne(
          absent,
          { $set: set, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow();
    }
    const base = {
      entryPointId: "entry-1",
      workspaceId: "workspace-1",
      version: 0,
    };
    for (const update of [
      { $set: { status: "DRAFT" } },
      { $unset: { sourceId: 1 } },
      { $rename: { wabaId: "oldWaba" } },
      { $unset: { currentCodeId: 1 } },
    ])
      await expect(
        WhatsAppQrEntryPoint.updateOne(
          base,
          { ...update, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow();

    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    await expect(
      WhatsAppQrEntryPoint.updateOne(
        {
          ...base,
          status: "ACTIVE",
          sourceId: "source",
          wabaId: "waba",
          phoneNumberId: "phone",
          currentCodeId: "code",
        },
        {
          $set: { status: "DRAFT" },
          $unset: {
            sourceId: 1,
            wabaId: 1,
            phoneNumberId: 1,
            currentCodeId: 1,
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      entryPoint({
        status: "DETACHED",
        sourceId: "source",
        wabaId: "waba",
        phoneNumberId: "phone",
        currentCodeId: "code",
      }).validateSync()
    ).toBeUndefined();
  });

  it("blocks persisted-document and deletion bypasses", async () => {
    const base = {
      ...entryPoint().toObject(),
      _id: new Types.ObjectId(),
    };
    for (const [path, value] of [
      ["placementName", "Changed"],
      ["scenarioId", "scenario-2"],
      ["sourceId", "source"],
      ["currentCodeId", "code"],
      ["status", "DETACHED"],
      ["entryPointId", "entry-2"],
    ] as const) {
      const document = WhatsAppQrEntryPoint.hydrate(base);
      document.set(path, value);
      await expect(document.save()).rejects.toThrow();
    }
    const write = jest
      .spyOn(WhatsAppQrEntryPoint.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const versionOnly = WhatsAppQrEntryPoint.hydrate(base);
    versionOnly.version = 1;
    await expect(versionOnly.save()).rejects.toThrow(/atomic version CAS/);
    expect(write).not.toHaveBeenCalled();
    await expect(
      WhatsAppQrEntryPoint.hydrate(base).deleteOne()
    ).rejects.toThrow(/cannot be deleted/);
    await expect(WhatsAppQrEntryPoint.deleteOne({}).exec()).rejects.toThrow(
      /cannot be deleted/
    );
    await expect(WhatsAppQrEntryPoint.deleteMany({}).exec()).rejects.toThrow(
      /cannot be deleted/
    );
    await expect(
      WhatsAppQrEntryPoint.findOneAndDelete({}).exec()
    ).rejects.toThrow(/cannot be deleted/);
  });

  it("hydrates legacy records with missing assignment projections", () => {
    const legacy = entryPoint().toObject();
    delete (legacy as { assignmentState?: unknown }).assignmentState;
    delete (legacy as { placementNameSearch?: unknown }).placementNameSearch;

    expect(WhatsAppQrEntryPoint.hydrate(legacy).validateSync()).toBeUndefined();
  });

  it("declares a partial unique assignment binding and immutable migration scan", () => {
    expect(WHATSAPP_QR_ENTRY_POINT_INDEXES).toEqual([
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
    ]);
    expect(WhatsAppQrEntryPoint.schema.indexes()).toEqual(
      WHATSAPP_QR_ENTRY_POINT_INDEXES.map(index => [index.key, index.options])
    );
  });
});
