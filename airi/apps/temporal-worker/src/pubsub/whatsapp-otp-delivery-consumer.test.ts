import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";

import { PubSub } from "@google-cloud/pubsub";

import { startWhatsAppOtpDeliveryConsumer } from "./whatsapp-otp-delivery-consumer.js";

const CONSUME_PERMISSION = "pubsub.subscriptions.consume";

function fixture(
  t: TestContext,
  permissions: () => Promise<Record<string, boolean>>,
  closeError?: Error,
) {
  const previousEnabled = process.env.WHATSAPP_OTP_PUBSUB_ENABLED;
  process.env.WHATSAPP_OTP_PUBSUB_ENABLED = "true";
  t.after(() => {
    if (previousEnabled === undefined) {
      delete process.env.WHATSAPP_OTP_PUBSUB_ENABLED;
    } else {
      process.env.WHATSAPP_OTP_PUBSUB_ENABLED = previousEnabled;
    }
  });

  const actions: string[] = [];
  const subscription = Object.assign(new EventEmitter(), {
    iam: {
      testPermissions: async (requested: string[]) => {
        assert.deepEqual(requested, [CONSUME_PERMISSION]);
        actions.push("test-permissions");
        return [await permissions(), {}];
      },
    },
    close: async () => {
      actions.push("close");
      if (closeError) throw closeError;
    },
  });
  t.mock.method(PubSub.prototype, "subscription", () => {
    actions.push("create");
    return subscription as unknown as ReturnType<PubSub["subscription"]>;
  });
  return { actions, subscription };
}

test("waits for consume permission before attaching OTP listeners", async (t) => {
  let grant!: (permissions: Record<string, boolean>) => void;
  const permissionResult = new Promise<Record<string, boolean>>((resolve) => {
    grant = resolve;
  });
  const { actions, subscription } = fixture(t, () => permissionResult);

  const starting = startWhatsAppOtpDeliveryConsumer();
  assert.deepEqual(actions, ["create", "test-permissions"]);
  assert.equal(subscription.listenerCount("message"), 0);
  assert.equal(subscription.listenerCount("error"), 0);

  grant({ [CONSUME_PERMISSION]: true });
  const stop = await starting;
  assert.equal(subscription.listenerCount("message"), 1);
  assert.equal(subscription.listenerCount("error"), 1);

  await stop();
  assert.equal(subscription.listenerCount("message"), 0);
  assert.equal(subscription.listenerCount("error"), 0);
  assert.deepEqual(actions, ["create", "test-permissions", "close"]);
});

const deniedPermissionMaps: Record<string, boolean>[] = [
  { [CONSUME_PERMISSION]: false },
  {},
];
for (const permissionMap of deniedPermissionMaps) {
  test(`rejects OTP startup and closes when consume permission is ${Object.keys(permissionMap).length ? "denied" : "missing"}`, async (t) => {
    const { actions, subscription } = fixture(t, async () => permissionMap);

    await assert.rejects(
      startWhatsAppOtpDeliveryConsumer(),
      /pubsub\.subscriptions\.consume/,
    );

    assert.deepEqual(actions, ["create", "test-permissions", "close"]);
    assert.equal(subscription.listenerCount("message"), 0);
    assert.equal(subscription.listenerCount("error"), 0);
  });
}

for (const closeError of [undefined, new Error("close failed")]) {
  test(`preserves an IAM RPC failure when subscription cleanup ${closeError ? "fails" : "succeeds"}`, async (t) => {
    const rpcError = new Error("IAM unavailable");
    const { actions, subscription } = fixture(t, async () => {
      throw rpcError;
    }, closeError);

    await assert.rejects(
      startWhatsAppOtpDeliveryConsumer(),
      (error) => error === rpcError,
    );

    assert.deepEqual(actions, ["create", "test-permissions", "close"]);
    assert.equal(subscription.listenerCount("message"), 0);
    assert.equal(subscription.listenerCount("error"), 0);
  });
}

test("does not create a subscription or test IAM when OTP is disabled", async (t) => {
  const { actions } = fixture(t, async () => ({ [CONSUME_PERMISSION]: true }));
  process.env.WHATSAPP_OTP_PUBSUB_ENABLED = "false";

  const stop = await startWhatsAppOtpDeliveryConsumer();
  await stop();

  assert.deepEqual(actions, []);
});
