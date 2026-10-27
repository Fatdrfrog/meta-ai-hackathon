import {
  bulkCampaignEligibilityBlocksSend,
  bulkCampaignPlanLimitBlocksSend,
  bulkCampaignReadinessErrorKey,
  bulkCampaignReadinessFix,
  bulkCampaignWhatsAppSettingsHref,
  resolveBulkCampaignPlanCheck,
  resolveBulkCampaignReadinessBlockedReason,
  resolveBulkCampaignReadinessFailure,
  resolveBulkCampaignSharedSendGate,
  resolveBulkCampaignSendStatus,
} from "./bulk-campaign-send-gate";

const openGate = {
  isSubmitting: false,
  hasActiveDispatch: false,
  recipientParsing: false,
  emptyAudience: false,
  eligibilityCanSubmit: true,
} as const;

describe("bulkCampaignEligibilityBlocksSend", () => {
  it("blocks unresolved eligibility for fixed sends", () => {
    expect(
      bulkCampaignEligibilityBlocksSend({ eligibilityCanSubmit: false })
    ).toBe(true);
    expect(
      bulkCampaignEligibilityBlocksSend({ eligibilityCanSubmit: true })
    ).toBe(false);
    expect(
      bulkCampaignEligibilityBlocksSend({
        eligibilityCanSubmit: false,
        recurring: true,
      })
    ).toBe(false);
  });
});

describe("resolveBulkCampaignSharedSendGate", () => {
  it("stays open when shared flags are clear", () => {
    expect(resolveBulkCampaignSharedSendGate(openGate)).toEqual({
      blocked: false,
      eligibilityBlocksSend: false,
    });
  });

  it.each([
    ["isSubmitting", { isSubmitting: true }],
    ["hasActiveDispatch", { hasActiveDispatch: true }],
    ["recipientParsing", { recipientParsing: true }],
    ["emptyAudience", { emptyAudience: true }],
  ] as const)("blocks send when %s is set", (_label, override) => {
    expect(
      resolveBulkCampaignSharedSendGate({ ...openGate, ...override }).blocked
    ).toBe(true);
  });

  it("blocks send while the eligibility check is unresolved", () => {
    expect(
      resolveBulkCampaignSharedSendGate({
        ...openGate,
        eligibilityCanSubmit: false,
      })
    ).toEqual({
      blocked: true,
      eligibilityBlocksSend: true,
    });
  });

  it("does not treat a deferred recurring preview as unresolved", () => {
    expect(
      resolveBulkCampaignSharedSendGate({
        ...openGate,
        eligibilityCanSubmit: false,
        recurring: true,
      })
    ).toEqual({
      blocked: false,
      eligibilityBlocksSend: false,
    });
  });
});

describe("resolveBulkCampaignReadinessBlockedReason", () => {
  const clear = {
    checking: false,
    planUnavailable: false,
    failed: false,
    allExcluded: false,
  };

  it("has no reason when the check passed", () => {
    expect(resolveBulkCampaignReadinessBlockedReason(clear)).toBeNull();
    expect(
      resolveBulkCampaignReadinessBlockedReason({
        ...clear,
        readinessState: "ready",
      })
    ).toBeNull();
  });

  it("names the first reason in priority order", () => {
    expect(
      resolveBulkCampaignReadinessBlockedReason({
        checking: true,
        planUnavailable: true,
        failed: true,
        allExcluded: true,
        readinessState: "blocked",
      })
    ).toBe("checking");
    expect(
      resolveBulkCampaignReadinessBlockedReason({
        ...clear,
        planUnavailable: true,
        failed: true,
      })
    ).toBe("plan_unavailable");
    expect(
      resolveBulkCampaignReadinessBlockedReason({
        ...clear,
        failed: true,
        allExcluded: true,
      })
    ).toBe("check_failed");
    expect(
      resolveBulkCampaignReadinessBlockedReason({
        ...clear,
        allExcluded: true,
        readinessState: "ready",
      })
    ).toBe("all_excluded");
  });

  it.each(["blocked", "unavailable"] as const)(
    "reports a %s readiness result as blocked",
    readinessState => {
      expect(
        resolveBulkCampaignReadinessBlockedReason({ ...clear, readinessState })
      ).toBe("blocked");
    }
  );
});

describe("resolveBulkCampaignPlanCheck", () => {
  const settled = {
    applies: true,
    loading: false,
    error: undefined,
    preview: { configured: true },
  };

  it("is clear when the number is set up or the check doesn't apply", () => {
    const clear = { checking: false, planUnavailable: false, failed: false };
    expect(resolveBulkCampaignPlanCheck(settled)).toEqual(clear);
    expect(
      resolveBulkCampaignPlanCheck({
        ...settled,
        applies: false,
        error: new Error("Unauthorized"),
      })
    ).toEqual(clear);
  });

  it("says the number is unavailable only when the lookup answered so", () => {
    expect(
      resolveBulkCampaignPlanCheck({
        ...settled,
        preview: { configured: false },
      })
    ).toMatchObject({ planUnavailable: true, failed: false });
  });

  it("calls a failed lookup a failed check, not a missing number", () => {
    // The hook also reports a fetch failure as an unconfigured preview.
    expect(
      resolveBulkCampaignPlanCheck({
        ...settled,
        error: new Error("Unauthorized"),
        preview: { configured: false },
      })
    ).toEqual({ checking: false, planUnavailable: false, failed: true });
  });

  it("reports a running lookup as checking", () => {
    expect(
      resolveBulkCampaignPlanCheck({
        ...settled,
        loading: true,
        error: new Error("Unauthorized"),
      })
    ).toEqual({ checking: true, planUnavailable: false, failed: false });
  });
});

describe("resolveBulkCampaignReadinessFailure", () => {
  const clearPlan = { checking: false, planUnavailable: false, failed: false };
  const throttled = {
    state: "error",
    code: "meta_rate_limited",
    retryAt: 1_700_000_060_000,
  };

  it("names the missing number before the recipient check", () => {
    expect(
      resolveBulkCampaignReadinessFailure({
        plan: { ...clearPlan, planUnavailable: true },
        eligibility: throttled,
      })
    ).toEqual({ failed: true, code: "plan_unavailable" });
  });

  it("gives a failed number lookup no reason code", () => {
    expect(
      resolveBulkCampaignReadinessFailure({
        plan: { ...clearPlan, failed: true },
        eligibility: throttled,
      })
    ).toEqual({ failed: true });
  });

  it("passes on the recipient check's code and retry time", () => {
    expect(
      resolveBulkCampaignReadinessFailure({
        plan: clearPlan,
        eligibility: throttled,
      })
    ).toEqual({
      failed: true,
      code: "meta_rate_limited",
      retryAt: 1_700_000_060_000,
    });
    expect(
      resolveBulkCampaignReadinessFailure({
        plan: clearPlan,
        eligibility: { state: "ready" },
      })
    ).toEqual({ failed: false });
    expect(
      resolveBulkCampaignReadinessFailure({
        plan: clearPlan,
        eligibility: null,
      })
    ).toEqual({ failed: false });
  });
});

describe("bulkCampaignReadinessErrorKey", () => {
  it.each([
    "meta_rate_limited",
    "template_lookup_unavailable",
    "template_unavailable",
    "plan_unavailable",
  ])("maps %s to its translated line", code => {
    expect(bulkCampaignReadinessErrorKey(code)).toBe(
      `readiness.errors.${code}`
    );
  });

  it.each(["bulk_campaign_provenance_invalid", "", null, undefined])(
    "has no line for %p",
    code => {
      expect(bulkCampaignReadinessErrorKey(code)).toBeNull();
    }
  );
});

describe("bulkCampaignReadinessFix", () => {
  const settings =
    "/panel/w/workspace-1/settings/integrations?integration=whatsapp";

  it.each(["plan_unavailable", "meta_disconnected"])(
    "sends %s to WhatsApp in Integrations",
    code => {
      expect(bulkCampaignReadinessFix(code, "workspace-1")).toEqual({
        kind: "integrations",
        href: settings,
        external: false,
      });
    }
  );

  it.each(["meta_billing", "meta_sender_restricted", "meta_business_limit"])(
    "sends %s to WhatsApp Manager",
    code => {
      expect(bulkCampaignReadinessFix(code, null)).toEqual({
        kind: "whatsappManager",
        href: expect.stringMatching(
          /^https:\/\/business\.facebook\.com\/wa\/manage\//
        ),
        external: true,
      });
    }
  );

  it("needs the workspace for its own settings link", () => {
    expect(bulkCampaignReadinessFix("plan_unavailable", undefined)).toBeNull();
  });

  it.each([
    "meta_rate_limited",
    "contact_frequency_limit",
    "meta_check_unavailable",
    "toString",
    "",
    null,
  ])("offers no page for %p", code => {
    expect(bulkCampaignReadinessFix(code, "workspace-1")).toBeNull();
  });

  it("encodes the workspace in the settings link", () => {
    expect(bulkCampaignWhatsAppSettingsHref("a/b")).toBe(
      "/panel/w/a%2Fb/settings/integrations?integration=whatsapp"
    );
  });
});

describe("bulkCampaignPlanLimitBlocksSend", () => {
  it.each([{ conversationExhausted: true }, { trialExpired: true }])(
    "reflects the server's base plan restriction %j",
    limit => {
      expect(bulkCampaignPlanLimitBlocksSend(limit)).toBe(true);
    }
  );
  it("blocks only a used-up allowance", () => {
    expect(
      bulkCampaignPlanLimitBlocksSend({ bulkRecipientExhausted: true })
    ).toBe(true);
    expect(
      bulkCampaignPlanLimitBlocksSend({ bulkRecipientExhausted: false })
    ).toBe(false);
  });

  it("never blocks on unknown limits", () => {
    expect(bulkCampaignPlanLimitBlocksSend(undefined)).toBe(false);
    expect(bulkCampaignPlanLimitBlocksSend(null)).toBe(false);
    expect(bulkCampaignPlanLimitBlocksSend({})).toBe(false);
  });
});

describe("resolveBulkCampaignSendStatus", () => {
  const ready = {
    state: "ready" as const,
    checkedAt: "2026-10-19T10:00:00.000Z",
    remainingCapacity: null,
    reasons: [],
  };

  it("prioritizes the plan over a failed check and stale provider readiness", () => {
    expect(
      resolveBulkCampaignSendStatus({
        limit: { bulkRecipientExhausted: true },
        readiness: ready,
        readinessError: true,
      })
    ).toEqual({
      state: "plan_blocked",
      blocked: true,
      planReason: "campaign_limit",
    });
  });

  it.each([
    ["trial_expired", { trialExpired: true, bulkRecipientExhausted: true }],
    ["conversation_limit", { conversationExhausted: true }],
  ] as const)(
    "explains %s without depending on WhatsApp checks",
    (planReason, limit) => {
      expect(resolveBulkCampaignSendStatus({ limit })).toEqual({
        state: "plan_blocked",
        blocked: true,
        planReason,
      });
    }
  );

  it.each([
    ["sending", { isSubmitting: true }],
    ["active_dispatch", { hasActiveDispatch: true }],
  ] as const)(
    "keeps %s lifecycle ahead of a changed plan",
    (state, lifecycle) => {
      expect(
        resolveBulkCampaignSendStatus({
          ...lifecycle,
          limit: { trialExpired: true },
        })
      ).toMatchObject({ state, blocked: true });
    }
  );

  it.each([
    ["checking", { checkingReadiness: true }],
    ["unavailable", { readinessError: true }],
    ["noRecipients", { allExcluded: true }],
    ["awaitingAudience", { awaitingAudience: true }],
    ["blocked", { sendBlockedElsewhere: true }],
  ] as const)("does not show stale readiness over %s", (state, guard) => {
    expect(
      resolveBulkCampaignSendStatus({ readiness: ready, ...guard })
    ).toEqual({ state, blocked: true, planReason: null });
  });

  it("does not invent a provider requirement for channels or recurring sends without one", () => {
    expect(resolveBulkCampaignSendStatus({})).toEqual({
      state: "ready",
      blocked: false,
      planReason: null,
    });
  });
  it.each(["unavailable", "blocked"] as const)(
    "preserves provider %s while the audience is missing",
    state => {
      expect(
        resolveBulkCampaignSendStatus({
          readiness: { ...ready, state },
          awaitingAudience: true,
        })
      ).toMatchObject({ state, blocked: true });
    }
  );
});
