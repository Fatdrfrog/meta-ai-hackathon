import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ApplicationFailure } from "@temporalio/activity";
import {
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY,
  type ElevenLabsCreativeTranscriptionCompleteActivityInput,
} from "@icecore/temporal";
import { createLocalTemporalWorkflowHarness } from "./testing/local-temporal.js";

test(
  "an ambiguous submission waits for a late paid result without another submit",
  { timeout: 90_000 },
  async () => {
    const harness = await createLocalTemporalWorkflowHarness(
      fileURLToPath(
        new URL(
          "./workflows/elevenlabs-creative-transcription.ts",
          import.meta.url,
        ),
      ),
    );
    let submissions = 0;
    let failures = 0;
    try {
      await harness.run({
        workflowType: "elevenLabsCreativeTranscriptionWorkflow",
        input: {
          contractVersion: 1,
          workspaceId: "workspace-1",
          assetId: "asset-1",
          sourceAssetId: "source-1",
          mode: "transcript",
          mediaType: "audio",
          providerSourceId: "customer-source",
        },
        activities: {
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_SUBMIT_ACTIVITY]: async () => {
            submissions += 1;
            throw ApplicationFailure.nonRetryable(
              "Provider response lost",
              "ElevenLabsCreativeTranscriptionOutcomeUnknown",
            );
          },
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETE_ACTIVITY]: async (
            input: ElevenLabsCreativeTranscriptionCompleteActivityInput,
          ) => {
            assert.equal(
              input.transcription.data.text,
              "Already paid transcript",
            );
            return {
              assetId: input.assetId,
              status: "complete",
              providerRequestId: input.transcription.requestId,
              terminal: true,
            };
          },
          [ELEVENLABS_CREATIVE_TRANSCRIPTION_FAIL_ACTIVITY]: async () => {
            failures += 1;
            return { assetId: "asset-1", status: "failed", terminal: true };
          },
        },
        assert: async (handle) => {
          const deadline = Date.now() + 15_000;
          let failed = false;
          while (!failed && Date.now() < deadline) {
            failed = Boolean(
              (await handle.fetchHistory()).events?.some(
                (event) => event.activityTaskFailedEventAttributes,
              ),
            );
            if (!failed) await delay(50);
          }
          assert.equal(
            failed,
            true,
            "submission failure must be recorded first",
          );
          await delay(100);
          const timer = (await handle.fetchHistory()).events?.find(
            (event) => event.timerStartedEventAttributes,
          )?.timerStartedEventAttributes;
          assert.equal(
            Number(timer?.startToFireTimeout?.seconds),
            24 * 60 * 60,
            "late-result wait must keep the finite 24-hour deadline",
          );
          assert.equal(
            failures,
            0,
            "an ambiguous paid submission must keep waiting",
          );
          await handle.signal(
            ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL,
            {
              requestId: "late-request",
              status: "completed",
              mode: "transcript",
              webhookType: "speech_to_text",
              data: { text: "Already paid transcript" },
            },
          );
          assert.deepEqual(await handle.result(), {
            assetId: "asset-1",
            status: "complete",
            providerRequestId: "late-request",
            terminal: true,
          });
          assert.equal(submissions, 1);
          assert.equal(failures, 0);
        },
      });
    } finally {
      await harness.close();
    }
  },
);
