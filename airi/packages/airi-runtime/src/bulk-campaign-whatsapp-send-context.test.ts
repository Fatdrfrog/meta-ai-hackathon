import assert from "node:assert/strict";
import test from "node:test";

import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import type { BulkCampaignReadiness } from "@icecore/scenario-contracts";
import {
  createBatchScopedWhatsAppSendingReadinessResolver,
  createBatchScopedWhatsAppSendContextResolver,
  resolveBulkCampaignWhatsAppSendContext,
} from "./bulk-campaign-whatsapp-send-context";

type LegacyWhatsAppDispatchItem = Extract<
  BulkCampaignDispatchItem,
  { channel: "whatsapp" }
> & {
  accessToken: string;
  messagingAccountId: string;
  marketingMessagesEnabled: boolean;
};

test("shares an in-flight health lookup across sources in one WABA and separates workspace/account scope", async () => {
  const ready: BulkCampaignReadiness = {
    state: "ready",
    checkedAt: new Date().toISOString(),
    remainingCapacity: null,
    reasons: [],
  };
  let resolveHealth!: (value: BulkCampaignReadiness) => void;
  const deferred = new Promise<BulkCampaignReadiness>((resolve) => {
    resolveHealth = resolve;
  });
  const calls: string[] = [];
  const resolveForBatch = createBatchScopedWhatsAppSendingReadinessResolver(
    async context => {
      calls.push(`${context.workspaceId}:${context.wabaId}`);
      return deferred;
    },
  );
  const context = {
    workspaceId: "workspace-1", sourceId: "source-1", wabaId: "waba-1",
    accessToken: "token", phoneNumberId: "phone-1",
  };
  const first = resolveForBatch(context);
  const second = resolveForBatch({ ...context, sourceId: "source-2" });
  const otherWaba = resolveForBatch({ ...context, wabaId: "waba-2" });
  const otherWorkspace = resolveForBatch({ ...context, workspaceId: "workspace-2" });
  await Promise.resolve();

  assert.equal(first, second);
  assert.deepEqual(calls, ["workspace-1:waba-1", "workspace-1:waba-2", "workspace-2:waba-1"]);
  resolveHealth(ready);
  assert.deepEqual(await Promise.all([first, second, otherWaba, otherWorkspace]), [ready, ready, ready, ready]);
});

test("retains a failed or malformed health decision for the batch without leaking provider details", async () => {
  for (const malformed of [false, true]) {
    let calls = 0;
    const resolveForBatch = createBatchScopedWhatsAppSendingReadinessResolver(async () => {
      calls += 1;
      if (!malformed) throw new Error("provider credential detail");
      return { state: "ready" } as BulkCampaignReadiness;
    });
    const context = {
      workspaceId: "workspace-1", wabaId: "waba-1",
      accessToken: "token", phoneNumberId: "phone-1",
    };
    const first = await resolveForBatch(context);
    const second = await resolveForBatch(context);

    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    assert.equal(first.state, "unavailable");
    assert.deepEqual(first.reasons, [{ code: "meta_check_unavailable" }]);
    assert.equal(JSON.stringify(first).includes("credential"), false);
  }
});

const legacyItem: LegacyWhatsAppDispatchItem = {
  channel: "whatsapp",
  workspaceId: "workspace-1",
  sourceId: "source-1",
  recipient: { phone: "77010000001" },
  phoneNumberId: "phone-1",
  accessToken: "stale-token",
  messagingAccountId: "stale-account",
  marketingMessagesEnabled: true,
  templateName: "update",
};

test("shares one fresh source resolution within an activity batch", async () => {
  let resolutionCount = 0;
  const resolveForBatch = createBatchScopedWhatsAppSendContextResolver(
    async ({ workspaceId, sourceId }) => {
      resolutionCount += 1;
      return {
        workspaceId: workspaceId || undefined,
        sourceId: sourceId || undefined,
        phoneNumberId: `phone-${sourceId}`,
        accessToken: `token-${sourceId}`,
      };
    },
  );

  const [first, replay, other] = await Promise.all([
    resolveForBatch({ workspaceId: "workspace-1", sourceId: "source-1" }),
    resolveForBatch({ workspaceId: "workspace-1", sourceId: "source-1" }),
    resolveForBatch({ workspaceId: "workspace-1", sourceId: "source-2" }),
  ]);

  assert.equal(resolutionCount, 2);
  assert.deepEqual(replay, first);
  assert.equal(other?.sourceId, "source-2");
});

test("does not authorize a bulk send with an embedded legacy credential when the live source is unavailable", async () => {
  await assert.rejects(
    resolveBulkCampaignWhatsAppSendContext({
      item: legacyItem,
      resolveSendContext: async () => null,
    }),
    /send context is unavailable/i,
  );
});

test("rejects a bulk item when the live source now resolves to another phone number", async () => {
  await assert.rejects(
    resolveBulkCampaignWhatsAppSendContext({
      item: legacyItem,
      resolveSendContext: async () => ({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        phoneNumberId: "phone-2",
        accessToken: "live-token",
      }),
    }),
    /phone number changed before dispatch/i,
  );
});

test("rejects a bulk item when resolution returns a different source identity", async () => {
  await assert.rejects(
    resolveBulkCampaignWhatsAppSendContext({
      item: legacyItem,
      resolveSendContext: async () => ({
        sourceId: "source-2",
        workspaceId: "workspace-1",
        phoneNumberId: "phone-1",
        accessToken: "live-token",
      }),
    }),
    /source changed before dispatch/i,
  );
});

test("rejects a bulk item when resolution returns a different workspace identity", async () => {
  await assert.rejects(
    resolveBulkCampaignWhatsAppSendContext({
      item: legacyItem,
      resolveSendContext: async () => ({
        sourceId: "source-1",
        workspaceId: "workspace-2",
        phoneNumberId: "phone-1",
        accessToken: "live-token",
      }),
    }),
    /workspace changed before dispatch/i,
  );
});

test("returns only the matching live source context", async () => {
  const context = await resolveBulkCampaignWhatsAppSendContext({
    item: legacyItem,
    resolveSendContext: async () => ({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      phoneNumberId: "phone-1",
      accessToken: "live-token",
      messagingAccountId: "live-account",
      marketingMessagesEnabled: false,
    }),
  });

  assert.deepEqual(context, {
    sourceId: "source-1",
    workspaceId: "workspace-1",
    phoneNumberId: "phone-1",
    accessToken: "live-token",
    messagingAccountId: "live-account",
    marketingMessagesEnabled: false,
  });
});
