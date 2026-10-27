import mongoose from "mongoose";
import { Conversation } from "@/models/conversation";
import {
  CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC,
  CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC,
  createWhatsAppConversationOwnership,
  type WhatsAppConversationOwnershipModel,
} from "@icecore/airi-runtime/whatsapp-conversation-ownership";
import * as lookup from "./conversation-lookup";

const mockUsageDelta = jest.fn();
jest.mock("@/lib/customers/service", () => ({
  syncCustomerForConversation: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockUsageDelta(...args),
}));

const uri =
  "mongodb://127.0.0.1:27277/airi_whatsapp_ownership_test?replicaSet=airiCostTests";
const describeMongo = process.env.WHATSAPP_CONVERSATION_TEST_MONGODB_URI
  ? describe
  : describe.skip;
const workspaceId = "whatsapp-conversation-ownership-test";

async function getConversation(
  chatId = "wa_77010000202",
  sourceId: string | null = "source-1",
  workspace = workspaceId,
  candidateIds: string[] = [chatId]
) {
  return lookup.getOrCreateWhatsAppConversation({
    workspaceId: workspace,
    sourceId,
    chatId,
    candidateIds,
    create: async (ownershipKey, identityKeys) =>
      new Conversation({
        workspaceId: workspace,
        sourceId,
        chat: chatId,
        user: chatId,
        channel: "whatsapp",
        messages: [],
        whatsappConversationIdentityKey: ownershipKey,
        whatsappConversationIdentityKeys: identityKeys,
      }).save(),
  });
}

describeMongo(
  "atomic WhatsApp conversation ownership on isolated local Mongo",
  () => {
    beforeAll(async () => {
      if (
        process.env.WHATSAPP_CONVERSATION_TEST_MONGODB_URI !== uri ||
        process.env.MONGODB_URI !== uri
      ) {
        throw new Error(
          "Only the explicitly selected local conversation test database is allowed"
        );
      }
      await mongoose.connect(uri, { autoIndex: false });
    });
    beforeEach(async () => {
      await Conversation.collection.deleteMany({
        workspaceId: { $in: [workspaceId, `${workspaceId}-other`] },
      });
      mockUsageDelta.mockClear();
    });
    afterAll(async () => {
      await Conversation.collection.deleteMany({
        workspaceId: { $in: [workspaceId, `${workspaceId}-other`] },
      });
      await mongoose.disconnect();
    });

    it("gives simultaneous first messages one persisted owner and one creation side effect", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => getConversation())
      );
      expect(
        new Set(results.map(result => String(result?.conversation._id))).size
      ).toBe(1);
      expect(results.filter(result => result?.created)).toHaveLength(1);
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(
        mockUsageDelta.mock.calls.filter(
          ([event]) => event.metric === "conversation_count"
        )
      ).toHaveLength(1);
    });

    it("normalizes national phone aliases and isolates source and workspace owners", async () => {
      const [international, national, otherSource, otherWorkspace] =
        await Promise.all([
          getConversation(),
          getConversation("wa_87010000202"),
          getConversation("wa_77010000202", "source-2"),
          getConversation("wa_77010000202", "source-1", `${workspaceId}-other`),
        ]);
      expect(String(international?.conversation._id)).toBe(
        String(national?.conversation._id)
      );
      expect(
        new Set(
          [international, otherSource, otherWorkspace].map(result =>
            String(result?.conversation._id)
          )
        ).size
      ).toBe(3);
    });

    it("pins one legacy duplicate without deleting or merging either existing conversation", async () => {
      const ids = [
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ];
      await Conversation.collection.insertMany(
        ids.map((_id, index) => ({
          _id,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          user: "wa_77010000202",
          messages: [],
          updatedAt: new Date(1000 + index),
        }))
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, () => getConversation())
      );
      expect(results.every(result => !result?.created)).toBe(true);
      expect(
        new Set(results.map(result => String(result?.conversation._id))).size
      ).toBe(1);
      expect(await Conversation.countDocuments({ workspaceId })).toBe(2);
      const pinnedId = results[0]?.conversation._id;
      await Conversation.collection.updateOne(
        { _id: ids.find(id => String(id) !== String(pinnedId)) },
        { $set: { updatedAt: new Date() } }
      );
      expect(String((await getConversation())?.conversation._id)).toBe(
        String(pinnedId)
      );
      const readOwner =
        await lookup.findExistingWhatsAppConversationForRecipient({
          workspaceId,
          sourceId: "source-1",
          recipient: "77010000202",
        });
      expect(String(readOwner?._id)).toBe(String(pinnedId));
    });

    it("converges raw and canonical BSUIDs without losing their case", async () => {
      const results = await Promise.all([
        getConversation("US.Customer"),
        getConversation("wa_bsuid_US.Customer"),
      ]);
      expect(String(results[0]?.conversation._id)).toBe(
        String(results[1]?.conversation._id)
      );
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("reuses a pinned BSUID owner when a later caller also knows its phone", async () => {
      const bsuidOwner = await getConversation("wa_bsuid_US.Customer");
      const create = jest.fn();
      const laterCall = await lookup.getOrCreateWhatsAppConversation({
        workspaceId,
        sourceId: "source-1",
        chatId: "wa_77010000202",
        candidateIds: ["wa_77010000202", "wa_bsuid_US.Customer"],
        create,
      });
      expect(String(laterCall?.conversation._id)).toBe(
        String(bsuidOwner?.conversation._id)
      );
      expect(laterCall?.created).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("atomically converges concurrent phone and BSUID observations with a proven shared alias", async () => {
      const aliases = ["wa_77010000202", "wa_bsuid_US.Customer"];
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          getConversation(aliases[index % 2], "source-1", workspaceId, aliases)
        )
      );
      expect(
        new Set(results.map(result => String(result?.conversation._id))).size
      ).toBe(1);
      expect(results.filter(result => result?.created)).toHaveLength(1);
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
      for (const alias of aliases) {
        expect(String((await getConversation(alias))?.conversation._id)).toBe(
          String(results[0]?.conversation._id)
        );
      }
    });

    it("preserves the established legacy history and scenario owner over a newer empty duplicate", async () => {
      const established = new mongoose.Types.ObjectId();
      const empty = new mongoose.Types.ObjectId();
      const historyMessage = new mongoose.Types.ObjectId();
      const state = {
        lockedScenarioId: "active-scenario",
        activeNodeId: "waiting",
        pendingCondition: { type: "timeout" },
      };
      await Conversation.collection.insertMany([
        {
          _id: established,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          user: "wa_77010000202",
          messages: [historyMessage],
          airi_scenario_state: state,
          airi_handoff_active: true,
          airi_handoff_started_at: new Date(1500),
          lastMessageAt: new Date(2000),
          createdAt: new Date(1000),
          updatedAt: new Date(2000),
        },
        {
          _id: empty,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          user: "wa_77010000202",
          messages: [],
          createdAt: new Date(1569),
          updatedAt: new Date(3000),
        },
        {
          workspaceId,
          sourceId: "unrelated-source",
          channel: "whatsapp",
          chat: "wa_77010000202",
          messages: [historyMessage],
          airi_scenario_state: { lockedScenarioId: "zzz" },
          updatedAt: new Date(5000),
        },
      ]);
      const result = await getConversation();
      expect(String(result?.conversation._id)).toBe(String(established));
      const persisted = await Conversation.collection.findOne({
        _id: established,
      });
      expect(persisted?.airi_scenario_state).toEqual(state);
      expect(persisted?.airi_handoff_active).toBe(true);
      expect(persisted?.airi_handoff_started_at).toEqual(new Date(1500));
      expect(persisted?.messages).toEqual([historyMessage]);
      expect(await Conversation.countDocuments({ workspaceId })).toBe(3);
      expect(
        (await Conversation.collection.findOne({ _id: empty }))
          ?.whatsappConversationIdentityKey
      ).toBeUndefined();
    });

    it("retains all aliases during competing same-source enrollment of a keyed legacy row", async () => {
      const legacyId = new mongoose.Types.ObjectId();
      const originalKey = lookup.buildWhatsAppConversationIdentityKey({
        workspaceId,
        sourceId: "source-1",
        chatId: "wa_bsuid_US.Original",
      });
      await Conversation.collection.insertOne({
        _id: legacyId,
        workspaceId,
        sourceId: "source-1",
        channel: "whatsapp",
        chat: "wa_77010000202",
        user: "wa_77010000202",
        messages: [],
        whatsappConversationIdentityKey: originalKey,
      });
      const aliases = Array.from(
        { length: 12 },
        (_, index) => "wa_bsuid_US.Proven" + index
      );
      const results = await Promise.all(
        aliases.map(alias =>
          getConversation("wa_77010000202", "source-1", workspaceId, [
            "wa_77010000202",
            alias,
          ])
        )
      );
      expect(
        results.every(
          result => String(result?.conversation._id) === String(legacyId)
        )
      ).toBe(true);
      const persisted = await Conversation.collection.findOne({
        _id: legacyId,
      });
      expect(persisted?.whatsappConversationIdentityKey).toBe(originalKey);
      expect(persisted?.whatsappConversationIdentityKeys).toEqual(
        expect.arrayContaining(
          aliases.map(chatId =>
            lookup.buildWhatsAppConversationIdentityKey({
              workspaceId,
              sourceId: "source-1",
              chatId,
            })
          )
        )
      );
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("does not guess disjoint identities or merge conflicting enrolled owners", async () => {
      const phone = await getConversation();
      const bsuid = await getConversation("wa_bsuid_US.Customer");
      expect(String(phone?.conversation._id)).not.toBe(
        String(bsuid?.conversation._id)
      );
      await expect(
        getConversation("wa_77010000202", "source-1", workspaceId, [
          "wa_77010000202",
          "wa_bsuid_US.Customer",
        ])
      ).rejects.toThrow("conflicting enrolled owners");
      expect(await Conversation.countDocuments({ workspaceId })).toBe(2);
    });

    it("bounds the actual enrolled-owner query as unrelated workspace rows grow", async () => {
      const owner = await getConversation();
      const ownership = createWhatsAppConversationOwnership(Conversation);
      const find = jest.spyOn(Conversation, "find");
      try {
        for (const addedRows of [100, 1900]) {
          await Conversation.collection.insertMany(
            Array.from({ length: addedRows }, () => ({
              workspaceId,
              sourceId: "source-1",
              channel: "whatsapp",
              chat: "unrelated-legacy-chat",
              messages: [],
            }))
          );
          find.mockClear();
          const found = await ownership.findOwnedWhatsAppConversation({
            workspaceId,
            sourceId: "source-1",
            chatId: "wa_77010000202",
            candidateIds: ["wa_77010000202", "wa_87010000202"],
          });
          // The same row matches both unique indexes and must remain one owner.
          expect(String(found?._id)).toBe(String(owner?.conversation._id));
          expect(find).toHaveBeenCalledTimes(1);
          // Explain the canonical query, including its real projection, sort and
          // limit. A separately written filter could pass while production scans.
          const plan = await find.mock.results[0].value
            .clone()
            .maxTimeMS(5000)
            .explain("executionStats");
          expect(plan.executionStats.nReturned).toBe(1);
          expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(2);
          expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(8);
          const winningPlan = JSON.stringify(plan.queryPlanner.winningPlan);
          for (const spec of [
            CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC,
            CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC,
          ]) {
            expect(winningPlan).toContain(spec.options.name);
          }
          expect(winningPlan).not.toContain("COLLSCAN");
        }
      } finally {
        find.mockRestore();
      }
    });

    it("rejects distinct scalar-only and alias owners without changing either row", async () => {
      const ownership = createWhatsAppConversationOwnership(Conversation);
      await ownership.ensureWhatsAppConversationOwnershipIndex();
      const params = {
        workspaceId,
        sourceId: "source-1",
        chatId: "wa_77010000202",
        candidateIds: ["wa_77010000202"],
      };
      const key = lookup.buildWhatsAppConversationIdentityKey(params);
      await Conversation.collection.insertMany([
        {
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          whatsappConversationIdentityKey: key,
        },
        {
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          whatsappConversationIdentityKeys: [key],
        },
      ]);
      const before = await Conversation.collection
        .find({ workspaceId })
        .sort({ _id: 1 })
        .toArray();
      await expect(
        ownership.findOwnedWhatsAppConversation(params)
      ).rejects.toThrow("conflicting enrolled owners");
      const create = jest.fn();
      await expect(
        ownership.getOrCreateWhatsAppConversation({ ...params, create })
      ).rejects.toThrow("conflicting enrolled owners");
      expect(create).not.toHaveBeenCalled();
      expect(
        await Conversation.collection
          .find({ workspaceId })
          .sort({ _id: 1 })
          .toArray()
      ).toEqual(before);
    });

    it("keeps scope and alias-type fences while accepting null or missing sources", async () => {
      const ownership = createWhatsAppConversationOwnership(Conversation);
      await ownership.ensureWhatsAppConversationOwnershipIndex();
      const params = {
        workspaceId,
        sourceId: "source-1",
        chatId: "wa_77010000202",
        candidateIds: ["wa_77010000202"],
      };
      const key = lookup.buildWhatsAppConversationIdentityKey(params);
      const scope = { workspaceId, sourceId: "source-1", channel: "whatsapp" };
      for (const fields of [
        ...[
          { workspaceId: `${workspaceId}-other` },
          { sourceId: "source-2" },
          { channel: "telegram" },
        ].flatMap(fields => [
          { ...fields, whatsappConversationIdentityKey: key },
          { ...fields, whatsappConversationIdentityKeys: [key] },
        ]),
        { whatsappConversationIdentityKeys: key },
        { whatsappConversationIdentityKeys: { "0": key } },
        {
          whatsappConversationIdentityKey: 42,
          whatsappConversationIdentityKeys: [],
        },
        { whatsappConversationIdentityKeys: null },
        {},
      ]) {
        const inserted = await Conversation.collection.insertOne({
          ...scope,
          ...fields,
        });
        try {
          expect(
            await ownership.findOwnedWhatsAppConversation(params)
          ).toBeNull();
        } finally {
          await Conversation.collection.deleteOne({ _id: inserted.insertedId });
        }
      }
      const sourceLess = { ...params, sourceId: null };
      for (const source of [{ sourceId: null }, {}]) {
        const inserted = await Conversation.collection.insertOne({
          workspaceId,
          channel: "whatsapp",
          ...source,
          whatsappConversationIdentityKeys: [
            lookup.buildWhatsAppConversationIdentityKey(sourceLess),
          ],
        });
        try {
          expect(
            String(
              (await ownership.findOwnedWhatsAppConversation(sourceLess))?._id
            )
          ).toBe(String(inserted.insertedId));
          expect(
            await ownership.findOwnedWhatsAppConversation(params)
          ).toBeNull();
        } finally {
          await Conversation.collection.deleteOne({ _id: inserted.insertedId });
        }
      }
    });

    it("creates the partial alias index safely over absent, null, empty and non-WhatsApp legacy values", async () => {
      // Dedicated collection proves index creation, rather than a pre-existing index accepting fixtures.
      const collection = mongoose.connection.collection(
        "ownership_partial_index_fixture_" +
          new mongoose.Types.ObjectId().toHexString()
      );
      try {
        await collection.insertMany(
          Array.from({ length: 2 }, () => [
            { channel: "whatsapp" },
            { channel: "whatsapp", whatsappConversationIdentityKeys: null },
            { channel: "whatsapp", whatsappConversationIdentityKeys: [] },
            {
              channel: "telegram",
              whatsappConversationIdentityKeys: ["shared"],
            },
          ]).flat()
        );
        await collection.createIndex(
          CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC.keys,
          CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC.options
        );
        await collection.insertOne({
          channel: "whatsapp",
          whatsappConversationIdentityKeys: ["phone", "bsuid", "phone"],
        });
        await expect(
          collection.insertOne({
            channel: "whatsapp",
            whatsappConversationIdentityKeys: ["other", "bsuid"],
          })
        ).rejects.toMatchObject({ code: 11000 });
        expect(await collection.countDocuments({})).toBe(9);
      } finally {
        await collection.drop();
      }
      const unclaimed = new Conversation({
        workspaceId,
        channel: "whatsapp",
        chat: "legacy",
        user: "legacy",
      });
      expect(unclaimed.get("whatsappConversationIdentityKeys")).toBeUndefined();
    });

    it("reads a phone-first owner by its later enrolled BSUID without mutating ownership", async () => {
      const owner = await getConversation();
      await getConversation("wa_77010000202", "source-1", workspaceId, [
        "wa_77010000202",
        "wa_bsuid_US.Customer",
      ]);
      const before = await Conversation.collection.findOne({
        _id: owner?.conversation._id,
      });
      const read = await lookup.findExistingWhatsAppConversationForRecipient({
        workspaceId,
        sourceId: "source-1",
        recipient: "US.Customer",
      });
      expect(String(read?._id)).toBe(String(owner?.conversation._id));
      expect(
        await Conversation.collection.findOne({ _id: owner?.conversation._id })
      ).toEqual(before);
    });

    it("adopts a legacy source-less row without sharing it with a different source", async () => {
      const _id = new mongoose.Types.ObjectId();
      await Conversation.collection.insertOne({
        _id,
        workspaceId,
        channel: "whatsapp",
        chat: "wa_87010000202",
        messages: [],
        whatsappConversationIdentityKey: null,
      });
      const first = await getConversation();
      const otherSource = await getConversation("wa_77010000202", "source-2");
      expect(String(first?.conversation._id)).toBe(String(_id));
      expect(String(otherSource?.conversation._id)).not.toBe(String(_id));
    });

    it("retains proven aliases when adopting a source-less owner without copying foreign aliases", async () => {
      const phone = "wa_77010000202",
        bsuid = "wa_bsuid_US.Customer";
      const owner = await getConversation(phone, null, workspaceId, [
        phone,
        bsuid,
      ]);
      const invalid = [
        "not-json",
        lookup.buildWhatsAppConversationIdentityKey({
          workspaceId: "foreign",
          sourceId: null,
          chatId: "wa_bsuid_US.Foreign",
        }),
        lookup.buildWhatsAppConversationIdentityKey({
          workspaceId,
          sourceId: "foreign-source",
          chatId: "wa_bsuid_US.ForeignSource",
        }),
      ];
      await Conversation.collection.updateOne(
        { _id: owner?.conversation._id },
        { $addToSet: { whatsappConversationIdentityKeys: { $each: invalid } } }
      );
      const adopted = await getConversation(phone, "source-1");
      expect(String(adopted?.conversation._id)).toBe(
        String(owner?.conversation._id)
      );
      expect(
        String((await getConversation(bsuid, "source-1"))?.conversation._id)
      ).toBe(String(owner?.conversation._id));
      const stored = await Conversation.collection.findOne({
        _id: owner?.conversation._id,
      });
      expect(stored?.whatsappConversationIdentityKeys).toEqual(
        expect.arrayContaining(
          [phone, bsuid].map(chatId =>
            lookup.buildWhatsAppConversationIdentityKey({
              workspaceId,
              sourceId: "source-1",
              chatId,
            })
          )
        )
      );
      expect(stored?.whatsappConversationIdentityKeys).toHaveLength(2);
    });

    it("retains an old primary identity during source adoption when it was never in the alias array", async () => {
      const legacy = new mongoose.Types.ObjectId();
      await Conversation.collection.insertOne({
        _id: legacy,
        workspaceId,
        channel: "whatsapp",
        chat: "wa_77010000202",
        user: "wa_77010000202",
        whatsappConversationIdentityKey:
          lookup.buildWhatsAppConversationIdentityKey({
            workspaceId,
            sourceId: null,
            chatId: "wa_bsuid_US.PrimaryOnly",
          }),
      });
      expect(String((await getConversation())?.conversation._id)).toBe(
        String(legacy)
      );
      expect(
        String(
          (await getConversation("wa_bsuid_US.PrimaryOnly"))?.conversation._id
        )
      ).toBe(String(legacy));
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("adopts a source-less owner through an enrolled alias absent from chat and user", async () => {
      const owner = await getConversation("wa_77010000202", null, workspaceId, [
        "wa_77010000202",
        "wa_bsuid_US.Customer",
      ]);
      const adopted = await getConversation("wa_bsuid_US.Customer", "source-1");
      expect(String(adopted?.conversation._id)).toBe(
        String(owner?.conversation._id)
      );
      expect(
        String((await getConversation("wa_77010000202"))?.conversation._id)
      ).toBe(String(owner?.conversation._id));
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("retries source adoption when another writer enrolled an alias after its snapshot", async () => {
      const owner = await getConversation("wa_77010000202", null);
      const alias = lookup.buildWhatsAppConversationIdentityKey({
        workspaceId,
        sourceId: null,
        chatId: "wa_bsuid_US.Concurrent",
      });
      let injected = false;
      const model = {
        collection: Conversation.collection,
        find: Conversation.find.bind(Conversation),
        findOne: Conversation.findOne.bind(Conversation),
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          options: { new: true; timestamps: false }
        ) => {
          if (!injected && filter.sourceId === null) {
            injected = true;
            await Conversation.collection.updateOne(
              { _id: owner?.conversation._id },
              { $addToSet: { whatsappConversationIdentityKeys: alias } }
            );
          }
          return Conversation.findOneAndUpdate(filter, update, options);
        },
      } as unknown as WhatsAppConversationOwnershipModel;
      const create = jest.fn();
      const result = await createWhatsAppConversationOwnership(
        model
      ).getOrCreateWhatsAppConversation({
        workspaceId,
        sourceId: "source-1",
        chatId: "wa_77010000202",
        candidateIds: ["wa_77010000202"],
        create,
      });
      expect(String(result?.conversation._id)).toBe(
        String(owner?.conversation._id)
      );
      expect(create).not.toHaveBeenCalled();
      expect(
        String(
          (await getConversation("wa_bsuid_US.Concurrent"))?.conversation._id
        )
      ).toBe(String(owner?.conversation._id));
      expect(await Conversation.countDocuments({ workspaceId })).toBe(1);
    });

    it("prefers recent manager history over stale scenario state and a newer empty sibling", async () => {
      const recent = new mongoose.Types.ObjectId();
      const stale = new mongoose.Types.ObjectId();
      const empty = new mongoose.Types.ObjectId();
      await Conversation.collection.insertMany([
        {
          _id: recent,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          messages: [new mongoose.Types.ObjectId()],
          lastMessageAt: new Date(2000),
          updatedAt: new Date(2000),
          airi_handoff_active: true,
          airi_handoff_started_at: new Date(1500),
        },
        {
          _id: stale,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          messages: [new mongoose.Types.ObjectId()],
          lastMessageAt: new Date(1000),
          updatedAt: new Date(1000),
          airi_scenario_state: { lockedScenarioId: "stale-scenario" },
        },
        {
          _id: empty,
          workspaceId,
          sourceId: "source-1",
          channel: "whatsapp",
          chat: "wa_77010000202",
          messages: [],
          updatedAt: new Date(3000),
        },
      ]);
      const read = await lookup.findExistingWhatsAppConversationForRecipient({
        workspaceId,
        sourceId: "source-1",
        recipient: "77010000202",
      });
      expect(String(read?._id)).toBe(String(recent));
      expect(String((await getConversation())?.conversation._id)).toBe(
        String(recent)
      );
      expect(await Conversation.countDocuments({ workspaceId })).toBe(3);
      const stored = await Conversation.collection.findOne({ _id: recent });
      expect(stored?.airi_handoff_active).toBe(true);
      expect(stored?.airi_handoff_started_at).toEqual(new Date(1500));
    });

    it("atomically adopts an already pinned source-less owner", async () => {
      const sourceLess = await getConversation("wa_77010000202", null);
      const [first, second] = await Promise.all([
        getConversation("wa_77010000202", "source-1"),
        getConversation("wa_77010000202", "source-2"),
      ]);
      const ids = [first, second].map(result =>
        String(result?.conversation._id)
      );
      expect(new Set(ids).size).toBe(2);
      expect(ids).toContain(String(sourceLess?.conversation._id));
      expect(await Conversation.countDocuments({ workspaceId })).toBe(2);
    });
  }
);
