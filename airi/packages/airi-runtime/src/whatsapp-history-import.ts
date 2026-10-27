import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import { asWhatsAppRecord as asRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  resolveWhatsAppMessageContext,
  resolveWhatsAppOutboundRecipientContact,
} from "@icecore/shared/lib/whatsapp/webhook-direction";
import {
  buildWhatsAppWebhookEventEnvelopes,
  type WhatsAppWebhookEventEnvelope,
} from "./whatsapp-webhook-event-envelopes";

export type WhatsAppHistoryImportBinding = {
  capacityPolicyVersion?: 1;
  sessionId: string;
  sessionStartedAt: string;
  rangeDays: number;
  sourceId: string;
  workspaceId: string;
  phoneNumberId: string;
  wabaId?: string | null;
};

export type WhatsAppHistoryImportReceipt = WhatsAppHistoryImportBinding & {
  role: "chunk" | "message";
  parentDedupeKey?: string;
  providerMessageId?: string;
  expectedChildren?: number;
  expandedAt?: string;
  outcome?: "synchronized" | "skipped" | "superseded" | "provider_error";
  skipReason?: string;
  providerErrors?: Array<{
    code?: number | string;
    message?: string;
    title?: string;
    error_data?: { details?: string };
  }>;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return serializeCanonicalJson(JSON.parse(JSON.stringify(value ?? null)));
}

function contactPartition(
  message: Record<string, unknown>,
  value: Record<string, unknown>,
): string {
  const historyEntry = records(value.history)[0];
  const thread = records(historyEntry?.threads)[0];
  const context = asRecord(thread?.context);
  return String(
    thread?.id ||
      context.user_id ||
      context.wa_id ||
      message.to_user_id ||
      message.to ||
      message.from_user_id ||
      message.from ||
      message.id ||
      "unknown",
  );
}

export function attachWhatsAppHistoryImportBinding(
  envelope: WhatsAppWebhookEventEnvelope,
  binding: WhatsAppHistoryImportBinding,
): WhatsAppWebhookEventEnvelope {
  if (envelope.field !== "history")
    throw new Error("Only history receipts can bind an import session");
  return {
    ...envelope,
    workspaceId: binding.workspaceId,
    sourceId: binding.sourceId,
    dedupeKey: `${envelope.dedupeKey}:session:${binding.sessionId}`,
    historyImport: { ...binding, role: "chunk" },
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : value ? [value] : []).map(asRecord);
}

/** One provider chunk remains the durable expansion manifest. Children contain
 * only their own message and contact context, never a copy of sibling messages. */
export function buildWhatsAppHistoryMessageEnvelopes(
  parent: WhatsAppWebhookEventEnvelope,
): WhatsAppWebhookEventEnvelope[] {
  const binding = parent.historyImport;
  if (!binding || binding.role !== "chunk")
    throw new Error("History chunk binding is required");
  const childBinding: WhatsAppHistoryImportBinding = {
    capacityPolicyVersion: binding.capacityPolicyVersion,
    sessionId: binding.sessionId,
    sessionStartedAt: binding.sessionStartedAt,
    rangeDays: binding.rangeDays,
    sourceId: binding.sourceId,
    workspaceId: binding.workspaceId,
    phoneNumberId: binding.phoneNumberId,
    wabaId: binding.wabaId,
  };
  const entry = records(parent.payload.body.entry)[0] || {};
  const change = records(entry.changes)[0] || {};
  const value = asRecord(change.value);
  const {
    history: _history,
    messages: _messages,
    message_echoes: _echoes,
    smb_message_echoes: _smbEchoes,
    errors: _errors,
    contacts: _contacts,
    ...baseValue
  } = value;
  const displayPhoneNumber = asRecord(value.metadata).display_phone_number;
  const messageContacts = (
    message: Record<string, unknown>,
    contacts: unknown,
    outbound = false,
  ) => {
    const params = {
      messageData: message,
      contacts: records(contacts),
      displayPhoneNumber:
        typeof displayPhoneNumber === "string" ? displayPhoneNumber : undefined,
    };
    const contact = outbound
      ? resolveWhatsAppOutboundRecipientContact(params)
      : resolveWhatsAppMessageContext(params).contactData;
    return contact
      ? [
          {
            wa_id: contact.waId,
            user_id: contact.userId,
            parent_user_id: contact.parentUserId,
            profile: contact.profile,
          },
        ]
      : [];
  };
  const children = new Map<string, WhatsAppWebhookEventEnvelope>();
  const add = (
    message: Record<string, unknown>,
    messageValue: Record<string, unknown>,
  ) => {
    const id =
      typeof message.id === "string"
        ? normalizeWhatsAppMessageId(message.id)
        : "";
    // Missing IDs remain inspectable/retryable, and cannot collide with valid IDs.
    const providerMessageId = id || `missing:${hash(JSON.stringify(message))}`;
    const body = {
      object: parent.object,
      entry: [
        {
          ...entry,
          changes: [
            { field: "history", value: { ...baseValue, ...messageValue } },
          ],
        },
      ],
    };
    const child = buildWhatsAppWebhookEventEnvelopes({
      body,
      rawBody: JSON.stringify(body),
      receivedAt: parent.receivedAt,
    })[0]!;
    const contentRevision = hash(
      stableJson({
        type: message.type,
        content: message[String(message.type)],
        errors: message.errors,
        context: message.context,
        referral: message.referral,
      }),
    );
    child.dedupeKey = `whatsapp:history:${binding.sourceId}:${binding.sessionId}:message:${providerMessageId}:${contentRevision}`;
    child.itemKind = "history_message";
    child.orderingKey = `${binding.phoneNumberId}:history_message:${hash(contactPartition(message, messageValue)).slice(0, 24)}`;
    child.workspaceId = binding.workspaceId;
    child.sourceId = binding.sourceId;
    child.historyMetadata = null;
    child.payload.originalRawBodyHash = parent.payload.originalRawBodyHash;
    child.historyImport = {
      ...childBinding,
      role: "message",
      parentDedupeKey: parent.dedupeKey,
      providerMessageId,
    };
    children.set(child.dedupeKey, child);
  };
  for (const historyEntry of records(value.history)) {
    for (const thread of records(historyEntry.threads)) {
      for (const message of records(thread.messages)) {
        add(message, {
          history: [{ threads: [{ ...thread, messages: [message] }] }],
        });
      }
    }
    for (const message of records(historyEntry.messages)) {
      add(message, {
        history: [
          {
            messages: [message],
            contacts: messageContacts(
              message,
              historyEntry.contacts || value.contacts,
            ),
          },
        ],
      });
    }
  }
  for (const message of records(value.messages))
    add(message, {
      messages: [message],
      contacts: messageContacts(message, value.contacts),
    });
  for (const key of ["message_echoes", "smb_message_echoes"] as const) {
    for (const message of records(value[key]))
      add(message, {
        [key]: [message],
        contacts: messageContacts(message, value.contacts, true),
      });
  }
  return [...children.values()];
}

export function getWhatsAppHistoryProviderErrors(
  body: unknown,
): NonNullable<WhatsAppHistoryImportReceipt["providerErrors"]> {
  const entry = records(asRecord(body).entry)[0];
  const change = records(entry?.changes)[0];
  return records(asRecord(change?.value).history).flatMap((item) =>
    records(item.errors),
  );
}
