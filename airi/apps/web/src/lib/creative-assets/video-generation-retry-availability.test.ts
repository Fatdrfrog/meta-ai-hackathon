import { resolveVideoGenerationRetryAvailability } from "./video-generation-retry-availability";

function failedAsset() {
  return {
    status: "failed",
    providerRequestId: "operations/video-1",
    providerStatusUrl: "operations/video-1",
    generation: {
      contractVersion: 1,
      submission: {
        state: "submitted",
        providerRequestId: "operations/video-1",
      },
      failure: {
        phase: "store",
        code: "provider_result_not_ready",
        retryable: false,
        submissionUncertain: false,
      },
    },
  };
}

describe("resolveVideoGenerationRetryAvailability", () => {
  it("offers a no-submit provider-result recovery for a known request", () => {
    expect(resolveVideoGenerationRetryAvailability(failedAsset())).toEqual({
      canRetry: true,
      mode: "provider_result",
      requiresDuplicateChargeAcknowledgement: false,
      providerResultResume: {
        providerRequestId: "operations/video-1",
        providerRequestLocator: "operations/video-1",
        pollCount: 0,
        elapsedMs: 0,
      },
    });
  });

  it("does not turn the same nonretryable failure into a fresh paid retry without a safe locator", () => {
    expect(
      resolveVideoGenerationRetryAvailability({
        ...failedAsset(),
        providerStatusUrl: null,
      })
    ).toEqual({
      canRetry: false,
      mode: null,
      requiresDuplicateChargeAcknowledgement: false,
      providerResultResume: null,
    });
  });

  it("requires acknowledgement only for a fresh retry with an uncertain submission", () => {
    const asset = failedAsset();
    asset.generation.submission.state = "unknown";
    asset.generation.failure = {
      phase: "submit",
      code: "submission_unknown",
      retryable: false,
      submissionUncertain: true,
    };

    expect(resolveVideoGenerationRetryAvailability(asset)).toEqual({
      canRetry: true,
      mode: "fresh",
      requiresDuplicateChargeAcknowledgement: true,
      providerResultResume: null,
    });
  });
});
