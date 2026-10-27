import { createHash } from "node:crypto";

import { WHATSAPP_QR_FINAL_MESSAGE_MAX_LENGTH } from "@icecore/scenario-contracts";
import {
  getWhatsAppGraphClient,
  MetaGraphRequestError,
  normalizeMetaGraphPagingNextUrl,
  parseGraphResponse,
  parseMetaGraphAPIError,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import { normalizeWhatsAppQrProviderLink } from "./importLink";

const CHAT_QR_FIELDS = "code,prefilled_message,deep_link_url";
const CHAT_QR_PAGE_SIZE = 100;
const CHAT_QR_MAX_PAGES = 100;
const CHAT_QR_MAX_ITEMS = 10_000;
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const CHAT_QR_CURSOR_VERSION = 1;
const CHAT_QR_CURSOR_MAX_LENGTH = 16_384;
const CHAT_QR_SAFE_URL_MAX_LENGTH = 4_096;
const CHAT_QR_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHAT_QR_SAFE_PAGING_QUERY_KEYS = new Set(["after", "fields", "limit"]);

export type WhatsAppChatQr = {
  code: string;
  prefilledMessage: string;
  deepLink: string;
};

export type WhatsAppChatQrPage = {
  data: WhatsAppChatQr[];
  nextCursor?: string;
};

export type WhatsAppChatQrProviderErrorEvidence = {
  category:
    | "graph_response"
    | "no_response"
    | "invalid_request"
    | "invalid_response"
    | "identity_changed"
    | "duplicate_identity"
    | "not_found"
    | "pagination_bound";
  httpStatus?: number;
  providerCode?: number;
  providerSubcode?: number;
};

export class WhatsAppChatQrProviderError extends Error {
  readonly outcome: "definite" | "ambiguous";
  readonly evidence: WhatsAppChatQrProviderErrorEvidence;

  constructor(
    outcome: "definite" | "ambiguous",
    evidence: WhatsAppChatQrProviderErrorEvidence,
  ) {
    super("WhatsApp Chat QR provider request failed");
    this.name = "WhatsAppChatQrProviderError";
    this.outcome = outcome;
    this.evidence = evidence;
  }
}

type WithClient = {
  client?: WhatsAppGraphClient;
  signal?: AbortSignal;
};

function definite(
  category: WhatsAppChatQrProviderErrorEvidence["category"],
  extra: Omit<WhatsAppChatQrProviderErrorEvidence, "category"> = {},
): WhatsAppChatQrProviderError {
  return new WhatsAppChatQrProviderError("definite", { category, ...extra });
}

function ambiguous(
  category: WhatsAppChatQrProviderErrorEvidence["category"],
  extra: Omit<WhatsAppChatQrProviderErrorEvidence, "category"> = {},
): WhatsAppChatQrProviderError {
  return new WhatsAppChatQrProviderError("ambiguous", { category, ...extra });
}

function graphFailure(
  value: unknown,
  httpStatus?: number,
): WhatsAppChatQrProviderError {
  const graphError = parseMetaGraphAPIError(value);
  return definite("graph_response", {
    ...(Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
    ...(Number.isSafeInteger(graphError?.code)
      ? { providerCode: graphError!.code }
      : {}),
    ...(Number.isSafeInteger(graphError?.error_subcode)
      ? { providerSubcode: graphError!.error_subcode }
      : {}),
  });
}

function classifyThrown(
  error: unknown,
  mutationDispatched: boolean,
): WhatsAppChatQrProviderError {
  if (error instanceof WhatsAppChatQrProviderError) return error;
  if (error instanceof MetaGraphRequestError) {
    if (error.status >= 200 && error.status < 300) {
      return ambiguous("invalid_response", { httpStatus: error.status });
    }
    return graphFailure(error.details, error.status);
  }
  return new WhatsAppChatQrProviderError(
    mutationDispatched ? "ambiguous" : "definite",
    { category: "no_response" },
  );
}

function normalizePhoneNumberId(value: string): string {
  if (
    typeof value !== "string" ||
    !PHONE_NUMBER_ID_PATTERN.test(value) ||
    value.trim() !== value
  ) {
    throw definite("invalid_request");
  }
  return value;
}

function normalizeAccessToken(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw definite("invalid_request");
  }
  return value;
}

function normalizeCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw definite("invalid_request");
  }
  try {
    return normalizeWhatsAppQrProviderLink("https://wa.me/message/" + value)
      .providerCode;
  } catch {
    throw definite("invalid_request");
  }
}

function normalizePrefilledMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > WHATSAPP_QR_FINAL_MESSAGE_MAX_LENGTH
  ) {
    throw definite("invalid_response");
  }
  return value;
}

function assertNoGraphError(value: unknown): void {
  if (parseMetaGraphAPIError(value)) throw graphFailure(value);
}

function normalizeProviderQr(
  value: unknown,
  options: { allowMismatchedIdentity?: boolean } = {},
): WhatsAppChatQr {
  assertNoGraphError(value);
  const record = asNullableRecord(value);
  if (!record) throw definite("invalid_response");
  if (
    typeof record.code !== "string" ||
    record.code.trim() !== record.code ||
    typeof record.deep_link_url !== "string" ||
    record.deep_link_url.trim() !== record.deep_link_url
  ) {
    throw definite("invalid_response");
  }
  let link: ReturnType<typeof normalizeWhatsAppQrProviderLink>;
  try {
    link = normalizeWhatsAppQrProviderLink(record.deep_link_url);
  } catch {
    throw definite("invalid_response");
  }
  if (!options.allowMismatchedIdentity && link.providerCode !== record.code) {
    throw definite("invalid_response");
  }
  return {
    code: record.code,
    prefilledMessage: normalizePrefilledMessage(record.prefilled_message),
    deepLink: link.deepLink,
  };
}

function normalizeProviderPage(
  payload: unknown,
  limit: number,
): {
  data: readonly WhatsAppChatQr[];
  next?: string;
} {
  assertNoGraphError(payload);
  const response = asNullableRecord(payload);
  if (!response || !Array.isArray(response.data)) {
    throw definite("invalid_response");
  }
  if (response.data.length > limit) {
    throw definite("invalid_response");
  }
  const paging = response.paging;
  if (
    paging !== undefined &&
    (asNullableRecord(paging) === null || Array.isArray(paging))
  ) {
    throw definite("invalid_response");
  }
  const next = asNullableRecord(paging)?.next;
  if (
    next !== undefined &&
    (typeof next !== "string" || next.length === 0 || next.trim() !== next)
  ) {
    throw definite("invalid_response");
  }
  const data = response.data.map((item) => normalizeProviderQr(item));
  const seen = new Set<string>();
  for (const qr of data) {
    if (seen.has(qr.code)) throw definite("duplicate_identity");
    seen.add(qr.code);
  }
  return {
    data,
    ...(typeof next === "string" ? { next } : {}),
  };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeProviderSingle(payload: unknown): WhatsAppChatQr {
  assertNoGraphError(payload);
  const response = asNullableRecord(payload);
  if (!response) throw definite("invalid_response");
  if (!hasOwn(response, "data")) return normalizeProviderQr(response);
  if (!Array.isArray(response.data)) throw definite("invalid_response");
  if (response.data.length === 0) throw definite("not_found");
  if (response.data.length !== 1) throw definite("invalid_response");
  return normalizeProviderQr(response.data[0]);
}

function collectionPath(phoneNumberId: string): string {
  return phoneNumberId + "/message_qrdls";
}

type ChatQrCursor = {
  v: typeof CHAT_QR_CURSOR_VERSION;
  nextUrl: string;
  seen: string[];
};

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function normalizePageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > CHAT_QR_PAGE_SIZE) {
    throw definite("invalid_request");
  }
  return value;
}

function pagingFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function normalizeChatQrPagingUrl(
  value: string,
  phoneNumberId: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CHAT_QR_SAFE_URL_MAX_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }
  const safeUrl = normalizeMetaGraphPagingNextUrl(value);
  const url = new URL(safeUrl);
  const expectedPath = new RegExp(
    `^/v[0-9]+\\.[0-9]+/${phoneNumberId}/message_qrdls$`,
  );
  if (!expectedPath.test(url.pathname)) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }
  const queryKeys = Array.from(url.searchParams.keys());
  if (queryKeys.some((key) => !CHAT_QR_SAFE_PAGING_QUERY_KEYS.has(key))) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }
  const after = url.searchParams.getAll("after");
  const fields = url.searchParams.getAll("fields");
  const limits = url.searchParams.getAll("limit");
  if (
    after.length !== 1 ||
    after[0]!.length === 0 ||
    fields.length > 1 ||
    (fields.length === 1 && fields[0] !== CHAT_QR_FIELDS) ||
    limits.length > 1 ||
    (limits.length === 1 &&
      (!/^[0-9]+$/.test(limits[0]!) ||
        Number(limits[0]) < 1 ||
        Number(limits[0]) > CHAT_QR_PAGE_SIZE))
  ) {
    throw new Error("Rejected unsafe Meta Graph paging URL");
  }
  return safeUrl;
}

function decodePageCursor(value: string, phoneNumberId: string): ChatQrCursor {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > CHAT_QR_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw definite("invalid_request");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw definite("invalid_request");
    }
    const decoded = asNullableRecord(JSON.parse(bytes.toString("utf8")));
    if (
      !decoded ||
      !exactKeys(decoded, ["v", "nextUrl", "seen"]) ||
      decoded.v !== CHAT_QR_CURSOR_VERSION ||
      typeof decoded.nextUrl !== "string" ||
      !Array.isArray(decoded.seen)
    ) {
      throw definite("invalid_request");
    }
    if (decoded.seen.length >= CHAT_QR_MAX_PAGES) {
      throw definite("pagination_bound");
    }
    const safeUrl = normalizeChatQrPagingUrl(decoded.nextUrl, phoneNumberId);
    if (safeUrl !== decoded.nextUrl) throw definite("invalid_request");
    const seen = decoded.seen;
    if (
      seen.length === 0 ||
      seen.some(
        (item) =>
          typeof item !== "string" || !CHAT_QR_FINGERPRINT_PATTERN.test(item),
      ) ||
      new Set(seen).size !== seen.length ||
      seen.at(-1) !== pagingFingerprint(safeUrl)
    ) {
      throw definite("invalid_request");
    }
    return { v: CHAT_QR_CURSOR_VERSION, nextUrl: safeUrl, seen: [...seen] };
  } catch (error) {
    if (error instanceof WhatsAppChatQrProviderError) throw error;
    throw definite("invalid_request");
  }
}

function encodePageCursor(params: {
  rawNext: string;
  phoneNumberId: string;
  seen: readonly string[];
}): string {
  let safeUrl: string;
  try {
    safeUrl = normalizeChatQrPagingUrl(params.rawNext, params.phoneNumberId);
  } catch {
    throw definite("invalid_response");
  }
  const fingerprint = pagingFingerprint(safeUrl);
  if (params.seen.includes(fingerprint)) {
    throw definite("pagination_bound");
  }
  const seen = [...params.seen, fingerprint];
  if (seen.length >= CHAT_QR_MAX_PAGES) {
    throw definite("pagination_bound");
  }
  const cursor: ChatQrCursor = {
    v: CHAT_QR_CURSOR_VERSION,
    nextUrl: safeUrl,
    seen,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function createWhatsAppChatQr(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    prefilledMessage: string;
  },
): Promise<WhatsAppChatQr> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const prefilledMessage = normalizePrefilledMessage(params.prefilledMessage);
  const client = params.client ?? getWhatsAppGraphClient();
  let dispatched = false;
  try {
    dispatched = true;
    const response = await client.postJson<unknown>(
      collectionPath(phoneNumberId),
      {
        token: accessToken,
        body: { prefilled_message: prefilledMessage },
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    const qr = normalizeProviderQr(response);
    if (qr.prefilledMessage !== prefilledMessage) {
      throw definite("invalid_response");
    }
    return qr;
  } catch (error) {
    throw classifyThrown(error, dispatched);
  }
}

export async function listWhatsAppChatQrPage(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    limit: number;
    cursor?: string;
  },
): Promise<WhatsAppChatQrPage> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const limit = normalizePageLimit(params.limit);
  const client = params.client ?? getWhatsAppGraphClient();
  const cursor = params.cursor
    ? decodePageCursor(params.cursor, phoneNumberId)
    : undefined;
  try {
    const payload = await client.getJson<unknown>(
      cursor?.nextUrl ?? collectionPath(phoneNumberId),
      {
        token: accessToken,
        query: {
          fields: CHAT_QR_FIELDS,
          limit,
        },
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    const page = normalizeProviderPage(payload, limit);
    return {
      data: [...page.data],
      ...(page.next
        ? {
            nextCursor: encodePageCursor({
              rawNext: page.next,
              phoneNumberId,
              seen: cursor?.seen ?? [],
            }),
          }
        : {}),
    };
  } catch (error) {
    throw classifyThrown(error, false);
  }
}

export async function listWhatsAppChatQrs(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
  },
): Promise<WhatsAppChatQr[]> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const client = params.client ?? getWhatsAppGraphClient();
  const qrs: WhatsAppChatQr[] = [];
  const seenCodes = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  try {
    do {
      const page = await listWhatsAppChatQrPage({
        phoneNumberId,
        accessToken,
        limit: CHAT_QR_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        client,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      pageCount += 1;
      for (const qr of page.data) {
        if (seenCodes.has(qr.code)) throw definite("duplicate_identity");
        seenCodes.add(qr.code);
        qrs.push(qr);
      }
      if (qrs.length > CHAT_QR_MAX_ITEMS) {
        throw definite("pagination_bound");
      }
      cursor = page.nextCursor;
      if (cursor && pageCount >= CHAT_QR_MAX_PAGES) {
        throw definite("pagination_bound");
      }
    } while (cursor);
    return qrs;
  } catch (error) {
    throw classifyThrown(error, false);
  }
}

export async function getWhatsAppChatQr(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    code: string;
  },
): Promise<WhatsAppChatQr> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const code = normalizeCode(params.code);
  const client = params.client ?? getWhatsAppGraphClient();
  try {
    const response = await client.getJson<unknown>(
      collectionPath(phoneNumberId) + "/" + encodeURIComponent(code),
      {
        token: accessToken,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    const qr = normalizeProviderSingle(response);
    if (qr.code !== code) throw definite("identity_changed");
    return qr;
  } catch (error) {
    const classified = classifyThrown(error, false);
    if (
      classified.evidence.category === "graph_response" &&
      classified.evidence.httpStatus === 404
    ) {
      throw definite("not_found", { httpStatus: 404 });
    }
    throw classified;
  }
}

export async function updateWhatsAppChatQrMessage(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    current: WhatsAppChatQr;
    prefilledMessage: string;
  },
): Promise<WhatsAppChatQr> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const currentCode = normalizeCode(params.current.code);
  let currentLink: string;
  try {
    const link = normalizeWhatsAppQrProviderLink(params.current.deepLink);
    if (link.providerCode !== currentCode) throw new Error();
    currentLink = link.deepLink;
  } catch {
    throw definite("invalid_request");
  }
  const prefilledMessage = normalizePrefilledMessage(params.prefilledMessage);
  const client = params.client ?? getWhatsAppGraphClient();
  let dispatched = false;
  try {
    dispatched = true;
    const response = await client.postJson<unknown>(
      collectionPath(phoneNumberId),
      {
        token: accessToken,
        body: {
          code: currentCode,
          prefilled_message: prefilledMessage,
        },
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    const qr = normalizeProviderQr(response, {
      allowMismatchedIdentity: true,
    });
    if (qr.code !== currentCode || qr.deepLink !== currentLink) {
      throw definite("identity_changed");
    }
    if (qr.prefilledMessage !== prefilledMessage) {
      throw definite("invalid_response");
    }
    return qr;
  } catch (error) {
    throw classifyThrown(error, dispatched);
  }
}

export async function deleteWhatsAppChatQr(
  params: WithClient & {
    phoneNumberId: string;
    accessToken: string;
    code: string;
  },
): Promise<void> {
  const phoneNumberId = normalizePhoneNumberId(params.phoneNumberId);
  const accessToken = normalizeAccessToken(params.accessToken);
  const code = normalizeCode(params.code);
  const client = params.client ?? getWhatsAppGraphClient();
  let dispatched = false;
  try {
    dispatched = true;
    const response = await client.request(
      collectionPath(phoneNumberId) + "/" + encodeURIComponent(code),
      {
        method: "DELETE",
        token: accessToken,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    let payload: unknown;
    try {
      payload = await parseGraphResponse<unknown>(response);
    } catch {
      throw response.ok
        ? ambiguous("invalid_response", { httpStatus: response.status })
        : definite("invalid_response", { httpStatus: response.status });
    }
    if (!response.ok || parseMetaGraphAPIError(payload)) {
      throw graphFailure(payload, response.status);
    }
    const acknowledgement = asNullableRecord(payload);
    if (
      !acknowledgement ||
      Object.keys(acknowledgement).length !== 1 ||
      acknowledgement.success !== true
    ) {
      throw definite("invalid_response");
    }
  } catch (error) {
    throw classifyThrown(error, dispatched);
  }
}
