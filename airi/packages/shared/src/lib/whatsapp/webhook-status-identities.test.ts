import assert from "node:assert/strict";
import test from "node:test";

import { resolveWhatsAppStatusRecipientIdentity } from "./webhook-status-identities.js";

test("falls back to recipient_user_id when recipient_id is empty", () => {
  const result = resolveWhatsAppStatusRecipientIdentity({
    status: {
      recipient_id: "",
      recipient_user_id: "US.1349.private",
    },
    contacts: [
      {
        wa_id: "",
        user_id: "US.1349.private",
        profile: {
          name: "Private Customer",
          username: "@private_customer",
        },
      },
    ],
  });

  assert.equal(result.recipientId, "US.1349.private");
  assert.equal(result.contact?.userId, "US.1349.private");
  assert.equal(result.contact?.waId, undefined);
  assert.equal(result.contact?.profile.username, "@private_customer");
});

test("keeps group recipient id separate from the participant identity", () => {
  const result = resolveWhatsAppStatusRecipientIdentity({
    status: {
      recipient_id: "120363000000000000@g.us",
      recipient_type: "group",
      recipient_participant_id: "16505551234",
    },
    contacts: [
      {
        wa_id: "16505551234",
        profile: {
          name: "Group Participant",
        },
      },
    ],
  });

  assert.equal(result.recipientId, "120363000000000000@g.us");
  assert.equal(result.recipientWaId, "16505551234");
  assert.equal(result.recipientUserId, null);
  assert.equal(result.contact?.waId, "16505551234");
});
