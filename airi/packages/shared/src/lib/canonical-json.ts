import { sha256Hex } from "./sha256";

const MAX_DEPTH = 64;
const MAX_MEMBERS = 10_000;
const MAX_BYTES = 1_000_000;
const NATIVE_OBJECT_CONSTRUCTOR_SOURCE =
  Function.prototype.toString.call(Object);

export class CanonicalJsonSerializationError extends Error {
  readonly name = "CanonicalJsonSerializationError";
}

export type CanonicalJsonSerializationOptions = {
  maxDepth?: number;
  maxMembers?: number;
  maxBytes?: number;
};

type SerializationState = {
  bytes: number;
  members: number;
  seen: Set<object>;
  limits: Required<CanonicalJsonSerializationOptions>;
};

function fail(message: string): never {
  throw new CanonicalJsonSerializationError(message);
}

function emit(state: SerializationState, output: string): string {
  state.bytes += new TextEncoder().encode(output).byteLength;
  if (state.bytes > state.limits.maxBytes) {
    return fail("Canonical JSON byte limit exceeded");
  }
  return output;
}

function canEmitJsonString(value: string, state: SerializationState): boolean {
  const remaining = state.limits.maxBytes - state.bytes;
  let bytes = 2;
  if (bytes > remaining) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 8 || code === 9 || code === 10 || code === 12 || code === 13
          ? 2
          : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > remaining) return false;
  }
  return true;
}

function emitJsonString(state: SerializationState, value: string): string {
  if (!canEmitJsonString(value, state)) {
    return fail("Canonical JSON byte limit exceeded");
  }
  return emit(state, JSON.stringify(value));
}

function addMember(state: SerializationState): void {
  state.members += 1;
  if (state.members > state.limits.maxMembers) {
    fail("Canonical JSON member limit exceeded");
  }
}

function hasIntrinsicObjectPrototypeSignature(prototype: object): boolean {
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(
    prototype,
    "constructor",
  )?.value;
  return (
    typeof constructor === "function" &&
    constructor.prototype === prototype &&
    Function.prototype.toString.call(constructor) ===
      NATIVE_OBJECT_CONSTRUCTOR_SOURCE
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    hasIntrinsicObjectPrototypeSignature(prototype)
  );
}

function serialize(
  value: unknown,
  state: SerializationState,
  depth: number,
): string {
  if (depth > state.limits.maxDepth) {
    return fail("Canonical JSON depth limit exceeded");
  }

  if (typeof value === "string") {
    return emitJsonString(state, value);
  }
  if (value === null || typeof value === "boolean") {
    return emit(state, JSON.stringify(value));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail("Canonical JSON does not support non-finite numbers");
    }
    return emit(state, JSON.stringify(value));
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return fail(`Canonical JSON does not support ${typeof value}`);
  }
  if (typeof value !== "object") {
    return fail("Canonical JSON encountered an unsupported value");
  }
  if (state.seen.has(value)) {
    return fail("Canonical JSON does not support cycles");
  }
  if (Array.isArray(value)) {
    state.seen.add(value);
    try {
      const parts: string[] = [emit(state, "[")];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          return fail("Canonical JSON does not support sparse arrays");
        }
        addMember(state);
        if (index > 0) {
          parts.push(emit(state, ","));
        }
        parts.push(serialize(value[index], state, depth + 1));
      }
      parts.push(emit(state, "]"));
      return parts.join("");
    } finally {
      state.seen.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    return fail("Canonical JSON only supports plain objects");
  }

  state.seen.add(value);
  try {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const parts: string[] = [emit(state, "{")];
    for (const [index, key] of keys.entries()) {
      addMember(state);
      if (index > 0) {
        parts.push(emit(state, ","));
      }
      parts.push(emitJsonString(state, key), emit(state, ":"));
      const child = value[key];
      if (child === undefined) {
        return fail("Canonical JSON does not support undefined values");
      }
      parts.push(serialize(child, state, depth + 1));
    }
    parts.push(emit(state, "}"));
    return parts.join("");
  } finally {
    state.seen.delete(value);
  }
}

/** Strict deterministic JSON. Owners of larger contracts must choose explicit finite budgets. */
export function serializeCanonicalJson(
  value: unknown,
  options: CanonicalJsonSerializationOptions = {},
): string {
  const limits = {
    maxDepth: options.maxDepth === undefined ? MAX_DEPTH : options.maxDepth,
    maxMembers:
      options.maxMembers === undefined ? MAX_MEMBERS : options.maxMembers,
    maxBytes: options.maxBytes === undefined ? MAX_BYTES : options.maxBytes,
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      fail(`Canonical JSON ${name} must be a positive safe integer`);
    }
  }
  return serialize(value, { bytes: 0, members: 0, seen: new Set(), limits }, 0);
}

/** Lowercase hex SHA-256 of the UTF-8 canonical JSON of `value`. */
export function sha256CanonicalJson(value: unknown): string {
  return sha256Hex(serializeCanonicalJson(value));
}
