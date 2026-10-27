/**
 * @jest-environment node
 */

import { Types } from "mongoose";

import {
  WhatsAppQrCode,
  WHATSAPP_QR_CODE_INDEXES,
  WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT,
} from "./whatsapp-qr-code";

function code(overrides: Record<string, unknown> = {}) {
  return new WhatsAppQrCode({
    codeId: "code-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    referenceCode: "01234ABCDE",
    providerCode: "provider-code-1",
    deepLink: "https://wa.me/message/provider-code-1",
    prefilledMessage: "Welcome\n[Ref: 01234-ABCDE]",
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 0,
    ...overrides,
  });
}

function hydratedCode() {
  return WhatsAppQrCode.hydrate({
    _id: new Types.ObjectId(),
    codeId: "code-1",
    workspaceId: "workspace-1",
    entryPointId: "entry-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    referenceCode: "01234ABCDE",
    providerCode: "provider-code-1",
    deepLink: "https://wa.me/message/provider-code-1",
    placementBindingState: "CURRENT",
    routingState: "ENABLED",
    providerState: "ACTIVE",
    version: 0,
  });
}

describe("WhatsAppQrCode", () => {
  it("keeps the manageable replacement history bounded", () => {
    expect(WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT).toBe(20);
  });

  afterEach(() => jest.restoreAllMocks());
  it("keeps provider and routing state bounded on the per-code record", () => {
    expect(WhatsAppQrCode.collection.collectionName).toBe("whatsapp_qr_codes");
    expect(WhatsAppQrCode.schema.get("strict")).toBe("throw");
    expect(
      WhatsAppQrCode.schema.path("placementBindingState")?.options.enum
    ).toEqual(["CURRENT", "HISTORICAL", "DETACHED"]);
    expect(WhatsAppQrCode.schema.path("routingState")?.options.enum).toEqual([
      "ENABLED",
      "DISABLED",
    ]);
    expect(WhatsAppQrCode.schema.path("providerState")?.options.enum).toEqual([
      "PENDING",
      "ACTIVE",
      "RECONCILING",
      "DELETED",
    ]);
    expect(code().validateSync()).toBeUndefined();
    expect(
      code({ referenceCode: "123" }).validateSync()?.errors.referenceCode
    ).toBeDefined();
    expect(
      code({ prefilledMessage: "x".repeat(141) }).validateSync()?.errors
        .prefilledMessage
    ).toBeDefined();
    expect(code({ version: 1.5 }).validateSync()?.errors.version).toBeDefined();
    expect(
      code({
        providerState: "PENDING",
        providerCode: undefined,
        deepLink: undefined,
      }).validateSync()
    ).toBeUndefined();
    expect(
      code({ providerState: "ACTIVE", providerCode: undefined }).validateSync()
    ).toBeDefined();
  });

  it("validates every provider lifecycle combination", () => {
    expect(
      code({
        providerState: "PENDING",
        providerCode: undefined,
        deepLink: undefined,
      }).validateSync()
    ).toBeUndefined();
    expect(
      code({
        providerState: "RECONCILING",
        providerCode: undefined,
        deepLink: undefined,
      }).validateSync()
    ).toBeUndefined();
    expect(
      code({ providerState: "RECONCILING" }).validateSync()
    ).toBeUndefined();
    expect(
      code({
        providerState: "RECONCILING",
        providerCode: "provider",
        deepLink: undefined,
      }).validateSync()
    ).toBeDefined();
    expect(code({ providerState: "ACTIVE" }).validateSync()).toBeUndefined();
    expect(
      code({ providerState: "ACTIVE", deepLink: undefined }).validateSync()
    ).toBeDefined();
    expect(code({ providerState: "DELETED" }).validateSync()).toBeUndefined();
    expect(
      code({ providerState: "DELETED", providerCode: undefined }).validateSync()
    ).toBeDefined();
  });

  it("rejects a persisted version-only save so the CAS fence cannot be forged", async () => {
    const document = hydratedCode();
    document.version = 7;

    await expect(document.save()).rejects.toThrow(/atomic version CAS/);
  });

  it("rejects every persisted durable-field save so atomic CAS is canonical", async () => {
    for (const [path, value] of [
      ["referenceCode", "FGHJKMNPQR"],
      ["providerCode", "provider-code-2"],
      ["deepLink", "https://wa.me/message/provider-code-2"],
      ["prefilledMessage", "Updated message"],
      ["placementBindingState", "HISTORICAL"],
      ["routingState", "DISABLED"],
      ["providerState", "RECONCILING"],
    ] as const) {
      const document = hydratedCode();
      document.set(path, value);
      await expect(document.save()).rejects.toThrow(/atomic version CAS/);
    }
  });

  it("rejects destructive and bypass write APIs before collection", async () => {
    const filter = { codeId: "code-1", workspaceId: "workspace-1", version: 0 };
    await expect(hydratedCode().deleteOne()).rejects.toThrow(/tombstones/);
    await expect(WhatsAppQrCode.deleteOne(filter).exec()).rejects.toThrow(
      /tombstones/
    );
    await expect(WhatsAppQrCode.deleteMany(filter).exec()).rejects.toThrow(
      /tombstones/
    );
    await expect(
      WhatsAppQrCode.findOneAndDelete(filter).exec()
    ).rejects.toThrow(/tombstones/);
    await expect(
      WhatsAppQrCode.updateMany(
        filter,
        { $set: { routingState: "DISABLED" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.replaceOne(filter, code().toObject(), {
        runValidators: true,
      }).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.findOneAndReplace(filter, code().toObject(), {
        runValidators: true,
      }).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.updateOne(
        filter,
        [{ $set: { routingState: "DISABLED" } }] as never,
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.updateOne(
        filter,
        { $unset: { providerCode: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.updateOne(
        filter,
        { $rename: { deepLink: "other" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
  });

  it("allows a CAS routing toggle", async () => {
    const write = jest
      .spyOn(WhatsAppQrCode.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1", workspaceId: "workspace-1", version: 0 },
        { $set: { routingState: "DISABLED" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("enforces lifecycle state filters independently of document validators", async () => {
    const write = jest
      .spyOn(WhatsAppQrCode.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const absent = {
      codeId: "code-1",
      workspaceId: "workspace-1",
      version: 0,
      providerCode: { $exists: false },
      deepLink: { $exists: false },
    };
    const activeExisting = {
      codeId: "code-1",
      workspaceId: "workspace-1",
      version: 0,
      providerCode: "provider-code-1",
      deepLink: "https://wa.me/message/provider-code-1",
      providerState: "ACTIVE",
    };
    const reconcilingExisting = {
      ...activeExisting,
      providerState: "RECONCILING",
    };
    const deletedExisting = {
      ...activeExisting,
      providerState: "DELETED",
    };
    const typeExisting = {
      codeId: "code-1",
      workspaceId: "workspace-1",
      version: 0,
      providerCode: { $type: "string" },
      deepLink: { $type: "string" },
    };
    await expect(
      WhatsAppQrCode.updateOne(
        absent,
        { $set: { providerState: "RECONCILING" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        absent,
        {
          $set: {
            providerState: "RECONCILING",
            providerCode: "provider",
            deepLink: "https://wa.me/message/provider",
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        absent,
        {
          $set: { providerState: "RECONCILING", providerCode: "provider" },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/observed/);
    await expect(
      WhatsAppQrCode.updateOne(
        absent,
        { $set: { providerState: "PENDING" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1", workspaceId: "workspace-1", version: 0 },
        { $set: { providerState: "PENDING" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/absent/);
    await expect(
      WhatsAppQrCode.updateOne(
        activeExisting,
        { $set: { providerState: "RECONCILING" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        reconcilingExisting,
        { $set: { providerState: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        typeExisting,
        { $set: { providerState: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/existing/);
    await expect(
      WhatsAppQrCode.updateOne(
        activeExisting,
        { $set: { providerState: "DELETED" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    await expect(
      WhatsAppQrCode.updateOne(
        reconcilingExisting,
        { $set: { providerState: "DELETED" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    for (const nextState of ["ACTIVE", "RECONCILING", "DELETED"] as const)
      await expect(
        WhatsAppQrCode.updateOne(
          deletedExisting,
          { $set: { providerState: nextState }, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow(/provider state/);
    await expect(
      WhatsAppQrCode.updateOne(
        {
          codeId: "code-1",
          workspaceId: "workspace-1",
          version: 0,
          providerCode: "provider-code-1",
          deepLink: "https://wa.me/message/provider-code-1",
        },
        { $set: { providerState: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/provider state/);
    await expect(
      WhatsAppQrCode.updateOne(
        { ...reconcilingExisting, providerState: { $eq: "RECONCILING" } },
        { $set: { providerState: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/provider state/);
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1", workspaceId: "workspace-1", version: 0 },
        { $set: { providerState: "ACTIVE" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/existing/);
    expect(write).toHaveBeenCalledTimes(7);
  });

  it("requires provider confirmation CAS and keeps tombstones undeletable", async () => {
    const write = jest
      .spyOn(WhatsAppQrCode.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const filter = {
      codeId: "code-1",
      workspaceId: "workspace-1",
      version: 0,
      providerCode: { $exists: false },
      deepLink: { $exists: false },
    };
    await expect(
      WhatsAppQrCode.updateOne(
        filter,
        {
          $set: {
            providerCode: "provider",
            deepLink: "https://wa.me/message/provider",
            providerState: "ACTIVE",
          },
          $inc: { version: 1 },
        },
        { runValidators: true }
      ).exec()
    ).resolves.toMatchObject({ acknowledged: true });
    for (const identity of [
      {
        providerCode: "   ",
        deepLink: "https://wa.me/message/provider",
      },
      { providerCode: "provider", deepLink: "  " },
    ])
      await expect(
        WhatsAppQrCode.updateOne(
          filter,
          {
            $set: { ...identity, providerState: "ACTIVE" },
            $inc: { version: 1 },
          },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow(/Provider identity/);
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1" },
        {
          $set: {
            providerCode: "provider",
            deepLink: "link",
            providerState: "ACTIVE",
          },
        },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    await expect(WhatsAppQrCode.deleteMany({}).exec()).rejects.toThrow(
      /tombstones/
    );
    await expect(WhatsAppQrCode.findOneAndDelete({}).exec()).rejects.toThrow(
      /tombstones/
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("requires exact CAS for each mutable code field", async () => {
    const write = jest
      .spyOn(WhatsAppQrCode.collection, "updateOne")
      .mockResolvedValue({ acknowledged: true } as never);
    const cas = { codeId: "code-1", workspaceId: "workspace-1", version: 0 };
    for (const update of [
      { prefilledMessage: "Updated message" },
      { routingState: "DISABLED" },
      { placementBindingState: "HISTORICAL" },
    ])
      await expect(
        WhatsAppQrCode.updateOne(
          cas,
          { $set: update, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).resolves.toMatchObject({ acknowledged: true });
    for (const update of [
      { prefilledMessage: "Updated message" },
      { routingState: "DISABLED" },
      { placementBindingState: "HISTORICAL" },
    ])
      await expect(
        WhatsAppQrCode.updateOne(
          { codeId: "code-1", workspaceId: "workspace-1" },
          { $set: update, $inc: { version: 1 } },
          { runValidators: true }
        ).exec()
      ).rejects.toThrow(/CAS/);
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: { $eq: "code-1" }, workspaceId: "workspace-1", version: 0 },
        { $set: { routingState: "DISABLED" }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS/);
    await expect(
      WhatsAppQrCode.updateOne(
        cas,
        { $set: { prefilledMessage: "x".repeat(141) }, $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow();
    await expect(
      WhatsAppQrCode.updateOne(
        cas,
        { $inc: { version: 1 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/durable field/);
    await expect(
      WhatsAppQrCode.updateOne(
        cas,
        { $set: { routingState: "DISABLED" }, $inc: { version: 2 } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/CAS|version/);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("rejects permanent reference changes and permits provider identity only from absent to set", async () => {
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1" },
        { $set: { referenceCode: "FGHJKMNPQR" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/Permanent/);
    await expect(
      WhatsAppQrCode.updateOne(
        { codeId: "code-1" },
        { $set: { providerCode: "provider-2" } },
        { runValidators: true }
      ).exec()
    ).rejects.toThrow(/Provider identity/);
  });

  it("declares bounded history and isolated runtime/unique lookup indexes", () => {
    expect(WHATSAPP_QR_CODE_INDEXES).toEqual([
      {
        key: { codeId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_code_id_unique",
        },
      },
      {
        key: { workspaceId: 1, referenceCode: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_code_workspace_reference_unique",
        },
      },
      {
        key: { wabaId: 1, phoneNumberId: 1, providerCode: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_code_provider_identity_unique",
          partialFilterExpression: { providerCode: { $type: "string" } },
        },
      },
      {
        key: { workspaceId: 1, entryPointId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_qr_code_current_placement_binding_unique",
          partialFilterExpression: { placementBindingState: "CURRENT" },
        },
      },
      {
        key: { workspaceId: 1, sourceId: 1, referenceCode: 1 },
        options: {
          background: true,
          name: "whatsapp_qr_code_runtime_reference_lookup",
        },
      },
      {
        key: {
          workspaceId: 1,
          entryPointId: 1,
          placementBindingState: 1,
          createdAt: -1,
        },
        options: {
          background: true,
          name: "whatsapp_qr_code_placement_history",
        },
      },
    ]);
    expect(WhatsAppQrCode.schema.indexes()).toEqual(
      WHATSAPP_QR_CODE_INDEXES.map(index => [index.key, index.options])
    );
  });
});
