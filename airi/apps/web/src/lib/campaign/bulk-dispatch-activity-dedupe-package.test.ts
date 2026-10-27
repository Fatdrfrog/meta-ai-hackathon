import {
  createBulkDispatchActivityDedupeStore,
  type BulkDispatchActivityDedupeModel,
} from "@icecore/airi-runtime/bulk-dispatch-activity-dedupe";
import BulkDispatchActivityDedupe from "@/models/bulk-dispatch-activity-dedupe";

function createLeanQuery(result: unknown) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(result),
    }),
  };
}

function createModel(): jest.Mocked<BulkDispatchActivityDedupeModel> {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
  };
}

describe("bulk dispatch activity dedupe package store", () => {
  it("reads successful activity attempts through an injected model", async () => {
    const model = createModel();
    model.findOne.mockReturnValue(
      createLeanQuery({
        messageId: "wamid-1",
        recipient: "15551234567",
        channel: "whatsapp",
      }) as ReturnType<BulkDispatchActivityDedupeModel["findOne"]>
    );
    const store = createBulkDispatchActivityDedupeStore(model);

    await expect(store.find("dedupe-key-1")).resolves.toEqual({
      messageId: "wamid-1",
      recipient: "15551234567",
      channel: "whatsapp",
    });
    expect(model.findOne).toHaveBeenCalledWith({ key: "dedupe-key-1" });
  });

  it("treats partial dedupe records as missing", async () => {
    const model = createModel();
    model.findOne.mockReturnValue(
      createLeanQuery({
        messageId: "wamid-1",
        recipient: "",
        channel: "whatsapp",
      }) as ReturnType<BulkDispatchActivityDedupeModel["findOne"]>
    );
    const store = createBulkDispatchActivityDedupeStore(model);

    await expect(store.find("dedupe-key-1")).resolves.toBeNull();
  });

  it("accepts identical receipts but rejects conflicting provider IDs", async () => {
    const model = createModel();
    const store = createBulkDispatchActivityDedupeStore(model);
    const receipt = {
      key: "dedupe-key-1",
      workspaceId: "workspace-1",
      channel: "email" as const,
      messageId: "message-1",
      recipient: "user@example.com",
    };
    model.updateOne.mockRejectedValue({ code: 11000 });
    model.findOne.mockReturnValue(createLeanQuery(receipt));
    await expect(store.record(receipt)).resolves.toBeUndefined();
    await expect(
      store.record({ ...receipt, messageId: "different" })
    ).rejects.toThrow(/conflict/i);

    const writeError = new Error("write failed");
    model.updateOne.mockRejectedValueOnce(writeError);
    await expect(
      store.record({
        key: "dedupe-key-2",
        workspaceId: "workspace-1",
        channel: "email",
        messageId: "message-2",
        recipient: "user@example.com",
      })
    ).rejects.toThrow(writeError);
  });

  it("atomically claims a nonexpiring intent and never reclaims an existing key", async () => {
    const model = createModel();
    const store = createBulkDispatchActivityDedupeStore(model);
    model.updateOne
      .mockResolvedValueOnce({ upsertedCount: 1 })
      .mockResolvedValueOnce({ upsertedCount: 0, matchedCount: 1 });
    const identity = {
      key: "intent-1",
      workspaceId: "workspace-1",
      channel: "whatsapp" as const,
      recipient: "77001234567",
    };
    const token = await store.claimIntent(identity);
    expect(token).toEqual(expect.any(String));
    expect(model.updateOne).toHaveBeenCalledWith(
      { key: identity.key },
      {
        $setOnInsert: expect.objectContaining({
          ...identity,
          state: "attempted",
          intentToken: token,
          createdAt: null,
          providerAttemptStartedAt: expect.any(Date),
        }),
      },
      expect.objectContaining({
        upsert: true,
        timestamps: false,
        writeConcern: { w: "majority" },
      })
    );
    await expect(store.claimIntent(identity)).resolves.toBeNull();
  });

  it("keeps pending intent separate from accepted receipt reads", async () => {
    const model = createModel();
    const store = createBulkDispatchActivityDedupeStore(model);
    const intent = {
      workspaceId: "workspace-1",
      channel: "whatsapp" as const,
      recipient: "77001234567",
      state: "attempted",
      intentToken: "lease-1",
    };
    model.findOne.mockReturnValue(createLeanQuery(intent));
    await expect(store.find("intent-1")).resolves.toBeNull();
    await expect(store.findIntent("intent-1")).resolves.toEqual({
      workspaceId: intent.workspaceId,
      channel: intent.channel,
      recipient: intent.recipient,
      intentToken: intent.intentToken,
    });
    model.findOne.mockReturnValue(
      createLeanQuery({ ...intent, intentToken: undefined })
    );
    await expect(store.findIntent("intent-1")).rejects.toThrow(/malformed/i);
  });

  it("clears only the same unresolved intent and upgrades acceptance with normal retention", async () => {
    const model = createModel();
    const store = createBulkDispatchActivityDedupeStore(model);
    model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await store.clearIntent({ key: "intent-1", intentToken: "lease-1" });
    expect(model.deleteOne).toHaveBeenCalledWith(
      {
        key: "intent-1",
        state: "attempted",
        intentToken: "lease-1",
        messageId: { $exists: false },
      },
      { writeConcern: { w: "majority" } }
    );
    model.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    await store.record({
      key: "intent-1",
      workspaceId: "workspace-1",
      channel: "whatsapp",
      recipient: "77001234567",
      messageId: "wamid-1",
    });
    expect(model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "intent-1",
        messageId: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "accepted",
          messageId: "wamid-1",
          createdAt: expect.any(Date),
        }),
        $unset: { intentToken: "" },
      }),
      expect.objectContaining({
        timestamps: false,
        writeConcern: { w: "majority" },
      })
    );
  });

  it("preserves nonexpiring intent and receipt timestamps through real Mongoose casting", async () => {
    const update = jest
      .spyOn(BulkDispatchActivityDedupe.collection, "updateOne")
      .mockResolvedValue({
        acknowledged: true,
        upsertedCount: 1,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedId: null,
      } as never);
    try {
      const store = createBulkDispatchActivityDedupeStore(
        BulkDispatchActivityDedupe as unknown as BulkDispatchActivityDedupeModel
      );
      const identity = {
        key: "cast-intent",
        workspaceId: "workspace-1",
        channel: "whatsapp" as const,
        recipient: "77001234567",
      };
      await store.claimIntent(identity);
      expect(update.mock.calls[0]?.[1]).toMatchObject({
        $setOnInsert: {
          createdAt: null,
          state: "attempted",
          providerAttemptStartedAt: expect.any(Date),
          intentToken: expect.any(String),
        },
      });
      expect(update.mock.calls[0]?.[1]).not.toHaveProperty("$set.createdAt");
      await store.record({ ...identity, messageId: "wamid-cast" });
      expect(update.mock.calls[1]?.[1]).toMatchObject({
        $set: {
          createdAt: expect.any(Date),
          state: "accepted",
          messageId: "wamid-cast",
        },
        $unset: { intentToken: "" },
      });
      expect(BulkDispatchActivityDedupe.schema.indexes()).toContainEqual([
        { createdAt: 1 },
        expect.objectContaining({ expireAfterSeconds: 60 * 60 * 24 * 30 }),
      ]);
    } finally {
      update.mockRestore();
    }
  });

  it("fails closed when rejection cannot clear its exact unresolved intent", async () => {
    const model = createModel();
    const store = createBulkDispatchActivityDedupeStore(model);
    model.deleteOne.mockResolvedValue({ deletedCount: 0 });
    await expect(
      store.clearIntent({ key: "intent-1", intentToken: "stale-token" })
    ).rejects.toThrow(/ownership/i);
  });
});
