const configurationError =
  "NEXT_PUBLIC_SUPABASE_ANON_KEY must be a Supabase publishable key or legacy anon JWT.";

function decodeJwtObject(segment) {
  try {
    const value = JSON.parse(
      atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

// Shared by web and mobile builds, public clients, and deployment tooling. This validates
// configuration type; Supabase verifies the credential's signature itself.
exports.validateSupabasePublicKey = function validateSupabasePublicKey(key) {
  if (key && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return key;
  if (key && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    const [encodedHeader, encodedPayload] = key.split(".");
    const header = decodeJwtObject(encodedHeader);
    const payload = decodeJwtObject(encodedPayload);
    if (
      header?.alg === "HS256" &&
      header.typ === "JWT" &&
      payload?.iss === "supabase" &&
      payload.role === "anon"
    )
      return key;
  }
  // Never include the rejected value: build logs and client errors are public.
  throw new Error(configurationError);
};
