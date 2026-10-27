import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueWhatsAppOtpDelivery,
  resolveWhatsAppOtpEnqueueTransport,
} from "./enqueue-delivery";
import type { WhatsAppOtpDeliveryMessage } from "./runtime";

const envKeys = [
  "WHATSAPP_OTP_DELIVERY_MODE",
  "WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST",
] as const;

const previous = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>;

function restoreEnv() {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const message: WhatsAppOtpDeliveryMessage = {
  workspaceId: "workspace-1",
  challengeId: "challenge-1",
  correlationId: "corr-1",
  queuedAt: "2026-09-01T00:00:00.000Z",
};

test("enqueue uses Pub/Sub only on the production default", async () => {
  delete process.env.WHATSAPP_OTP_DELIVERY_MODE;
  delete process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST;
  const started: unknown[] = [];
  const published: unknown[] = [];

  const result = await enqueueWhatsAppOtpDelivery(message, {
    startWorkflow: async (payload) => {
      started.push(payload);
      return { ok: true, messageId: "wf-1" };
    },
    publishToPubSub: async (payload) => {
      published.push(payload);
      return { ok: true, messageId: "pubsub-1" };
    },
  });

  assert.equal(resolveWhatsAppOtpEnqueueTransport("workspace-1"), "pubsub");
  assert.equal(result.ok, true);
  assert.equal(result.messageId, "pubsub-1");
  assert.equal(started.length, 0);
  assert.equal(published.length, 1);
  restoreEnv();
});

test("enqueue uses Temporal only for an allowlisted workspace", async () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "temporal";
  process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST =
    " workspace-CANARY , workspace-2 ";
  const started: string[] = [];
  const published: string[] = [];

  const canary = await enqueueWhatsAppOtpDelivery(
    { ...message, workspaceId: "workspace-canary" },
    {
      startWorkflow: async (payload) => {
        started.push(payload.workspaceId);
        return { ok: true, messageId: "wf-1" };
      },
      publishToPubSub: async (payload) => {
        published.push(payload.workspaceId);
        return { ok: true, messageId: "pubsub-1" };
      },
    },
  );
  const other = await enqueueWhatsAppOtpDelivery(
    { ...message, workspaceId: "workspace-other" },
    {
      startWorkflow: async (payload) => {
        started.push(payload.workspaceId);
        return { ok: true, messageId: "wf-1" };
      },
      publishToPubSub: async (payload) => {
        published.push(payload.workspaceId);
        return { ok: true, messageId: "pubsub-1" };
      },
    },
  );

  assert.equal(canary.messageId, "wf-1");
  assert.equal(other.messageId, "pubsub-1");
  assert.deepEqual(started, ["workspace-canary"]);
  assert.deepEqual(published, ["workspace-other"]);
  restoreEnv();
});

test("unknown delivery modes fail closed to Pub/Sub and never dual-send", async () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "both";
  process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST = "workspace-1";
  const started: unknown[] = [];
  const published: unknown[] = [];

  await enqueueWhatsAppOtpDelivery(message, {
    startWorkflow: async (payload) => {
      started.push(payload);
      return { ok: true, messageId: "wf-1" };
    },
    publishToPubSub: async (payload) => {
      published.push(payload);
      return { ok: true, messageId: "pubsub-1" };
    },
  });

  assert.equal(resolveWhatsAppOtpEnqueueTransport("workspace-1"), "pubsub");
  assert.equal(started.length, 0);
  assert.equal(published.length, 1);
  restoreEnv();
});
