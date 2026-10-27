import assert from "node:assert/strict";
import test from "node:test";

import { extractWhatsAppCallWebhookEvents } from "./webhook-call-events.js";

test("normalizes calls and call statuses with BSUID identifiers", () => {
  const events = extractWhatsAppCallWebhookEvents({
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    contacts: [
      {
        wa_id: "",
        user_id: "US.1349.private",
        parent_user_id: "US.parent.private",
        profile: {
          name: "Private Customer",
          username: "private_customer",
          country_code: "US",
        },
      },
    ],
    calls: [
      {
        id: "wacid.1",
        event: "connect",
        direction: "USER_INITIATED",
        from: "",
        from_user_id: "US.1349.private",
        from_parent_user_id: "US.parent.private",
        to: "15551234567",
        to_user_id: "US.1349.business",
        to_parent_user_id: "US.parent.business",
        timestamp: "1770000000",
      },
    ],
    statuses: [
      {
        id: "wacid.2",
        type: "call",
        status: "RINGING",
        recipient_id: "",
        recipient_user_id: "US.1349.private",
        recipient_parent_user_id: "US.parent.private",
        timestamp: "1770000001",
      },
    ],
  });

  assert.equal(events.length, 2);
  assert.deepEqual(
    {
      kind: events[0]?.kind,
      callId: events[0]?.callId,
      event: events[0]?.event,
      direction: events[0]?.direction,
      fromUserId: events[0]?.fromUserId,
      fromParentUserId: events[0]?.fromParentUserId,
      toUserId: events[0]?.toUserId,
      toParentUserId: events[0]?.toParentUserId,
      contactUserId: events[0]?.contactUserId,
      contactParentUserId: events[0]?.contactParentUserId,
      contactUsername: events[0]?.contactUsername,
    },
    {
      kind: "call",
      callId: "wacid.1",
      event: "connect",
      direction: "USER_INITIATED",
      fromUserId: "US.1349.private",
      fromParentUserId: "US.parent.private",
      toUserId: "US.1349.business",
      toParentUserId: "US.parent.business",
      contactUserId: "US.1349.private",
      contactParentUserId: "US.parent.private",
      contactUsername: "private_customer",
    },
  );
  assert.deepEqual(
    {
      kind: events[1]?.kind,
      callId: events[1]?.callId,
      status: events[1]?.status,
      recipientId: events[1]?.recipientId,
      recipientUserId: events[1]?.recipientUserId,
      recipientParentUserId: events[1]?.recipientParentUserId,
      contactUserId: events[1]?.contactUserId,
      contactParentUserId: events[1]?.contactParentUserId,
      contactUsername: events[1]?.contactUsername,
    },
    {
      kind: "status",
      callId: "wacid.2",
      status: "RINGING",
      recipientId: "US.1349.private",
      recipientUserId: "US.1349.private",
      recipientParentUserId: "US.parent.private",
      contactUserId: "US.1349.private",
      contactParentUserId: "US.parent.private",
      contactUsername: "private_customer",
    },
  );
});

test("promotes media signaling and termination metadata", () => {
  const events = extractWhatsAppCallWebhookEvents({
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    calls: [
      {
        id: "wacid.connect",
        event: "connect",
        direction: "USER_INITIATED",
        from_user_id: "US.1349.private",
        to_user_id: "US.1349.business",
        timestamp: "1770000000",
        session: {
          sdp_type: "offer",
          sdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
        },
      },
      {
        id: "wacid.terminate",
        event: "terminate",
        timestamp: "1770000300",
        duration: 287,
        errors: [
          {
            code: 138019,
            message: "Call setup failed",
          },
        ],
      },
    ],
  });

  assert.equal(events.length, 2);
  assert.deepEqual(
    {
      callId: events[0]?.callId,
      event: events[0]?.event,
      sessionSdpType: events[0]?.sessionSdpType,
      sessionSdp: events[0]?.sessionSdp,
      durationSeconds: events[0]?.durationSeconds,
      errorCode: events[0]?.errorCode,
      errorMessage: events[0]?.errorMessage,
    },
    {
      callId: "wacid.connect",
      event: "connect",
      sessionSdpType: "offer",
      sessionSdp: "v=0\r\no=- 123 456 IN IP4 127.0.0.1",
      durationSeconds: null,
      errorCode: null,
      errorMessage: null,
    },
  );
  assert.deepEqual(
    {
      callId: events[1]?.callId,
      event: events[1]?.event,
      sessionSdpType: events[1]?.sessionSdpType,
      sessionSdp: events[1]?.sessionSdp,
      durationSeconds: events[1]?.durationSeconds,
      errorCode: events[1]?.errorCode,
      errorMessage: events[1]?.errorMessage,
    },
    {
      callId: "wacid.terminate",
      event: "terminate",
      sessionSdpType: null,
      sessionSdp: null,
      durationSeconds: 287,
      errorCode: 138019,
      errorMessage: "Call setup failed",
    },
  );
});
