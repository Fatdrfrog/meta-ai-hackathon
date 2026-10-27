import {
  asWhatsAppRecord,
  compactWhatsAppString,
} from "@icecore/shared/lib/whatsapp/value-utils";
import { readArray } from "@icecore/shared/lib/value-utils";

import { resolveWhatsAppReferralSourcePlatform } from "./referralFields";

const MAX_UNIQUE_LOG_VALUES = 12;
const WHATSAPP_API_UNAVAILABLE_UNSUPPORTED_CODE = "131060";

type JsonRecord = Record<string, unknown>;
type CounterMap = Record<string, number>;

export type WhatsAppWebhookLogSummary = {
  payloadObject: string | null;
  directEventName: string | null;
  rawBodyBytes: number;
  entryCount: number;
  changeCount: number;
  fieldCounts: CounterMap;
  valueKeys: string[];
  messageCount: number;
  messageEchoCount: number;
  smbMessageEchoCount: number;
  historyCount: number;
  historyThreadCount: number;
  historyMessageCount: number;
  statusCount: number;
  callCount: number;
  contactCount: number;
  messageTypeCounts: CounterMap;
  statusCounts: CounterMap;
  errorCount: number;
  errorCodes: string[];
  unsupportedMessageCount: number;
  unsupportedTypes: string[];
  unsupportedErrorCodes: string[];
  apiUnavailableUnsupportedCount: number;
  referralCount: number;
  referralSourceTypes: string[];
  referralSourcePlatforms: string[];
  referralWithCtwaClidCount: number;
  referralWithWelcomeMessageCount: number;
  referralOnUnsupportedCount: number;
  referralMissingOnUnsupportedCount: number;
};

function asObjectArray(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asWhatsAppRecord(item))
      .filter((item) => Object.keys(item).length > 0);
  }

  const record = asWhatsAppRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function normalizeLogToken(value: unknown, fallback = "unknown"): string {
  const raw =
    typeof value === "number" || typeof value === "string"
      ? String(value).trim()
      : "";
  if (!raw) return fallback;

  const normalized = raw.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "_");
  return normalized || fallback;
}

function addUnique(target: string[], value: unknown): void {
  const normalized = normalizeLogToken(value, "");
  if (!normalized || target.includes(normalized)) return;
  if (target.length >= MAX_UNIQUE_LOG_VALUES) return;
  target.push(normalized);
}

function incrementCounter(counter: CounterMap, keyValue: unknown): void {
  const key = normalizeLogToken(keyValue);
  counter[key] = (counter[key] || 0) + 1;
}

function readRawBodyBytes(rawBody: string): number {
  try {
    return new TextEncoder().encode(rawBody).length;
  } catch {
    return rawBody.length;
  }
}

function normalizeBodyForSummary(body: unknown): {
  body: JsonRecord;
  directEventName: string | null;
} {
  const record = asWhatsAppRecord(body);
  const directEventName = compactWhatsAppString(record.event);
  const directEventData = asWhatsAppRecord(record.data);

  if (directEventName && Object.keys(directEventData).length > 0) {
    return {
      directEventName: normalizeLogToken(directEventName),
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: directEventName,
                value: directEventData,
              },
            ],
          },
        ],
      },
    };
  }

  return { body: record, directEventName: null };
}

function getMessageReferral(message: JsonRecord): JsonRecord | null {
  const referral = asWhatsAppRecord(message.referral);
  return Object.keys(referral).length > 0 ? referral : null;
}

function recordErrorCodes(
  summary: WhatsAppWebhookLogSummary,
  errors: unknown[],
  unsupportedMessage = false,
): string[] {
  const codes: string[] = [];
  for (const error of errors) {
    const errorRecord = asWhatsAppRecord(error);
    const code = normalizeLogToken(errorRecord.code, "");
    summary.errorCount += 1;
    if (!code) continue;
    codes.push(code);
    addUnique(summary.errorCodes, code);
    if (unsupportedMessage) {
      addUnique(summary.unsupportedErrorCodes, code);
    }
  }
  return codes;
}

function recordReferral(
  summary: WhatsAppWebhookLogSummary,
  referral: JsonRecord,
  unsupportedMessage: boolean,
): void {
  summary.referralCount += 1;

  addUnique(summary.referralSourceTypes, referral.source_type);

  const sourceUrl = compactWhatsAppString(referral.source_url);
  const sourcePlatform = sourceUrl
    ? resolveWhatsAppReferralSourcePlatform(sourceUrl) || "other"
    : "";
  addUnique(summary.referralSourcePlatforms, sourcePlatform);

  if (compactWhatsAppString(referral.ctwa_clid)) {
    summary.referralWithCtwaClidCount += 1;
  }

  const welcomeMessage = asWhatsAppRecord(referral.welcome_message);
  if (compactWhatsAppString(welcomeMessage.text)) {
    summary.referralWithWelcomeMessageCount += 1;
  }

  if (unsupportedMessage) {
    summary.referralOnUnsupportedCount += 1;
  }
}

function recordMessage(
  summary: WhatsAppWebhookLogSummary,
  message: JsonRecord,
): void {
  const messageType = compactWhatsAppString(message.type) || "unknown";
  incrementCounter(summary.messageTypeCounts, messageType);

  const unsupportedMessage = messageType === "unsupported";
  const errorCodes = recordErrorCodes(
    summary,
    readArray(message.errors),
    unsupportedMessage,
  );

  if (unsupportedMessage) {
    summary.unsupportedMessageCount += 1;

    const unsupported = asWhatsAppRecord(message.unsupported);
    addUnique(summary.unsupportedTypes, unsupported.type);

    if (errorCodes.includes(WHATSAPP_API_UNAVAILABLE_UNSUPPORTED_CODE)) {
      summary.apiUnavailableUnsupportedCount += 1;
    }
  }

  const referral = getMessageReferral(message);
  if (referral) {
    recordReferral(summary, referral, unsupportedMessage);
  } else if (unsupportedMessage) {
    summary.referralMissingOnUnsupportedCount += 1;
  }
}

function recordMessages(
  summary: WhatsAppWebhookLogSummary,
  messages: unknown[],
): void {
  for (const message of messages) {
    recordMessage(summary, asWhatsAppRecord(message));
  }
}

function recordStatuses(
  summary: WhatsAppWebhookLogSummary,
  statuses: unknown[],
): void {
  summary.statusCount += statuses.length;
  for (const status of statuses) {
    const statusRecord = asWhatsAppRecord(status);
    incrementCounter(summary.statusCounts, statusRecord.status);
    recordErrorCodes(summary, readArray(statusRecord.errors));
  }
}

function recordHistory(
  summary: WhatsAppWebhookLogSummary,
  historyItems: JsonRecord[],
): void {
  summary.historyCount += historyItems.length;

  for (const historyItem of historyItems) {
    recordErrorCodes(summary, readArray(historyItem.errors));
    const directMessages = readArray(historyItem.messages);
    summary.historyMessageCount += directMessages.length;
    recordMessages(summary, directMessages);

    const threads = asObjectArray(historyItem.threads);
    summary.historyThreadCount += threads.length;
    for (const thread of threads) {
      const threadMessages = readArray(thread.messages);
      summary.historyMessageCount += threadMessages.length;
      recordMessages(summary, threadMessages);
    }

    summary.contactCount += readArray(historyItem.contacts).length;
  }
}

function createEmptySummary(params: {
  body: JsonRecord;
  directEventName: string | null;
  rawBody: string;
}): WhatsAppWebhookLogSummary {
  return {
    payloadObject: compactWhatsAppString(params.body.object),
    directEventName: params.directEventName,
    rawBodyBytes: readRawBodyBytes(params.rawBody),
    entryCount: 0,
    changeCount: 0,
    fieldCounts: {},
    valueKeys: [],
    messageCount: 0,
    messageEchoCount: 0,
    smbMessageEchoCount: 0,
    historyCount: 0,
    historyThreadCount: 0,
    historyMessageCount: 0,
    statusCount: 0,
    callCount: 0,
    contactCount: 0,
    messageTypeCounts: {},
    statusCounts: {},
    errorCount: 0,
    errorCodes: [],
    unsupportedMessageCount: 0,
    unsupportedTypes: [],
    unsupportedErrorCodes: [],
    apiUnavailableUnsupportedCount: 0,
    referralCount: 0,
    referralSourceTypes: [],
    referralSourcePlatforms: [],
    referralWithCtwaClidCount: 0,
    referralWithWelcomeMessageCount: 0,
    referralOnUnsupportedCount: 0,
    referralMissingOnUnsupportedCount: 0,
  };
}

export function buildWhatsAppWebhookLogSummary(params: {
  body: unknown;
  rawBody: string;
}): WhatsAppWebhookLogSummary {
  const normalized = normalizeBodyForSummary(params.body);
  const summary = createEmptySummary({
    body: normalized.body,
    directEventName: normalized.directEventName,
    rawBody: params.rawBody,
  });

  const entries = asObjectArray(normalized.body.entry);
  summary.entryCount = entries.length;

  for (const entry of entries) {
    for (const change of asObjectArray(entry.changes)) {
      summary.changeCount += 1;
      incrementCounter(summary.fieldCounts, change.field);

      const value = asWhatsAppRecord(change.value);
      for (const key of Object.keys(value)) {
        addUnique(summary.valueKeys, key);
      }

      const messages = readArray(value.messages);
      const messageEchoes = readArray(value.message_echoes);
      const smbMessageEchoes = readArray(value.smb_message_echoes);
      const statuses = readArray(value.statuses);
      const calls = readArray(value.calls);

      summary.messageCount += messages.length;
      summary.messageEchoCount += messageEchoes.length;
      summary.smbMessageEchoCount += smbMessageEchoes.length;
      summary.callCount += calls.length;
      summary.contactCount += readArray(value.contacts).length;

      recordMessages(summary, messages);
      recordMessages(summary, messageEchoes);
      recordMessages(summary, smbMessageEchoes);
      recordStatuses(summary, statuses);
      recordErrorCodes(summary, readArray(value.errors));
      recordHistory(summary, asObjectArray(value.history));
    }
  }

  summary.valueKeys.sort();
  summary.errorCodes.sort();
  summary.unsupportedErrorCodes.sort();
  summary.unsupportedTypes.sort();
  summary.referralSourceTypes.sort();
  summary.referralSourcePlatforms.sort();

  return summary;
}
