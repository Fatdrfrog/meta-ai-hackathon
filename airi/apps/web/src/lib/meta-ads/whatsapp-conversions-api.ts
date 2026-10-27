import "server-only";

import {
  BoundedJsonResponseError,
  fetchJsonWithinLimits,
} from "@/lib/http/bounded-json-response";
import { buildGraphApiUrl } from "@icecore/shared/lib/meta/graph-version";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { MetaConversionSnapshot } from "@icecore/shared/types/conversion-events";

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;
const GRAPH_ID_PATTERN = /^[0-9]{1,32}$/;
const SHORT_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class WhatsAppConversionsApiError extends Error {
  readonly name = "WhatsAppConversionsApiError";

  constructor(readonly code: string) {
    super(code);
  }
}

export type WhatsAppConversionSendResult =
  | { status: "sent"; traceId?: string }
  | { status: "rejected"; code: string }
  | { status: "delivery_unknown"; code: string };

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function validAccessToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/\s/.test(value)
  );
}

/** `now` is Unix seconds; callers validate again immediately before claiming delivery. */
export function validateMetaConversionSnapshot(
  snapshot: MetaConversionSnapshot,
  now = Math.floor(Date.now() / 1000)
): string | null {
  if (!isRecord(snapshot)) return "invalid_snapshot";
  if (!matches(snapshot.sourceId, SHORT_IDENTIFIER_PATTERN))
    return "invalid_source_id";
  if (!matches(snapshot.datasetId, GRAPH_ID_PATTERN))
    return "invalid_dataset_id";
  if (!matches(snapshot.wabaId, GRAPH_ID_PATTERN)) return "invalid_waba_id";
  if (
    typeof snapshot.ctwaClid !== "string" ||
    snapshot.ctwaClid.length === 0 ||
    snapshot.ctwaClid.length > 4096 ||
    /[\s\x00-\x1f\x7f]/.test(snapshot.ctwaClid)
  )
    return "invalid_ctwa_clid";
  if (
    snapshot.eventName !== "Purchase" &&
    snapshot.eventName !== "OrderReturned"
  )
    return "invalid_event_name";
  if (
    !Number.isSafeInteger(snapshot.eventTime) ||
    snapshot.eventTime <= 0 ||
    !Number.isSafeInteger(now)
  )
    return "invalid_event_time";
  if (snapshot.eventTime > now) return "event_in_future";
  if (now - snapshot.eventTime > MAX_EVENT_AGE_SECONDS) return "event_too_old";
  if (
    typeof snapshot.value !== "number" ||
    !Number.isFinite(snapshot.value) ||
    snapshot.value <= 0 ||
    snapshot.value > 99_999_999.99 ||
    Math.round(snapshot.value * 100) / 100 !== snapshot.value
  )
    return "invalid_value";
  if (!matches(snapshot.currency, /^[A-Z]{3}$/)) return "invalid_currency";
  if (
    snapshot.testEventCode !== undefined &&
    !matches(snapshot.testEventCode, TRACE_ID_PATTERN)
  )
    return "invalid_test_event_code";
  return null;
}

function graphRejectionCode(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const { code, error_subcode: subcode, message, type } = payload.error;
  if (
    typeof code !== "number" ||
    !Number.isSafeInteger(code) ||
    code < 0 ||
    typeof message !== "string" ||
    typeof type !== "string" ||
    !type
  )
    return null;
  return `meta_graph_${code}${typeof subcode === "number" && Number.isSafeInteger(subcode) && subcode >= 0 ? `_${subcode}` : ""}`;
}

function transportFailureCode(error: unknown): string {
  return error instanceof BoundedJsonResponseError
    ? error.code
    : "transport_error";
}

function postMetaJson(path: string, accessToken: string, body: unknown) {
  return fetchJsonWithinLimits(
    buildGraphApiUrl(path),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
    },
    { maxBytes: RESPONSE_MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
  );
}

export async function provisionWhatsAppConversionDataset(input: {
  wabaId: string;
  accessToken: string;
}): Promise<string> {
  if (!matches(input.wabaId, GRAPH_ID_PATTERN))
    throw new WhatsAppConversionsApiError("invalid_waba_id");
  if (!validAccessToken(input.accessToken))
    throw new WhatsAppConversionsApiError("invalid_access_token");
  let result: Awaited<ReturnType<typeof postMetaJson>>;
  try {
    result = await postMetaJson(
      `${input.wabaId}/dataset`,
      input.accessToken,
      {}
    );
  } catch (error) {
    throw new WhatsAppConversionsApiError(transportFailureCode(error));
  }
  if (!result.response.ok)
    throw new WhatsAppConversionsApiError(
      graphRejectionCode(result.payload) ?? "unconfirmed_http_error"
    );
  if (
    !isRecord(result.payload) ||
    "error" in result.payload ||
    !matches(result.payload.id, GRAPH_ID_PATTERN)
  ) {
    throw new WhatsAppConversionsApiError("invalid_dataset_response");
  }
  return result.payload.id;
}

/** One attempt only: Business Messaging does not promise provider deduplication. */
export async function sendWhatsAppConversionEvent(input: {
  snapshot: MetaConversionSnapshot;
  eventId: string;
  accessToken: string;
}): Promise<WhatsAppConversionSendResult> {
  const invalid = validateMetaConversionSnapshot(input.snapshot);
  if (invalid) return { status: "rejected", code: invalid };
  if (!matches(input.eventId, SHORT_IDENTIFIER_PATTERN))
    return { status: "rejected", code: "invalid_event_id" };
  if (!validAccessToken(input.accessToken))
    return { status: "rejected", code: "invalid_access_token" };
  const { snapshot } = input;
  let result: Awaited<ReturnType<typeof postMetaJson>>;
  try {
    result = await postMetaJson(
      `${snapshot.datasetId}/events`,
      input.accessToken,
      {
        data: [
          {
            event_name: snapshot.eventName,
            event_time: snapshot.eventTime,
            event_id: input.eventId,
            action_source: "business_messaging",
            messaging_channel: "whatsapp",
            user_data: {
              whatsapp_business_account_id: snapshot.wabaId,
              ctwa_clid: snapshot.ctwaClid,
            },
            custom_data: { currency: snapshot.currency, value: snapshot.value },
          },
        ],
        ...(snapshot.testEventCode
          ? { test_event_code: snapshot.testEventCode }
          : {}),
      }
    );
  } catch (error) {
    return { status: "delivery_unknown", code: transportFailureCode(error) };
  }
  const { response, payload } = result;
  if (!response.ok) {
    const code = graphRejectionCode(payload);
    return code
      ? { status: "rejected", code }
      : { status: "delivery_unknown", code: "unconfirmed_http_error" };
  }
  if (
    !isRecord(payload) ||
    "error" in payload ||
    payload.events_received !== 1
  ) {
    return { status: "delivery_unknown", code: "missing_acceptance" };
  }
  const traceId = payload.fbtrace_id;
  const safeTrace =
    matches(traceId, TRACE_ID_PATTERN) &&
    ![input.accessToken, snapshot.ctwaClid].some(value =>
      traceId.includes(value)
    );
  return { status: "sent", ...(safeTrace ? { traceId } : {}) };
}
