import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type {
  ActivityExecuteInput,
  ActivityInterceptorsFactory,
} from "@temporalio/worker";

import { buildUpstashUsageActivityInterceptors } from "./upstash-usage-activity-interceptor.js";
import {
  installUpstashUsageTracking,
  measureUpstashUsage,
  resetUpstashUsageTrackingForTests,
  upstashUsageLogFields,
} from "./upstash-usage.js";

const UPSTASH_URL = "https://example-upstash.test";

afterEach(() => {
  resetUpstashUsageTrackingForTests();
});

function createHost(
  respond: (url: string) => Promise<Response> = async () => new Response("{}"),
) {
  const urls: string[] = [];
  const host = {
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      return respond(url);
    }) as typeof fetch,
  };
  return { host, urls };
}

function pipelineBody(commands: number): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(
      Array.from({ length: commands }, (_, index) => ["GET", `key-${index}`]),
    ),
  };
}

test("counts Upstash requests only inside a scope and only for the Upstash host", async () => {
  const { host, urls } = createHost();
  assert.equal(installUpstashUsageTracking(`${UPSTASH_URL}/`, host), true);

  await host.fetch(UPSTASH_URL, { body: JSON.stringify(["GET", "outside"]) });
  const { usage } = await measureUpstashUsage(async () => {
    await host.fetch(UPSTASH_URL, { body: JSON.stringify(["GET", "a"]) });
    await host.fetch(`${UPSTASH_URL}/pipeline`, pipelineBody(3));
    await host.fetch("https://graph.facebook.com/v23.0/me");
    return "done";
  });

  assert.equal(urls.length, 4, "every request still reaches the real fetch");
  assert.equal(usage.requests, 2);
  assert.equal(usage.commands, 4);
  assert.equal(usage.failures, 0);
  assert.ok(usage.waitMs >= 0);
});

test("a failed Upstash request is counted and the error is rethrown", async () => {
  const { host } = createHost(async () => {
    throw new Error("socket hang up");
  });
  installUpstashUsageTracking(UPSTASH_URL, host);

  const { usage } = await measureUpstashUsage(async () => {
    await assert.rejects(
      host.fetch(UPSTASH_URL, { body: "[]" }),
      /socket hang up/,
    );
  });
  assert.equal(usage.requests, 1);
  assert.equal(usage.failures, 1);
});

test("concurrent and nested scopes keep separate counts", async () => {
  const { host } = createHost(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response("{}");
  });
  installUpstashUsageTracking(UPSTASH_URL, host);
  const call = () => host.fetch(UPSTASH_URL, { body: "[]" });

  const [first, second] = await Promise.all([
    measureUpstashUsage(async () => {
      await call();
      await call();
      const inner = await measureUpstashUsage(async () => {
        await call();
      });
      return inner.usage.requests;
    }),
    measureUpstashUsage(async () => {
      await call();
    }),
  ]);

  assert.equal(first.usage.requests, 2, "the nested scope is not added");
  assert.equal(first.value, 1);
  assert.equal(second.usage.requests, 1);
});

test("installs once and adds no log fields while tracking is off", async () => {
  const { host } = createHost();
  assert.deepEqual(
    upstashUsageLogFields({
      requests: 1,
      commands: 1,
      waitMs: 1,
      maxRequestMs: 1,
      failures: 0,
    }),
    {},
  );
  assert.equal(installUpstashUsageTracking(undefined, host), false);
  assert.equal(installUpstashUsageTracking(UPSTASH_URL, host), true);
  assert.equal(installUpstashUsageTracking(UPSTASH_URL, host), false);
  assert.deepEqual(
    upstashUsageLogFields({
      requests: 2,
      commands: 5,
      waitMs: 180.6,
      maxRequestMs: 120.2,
      failures: 0,
    }),
    {
      upstashRequests: 2,
      upstashCommands: 5,
      upstashWaitMs: 181,
      upstashMaxRequestMs: 120,
      upstashFailures: 0,
    },
  );
});

function createActivityContext(activityType: string) {
  return {
    info: {
      activityType,
      attempt: 1,
      isLocal: false,
      taskQueue: "airi-conversation",
      workflowType: "airiConversationWorkflow",
    },
  } as Parameters<ActivityInterceptorsFactory>[0];
}

function turnInput(): ActivityExecuteInput {
  return {
    args: [
      {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        text: "private customer message",
      },
    ],
    headers: {},
  } as ActivityExecuteInput;
}

test("the activity interceptor logs a turn's Upstash usage without message text", async () => {
  const { host } = createHost();
  installUpstashUsageTracking(UPSTASH_URL, host);
  const records: Array<{ event: string; context: Record<string, unknown> }> =
    [];
  const interceptors = buildUpstashUsageActivityInterceptors({
    info: (event: string, context?: Record<string, unknown>) =>
      records.push({ event, context: context || {} }),
  } as never)(createActivityContext("airi.prepareConversationTurn"));

  const result = await interceptors.inbound?.execute?.(turnInput(), async () => {
    await host.fetch(UPSTASH_URL, { body: "[]" });
    await host.fetch(`${UPSTASH_URL}/pipeline`, pipelineBody(2));
    return "prepared";
  });

  assert.equal(result, "prepared");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.event, "airi.worker.upstash_usage");
  assert.deepEqual(
    { ...records[0]?.context, durationMs: 0, upstashWaitMs: 0, upstashMaxRequestMs: 0 },
    {
      activityType: "airi.prepareConversationTurn",
      workflowType: "airiConversationWorkflow",
      attempt: 1,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      durationMs: 0,
      upstashRequests: 2,
      upstashCommands: 3,
      upstashWaitMs: 0,
      upstashMaxRequestMs: 0,
      upstashFailures: 0,
    },
  );
});

test("the activity interceptor logs turns with zero calls but skips other quiet activities", async () => {
  const { host } = createHost();
  installUpstashUsageTracking(UPSTASH_URL, host);
  const records: string[] = [];
  const build = buildUpstashUsageActivityInterceptors({
    info: (_event: string, context?: Record<string, unknown>) =>
      records.push(String(context?.activityType)),
  } as never);

  await build(createActivityContext("airi.deliverOutbound")).inbound?.execute?.(
    turnInput(),
    async () => "delivered",
  );
  await build(createActivityContext("billingSubscriptionChargeActivity"))
    .inbound?.execute?.(turnInput(), async () => "charged");
  await build(createActivityContext("billingSubscriptionChargeActivity"))
    .inbound?.execute?.(turnInput(), async () => {
      await host.fetch(UPSTASH_URL, { body: "[]" });
      return "charged";
    });

  assert.deepEqual(records, [
    "airi.deliverOutbound",
    "billingSubscriptionChargeActivity",
  ]);
});

test("the activity interceptor stays out of the way when tracking is off", async () => {
  const records: string[] = [];
  const interceptors = buildUpstashUsageActivityInterceptors({
    info: (event: string) => records.push(event),
  } as never)(createActivityContext("airi.prepareConversationTurn"));

  const result = await interceptors.inbound?.execute?.(
    turnInput(),
    async () => "prepared",
  );

  assert.equal(result, "prepared");
  assert.deepEqual(records, []);
});
