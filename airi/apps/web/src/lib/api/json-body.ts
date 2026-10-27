import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export class InvalidJsonBodyError extends Error {
  constructor(message = "Invalid JSON body") {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

export class JsonBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`JSON body exceeds ${maxBytes} bytes`);
    this.name = "JsonBodyTooLargeError";
  }
}

/**
 * Reads a Request or Response body without holding more than `maxBytes`.
 * A larger Content-Length is rejected before the body is touched (a fetch
 * caller releases that body, e.g. by aborting its request), and the stream is
 * cancelled as soon as it passes the limit. Both throw JsonBodyTooLargeError,
 * named for the JSON routes but used for any body, fetched media included.
 * Aborting `signal` cancels the read, a stalled one included, and rejects with
 * the signal's reason.
 */
export async function readBodyBytesWithinLimit(
  request: Pick<Request, "headers" | "body" | "bodyUsed">,
  maxBytes: number,
  options: { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
  const { signal } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("JSON body byte limit must be a positive integer");
  }
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new JsonBodyTooLargeError(maxBytes);
  }
  if (request.bodyUsed) {
    throw new TypeError("Request body has already been consumed");
  }
  signal?.throwIfAborted();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  // Cancelling settles a pending read, so a stalled body cannot outlive it.
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      byteLength += part.value.byteLength;
      if (byteLength > maxBytes) {
        throw new JsonBodyTooLargeError(maxBytes);
      }
      chunks.push(part.value);
    }
    complete = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The request stream may already be cancelled or errored.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBodyWithinLimit(
  request: Request,
  maxBytes: number
): Promise<unknown> {
  const bytes = await readBodyBytesWithinLimit(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export async function readJsonObjectBody(
  request: Request
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InvalidJsonBodyError();
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidJsonBodyError("JSON body must be an object");
  }

  return body as Record<string, unknown>;
}

export function invalidJsonBodyResponse(error: unknown) {
  return NextResponse.json(
    {
      error:
        error instanceof InvalidJsonBodyError
          ? error.message
          : "Invalid JSON body",
    },
    { status: 400 }
  );
}

/**
 * Parses any JSON value (no object check). Malformed JSON becomes a ready
 * 400 `{ error: "Invalid JSON body" }`, with `code` and `headers` when given.
 */
export async function readJsonBodyOrResponse(
  request: Request,
  options: { code?: string; headers?: Record<string, string> } = {}
): Promise<
  { ok: true; body: unknown } | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    const { code, headers } = options;
    return {
      ok: false,
      response: NextResponse.json(
        code
          ? { error: "Invalid JSON body", code }
          : { error: "Invalid JSON body" },
        { status: 400, headers }
      ),
    };
  }
}

/** 400 with the first zod issue's message, else `fallback`; `code` is added when given. */
export function zodErrorResponse(
  error: ZodError,
  options: { fallback?: string; code?: string } = {}
) {
  const message =
    error.issues[0]?.message || options.fallback || "Invalid request body";
  return NextResponse.json(
    options.code ? { error: message, code: options.code } : { error: message },
    { status: 400 }
  );
}

/** 400 `{ error: "<label> is required" }` for a missing request field. */
export function requiredFieldResponse(label: string) {
  return NextResponse.json({ error: `${label} is required` }, { status: 400 });
}

/** `{ error: message }` for an Error, else `String(error)`; status defaults to 400. */
export function errorMessageResponse(error: unknown, status = 400) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status }
  );
}
