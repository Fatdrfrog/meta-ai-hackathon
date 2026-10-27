import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const audience = "airi-website-cart";
function key() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("Cart session signing unavailable");
  return new TextEncoder().encode(secret);
}
export async function readCartSession(
  token: string,
  sourceId: string
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      audience,
      issuer: "airi.chat",
      algorithms: ["HS256"],
    });
    return payload.sourceId === sourceId &&
      typeof payload.sub === "string" &&
      /^[a-f0-9-]{36}$/.test(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
export async function issueCartSession(
  sourceId: string,
  existingToken?: string
) {
  const sessionId = existingToken
    ? await readCartSession(existingToken, sourceId)
    : null;
  return new SignJWT({ sourceId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sessionId || randomUUID())
    .setAudience(audience)
    .setIssuer("airi.chat")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key());
}
