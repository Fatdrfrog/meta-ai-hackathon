import assert from "node:assert/strict";
import test from "node:test";

import {
  configureOtpRuntime,
  deliverWhatsAppOtpChallenge,
  OTP_DELIVERY_LEASE_HELD_ERROR,
  resetOtpRuntimeForTests,
  type OtpRuntimeDeps,
} from "./index";

type ChallengeRecord = {
  _id: string;
  workspaceId: string;
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  sourceId: string;
  phoneNumberId?: string;
  encryptedCode: { iv: string; tag: string; ciphertext: string };
  expiresAt: Date;
  deliveryStatus: string;
  providerMessageId?: string;
};

function buildChallenge(
  overrides: Partial<ChallengeRecord> = {},
): ChallengeRecord {
  return {
    _id: "challenge-1",
    workspaceId: "workspace-1",
    recipientPhone: "77001234567",
    templateName: "login_code",
    languageCode: "ru",
    sourceId: "source-1",
    phoneNumberId: "phone-1",
    encryptedCode: { iv: "iv", tag: "tag", ciphertext: "ct" },
    expiresAt: new Date(Date.now() + 60_000),
    deliveryStatus: "queued",
    ...overrides,
  };
}

function createRuntime(
  overrides: Partial<OtpRuntimeDeps> = {},
  challenge: ChallengeRecord = buildChallenge(),
): {
  runtime: OtpRuntimeDeps;
  updates: unknown[];
} {
  const updates: unknown[] = [];
  const runtime = {
    connectDB: async () => undefined,
    encryptString: () => ({ iv: "iv", tag: "tag", ciphertext: "ct" }),
    decryptString: () => "123456",
    loadWhatsAppSource: async () => ({
      id: "source-1",
      credentials: { phone_number_id: "phone-1", access_token: "token" },
    }),
    extractCredentials: () => ({
      phoneNumberId: "phone-1",
      accessToken: "token",
    }),
    findApprovedAuthTemplate: async () => ({
      templateId: "template-1",
      name: "login_code",
      language: "ru",
    }),
    sendOtpTemplate: async () => ({ messageId: "wamid.otp" }),
    enqueueDelivery: async () => ({ ok: true, messageId: "wf-1" }),
    assertRequestAllowed: async () => undefined,
    getActiveBinding: async () => ({
      templateId: "template-1",
      templateName: "login_code",
      languageCode: "ru",
      ttlSeconds: 300,
      maxAttempts: 5,
    }),
    OtpChallengeModel: {
      findOneAndUpdate: async () => challenge,
      findOne: async () => challenge,
      updateOne: async (_filter: unknown, update: unknown) => {
        updates.push(update);
        return { modifiedCount: 1 };
      },
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
    OtpTemplateBindingModel: {} as OtpRuntimeDeps["OtpTemplateBindingModel"],
    ...overrides,
  } satisfies OtpRuntimeDeps;

  return { runtime, updates };
}

test("delivery claims a queued challenge and sends once", async () => {
  resetOtpRuntimeForTests();
  const sendCalls: unknown[] = [];
  const { runtime, updates } = createRuntime({
    sendOtpTemplate: async (input) => {
      sendCalls.push(input);
      return { messageId: "wamid.otp" };
    },
  });
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.deepEqual(result, {
    status: "sent",
    challengeId: "challenge-1",
    providerMessageId: "wamid.otp",
  });
  assert.equal(sendCalls.length, 1);
  const payload = JSON.stringify(sendCalls[0]);
  assert.match(payload, /123456/);
  assert.doesNotMatch(payload, /access_token/);
  assert.match(JSON.stringify(updates), /"deliveryStatus":"sent"/);
  assert.match(JSON.stringify(updates), /"providerMessageId":"wamid.otp"/);
});

test("delivery marks expired challenges without sending", async () => {
  resetOtpRuntimeForTests();
  let sent = false;
  const { runtime } = createRuntime({
    OtpChallengeModel: {
      findOneAndUpdate: async () => null,
      findOne: async () =>
        buildChallenge({
          expiresAt: new Date(Date.now() - 1_000),
          deliveryStatus: "queued",
        }),
      updateOne: async () => ({ modifiedCount: 1 }),
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
    sendOtpTemplate: async () => {
      sent = true;
      return { messageId: "wamid.otp" };
    },
  });
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.deepEqual(result, {
    status: "expired",
    challengeId: "challenge-1",
  });
  assert.equal(sent, false);
});

test("already-sent challenges do not send again", async () => {
  resetOtpRuntimeForTests();
  let sent = false;
  const { runtime } = createRuntime({
    OtpChallengeModel: {
      findOneAndUpdate: async () => null,
      findOne: async () =>
        buildChallenge({
          deliveryStatus: "sent",
          providerMessageId: "wamid.existing",
        }),
      updateOne: async () => ({ modifiedCount: 0 }),
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
    sendOtpTemplate: async () => {
      sent = true;
      return { messageId: "wamid.otp" };
    },
  });
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.deepEqual(result, {
    status: "already_sent",
    challengeId: "challenge-1",
    providerMessageId: "wamid.existing",
  });
  assert.equal(sent, false);
});

test("activity retry after a transient Meta failure sends once more", async () => {
  resetOtpRuntimeForTests();
  let sendCalls = 0;
  const { runtime, updates } = createRuntime({
    sendOtpTemplate: async () => {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error("Meta 500");
      return { messageId: "wamid.otp" };
    },
  });
  configureOtpRuntime(runtime);

  await assert.rejects(
    () =>
      deliverWhatsAppOtpChallenge({
        workspaceId: "workspace-1",
        challengeId: "challenge-1",
      }),
    /Meta 500/,
  );
  assert.match(JSON.stringify(updates[0]), /"deliveryStatus":"retrying"/);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });
  assert.equal(result.status, "sent");
  assert.equal(sendCalls, 2);
});

test("missing approved template is a permanent failure", async () => {
  resetOtpRuntimeForTests();
  const { runtime, updates } = createRuntime({
    findApprovedAuthTemplate: async () => null,
  });
  configureOtpRuntime(runtime);

  await assert.rejects(
    () =>
      deliverWhatsAppOtpChallenge({
        workspaceId: "workspace-1",
        challengeId: "challenge-1",
      }),
    /no longer approved/,
  );
  assert.match(JSON.stringify(updates[0]), /"deliveryStatus":"failed"/);
});

test("missing credentials are a permanent failure", async () => {
  resetOtpRuntimeForTests();
  const { runtime, updates } = createRuntime(
    {
      extractCredentials: () => ({}),
    },
    buildChallenge({ phoneNumberId: undefined }),
  );
  configureOtpRuntime(runtime);

  await assert.rejects(
    () =>
      deliverWhatsAppOtpChallenge({
        workspaceId: "workspace-1",
        challengeId: "challenge-1",
      }),
    /credentials are incomplete/,
  );
  assert.match(JSON.stringify(updates[0]), /"deliveryStatus":"failed"/);
});

test("an active send lease stays retryable without a second WhatsApp send", async () => {
  resetOtpRuntimeForTests();
  let sent = false;
  const { runtime } = createRuntime({
    OtpChallengeModel: {
      findOneAndUpdate: async () => null,
      findOne: async () =>
        buildChallenge({
          deliveryStatus: "sending",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      updateOne: async () => ({ modifiedCount: 0 }),
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
    sendOtpTemplate: async () => {
      sent = true;
      return { messageId: "wamid.otp" };
    },
  });
  configureOtpRuntime(runtime);

  await assert.rejects(
    () =>
      deliverWhatsAppOtpChallenge({
        workspaceId: "workspace-1",
        challengeId: "challenge-1",
      }),
    new RegExp(OTP_DELIVERY_LEASE_HELD_ERROR),
  );
  assert.equal(sent, false);
});

test("expired claimed challenges do not send after lookup", async () => {
  resetOtpRuntimeForTests();
  let sent = false;
  const { runtime, updates } = createRuntime(
    {
      sendOtpTemplate: async () => {
        sent = true;
        return { messageId: "wamid.otp" };
      },
    },
    buildChallenge({ expiresAt: new Date(Date.now() - 1_000) }),
  );
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.deepEqual(result, {
    status: "expired",
    challengeId: "challenge-1",
  });
  assert.equal(sent, false);
  assert.match(JSON.stringify(updates), /OTP challenge expired before delivery/);
});

test("a successful WhatsApp send is not retried when persist fails", async () => {
  resetOtpRuntimeForTests();
  let sendCalls = 0;
  let updateCalls = 0;
  const { runtime } = createRuntime({
    sendOtpTemplate: async () => {
      sendCalls += 1;
      return { messageId: "wamid.otp" };
    },
    OtpChallengeModel: {
      findOneAndUpdate: async () => buildChallenge(),
      findOne: async () => buildChallenge({ deliveryStatus: "sending" }),
      updateOne: async () => {
        updateCalls += 1;
        if (updateCalls === 1) throw new Error("mongo write failed");
        return { modifiedCount: 1 };
      },
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
  });
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.equal(result.status, "sent");
  assert.equal(sendCalls, 1);
  assert.equal(updateCalls, 2);
});

test("lease loss after send still records sent without a second WhatsApp call", async () => {
  resetOtpRuntimeForTests();
  let sendCalls = 0;
  const filters: unknown[] = [];
  const { runtime } = createRuntime({
    sendOtpTemplate: async () => {
      sendCalls += 1;
      return { messageId: "wamid.otp" };
    },
    OtpChallengeModel: {
      findOneAndUpdate: async () => buildChallenge(),
      findOne: async () =>
        buildChallenge({
          deliveryStatus: "sending",
          providerMessageId: null,
        }),
      updateOne: async (filter: unknown) => {
        filters.push(filter);
        const record = filter as { deliveryLeaseId?: string };
        if (record.deliveryLeaseId) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        return { matchedCount: 1, modifiedCount: 1 };
      },
      updateMany: async () => ({ modifiedCount: 0 }),
    } as unknown as OtpRuntimeDeps["OtpChallengeModel"],
  });
  configureOtpRuntime(runtime);

  const result = await deliverWhatsAppOtpChallenge({
    workspaceId: "workspace-1",
    challengeId: "challenge-1",
  });

  assert.equal(result.status, "sent");
  assert.equal(sendCalls, 1);
  assert.equal(filters.length, 2);
});
