import assert from "node:assert/strict";
import test from "node:test";
import { buildWhatsAppWebhookEventEnvelopes } from "./whatsapp-webhook-event-envelopes";
import * as history from "./whatsapp-history-import";

const binding = {
  sessionId: "new-session",
  sessionStartedAt: "2026-10-10T00:00:00Z",
  rangeDays: 180,
  sourceId: "source-1",
  workspaceId: "workspace-1",
  phoneNumberId: "phone-1",
  wabaId: "waba-1",
};
function chunk() {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "history",
            value: {
              metadata: { phone_number_id: "phone-1" },
              history: [
                {
                  metadata: { progress: 100, phase: 2, chunk_order: 1 },
                  threads: [
                    {
                      id: "15550000001",
                      context: { wa_id: "15550000001" },
                      messages: [
                        {
                          id: "wamid.one",
                          from: "15550000001",
                          timestamp: "1791590400",
                          type: "text",
                          text: { body: "one" },
                        },
                        {
                          id: "wamid.two",
                          from: "15550000001",
                          timestamp: "1791590401",
                          type: "media_placeholder",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
  return buildWhatsAppWebhookEventEnvelopes({
    body,
    rawBody: JSON.stringify(body),
  })[0]!;
}

test("binds a new generation without reusing an older onboarding receipt", () => {
  const first = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const second = history.attachWhatsAppHistoryImportBinding(chunk(), {
    ...binding,
    sessionId: "next-session",
  });
  assert.notEqual(first.dedupeKey, second.dedupeKey);
  assert.equal(first.historyImport?.role, "chunk");
  assert.equal(first.workspaceId, binding.workspaceId);
});

test("message receipt identity uses the shared canonical JSON ordering", () => {
  const parent = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const message = (parent.payload.body as any).entry[0].changes[0].value
    .history[0].threads[0].messages[0];
  message.text = { body: "one", preview_url: true };
  const first = history.buildWhatsAppHistoryMessageEnvelopes(parent);
  message.text = { preview_url: true, body: "one" };
  const reordered = history.buildWhatsAppHistoryMessageEnvelopes(parent);
  assert.deepEqual(
    first.map((child) => child.dedupeKey),
    reordered.map((child) => child.dedupeKey),
  );
});

test("splits a chunk into minimal deterministic background message receipts", () => {
  const parent = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const children = history.buildWhatsAppHistoryMessageEnvelopes(parent);
  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map((c) => c.dedupeKey),
    history
      .buildWhatsAppHistoryMessageEnvelopes(parent)
      .map((c) => c.dedupeKey),
  );
  assert.ok(
    children.every(
      (c) =>
        c.itemKind === "history_message" && c.historyImport?.role === "message",
    ),
  );
  assert.doesNotMatch(children[0]!.payload.rawBody, /wamid.two/);
  assert.match(children[0]!.payload.rawBody, /15550000001/);
  assert.equal(children[0]!.historyMetadata, null);
});

test("history children retain only their own contact context", () => {
  const parent = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const value = (parent.payload.body as any).entry[0].changes[0].value;
  value.metadata.display_phone_number = "15550000999";
  value.contacts = [
    { wa_id: "15550000077", profile: { name: "Unrelated global" } },
    { wa_id: "15550000002", profile: { name: "Flat customer" } },
    { user_id: "US.echo", profile: { name: "Echo customer" } },
  ];
  value.history[0].contacts = [
    { wa_id: "15550000088", profile: { name: "Unrelated entry" } },
    { wa_id: "15550000003", profile: { name: "Entry customer" } },
  ];
  value.history[0].messages = [
    {
      id: "wamid.entry",
      from: "15550000003",
      type: "text",
      text: { body: "entry" },
    },
  ];
  value.messages = [
    {
      id: "wamid.flat",
      from: "15550000002",
      type: "text",
      text: { body: "flat" },
    },
  ];
  value.message_echoes = [
    {
      id: "wamid.echo",
      from: "15550000999",
      to_user_id: "US.echo",
      type: "text",
      text: { body: "echo" },
    },
  ];
  const children = history.buildWhatsAppHistoryMessageEnvelopes(parent);
  const childValue = (id: string) =>
    (
      children.find(
        (child) => child.historyImport?.providerMessageId === `ws_${id}`,
      )!.payload.body as any
    ).entry[0].changes[0].value;
  assert.equal(childValue("wamid.one").contacts, undefined);
  assert.deepEqual(childValue("wamid.one").history[0].threads[0].context, {
    wa_id: "15550000001",
  });
  assert.equal(childValue("wamid.entry").contacts, undefined);
  assert.equal(childValue("wamid.entry").history[0].contacts.length, 1);
  assert.equal(
    childValue("wamid.entry").history[0].contacts[0].wa_id,
    "15550000003",
  );
  assert.equal(childValue("wamid.flat").contacts.length, 1);
  assert.equal(
    childValue("wamid.flat").contacts[0].profile.name,
    "Flat customer",
  );
  assert.equal(childValue("wamid.echo").contacts.length, 1);
  assert.equal(childValue("wamid.echo").contacts[0].user_id, "US.echo");
  assert.doesNotMatch(
    children.map((child) => child.payload.rawBody).join(""),
    /Unrelated/,
  );
});

test("preserves a mixed provider history payload as one expansion manifest", () => {
  const original = chunk();
  const body = structuredClone(original.payload.body) as any;
  body.entry[0].changes[0].value.messages = [
    { id: "wamid.flat", type: "text" },
  ];
  body.entry[0].changes[0].value.message_echoes = [
    { id: "wamid.echo", type: "text" },
  ];
  const parents = buildWhatsAppWebhookEventEnvelopes({
    body,
    rawBody: JSON.stringify(body),
  });
  assert.equal(parents.length, 1);
  assert.equal(
    history.buildWhatsAppHistoryMessageEnvelopes(
      history.attachWhatsAppHistoryImportBinding(parents[0]!, binding),
    ).length,
    4,
  );
});

test("a placeholder cannot reserve a message id against later available media", () => {
  const parent = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const placeholders = history.buildWhatsAppHistoryMessageEnvelopes(parent);
  assert.equal(placeholders.length, 2);
  const body = structuredClone(parent.payload.body) as any;
  body.entry[0].changes[0].value.history[0].threads[0].messages = [
    {
      id: "wamid.two",
      from: "15550000001",
      type: "image",
      image: { id: "media-1" },
    },
  ];
  const available = history.attachWhatsAppHistoryImportBinding(
    buildWhatsAppWebhookEventEnvelopes({
      body,
      rawBody: JSON.stringify(body),
    })[0]!,
    binding,
  );
  assert.equal(
    history.buildWhatsAppHistoryMessageEnvelopes(available).length,
    1,
  );
});

test("deduplicates cross-chunk content while retaining richer and mutation revisions", () => {
  const parent = history.attachWhatsAppHistoryImportBinding(chunk(), binding);
  const first = history.buildWhatsAppHistoryMessageEnvelopes(parent)[0]!;
  const next = structuredClone(parent);
  const value = (next.payload.body as any).entry[0].changes[0].value;
  value.history[0].metadata.chunk_order = 99;
  assert.equal(
    history.buildWhatsAppHistoryMessageEnvelopes(next)[0]!.dedupeKey,
    first.dedupeKey,
  );
  value.history[0].threads[0].messages[0] = {
    id: "wamid.one",
    from: "15550000001",
    type: "unsupported",
    errors: [{ code: 131060 }],
  };
  assert.notEqual(
    history.buildWhatsAppHistoryMessageEnvelopes(next)[0]!.dedupeKey,
    first.dedupeKey,
  );
});

test("retains the highest provider progress when a webhook contains out-of-order entries", () => {
  const body = structuredClone(chunk().payload.body) as any;
  body.entry[0].changes[0].value.history = [
    { metadata: { phase: 1, progress: 15, chunk_order: 2 } },
    { metadata: { phase: 2, progress: 100, chunk_order: 7 } },
    { metadata: { phase: 0, progress: 5, chunk_order: 1 } },
  ];
  const parent = buildWhatsAppWebhookEventEnvelopes({
    body,
    rawBody: JSON.stringify(body),
  })[0]!;
  assert.equal(parent.historyMetadata?.progress, 100);
});
