import { getMetaCredentialOwner } from "@/lib/meta/credential-owner";
import {
  isMetaGraphAuthorizationError,
  isMetaGraphRateLimitError,
} from "@icecore/shared/lib/meta/api";

export type WhatsAppMetaDiagnosticErrorClass =
  | "configured_app"
  | "rate_limited"
  | "authorization"
  | "transient";

/**
 * Classifies a Meta failure without performing route-specific side effects.
 * Configured-app ownership wins over provider authorization/rate-limit checks
 * so a broken server app does not incorrectly force customer reconnection.
 */
export function classifyWhatsAppMetaDiagnosticError(
  error: unknown
): WhatsAppMetaDiagnosticErrorClass {
  if (getMetaCredentialOwner(error) === "configured_app") {
    return "configured_app";
  }
  if (isMetaGraphRateLimitError(error)) return "rate_limited";
  if (isMetaGraphAuthorizationError(error)) return "authorization";
  return "transient";
}
