import assert from "node:assert/strict";
import test from "node:test";

import {
  isStoredWhatsAppTextMessageEditable,
  getWhatsAppMessageMutationKind,
  isWhatsAppStandaloneMessageEvent,
  type WhatsAppMessageEventLike,
} from "./message-mutations";

function message(
  value: WhatsAppMessageEventLike & { type: string },
): WhatsAppMessageEventLike {
  return {
    ...value,
  };
}

test("classifies native and co-existence message mutations", () => {
  assert.equal(
    getWhatsAppMessageMutationKind(message({ type: "edit" })),
    "edit",
  );
  assert.equal(
    getWhatsAppMessageMutationKind(message({ type: "revoke" })),
    "revoke",
  );
  assert.equal(
    getWhatsAppMessageMutationKind(
      message({ type: "unsupported", unsupported: { type: "EDIT" } }),
    ),
    "edit",
  );
  assert.equal(
    getWhatsAppMessageMutationKind(
      message({ type: "unsupported", unsupported: { type: "revoke" } }),
    ),
    "revoke",
  );
});

test("only message records, not mutations or reactions, are standalone", () => {
  assert.equal(
    isWhatsAppStandaloneMessageEvent(message({ type: "text" })),
    true,
  );
  assert.equal(
    isWhatsAppStandaloneMessageEvent(
      message({ type: "unsupported", unsupported: { type: "future_type" } }),
    ),
    true,
  );
  assert.equal(
    isWhatsAppStandaloneMessageEvent(message({ type: "reaction" })),
    false,
  );
  assert.equal(
    isWhatsAppStandaloneMessageEvent(message({ type: "edit" })),
    false,
  );
  assert.equal(
    isWhatsAppStandaloneMessageEvent(
      message({ type: "unsupported", unsupported: { type: "revoke" } }),
    ),
    false,
  );
});

test("only unstructured stored WhatsApp messages are text-editable", () => {
  assert.equal(isStoredWhatsAppTextMessageEditable({}), true);
  assert.equal(
    isStoredWhatsAppTextMessageEditable({
      whatsappServiceMessage: null,
      whatsappTemplate: null,
      whatsappFlow: null,
    }),
    true,
  );

  for (const kind of [
    "flow",
    "cta_url",
    "contacts",
    "location",
    "reply_buttons",
    "media_carousel",
  ]) {
    assert.equal(
      isStoredWhatsAppTextMessageEditable({
        whatsappServiceMessage: { version: 1, kind },
      }),
      false,
      kind,
    );
  }
  assert.equal(
    isStoredWhatsAppTextMessageEditable({
      whatsappServiceMessage: { version: 999, kind: "future_kind" },
    }),
    false,
  );
  assert.equal(
    isStoredWhatsAppTextMessageEditable({ whatsappServiceMessage: {} }),
    false,
  );

  assert.equal(
    isStoredWhatsAppTextMessageEditable({ whatsappTemplate: {} }),
    false,
  );
  assert.equal(
    isStoredWhatsAppTextMessageEditable({
      whatsappFlow: { flowId: "flow-1" },
    }),
    false,
  );
});
