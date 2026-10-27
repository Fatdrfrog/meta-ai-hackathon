import "server-only";
import { randomInt } from "node:crypto";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function isMetaAdsMcpConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
}

/** Opaque provider correlation, independent of account and customer identifiers. */
export function createMetaAdsMcpConversationId(): string {
  return Array.from(
    { length: 20 },
    () => ALPHABET[randomInt(ALPHABET.length)]
  ).join("");
}

/** Preserve one server-owned identity wherever the provider schema supports it. */
export function withMetaAdsMcpConversationId(
  tool: { inputSchema: Record<string, unknown> },
  args: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  const properties = tool.inputSchema.properties as
    | Record<string, unknown>
    | undefined;
  return properties?.client_conversation_id
    ? { ...args, client_conversation_id: id }
    : args;
}
