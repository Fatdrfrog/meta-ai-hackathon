import { createHash } from "node:crypto";

export function buildDeterministicMongoObjectId(
  namespace: string,
  value: string
): string {
  return createHash("sha256")
    .update(`${namespace}\u0000${value}`)
    .digest("hex")
    .slice(0, 24);
}
