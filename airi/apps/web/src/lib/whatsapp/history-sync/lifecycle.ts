import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { isWhatsAppHistorySyncEligible } from "./eligibility";

/**
 * Only connection persistence may create a history generation. The phone reset
 * helper alone cannot distinguish a new onboarding from a token reconnect.
 * Existing sessionless sources remain untouched until confirmed new onboarding.
 */
export function prepareWhatsAppHistorySyncSession({
  current,
  next,
  sessionId,
  startedAt,
  embeddedSignupCompleted = false,
}: {
  current: Readonly<Record<string, unknown>>;
  next: Record<string, unknown>;
  sessionId: string;
  startedAt: string;
  embeddedSignupCompleted?: boolean;
}): Record<string, unknown> {
  if (!isWhatsAppHistorySyncEligible(next)) return next;
  const previousPhone =
    normalizeWhatsAppAccountIdentifiers(current).phoneNumberId;
  const nextPhone = normalizeWhatsAppAccountIdentifiers(next).phoneNumberId;
  const previousSession = asWhatsAppRecord(current.history_sync);
  const offboarded =
    current.coexistence_reonboarding_status === "removed" ||
    current.coexistence_reonboarding_status === "offboarded";
  const offboardedAt = Date.parse(
    String(
      current.coexistence_reonboarding_last_event_at ||
        current.coexistence_reonboarding_removed_at ||
        current.coexistence_reonboarding_offboarded_at ||
        ""
    )
  );
  const previousStartedAt = Date.parse(
    String(previousSession.session_started_at || "")
  );
  const newOnboarding =
    embeddedSignupCompleted &&
    offboarded &&
    (!previousSession.session_id ||
      (Number.isFinite(offboardedAt) && offboardedAt > previousStartedAt));
  if (!nextPhone || (previousPhone === nextPhone && !newOnboarding))
    return next;
  return {
    ...next,
    history_sync: { session_id: sessionId, session_started_at: startedAt },
  };
}
