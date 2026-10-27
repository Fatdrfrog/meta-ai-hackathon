import {
  buildMarketingMessagesCredentialPatch,
  getMarketingMessagesUserFacingState,
  isMarketingMessagesApiOnboarded,
  resolveMarketingMessagesStatusFromMetaPayload,
  shouldSyncMarketingMessagesOnboarding,
} from "./messages-onboarding";
import type { WhatsAppCredentials } from "@/types/supabase";

describe("marketing messages onboarding helpers", () => {
  const baseCredentials = {
    phone_number_id: "phone-1",
    waba_id: "waba-1",
    access_token: "token",
  } as WhatsAppCredentials;

  it("builds a persisted credential patch from Meta status", () => {
    expect(
      buildMarketingMessagesCredentialPatch({
        status: "onboarded",
        checkedAt: "2026-07-21T12:00:00.000Z",
      })
    ).toEqual({
      marketing_messages_onboarding_status: "ONBOARDED",
      marketing_messages_api_status: "ONBOARDED",
      marketing_messages_enabled: true,
      marketing_messages_onboarding_last_checked_at: "2026-07-21T12:00:00.000Z",
    });
  });

  it("resolves status from waba or business payload shapes", () => {
    expect(
      resolveMarketingMessagesStatusFromMetaPayload({
        wabaStatus: "ELIGIBLE",
      })
    ).toBe("ELIGIBLE");

    expect(
      resolveMarketingMessagesStatusFromMetaPayload({
        businessStatus: { status: "ONBOARDED" },
      })
    ).toBe("ONBOARDED");
  });

  it("maps persisted credentials to user-facing states", () => {
    expect(getMarketingMessagesUserFacingState(baseCredentials)).toBe(
      "unknown"
    );
    expect(
      getMarketingMessagesUserFacingState({
        ...baseCredentials,
        marketing_messages_onboarding_last_checked_at:
          "2026-07-21T12:00:00.000Z",
      })
    ).toBe("unknown");
    expect(
      getMarketingMessagesUserFacingState({
        ...baseCredentials,
        marketing_messages_enabled: true,
      })
    ).toBe("ready");
    expect(
      isMarketingMessagesApiOnboarded({
        ...baseCredentials,
        marketing_messages_onboarding_status: "ONBOARDED",
      })
    ).toBe(true);
  });

  it("only auto-syncs when status was never checked", () => {
    expect(shouldSyncMarketingMessagesOnboarding(baseCredentials)).toBe(true);
    expect(
      shouldSyncMarketingMessagesOnboarding({
        ...baseCredentials,
        marketing_messages_onboarding_last_checked_at:
          "2026-07-21T12:00:00.000Z",
      })
    ).toBe(false);
  });

  it("uses an explicit non-ready status instead of a stale enabled flag", () => {
    const credentials = {
      ...baseCredentials,
      marketing_messages_enabled: true,
      marketing_messages_onboarding_status: "ELIGIBLE",
    };
    expect(isMarketingMessagesApiOnboarded(credentials)).toBe(false);
    expect(getMarketingMessagesUserFacingState(credentials)).toBe("not_ready");
  });

  it("keeps an unavailable provider status unknown after a completed check", () => {
    expect(
      getMarketingMessagesUserFacingState({
        ...baseCredentials,
        ...buildMarketingMessagesCredentialPatch({ status: null }),
      })
    ).toBe("unknown");
  });
});
