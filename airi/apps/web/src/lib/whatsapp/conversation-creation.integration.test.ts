import mongoose from "mongoose";
import { Conversation } from "@/models/conversation";

const mockUsageDelta = jest.fn();
const mockQuery = (value: unknown) => ({
  select: () => mockQuery(value),
  limit: () => mockQuery(value),
  lean: async () => value,
  populate: () => mockQuery(value),
  then: (
    resolve: (value: unknown) => unknown,
    reject: (error: unknown) => unknown
  ) => Promise.resolve(value).then(resolve, reject),
});
let mockIdentityRows: Array<Record<string, unknown>> = [];
const mockIdentityModel = {
  find: () => mockQuery(mockIdentityRows),
  findOneAndUpdate: () => ({
    exec: async () => ({ _id: "wa_77754272513", isBot: false }),
  }),
};
jest.mock("@icecore/airi-runtime/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: mockIdentityModel,
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    ...mockIdentityModel,
    findOneAndUpdate: async () => ({ _id: "wa_77754272513" }),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: class {
    [key: string]: unknown;
    $locals = {};
    _id = new (jest.requireActual<typeof import("mongoose")>(
      "mongoose"
    ).Types.ObjectId)();
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    static findOne() {
      return mockQuery(null);
    }
    async save() {
      await jest
        .requireActual<typeof import("mongoose")>("mongoose")
        .connection.collection("ownership_test_messages")
        .insertOne({
          _id: this._id,
          messageId: this.messageId,
          conversation: this.conversation,
        });
      return this;
    }
  },
}));
jest.mock("@/models/whatsapp-pending-message-mutation", () => ({
  __esModule: true,
  default: { find: () => ({ sort: () => ({ lean: async () => [] }) }) },
}));
jest.mock("@/lib/whatsapp/identity/indexes", () => ({
  ensureWhatsAppIdentityIndexes: async () => undefined,
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: async () => {
    // Preserve the measured first-message overlap: another inbound arrives while
    // the first creator is loading workspace settings, before either saves.
    await new Promise(resolve => setTimeout(resolve, 450));
    return { defaultScenariosEnabled: true };
  },
}));
jest.mock("@/lib/customers/service", () => ({
  syncCustomerForConversation: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockUsageDelta(...args),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: async (id: unknown, messageId: unknown) => {
    await jest
      .requireActual<
        typeof import("@/models/conversation")
      >("@/models/conversation")
      .Conversation.updateOne(
        { _id: id },
        { $addToSet: { messages: messageId } }
      );
    return { appended: true, revision: 1, generation: 1 };
  },
}));
jest.mock("@/lib/posthog/server", () => ({ getPostHogClient: () => null }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

const { processWhatsAppMessage } = jest.requireActual(
  "@icecore/airi-runtime/whatsapp-message-processor"
) as typeof import("@icecore/airi-runtime/whatsapp-message-processor");
const uri =
  "mongodb://127.0.0.1:27277/airi_whatsapp_ownership_test?replicaSet=airiCostTests";
const describeMongo = process.env.WHATSAPP_CONVERSATION_TEST_MONGODB_URI
  ? describe
  : describe.skip;
describeMongo(
  "first-message ownership through the real message processor",
  () => {
    beforeAll(async () => {
      if (
        process.env.WHATSAPP_CONVERSATION_TEST_MONGODB_URI !== uri ||
        process.env.MONGODB_URI !== uri
      )
        throw new Error(
          "Only the isolated local ownership database is allowed"
        );
      await mongoose.connect(uri, { autoIndex: false });
    });
    beforeEach(async () => {
      await Conversation.collection.deleteMany({
        workspaceId: "ownership-ingress-test",
      });
      await mongoose.connection
        .collection("ownership_test_messages")
        .deleteMany({});
      mockUsageDelta.mockClear();
      mockIdentityRows = [];
    });
    afterAll(async () => {
      await Conversation.collection.deleteMany({
        workspaceId: "ownership-ingress-test",
      });
      await mongoose.connection
        .collection("ownership_test_messages")
        .deleteMany({});
      await mongoose.disconnect();
    });
    it.each([false, true])(
      "enrolls a supplied parent alias only when identity resolution is unambiguous (conflict=%s)",
      async conflict => {
        const parentUserId = "US.Parent";
        if (conflict)
          mockIdentityRows = [
            { _id: "wa_77754272513", whatsapp: { waId: "77754272513" } },
            { _id: "wa_77799999999", whatsapp: { parentUserId } },
          ];
        await processWhatsAppMessage({
          messageData: {
            id: "wamid.parent",
            type: "text",
            text: { body: "Hello" },
          },
          contactData: {
            waId: "77754272513",
            parentUserId,
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
          workspaceId: "ownership-ingress-test",
          sourceId: "source-1",
          phoneNumberId: "phone-1",
          direction: "inbound",
          messageDate: new Date(),
          deferReferralEnrichment: true,
        });
        const owner = await Conversation.collection.findOne({
          workspaceId: "ownership-ingress-test",
        });
        const parentKey = JSON.stringify([
          "whatsapp:v1",
          "ownership-ingress-test",
          "source-1",
          "wa_bsuid_US.Parent",
        ]);
        if (conflict)
          expect(owner?.whatsappConversationIdentityKeys).not.toContain(
            parentKey
          );
        else
          expect(owner?.whatsappConversationIdentityKeys).toContain(parentKey);
      }
    );

    it("distinct inbound messages 322ms apart attach to one conversation and start once", async () => {
      const send = (id: string) =>
        processWhatsAppMessage({
          messageData: { id, type: "text", text: { body: "Hello" } },
          contactData: {
            waId: "77754272513",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
          workspaceId: "ownership-ingress-test",
          sourceId: "source-1",
          phoneNumberId: "phone-1",
          direction: "inbound",
          messageDate: new Date(),
          deferReferralEnrichment: true,
        });
      const first = send("wamid.concurrent-first");
      await new Promise(resolve => setTimeout(resolve, 322));
      const results = await Promise.all([
        first,
        send("wamid.concurrent-second"),
      ]);
      expect(new Set(results.map(result => result.conversationId)).size).toBe(
        1
      );
      expect(results.filter(result => result.isNewConversation)).toHaveLength(
        1
      );
      expect(
        await Conversation.countDocuments({
          workspaceId: "ownership-ingress-test",
        })
      ).toBe(1);
      const messages = await mongoose.connection
        .collection("ownership_test_messages")
        .find({})
        .toArray();
      expect(messages).toHaveLength(2);
      expect(
        new Set(messages.map(message => String(message.conversation))).size
      ).toBe(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(
        mockUsageDelta.mock.calls.filter(
          ([event]) => event.metric === "conversation_count"
        )
      ).toHaveLength(1);
    });
  }
);
