import {
  accumulateBulkCampaignEligibilityOutcome,
  createBulkCampaignErrorResult,
  createBulkCampaignSuccessResult,
  parseBulkCampaignCommandResult,
  projectBulkCampaignReplayResponse,
  serializeBulkCampaignCommandResult,
} from "./bulk-campaign-outcome";

const queuedOutcome = {
  disposition: "queued" as const,
  evaluatedAt: "2026-08-21T00:00:00.000Z",
  lifecycleStatus: "queued" as const,
  requestedTotal: 4,
  acceptedTotal: 3,
  queuedTotal: 3,
  uniqueRecipients: { requested: 3, accepted: 3, queued: 3 },
  skippedByReason: { prior_failure: 1 },
  warnings: { missingMarketingConsent: 0 },
  campaignId: "campaign-1",
  dispatchId: "dispatch-1",
  workflowId: "workflow-1",
};

describe("bulk campaign command outcomes", () => {
  it("accumulates preflight and policy exclusions without losing first-reason totals", () => {
    expect(
      accumulateBulkCampaignEligibilityOutcome({
        requestedTotal: 5,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 4, accepted: 1 },
        stages: [
          {
            skippedByReason: { ineligible: 1 },
            warnings: { missingMarketingConsent: 0 },
          },
          {
            skippedByReason: {
              marketing_opt_out: 1,
              recipient_limit: 1,
              prior_failure: 1,
            },
            warnings: { missingMarketingConsent: 2 },
          },
        ],
      })
    ).toEqual({
      requestedTotal: 5,
      acceptedTotal: 1,
      uniqueRecipients: { requested: 4, accepted: 1 },
      skippedByReason: {
        ineligible: 1,
        marketing_opt_out: 1,
        recipient_limit: 1,
        prior_failure: 1,
      },
      warnings: { missingMarketingConsent: 2 },
      allExcluded: false,
    });
  });

  it("rejects an accumulated eligibility outcome whose counts do not balance", () => {
    expect(() =>
      accumulateBulkCampaignEligibilityOutcome({
        requestedTotal: 2,
        acceptedTotal: 1,
        uniqueRecipients: { requested: 2, accepted: 1 },
        stages: [
          {
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
          },
        ],
      })
    ).toThrow(/requestedTotal/);
  });

  it("creates and serializes a balanced canonical success", () => {
    const result = createBulkCampaignSuccessResult(queuedOutcome);

    expect(serializeBulkCampaignCommandResult(result)).toMatchObject({
      ok: true,
      outcome: queuedOutcome,
      queued: true,
      scheduled: false,
      noOp: false,
      total: 3,
      skippedPriorFailed: 1,
      skippedRecipientCount: 1,
    });
  });

  it("projects persisted replay responses through a strict aggregate-only allowlist", () => {
    const replayResult = createBulkCampaignSuccessResult({
      ...queuedOutcome,
      disposition: "scheduled",
      lifecycleStatus: "scheduled",
    });
    const canonical = serializeBulkCampaignCommandResult(replayResult);
    const privateValues = [
      "+15550000002",
      "reader@example.com",
      "987654321",
      "private-variable",
      "private-message-body",
    ];
    const projected = projectBulkCampaignReplayResponse({
      ...canonical,
      scheduledAt: "2026-08-21T10:00:00+00:00",
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
        throughputLevel: "STANDARD",
        phone: privateValues[0],
      },
      recipientLimit: {
        originalCount: 4,
        acceptedCount: 3,
        rawLimit: "TIER_1K",
        source: "cached_meta",
        truncated: false,
        invalidRecipients: [privateValues[1]],
      },
      temporalDispatchStaging: "existing",
      audience: {
        fingerprint: "a".repeat(64),
        requestedTotal: 4,
        queuedTotal: 3,
        skippedOptIn: 0,
        overlap: {
          intersectionCount: 0,
          candidateCount: 3,
          ratio: 0,
        },
        phone: privateValues[0],
      },
      audienceConfirmation: {
        required: true,
        confirmed: true,
        fingerprint: "a".repeat(64),
        email: privateValues[1],
      },
      scenarioActivated: true,
      scenarioStatus: "active",
      message: privateValues[4],
      marketingOptInWarningPhones: [privateValues[0]],
      invalidRecipients: [privateValues[1]],
      rawChatId: privateValues[2],
      variables: { name: privateValues[3] },
      unknownNested: { email: privateValues[1] },
    });

    expect(projected.result).toEqual(replayResult);
    expect(projected.responseBody).toEqual({
      ...canonical,
      scheduledAt: "2026-08-21T10:00:00.000Z",
      batchPlan: {
        batchSize: 5,
        delayMs: 1_000,
        ratePerSecond: 5,
        rateSource: "cached_meta_throughput",
        throughputLevel: "STANDARD",
      },
      recipientLimit: {
        originalCount: 4,
        acceptedCount: 3,
        rawLimit: "TIER_1K",
        source: "cached_meta",
        truncated: false,
      },
      temporalDispatchStaging: "existing",
      audience: {
        fingerprint: "a".repeat(64),
        requestedTotal: 4,
        queuedTotal: 3,
        skippedOptIn: 0,
        overlap: {
          intersectionCount: 0,
          candidateCount: 3,
          ratio: 0,
        },
      },
      audienceConfirmation: {
        required: true,
        confirmed: true,
        fingerprint: "a".repeat(64),
      },
      message:
        "Campaign scheduled in Temporal. Messages will be sent at the selected date.",
      scenarioActivated: true,
      scenarioStatus: "active",
    });
    const serialized = JSON.stringify(projected.responseBody);
    for (const privateValue of privateValues) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("fails closed when a legacy replay has no stable persisted timestamp", () => {
    expect(() =>
      projectBulkCampaignReplayResponse({ queued: true, total: 1 })
    ).toThrow(/timestamp is missing/);
  });

  it("accepts a truthful replay recipient-limit pool when another exclusion happens after the limit", () => {
    const canonical = serializeBulkCampaignCommandResult(
      createBulkCampaignSuccessResult({
        ...queuedOutcome,
        requestedTotal: 3,
        acceptedTotal: 1,
        queuedTotal: 1,
        uniqueRecipients: { requested: 3, accepted: 1, queued: 1 },
        skippedByReason: { ineligible: 1, unsubscribed: 1 },
      })
    );

    expect(
      projectBulkCampaignReplayResponse({
        ...canonical,
        recipientLimit: {
          originalCount: 2,
          acceptedCount: 1,
          rawLimit: "1000",
          source: "channel_default",
          truncated: false,
        },
      }).responseBody
    ).toEqual(
      expect.objectContaining({
        recipientLimit: {
          originalCount: 2,
          acceptedCount: 1,
          rawLimit: "1000",
          source: "channel_default",
          truncated: false,
        },
      })
    );
  });

  it.each([
    [
      "a candidate count that differs from the accepted unique audience",
      { kind: "none", intersectionCount: 0, candidateCount: 2, ratio: 0 },
    ],
    [
      "a ratio that does not equal the persisted counts",
      { kind: "none", intersectionCount: 1, candidateCount: 3, ratio: 0.5 },
    ],
    [
      "an unknown classification with a nonzero intersection",
      {
        kind: "unknown",
        intersectionCount: 1,
        candidateCount: 3,
        ratio: 1 / 3,
      },
    ],
    [
      "an exact classification without a full intersection",
      {
        kind: "exact",
        intersectionCount: 2,
        candidateCount: 3,
        ratio: 2 / 3,
      },
    ],
    [
      "a high classification below the authoritative threshold",
      {
        kind: "high",
        intersectionCount: 2,
        candidateCount: 3,
        ratio: 2 / 3,
      },
    ],
  ])("rejects replay overlap with %s", (_description, overlap) => {
    const canonical = serializeBulkCampaignCommandResult(
      createBulkCampaignSuccessResult(queuedOutcome)
    );

    expect(() =>
      projectBulkCampaignReplayResponse({
        ...canonical,
        audience: {
          fingerprint: "a".repeat(64),
          requestedTotal: 4,
          queuedTotal: 3,
          skippedOptIn: 0,
          overlap,
        },
      })
    ).toThrow();
  });

  it.each([
    [
      "confirmed when confirmation was not required",
      { required: false, confirmed: true, fingerprint: "a".repeat(64) },
    ],
    [
      "confirmed without its audience fingerprint",
      { required: true, confirmed: true },
    ],
  ])(
    "rejects replay audience confirmation that is %s",
    (_description, audienceConfirmation) => {
      const canonical = serializeBulkCampaignCommandResult(
        createBulkCampaignSuccessResult(queuedOutcome)
      );

      expect(() =>
        projectBulkCampaignReplayResponse({
          ...canonical,
          audience: {
            fingerprint: "a".repeat(64),
            requestedTotal: 4,
            queuedTotal: 3,
            skippedOptIn: 0,
          },
          audienceConfirmation,
        })
      ).toThrow(/audience confirmation is inconsistent/);
    }
  );

  it("regenerates the fixed queued message when an admitted SQL replay omitted the compatibility alias", () => {
    const canonical = serializeBulkCampaignCommandResult(
      createBulkCampaignSuccessResult(queuedOutcome)
    );

    expect(projectBulkCampaignReplayResponse(canonical).responseBody).toEqual(
      expect.objectContaining({
        message:
          "Campaign queued in Temporal. Messages will be sent in the background. Check campaign history for delivery status.",
      })
    );
  });

  it("rejects malformed 2xx payloads", () => {
    expect(() =>
      parseBulkCampaignCommandResult({
        payload: { queued: true, total: "four" },
        httpStatus: 200,
      })
    ).toThrow(/Malformed successful bulk campaign response/);
  });

  it("normalizes a legacy queued success", () => {
    expect(
      parseBulkCampaignCommandResult({
        payload: {
          queued: true,
          total: 3,
          requestedTotal: 4,
          skippedPriorFailed: 1,
          status: "queued",
          campaignId: "campaign-1",
        },
        httpStatus: 200,
      })
    ).toEqual({
      ok: true,
      outcome: {
        disposition: "queued",
        evaluatedAt: expect.any(String),
        lifecycleStatus: "queued",
        requestedTotal: 4,
        acceptedTotal: 3,
        queuedTotal: 3,
        uniqueRecipients: { requested: 4, accepted: 3, queued: 3 },
        skippedByReason: { prior_failure: 1 },
        warnings: { missingMarketingConsent: 0 },
        campaignId: "campaign-1",
      },
    });
  });

  it("normalizes generic legacy skipped recipients as ineligible", () => {
    expect(
      parseBulkCampaignCommandResult({
        payload: {
          queued: true,
          total: 1,
          requestedTotal: 2,
          skippedRecipientCount: 1,
        },
        httpStatus: 200,
      })
    ).toEqual({
      ok: true,
      outcome: {
        disposition: "queued",
        evaluatedAt: expect.any(String),
        lifecycleStatus: "queued",
        requestedTotal: 2,
        acceptedTotal: 1,
        queuedTotal: 1,
        uniqueRecipients: { requested: 2, accepted: 1, queued: 1 },
        skippedByReason: { ineligible: 1 },
        warnings: { missingMarketingConsent: 0 },
      },
    });
  });

  it("keeps scheduled compatibility aliases queued and admission-total based", () => {
    const result = createBulkCampaignSuccessResult({
      ...queuedOutcome,
      disposition: "scheduled",
      lifecycleStatus: "scheduled",
      requestedTotal: 4,
      acceptedTotal: 3,
      queuedTotal: 3,
      skippedByReason: { prior_failure: 1 },
    });

    expect(serializeBulkCampaignCommandResult(result)).toMatchObject({
      queued: true,
      scheduled: true,
      total: 3,
    });
  });

  it("normalizes blocked and failed error payloads", () => {
    expect(
      parseBulkCampaignCommandResult({
        payload: { code: "audience_confirmation_required", error: "Confirm" },
        httpStatus: 409,
      })
    ).toEqual({
      ok: false,
      disposition: "blocked",
      code: "audience_confirmation_required",
      message: "Confirm",
    });
    expect(
      createBulkCampaignErrorResult({
        disposition: "failed",
        code: "dispatch_unavailable",
        message: "Try again later",
      })
    ).toEqual({
      ok: false,
      disposition: "failed",
      code: "dispatch_unavailable",
      message: "Try again later",
    });
  });

  it("normalizes a no-op result", () => {
    expect(
      parseBulkCampaignCommandResult({
        payload: { noOp: true, total: 0, status: "completed" },
        httpStatus: 200,
      })
    ).toEqual({
      ok: true,
      outcome: {
        disposition: "no_op",
        evaluatedAt: expect.any(String),
        lifecycleStatus: "completed",
        requestedTotal: 0,
        acceptedTotal: 0,
        queuedTotal: 0,
        uniqueRecipients: { requested: 0, accepted: 0, queued: 0 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
      },
    });
  });

  it("rejects a success whose requested total does not balance", () => {
    expect(() =>
      createBulkCampaignSuccessResult({
        disposition: "queued",
        evaluatedAt: "2026-08-21T00:00:00.000Z",
        lifecycleStatus: "queued",
        requestedTotal: 4,
        acceptedTotal: 2,
        queuedTotal: 2,
        uniqueRecipients: { requested: 3, accepted: 2, queued: 2 },
        skippedByReason: { prior_failure: 1 },
        warnings: { missingMarketingConsent: 0 },
      })
    ).toThrow(/requestedTotal/);
  });
});
