import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCallEvent,
  execResult,
} from "./testing/whatsapp-call-fixtures.js";
import {
  createWhatsAppCallConversationLinker,
  type WhatsAppCallConversationLinkerDependencies,
  type WhatsAppCallLinkedConversation,
} from "./whatsapp-call-conversation-linker-core.js";

function callSessionFindResult(value: unknown) {
  return {
    select: () => ({
      lean: <T = unknown>() => execResult(value as T),
    }),
  };
}

function createDeps() {
  const calls: Record<string, unknown[][]> = {
    callSessionUpdateOne: [],
    chatFindOneAndUpdate: [],
    conversationCreate: [],
    conversationFindOne: [],
    ensureCapacity: [],
    userFindOneAndUpdate: [],
  };
  const state = {
    callSessionLink: null as unknown,
    chat: {
      _id: "wa_bsuid_US.1349.private",
    } as WhatsAppCallLinkedConversation,
    conversationCreate: {
      _id: "conversation-new",
      customerId: null,
    } as WhatsAppCallLinkedConversation,
    conversationFindResults: [] as Array<WhatsAppCallLinkedConversation | null>,
    capacity: { allowed: true },
    user: {
      _id: "wa_bsuid_US.1349.private",
    } as WhatsAppCallLinkedConversation,
  };

  const deps: WhatsAppCallConversationLinkerDependencies<
    Record<string, never>
  > = {
    buildWhatsAppIdentitySnapshot: (contact) => ({
      userId: contact.userId,
      parentUserId: contact.parentUserId,
      username: contact.profile.username,
      profileName: contact.profile.name,
      primaryIdType: contact.primaryIdType,
    }),
    chatModel: {
      findOneAndUpdate: (...args) => {
        calls.chatFindOneAndUpdate.push(args);
        return execResult(state.chat);
      },
    },
    conversationModel: {
      create: async (...args) => {
        calls.conversationCreate.push(args);
        return state.conversationCreate;
      },
    },
    getOrCreateConversation: async (params) => {
      const { create, ...identity } = params;
      calls.conversationFindOne.push([identity]);
      const existing = state.conversationFindResults.shift();
      if (existing) return { conversation: existing, created: false };
      const conversation = await create("test-identity-key", [
        "test-identity-key",
      ]);
      return conversation ? { conversation, created: true } : null;
    },
    ensureCompanyConversationCapacity: async (...args) => {
      calls.ensureCapacity.push(args);
      return state.capacity;
    },
    getWorkspaceBotDefault: async () => true,
    getWorkspaceCoachDefault: async () => true,
    getWorkspaceScenariosDefault: async () => false,
    supabaseAdmin: {},
    userModel: {
      findOneAndUpdate: (...args) => {
        calls.userFindOneAndUpdate.push(args);
        return execResult(state.user);
      },
    },
    whatsAppCallSessionModel: {
      findOne: () => callSessionFindResult(state.callSessionLink),
      updateOne: (...args) => {
        calls.callSessionUpdateOne.push(args);
        return execResult({ modifiedCount: 1 });
      },
    },
  };

  return {
    calls,
    deps,
    linkWhatsAppCallSessionToConversation:
      createWhatsAppCallConversationLinker(deps),
    state,
  };
}

test("reuses an existing WhatsApp conversation by canonical BSUID identity", async () => {
  const { calls, linkWhatsAppCallSessionToConversation, state } = createDeps();
  state.conversationFindResults = [
    {
      _id: "conversation-1",
      customerId: "customer-1",
    },
  ];

  const result = await linkWhatsAppCallSessionToConversation({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: buildCallEvent(),
  });

  assert.deepEqual(result, {
    conversationId: "conversation-1",
    customerId: "customer-1",
    createdConversation: false,
  });
  assert.deepEqual(calls.userFindOneAndUpdate[0], [
    { _id: "wa_bsuid_US.1349.private" },
    {
      $set: {
        workspaceId: "workspace-1",
        isBot: false,
        whatsapp: {
          userId: "US.1349.private",
          parentUserId: "US.parent.private",
          username: "private_customer",
          profileName: "Private Customer",
          primaryIdType: "user_id",
        },
        username: "private_customer",
      },
      $setOnInsert: {
        firstName: "Private Customer",
      },
    },
    { upsert: true, new: true },
  ]);
  assert.deepEqual(calls.conversationFindOne[0], [
    {
      chatId: "wa_bsuid_US.1349.private",
      candidateIds: [
        "wa_bsuid_US.1349.private",
        "US.1349.private",
        "US.parent.private",
        "wa_bsuid_US.parent.private",
      ],
      workspaceId: "workspace-1",
      sourceId: "source-1",
    },
  ]);
  assert.equal(calls.conversationCreate.length, 0);
  assert.deepEqual(calls.callSessionUpdateOne[0], [
    {
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
    },
    {
      $set: {
        conversationId: "conversation-1",
        customerId: "customer-1",
      },
    },
  ]);
});

test("creates a new open WhatsApp conversation when no matching request exists", async () => {
  const { calls, linkWhatsAppCallSessionToConversation, state } = createDeps();
  state.conversationFindResults = [null, null];
  state.user = { _id: "wa_77012345678" };
  state.chat = { _id: "wa_77012345678" };

  const result = await linkWhatsAppCallSessionToConversation({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: buildCallEvent({ contactWaId: "77012345678" }),
  });

  assert.deepEqual(result, {
    conversationId: "conversation-new",
    customerId: null,
    createdConversation: true,
  });
  assert.deepEqual(calls.ensureCapacity[0], [{}, "workspace-1"]);
  assert.deepEqual(calls.conversationCreate[0]?.[0], {
    whatsappConversationIdentityKey: "test-identity-key",
    whatsappConversationIdentityKeys: ["test-identity-key"],
    chat: "wa_77012345678",
    user: "wa_77012345678",
    messages: [],
    is_classified: false,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    channel: "whatsapp",
    status: "open",
    airi_bot_enabled: true,
    airi_scenarios_enabled: false,
    airi_coach_enabled: true,
  });
});

for (const existingChatId of [
  "wa_bsuid_US.1349.private",
  "wa_bsuid_US.parent.private",
]) {
  test(`a phone and BSUID call reuses the prior ${existingChatId} conversation`, async () => {
    const { calls, deps, linkWhatsAppCallSessionToConversation, state } =
      createDeps();
    state.user = { _id: "wa_77012345678" };
    state.chat = { _id: "wa_77012345678" };
    deps.getOrCreateConversation = async ({ candidateIds, create }) => {
      if (candidateIds.includes(existingChatId)) {
        return {
          conversation: {
            _id: "prior-bsuid-conversation",
            customerId: "customer-1",
          },
          created: false,
        };
      }
      const conversation = await create("test-identity-key", [
        "test-identity-key",
      ]);
      return conversation ? { conversation, created: true } : null;
    };

    const result = await linkWhatsAppCallSessionToConversation({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      event: buildCallEvent({ contactWaId: "77012345678" }),
    });

    assert.deepEqual(result, {
      conversationId: "prior-bsuid-conversation",
      customerId: "customer-1",
      createdConversation: false,
    });
    assert.equal(calls.conversationCreate.length, 0);
  });
}

test("does not create a new conversation when capacity is exhausted", async () => {
  const { calls, linkWhatsAppCallSessionToConversation, state } = createDeps();
  state.conversationFindResults = [null, null];
  state.capacity = { allowed: false };

  const result = await linkWhatsAppCallSessionToConversation({
    workspaceId: "workspace-1",
    sourceId: "source-1",
    event: buildCallEvent(),
  });

  assert.equal(result, null);
  assert.equal(calls.conversationCreate.length, 0);
  assert.equal(calls.callSessionUpdateOne.length, 0);
});
