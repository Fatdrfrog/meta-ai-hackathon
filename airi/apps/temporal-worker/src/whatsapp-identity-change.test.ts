import assert from "node:assert/strict";
import test from "node:test";

import { parseUserChangedUserId } from "./whatsapp-identity-change-parser.js";
import { persistIdentityChangeMessageAndLink } from "./whatsapp-identity-change-message-link.js";
import { findWhatsAppNumberChangeAffectedRecords } from "./whatsapp-identity-change-recovery.js";

test("extracts old and new BSUID values from Meta's system body and user_id field", () => {
  const result = parseUserChangedUserId({
    messageFrom: "",
    system: {
      body: "User Private Customer changed from US.old1349 to US.new93737",
      user_id: "US.new93737",
      type: "user_changed_user_id",
    },
  });

  assert.deepEqual(result, {
    oldUserId: "US.old1349",
    newUserId: "US.new93737",
  });
});

test("number-change retry rediscovers only the exact already-migrated identity", async () => {
  type IdentityRow = {
    _id: string;
    workspaceId: string;
    whatsapp: { waId: string; previousWaIds: string[] };
  };
  const rows: IdentityRow[] = [
    {
      _id: "chat-1",
      workspaceId: "workspace-1",
      whatsapp: { waId: "77050000001", previousWaIds: [] },
    },
    {
      _id: "unrelated-new-owner",
      workspaceId: "workspace-1",
      whatsapp: { waId: "77050000002", previousWaIds: [] },
    },
  ];

  const model = {
    find(filter: Record<string, any>) {
      const matches = rows.filter((row) => {
        if (row.workspaceId !== filter.workspaceId) return false;
        return filter.$or.some((clause: Record<string, string>) => {
          const currentMatches =
            clause["whatsapp.waId"] === undefined ||
            row.whatsapp.waId === clause["whatsapp.waId"];
          const priorMatches =
            clause["whatsapp.previousWaIds"] === undefined ||
            row.whatsapp.previousWaIds.includes(
              clause["whatsapp.previousWaIds"],
            );
          return currentMatches && priorMatches;
        });
      });
      return {
        select() {
          return {
            async lean() {
              return matches.map(({ _id }) => ({ _id }));
            },
          };
        },
      };
    },
  };

  const first = await findWhatsAppNumberChangeAffectedRecords({
    chatModel: model,
    userModel: model,
    workspaceId: "workspace-1",
    oldWaId: "77050000001",
    newWaId: "77050000002",
  });
  assert.deepEqual(first.chatIds, ["chat-1"]);

  rows[0]!.whatsapp = {
    waId: "77050000002",
    previousWaIds: ["77050000001"],
  };

  const retry = await findWhatsAppNumberChangeAffectedRecords({
    chatModel: model,
    userModel: model,
    workspaceId: "workspace-1",
    oldWaId: "77050000001",
    newWaId: "77050000002",
  });
  assert.deepEqual(retry.chatIds, ["chat-1"]);
  assert.deepEqual(retry.userIds, ["chat-1"]);
});

test("second number-change attempt repairs a message saved before append failed", async () => {
  const identityRows = [
    {
      _id: "chat-1",
      workspaceId: "workspace-1",
      whatsapp: { waId: "old-wa", previousWaIds: [] as string[] },
    },
  ];
  const identityModel = {
    find(filter: Record<string, any>) {
      const matches = identityRows.filter(
        (row) =>
          row.workspaceId === filter.workspaceId &&
          filter.$or.some(
            (clause: Record<string, string>) =>
              (clause["whatsapp.waId"] === undefined ||
                row.whatsapp.waId === clause["whatsapp.waId"]) &&
              (clause["whatsapp.previousWaIds"] === undefined ||
                row.whatsapp.previousWaIds.includes(
                  clause["whatsapp.previousWaIds"],
                )),
          ),
      );
      return {
        select() {
          return {
            async lean() {
              return matches.map(({ _id }) => ({ _id }));
            },
          };
        },
      };
    },
  };
  let persistedMessage: { _id: string } | null = null;
  const messageModel = {
    findOne() {
      return {
        select() {
          return {
            async exec() {
              return persistedMessage;
            },
          };
        },
      };
    },
    async create() {
      persistedMessage = { _id: "message-1" };
      return persistedMessage;
    },
  };
  const appendError = new Error("append unavailable");
  let appendAttempt = 0;

  async function runAttempt() {
    const affected = await findWhatsAppNumberChangeAffectedRecords({
      chatModel: identityModel,
      userModel: identityModel,
      workspaceId: "workspace-1",
      oldWaId: "old-wa",
      newWaId: "new-wa",
    });
    assert.deepEqual(affected.chatIds, ["chat-1"]);

    identityRows[0]!.whatsapp = {
      waId: "new-wa",
      previousWaIds: ["old-wa"],
    };

    return persistIdentityChangeMessageAndLink(
      {
        messageModel,
        identityFilter: { messageId: "ws_numchg_1" },
        messageDocument: { messageId: "ws_numchg_1" },
        conversationId: "conversation-1",
        eventAt: new Date("2026-08-10T00:00:00.000Z"),
      },
      {
        appendMessage: async () => {
          appendAttempt += 1;
          if (appendAttempt === 1) throw appendError;
          return { appended: true };
        },
      },
    );
  }

  await assert.rejects(runAttempt(), appendError);
  const retry = await runAttempt();

  assert.equal(retry.created, false);
  assert.equal(retry.linkResult.appended, true);
  assert.equal(appendAttempt, 2);
});
