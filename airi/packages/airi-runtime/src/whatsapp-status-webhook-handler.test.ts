import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";


import {
  createWhatsAppStatusWebhookHandler,
  type WhatsAppStatusWebhookHandlerDependencies,
} from "./whatsapp-status-webhook-handler";

const calls = {
  realtime: [] as Array<[string, string, unknown]>,
};

const mocks = {
  findOpenWhatsAppConversationByChatId: async () => null,
  findOriginalMessageChatIdByMessageId: async () => null,
  persistCampaignMessageStatusWithOutbox: async () => ({
    applied: true,
    queuedToOutbox: false,
  }),
  recordWhatsAppMessageDeliveryStatus: async () => ({
    recorded: true,
    status: "read",
    messageFound: true,
    messageDeliveryUpdated: true,
    conversationId: "507f1f77bcf86cd799439011",
    messageObjectId: "507f1f77bcf86cd799439012",
    delivery: {
      status: "read",
      readAt: "2026-01-02T00:00:00.000Z",
    },
  }),
  resolveWhatsAppSourceByAccountIdentifiers: async () => ({
    id: "source_1",
    type: "whatsapp",
    workspace_id: "workspace_1",
    credentials: {
      coexistence_mode: true,
      partner_app_installed: true,
    },
  }),
  trackScenarioFlowReadByMessageId: async () => undefined,
  updateChatWhatsAppUserId: async () => undefined,
  updateUserWhatsAppUserId: async () => undefined,
};

function createSupabaseMock(filters: Array<[string, string, unknown]> = []) {
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters.push(["campaign_messages", column, value]);
      return query;
    },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    from: () => query,
  };
}

function createRequestLogger() {
  return {
    error: () => undefined,
    info: () => undefined,
    start: () => undefined,
    success: () => undefined,
    warn: () => undefined,
  };
}

function createDeps(
  overrides: Partial<WhatsAppStatusWebhookHandlerDependencies> = {},
): WhatsAppStatusWebhookHandlerDependencies {
  return {
    buildWhatsAppWebhookSourceSkipPayload: () => ({
      status: "ok",
      message: "source disconnected",
      reason: "partner_removed",
    }),
    findOpenWhatsAppConversationByChatId:
      mocks.findOpenWhatsAppConversationByChatId,
    findOriginalMessageChatIdByMessageId:
      mocks.findOriginalMessageChatIdByMessageId,
    getWhatsAppWebhookSourceSkip: () => null,
    persistCampaignMessageStatusWithOutbox:
      mocks.persistCampaignMessageStatusWithOutbox,
    realtimeTrigger: async (channel, eventName, payload) => {
      calls.realtime.push([channel, eventName, payload]);
    },
    recordWhatsAppMessageDeliveryStatus:
      mocks.recordWhatsAppMessageDeliveryStatus,
    resolveWhatsAppSourceByAccountIdentifiers:
      mocks.resolveWhatsAppSourceByAccountIdentifiers,
    trackScenarioFlowReadByMessageId: mocks.trackScenarioFlowReadByMessageId,
    updateChatWhatsAppUserId: mocks.updateChatWhatsAppUserId,
    updateUserWhatsAppUserId: mocks.updateUserWhatsAppUserId,
    ...overrides,
  };
}

beforeEach(() => {
  calls.realtime = [];
});

async function handleWindowExpiredStatus(
  overrides: Partial<WhatsAppStatusWebhookHandlerDependencies>,
  suppressRealtime = false,
) {
  const handler = createWhatsAppStatusWebhookHandler(createDeps(overrides));
  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba_1",
        changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "phone_1" },
          statuses: [{
            id: "wamid.window-expired", status: "failed",
            timestamp: "1767225600", recipient_id: "15551234567",
            errors: [{ code: 131047 }],
          }],
        } }],
      }],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
    suppressRealtime,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(response?.status, 200);
}

test("routes window-expired alerts using the scoped stored message without a recipient lookup", async () => {
  let recipientLookups = 0;
  await handleWindowExpiredStatus({
    recordWhatsAppMessageDeliveryStatus: async () => ({
      messageFound: true, messageDeliveryUpdated: false,
      conversationId: "known-conversation",
    }),
    findOpenWhatsAppConversationByChatId: async () => {
      recipientLookups++;
      return { _id: "other-conversation", workspaceId: "other-workspace" };
    },
  });
  assert.equal(recipientLookups, 0);
  assert.deepEqual(calls.realtime.map(([channel, event]) => [channel, event]), [
    ["private-conversation-known-conversation", "message-failed"],
    ["private-workspace_1-alerts", "alert"],
  ]);
});

test("scopes a window-expired recipient fallback to its resolved workspace and source", async () => {
  const conversations = [
    { _id: "other-tenant", workspaceId: "workspace_2", sourceId: "source_2" },
    { _id: "other-source", workspaceId: "workspace_1", sourceId: "source_2" },
    { _id: "matching", workspaceId: "workspace_1", sourceId: "source_1" },
  ];
  const lookups: unknown[] = [];
  await handleWindowExpiredStatus({
    recordWhatsAppMessageDeliveryStatus: async () => ({ messageFound: false }),
    findOpenWhatsAppConversationByChatId: async (query: unknown) => {
      lookups.push(query);
      const scope = typeof query === "object" && query !== null
        ? query as { workspaceId: string; sourceId: string }
        : null;
      return conversations.find(row => !scope || (
        row.workspaceId === scope.workspaceId && row.sourceId === scope.sourceId
      )) ?? null;
    },
  });
  assert.deepEqual(lookups, [{
    chatId: "wa_15551234567", workspaceId: "workspace_1", sourceId: "source_1",
  }]);
  assert.deepEqual(calls.realtime.map(([channel, event]) => [channel, event]), [
    ["private-conversation-matching", "message-failed"],
    ["private-workspace_1-alerts", "alert"],
  ]);
  assert.equal((calls.realtime[0][2] as { errorCode: number }).errorCode, 131047);
});

for (const source of [null, { workspace_id: "workspace_1" }, { id: "source_1" }]) {
  test(`does not fan out a recipient failure without resolved workspace and source: ${JSON.stringify(source)}`, async () => {
    let recipientLookups = 0;
    await handleWindowExpiredStatus({
      resolveWhatsAppSourceByAccountIdentifiers: async () => source,
      recordWhatsAppMessageDeliveryStatus: async () => ({ messageFound: false }),
      findOpenWhatsAppConversationByChatId: async () => {
        recipientLookups++;
        return { _id: "other-conversation", workspaceId: "other-workspace" };
      },
    });
    assert.equal(recipientLookups, 0);
    assert.deepEqual(calls.realtime, []);
  });
}

test("ignores a mismatched conversation returned by the recipient fallback", async () => {
  await handleWindowExpiredStatus({
    recordWhatsAppMessageDeliveryStatus: async () => ({ messageFound: false }),
    findOpenWhatsAppConversationByChatId: async () => ({
      _id: "other-conversation", workspaceId: "other-workspace",
    }),
  });
  assert.deepEqual(calls.realtime, []);
});

function taskCallbackBody(workspaceId = "workspace_1") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone_1" },
              statuses: [
                {
                  id: "wamid.task-acceptance",
                  status: "delivered",
                  timestamp: "1767312000",
                  recipient_id: "77060000001",
                  biz_opaque_callback_data: JSON.stringify({
                    k: "cmp",
                    c: "campaign_1",
                    w: workspaceId,
                    t: "507f1f77bcf86cd799439011",
                  }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test("recovers a task-specific provider acceptance only from verified matching source status", async () => {
  const order: string[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordCampaignTaskProviderAcceptance: async (params) => {
        assert.deepEqual(params, {
          workspaceId: "workspace_1",
          campaignId: "campaign_1",
          taskId: "507f1f77bcf86cd799439011",
          sourceId: "source_1",
          phoneNumberId: "phone_1",
          recipient: "77060000001",
          messageId: "wamid.task-acceptance",
        });
        order.push("receipt");
      },
      persistCampaignMessageStatusWithOutbox: async () => {
        order.push("status");
        return { applied: true };
      },
    }),
  );
  const response = await handler({
    body: taskCallbackBody(),
    providerSignatureVerified: true,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });
  assert.equal(response?.status, 200);
  assert.deepEqual(order, ["receipt", "status"]);
});

for (const mismatch of ["unverified", "workspace", "source_missing"] as const) {
  test(`does not manufacture a task acceptance from ${mismatch} callback`, async () => {
    let receipts = 0;
    const handler = createWhatsAppStatusWebhookHandler(
      createDeps({
        recordCampaignTaskProviderAcceptance: async () => {
          receipts += 1;
        },
        ...(mismatch === "source_missing"
          ? { resolveWhatsAppSourceByAccountIdentifiers: async () => null }
          : {}),
      }),
    );
    await handler({
      body: taskCallbackBody(
        mismatch === "workspace" ? "forged_workspace" : "workspace_1",
      ),
      providerSignatureVerified: mismatch !== "unverified",
      requestLogger: createRequestLogger(),
      supabase: createSupabaseMock(),
    });
    assert.equal(receipts, 0);
  });
}

test("retains status outbox and retries the authenticated event after task witness persistence fails", async () => {
  let queuedStatuses = 0;
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordCampaignTaskProviderAcceptance: async () => {
        throw new Error("receipt store unavailable");
      },
      persistCampaignMessageStatusWithOutbox: async () => {
        queuedStatuses += 1;
        return { applied: false, queuedToOutbox: true };
      },
    }),
  );
  const response = await handler({
    body: taskCallbackBody(),
    providerSignatureVerified: true,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });
  assert.equal(queuedStatuses, 1);
  assert.equal(response?.status, 503);
});

for (const lookupFailure of ["throw", "null"] as const) {
  test(`retries a verified task callback after source lookup ${lookupFailure} and later recovers its witness`, async () => {
    let queuedStatuses = 0;
    let recordedAcceptances = 0;
    let sourceRecovered = false;
    const handler = createWhatsAppStatusWebhookHandler(
      createDeps({
        resolveWhatsAppSourceByAccountIdentifiers: async () => {
          if (sourceRecovered)
            return mocks.resolveWhatsAppSourceByAccountIdentifiers();
          if (lookupFailure === "null") return null;
          throw new Error("source store temporarily unavailable");
        },
        recordCampaignTaskProviderAcceptance: async () => {
          recordedAcceptances += 1;
        },
        persistCampaignMessageStatusWithOutbox: async () => {
          queuedStatuses += 1;
          return { applied: false, queuedToOutbox: true };
        },
      }),
    );
    const response = await handler({
      body: taskCallbackBody(),
      providerSignatureVerified: true,
      requestLogger: createRequestLogger(),
      supabase: createSupabaseMock(),
    });
    assert.equal(queuedStatuses, 1);
    assert.equal(recordedAcceptances, 0);
    assert.equal(response?.status, 503);
    sourceRecovered = true;
    const recoveredResponse = await handler({
      body: taskCallbackBody(),
      providerSignatureVerified: true,
      requestLogger: createRequestLogger(),
      supabase: createSupabaseMock(),
    });
    assert.equal(queuedStatuses, 2);
    assert.equal(recordedAcceptances, 1);
    assert.equal(recoveredResponse?.status, 200);
  });
}

test("emits a conversation delivery update when a WhatsApp status matches a stored message", async () => {
  const supabaseFilters: Array<[string, string, unknown]> = [];
  const handler = createWhatsAppStatusWebhookHandler(createDeps());
  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone_1",
                },
                statuses: [
                  {
                    id: "wamid.status-1",
                    status: "read",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(supabaseFilters),
  });

  assert.equal(response?.status, 200);
  assert.ok(
    supabaseFilters.some(
      ([, column, value]) => column === "channel" && value === "whatsapp",
    ),
  );
  assert.deepEqual(calls.realtime[0]?.slice(0, 2), [
    "private-conversation-507f1f77bcf86cd799439011",
    "message-delivery",
  ]);
  assert.equal(
    (calls.realtime[0]?.[2] as { workspaceId?: string }).workspaceId,
    "workspace_1",
  );
});

test("suppresses realtime while still recording WhatsApp delivery status", async () => {
  let recorded = false;
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordWhatsAppMessageDeliveryStatus: async () => {
        recorded = true;
        return {
          recorded: true,
          status: "read",
          messageFound: true,
          messageDeliveryUpdated: true,
          conversationId: "507f1f77bcf86cd799439011",
          messageObjectId: "507f1f77bcf86cd799439012",
          delivery: {
            status: "read",
            readAt: "2026-01-02T00:00:00.000Z",
          },
        };
      },
    }),
  );

  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone_1",
                },
                statuses: [
                  {
                    id: "wamid.status-1",
                    status: "read",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
    suppressRealtime: true,
  });

  assert.equal(response?.status, 200);
  assert.equal(recorded, true);
  assert.equal(calls.realtime.length, 0);
});

test("accepts played group statuses and emits the persisted delivery state", async () => {
  const recordCalls: unknown[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordWhatsAppMessageDeliveryStatus: async (params) => {
        recordCalls.push(params);
        return {
          recorded: true,
          status: "played",
          eventStatus: "played",
          messageFound: true,
          messageDeliveryUpdated: true,
          conversationId: "507f1f77bcf86cd799439011",
          messageObjectId: "507f1f77bcf86cd799439012",
          delivery: {
            status: "played",
            playedAt: "2026-06-22T10:15:00.000Z",
            readAt: "2026-06-22T10:15:00.000Z",
            recipientId: "120363000000000000@g.us",
            recipientType: "group",
            recipientParticipantId: "15551234567",
            pricingCategory: "marketing_lite",
          },
        };
      },
    }),
  );

  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone_1",
                },
                statuses: [
                  {
                    id: "wamid.voice-1",
                    status: "played",
                    timestamp: "1782123300",
                    recipient_id: "120363000000000000@g.us",
                    recipient_type: "group",
                    recipient_participant_id: "15551234567",
                    recipient_identity_key_hash: "identity_hash_1",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(response?.status, 200);
  assert.equal((recordCalls[0] as { status?: string }).status, "played");
  assert.equal(
    (recordCalls[0] as { recipientType?: string }).recipientType,
    "group",
  );
  assert.equal(
    (calls.realtime[0]?.[2] as { status?: string }).status,
    "played",
  );
});

test("does not emit realtime when the delivery helper only records an unsupported provider status", async () => {
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordWhatsAppMessageDeliveryStatus: async () => ({
        recorded: true,
        status: null,
        eventStatus: "unknown",
        messageFound: true,
        messageDeliveryUpdated: false,
        conversationId: "507f1f77bcf86cd799439011",
        messageObjectId: "507f1f77bcf86cd799439012",
        delivery: {
          status: "read",
        },
      }),
    }),
  );

  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone_1",
                },
                statuses: [
                  {
                    id: "wamid.future-1",
                    status: "displayed",
                    timestamp: "1782123300",
                    recipient_id: "15551234567",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(response?.status, 200);
  assert.equal(calls.realtime.length, 0);
});

test("skips status processing when the resolved source is disconnected", async () => {
  let deliveryCalled = false;
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      getWhatsAppWebhookSourceSkip: () => ({ reason: "partner_removed" }),
      recordWhatsAppMessageDeliveryStatus: async () => {
        deliveryCalled = true;
        return {};
      },
    }),
  );

  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "phone_1",
                },
                statuses: [
                  {
                    id: "wamid.status-removed",
                    status: "read",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    status: "ok",
    message: "source disconnected",
    reason: "partner_removed",
  });
  assert.equal(deliveryCalled, false);
  assert.equal(calls.realtime.length, 0);
});

for (const verified of [false, true]) {
  test(`preserves verified task acceptance before a disconnected-source skip (${verified})`, async () => {
    let receipts = 0;
    let automationWrites = 0;
    const handler = createWhatsAppStatusWebhookHandler(
      createDeps({
        getWhatsAppWebhookSourceSkip: () => ({ reason: "partner_removed" }),
        recordCampaignTaskProviderAcceptance: async () => {
          receipts += 1;
        },
        recordWhatsAppMessageDeliveryStatus: async () => {
          automationWrites += 1;
          return {};
        },
        persistCampaignMessageStatusWithOutbox: async () => {
          automationWrites += 1;
          return { applied: true };
        },
      }),
    );

    const response = await handler({
      body: taskCallbackBody(),
      providerSignatureVerified: verified,
      requestLogger: createRequestLogger(),
      supabase: createSupabaseMock(),
    });

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), {
      status: "ok",
      message: "source disconnected",
      reason: "partner_removed",
    });
    assert.equal(receipts, verified ? 1 : 0);
    assert.equal(automationWrites, 0);
    assert.equal(calls.realtime.length, 0);
  });
}

test("retries verified acceptance persistence failures even after source disconnection", async () => {
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      getWhatsAppWebhookSourceSkip: () => ({ reason: "partner_removed" }),
      recordCampaignTaskProviderAcceptance: async () => {
        throw new Error("receipt store unavailable");
      },
    }),
  );

  const response = await handler({
    body: taskCallbackBody(),
    providerSignatureVerified: true,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(response?.status, 503);
  assert.equal(calls.realtime.length, 0);
});

for (const suppressRealtime of [false, true]) {
  test(`awaits campaign persistence and respects realtime suppression (${suppressRealtime})`, async () => {
    const persisted: unknown[] = [];
    const handler = createWhatsAppStatusWebhookHandler(
      createDeps({
        resolveWhatsAppSourceByAccountIdentifiers: async () => null,
        persistCampaignMessageStatusWithOutbox: async (payload) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          persisted.push(payload);
          return { applied: true, queuedToOutbox: false };
        },
      }),
    );

    const response = await handler({
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba_1",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: {
                    phone_number_id: "phone_1",
                  },
                  statuses: [
                    {
                      id: "wamid.campaign-1",
                      status: "delivered",
                      timestamp: "1767225600",
                      recipient_id: "15551234567",
                      biz_opaque_callback_data:
                        '{"k":"cmp","c":"campaign_1","w":"workspace_1"}',
                    },
                  ],
                },
              },
            ],
          },
        ],
      } as never,
      requestLogger: createRequestLogger(),
      supabase: createSupabaseMock(),
      suppressRealtime,
    });

    assert.equal(response?.status, 200);
    assert.equal(persisted.length, 1);
    assert.deepEqual(
      (persisted[0] as { realtime: unknown }).realtime,
      suppressRealtime
        ? undefined
        : {
            workspaceId: "workspace_1",
            campaignId: "campaign_1",
          },
    );
    assert.equal(JSON.stringify(persisted).includes("15551234567"), false);
  });
}

test("retains campaign persistence and realtime intent when callback-less workspace lookup rejects", async () => {
  const persisted: unknown[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      persistCampaignMessageStatusWithOutbox: async (payload) => {
        persisted.push(payload);
        return { applied: true, queuedToOutbox: false };
      },
    }),
  );
  const supabase = {
    from: (table: string) => {
      let fields = "";
      const query = {
        select: (value: string) => {
          fields = value;
          return query;
        },
        eq: () => query,
        maybeSingle: async () => ({
          data: fields.includes("campaign_id")
            ? { campaign_id: "campaign_1" }
            : { status: "sent", delivered_at: null },
          error: null,
        }),
        single: async () => {
          assert.equal(table, "campaign_history");
          throw new Error("workspace lookup unavailable");
        },
      };
      return query;
    },
  };
  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: "wamid.campaign-1",
                    status: "delivered",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase,
  });
  assert.equal(response?.status, 200);
  assert.equal(persisted.length, 1);
  assert.deepEqual((persisted[0] as { realtime: unknown }).realtime, {
    campaignId: "campaign_1",
  });
});

test("persists recipient-scoped Meta failures without re-scanning the campaign", async () => {
  const persistedUpdates: Record<string, unknown>[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      persistCampaignMessageStatusWithOutbox: async ({ updateData }) => {
        persistedUpdates.push(updateData);
        return { applied: true, queuedToOutbox: false };
      },
    }),
  );

  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: "wamid.campaign-failed",
                    status: "failed",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                    biz_opaque_callback_data:
                      '{"k":"cmp","c":"campaign_1","w":"workspace_1"}',
                    errors: [
                      {
                        code: 131049,
                        message: "This message was not delivered.",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(response?.status, 200);
  assert.equal(persistedUpdates[0]?.failure_scope, "recipient");
  assert.equal(persistedUpdates[0]?.error_code, 131049);
});

test("keeps billable pricing unknown without verified market/date/tier coverage", async () => {
  const persistedUpdates: Record<string, unknown>[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      persistCampaignMessageStatusWithOutbox: async ({ updateData }) => {
        persistedUpdates.push(updateData);
        return { applied: true, queuedToOutbox: false };
      },
    }),
  );

  await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: "wamid.campaign-delivered",
                    status: "delivered",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                    biz_opaque_callback_data:
                      '{"k":"cmp","c":"campaign_1","w":"workspace_1"}',
                    pricing: {
                      billable: true,
                      category: "marketing",
                      pricing_model: "PMP",
                      type: "regular",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });

  assert.equal(
    persistedUpdates[0]?.estimated_cost_usd,
    null,
  );
});

for (const receipt of [
  { name: "actual free service after October pricing change", pricing: { type: "free_customer_service", billable: false, category: "service" }, cost: 0, coverage: "provider_free" },
  { name: "conflicting provider flags", pricing: { type: "free_entry_point", billable: true, category: "service" }, cost: null, coverage: "unknown" },
  { name: "category without billability", pricing: { category: "service" }, cost: null, coverage: "unknown" },
]) {
  test(`preserves ${receipt.name} without synthesizing a tariff`, async () => {
    const updates: Record<string, unknown>[] = [];
    const handler = createWhatsAppStatusWebhookHandler(createDeps({
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      persistCampaignMessageStatusWithOutbox: async ({ updateData }) => { updates.push(updateData); return { applied: true, queuedToOutbox: false }; },
    }));
    await handler({ body: { object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "phone" }, statuses: [{ id: "wamid.receipt", status: "delivered", timestamp: String(Date.parse("2026-10-02T01:00:00Z") / 1000), recipient_id: "15551234567", biz_opaque_callback_data: '{"k":"cmp","c":"campaign_1","w":"workspace_1"}', pricing: receipt.pricing }] } }] }] } as never, requestLogger: createRequestLogger(), supabase: createSupabaseMock() });
    assert.equal(updates[0]?.estimated_cost_usd, receipt.cost);
    assert.equal(updates[0]?.cost_coverage, receipt.coverage);
    assert.equal(updates[0]?.pricing_category, "service");
    assert.equal(updates[0]?.pricing_event_at, "2026-10-02T01:00:00.000Z");
  });
}

test("persists pricing from an out-of-order duplicate without regressing delivery status", async () => {
  const persistedUpdates: Record<string, unknown>[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      persistCampaignMessageStatusWithOutbox: async ({ updateData }) => {
        persistedUpdates.push(updateData);
        return { applied: true, queuedToOutbox: false };
      },
    }),
  );
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({
      data: {
        status: "read",
        delivered_at: "2026-01-02T00:00:00.000Z",
      },
      error: null,
    }),
    single: async () => ({ data: null, error: null }),
  };
  const supabase = { from: () => query };

  await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: "wamid.campaign-delivered-late-pricing",
                    status: "delivered",
                    timestamp: "1767225600",
                    recipient_id: "15551234567",
                    biz_opaque_callback_data:
                      '{"k":"cmp","c":"campaign_1","w":"workspace_1"}',
                    pricing: {
                      billable: true,
                      category: "marketing",
                      pricing_model: "PMP",
                      type: "regular",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as never,
    requestLogger: createRequestLogger(),
    supabase,
  });

  assert.equal(persistedUpdates.length, 1);
  assert.equal(
    persistedUpdates[0]?.estimated_cost_usd,
    null,
  );
  assert.equal(persistedUpdates[0]?.status, undefined);
  assert.equal(persistedUpdates[0]?.delivered_at, undefined);
});

function campaignStatusBody(
  options: { callback?: string | null; recipientUserId?: string } = {},
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone_1" },
              statuses: [
                {
                  id: "wamid.campaign-1",
                  status: "delivered",
                  timestamp: "1767225600",
                  recipient_id: "15551234567",
                  ...(options.recipientUserId
                    ? { recipient_user_id: options.recipientUserId }
                    : {}),
                  ...(options.callback === null
                    ? {}
                    : {
                        biz_opaque_callback_data:
                          options.callback ??
                          '{"k":"cmp","c":"campaign_1","w":"workspace_1"}',
                      }),
                },
              ],
            },
          },
        ],
      },
    ],
  } as never;
}

type RecordParams = Parameters<
  WhatsAppStatusWebhookHandlerDependencies["recordWhatsAppMessageDeliveryStatus"]
>[0];

async function handleCampaignStatus(
  overrides: Partial<WhatsAppStatusWebhookHandlerDependencies>,
  options: Parameters<typeof campaignStatusBody>[0] = {},
  supabase: ReturnType<typeof createSupabaseMock> = createSupabaseMock(),
) {
  const handler = createWhatsAppStatusWebhookHandler(createDeps(overrides));
  const response = await handler({
    body: campaignStatusBody(options),
    requestLogger: createRequestLogger(),
    supabase,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(response?.status, 200);
}

test("records a hinted campaign status once, with its campaign id, when the verified source matches", async () => {
  const recorded: RecordParams[] = [];
  let persisted = 0;
  await handleCampaignStatus({
    recordWhatsAppMessageDeliveryStatus: async (params) => {
      recorded.push(params);
      return mocks.recordWhatsAppMessageDeliveryStatus();
    },
    persistCampaignMessageStatusWithOutbox: async () => {
      persisted += 1;
      return { applied: true, queuedToOutbox: false };
    },
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.workspaceId, "workspace_1");
  assert.equal(recorded[0]?.campaignId, "campaign_1");
  assert.equal(persisted, 1);
});

test("keeps the campaign follow-up record when the status arrives before its message is saved", async () => {
  const recorded: RecordParams[] = [];
  await handleCampaignStatus({
    recordWhatsAppMessageDeliveryStatus: async (params) => {
      recorded.push(params);
      return {
        ...(await mocks.recordWhatsAppMessageDeliveryStatus()),
        messageFound: recorded.length > 1,
        messageDeliveryUpdated: recorded.length > 1,
      };
    },
  });

  assert.deepEqual(
    recorded.map((params) => [params.workspaceId, params.campaignId]),
    [
      ["workspace_1", "campaign_1"],
      ["workspace_1", "campaign_1"],
    ],
  );
});

function campaignLookupSupabase(
  campaignRow: { campaign_id: string; phone: string } | null,
  campaignWorkspaceId = "workspace_1",
) {
  const lookups: string[] = [];
  return {
    lookups,
    client: {
      from: (table: string) => {
        let fields = "";
        const query = {
          select: (value: string) => {
            fields = value;
            lookups.push(`${table}:${value}`);
            return query;
          },
          eq: () => query,
          maybeSingle: async () => ({
            data: fields.includes("campaign_id")
              ? campaignRow
              : { status: "sent", delivered_at: null },
            error: null,
          }),
          single: async () => ({
            data: { workspace_id: campaignWorkspaceId },
            error: null,
          }),
        };
        return query;
      },
    },
  };
}

test("never records a status into the workspace a foreign hint names", async () => {
  const recorded: RecordParams[] = [];
  const realtime: unknown[] = [];
  const supabase = campaignLookupSupabase(null);
  await handleCampaignStatus(
    {
      recordWhatsAppMessageDeliveryStatus: async (params) => {
        recorded.push(params);
        return mocks.recordWhatsAppMessageDeliveryStatus();
      },
      persistCampaignMessageStatusWithOutbox: async (params) => {
        realtime.push(params.realtime);
        return { applied: true, queuedToOutbox: false };
      },
    },
    { callback: '{"k":"cmp","c":"campaign_2","w":"workspace_2"}' },
    supabase.client as never,
  );

  assert.deepEqual(
    recorded.map((params) => [params.workspaceId, params.campaignId]),
    [["workspace_1", undefined]],
  );
  assert.deepEqual(realtime, []);
  // The stored campaign row, not the hint, decides the campaign.
  assert.ok(
    supabase.lookups.includes("campaign_messages:campaign_id, phone"),
  );
});

test("a foreign hint falls back to the stored campaign of the message", async () => {
  const recorded: RecordParams[] = [];
  const realtime: unknown[] = [];
  const supabase = campaignLookupSupabase({
    campaign_id: "campaign_9",
    phone: "15551234567",
  });
  await handleCampaignStatus(
    {
      recordWhatsAppMessageDeliveryStatus: async (params) => {
        recorded.push(params);
        return mocks.recordWhatsAppMessageDeliveryStatus();
      },
      persistCampaignMessageStatusWithOutbox: async (params) => {
        realtime.push(params.realtime);
        return { applied: true, queuedToOutbox: false };
      },
    },
    { callback: '{"k":"cmp","c":"campaign_2","w":"workspace_2"}' },
    supabase.client as never,
  );

  assert.deepEqual(
    recorded.map((params) => [params.workspaceId, params.campaignId]),
    [
      ["workspace_1", undefined],
      ["workspace_1", "campaign_9"],
    ],
  );
  assert.deepEqual(realtime, [{ campaignId: "campaign_9" }]);
});

test("a hint without a resolved source cannot name the workspace", async () => {
  const recorded: RecordParams[] = [];
  const supabase = campaignLookupSupabase(null);
  await handleCampaignStatus(
    {
      resolveWhatsAppSourceByAccountIdentifiers: async () => null,
      recordWhatsAppMessageDeliveryStatus: async (params) => {
        recorded.push(params);
        return mocks.recordWhatsAppMessageDeliveryStatus();
      },
    },
    { callback: '{"k":"cmp","c":"campaign_1","w":"workspace_1"}' },
    supabase.client as never,
  );

  assert.deepEqual(recorded, []);
});

test("records the campaign status again when the first delivery record failed", async () => {
  const recorded: RecordParams[] = [];
  await handleCampaignStatus({
    recordWhatsAppMessageDeliveryStatus: async (params) => {
      recorded.push(params);
      if (recorded.length === 1) throw new Error("Mongo unavailable");
      return mocks.recordWhatsAppMessageDeliveryStatus();
    },
  });

  assert.equal(recorded.length, 2);
  assert.equal(recorded[1]?.campaignId, "campaign_1");
});

test("records a callback-less campaign status with the campaign it looked up", async () => {
  const recorded: RecordParams[] = [];
  const supabase = {
    from: () => {
      let fields = "";
      const query = {
        select: (value: string) => {
          fields = value;
          return query;
        },
        eq: () => query,
        maybeSingle: async () => ({
          data: fields.includes("campaign_id")
            ? { campaign_id: "campaign_9", phone: "15551234567" }
            : { status: "sent", delivered_at: null },
          error: null,
        }),
        single: async () => ({
          data: { workspace_id: "workspace_1" },
          error: null,
        }),
      };
      return query;
    },
  };
  await handleCampaignStatus(
    {
      recordWhatsAppMessageDeliveryStatus: async (params) => {
        recorded.push(params);
        return mocks.recordWhatsAppMessageDeliveryStatus();
      },
    },
    { callback: null },
    supabase as never,
  );

  assert.deepEqual(
    recorded.map((params) => [params.workspaceId, params.campaignId]),
    [
      ["workspace_1", undefined],
      ["workspace_1", "campaign_9"],
    ],
  );
});

test("starts the campaign row update while the delivery record is still running", async () => {
  const order: string[] = [];
  let markPersistStarted!: () => void;
  const persistStarted = new Promise<void>((resolve) => {
    markPersistStarted = resolve;
  });
  await handleCampaignStatus({
    recordWhatsAppMessageDeliveryStatus: async () => {
      const overlapped = await Promise.race([
        persistStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      order.push(overlapped ? "record-overlapped" : "record-alone");
      return mocks.recordWhatsAppMessageDeliveryStatus();
    },
    persistCampaignMessageStatusWithOutbox: async () => {
      order.push("persist");
      markPersistStarted();
      return { applied: true, queuedToOutbox: false };
    },
  });

  assert.deepEqual(order, ["persist", "record-overlapped"]);
});

test("repeats the conditional BSUID writes on a later status so an earlier failure is retried", async () => {
  let lookups = 0;
  let writes = 0;
  await handleCampaignStatus(
    {
      recordWhatsAppMessageDeliveryStatus: async () => ({
        ...(await mocks.recordWhatsAppMessageDeliveryStatus()),
        chatId: "wa_15551234567",
        // An earlier status stored this BSUID, but its writes may have failed.
        ...({ priorRecipientUserId: "KZ.1234567890" } as object),
      }),
      findOriginalMessageChatIdByMessageId: async () => {
        lookups += 1;
        return "wa_15551234567";
      },
      updateUserWhatsAppUserId: async () => {
        writes += 1;
      },
      updateChatWhatsAppUserId: async () => {
        writes += 1;
      },
    },
    { recipientUserId: "KZ.1234567890" },
  );

  assert.equal(lookups, 0);
  assert.equal(writes, 2);
});

test("enriches a new BSUID from the recorded chat without another message lookup", async () => {
  let lookups = 0;
  const writes: Array<[string, { chatId: string; userId: string }]> = [];
  await handleCampaignStatus(
    {
      recordWhatsAppMessageDeliveryStatus: async () => ({
        ...(await mocks.recordWhatsAppMessageDeliveryStatus()),
        chatId: "wa_15551234567",
      }),
      findOriginalMessageChatIdByMessageId: async () => {
        lookups += 1;
        return null;
      },
      updateUserWhatsAppUserId: async (params) => {
        writes.push(["user", params]);
      },
      updateChatWhatsAppUserId: async (params) => {
        writes.push(["chat", params]);
      },
    },
    { recipientUserId: "KZ.1234567890" },
  );

  assert.equal(lookups, 0);
  assert.deepEqual(
    writes.sort(([left], [right]) => left.localeCompare(right)),
    [
      ["chat", { chatId: "wa_15551234567", userId: "KZ.1234567890" }],
      ["user", { chatId: "wa_15551234567", userId: "KZ.1234567890" }],
    ],
  );
});

test("falls back to the message lookup for BSUID enrichment when the record has no chat", async () => {
  let lookups = 0;
  let writes = 0;
  await handleCampaignStatus(
    {
      findOriginalMessageChatIdByMessageId: async () => {
        lookups += 1;
        return "wa_15551234567";
      },
      updateUserWhatsAppUserId: async () => {
        writes += 1;
      },
      updateChatWhatsAppUserId: async () => {
        writes += 1;
      },
    },
    { recipientUserId: "KZ.1234567890" },
  );

  assert.equal(lookups, 1);
  assert.equal(writes, 2);
});

type ReleaseParams = Parameters<
  NonNullable<WhatsAppStatusWebhookHandlerDependencies["releaseCampaignContactSlot"]>
>[0];

async function handleFailedCampaignStatus(
  overrides: Partial<WhatsAppStatusWebhookHandlerDependencies>,
  options: {
    verified?: boolean;
    status?: string;
    callback?: Record<string, string>;
  } = {},
) {
  const handler = createWhatsAppStatusWebhookHandler(createDeps(overrides));
  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba_1",
        changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "phone_1" },
          statuses: [{
            id: "wamid.campaign-failed",
            status: options.status ?? "failed",
            timestamp: "1767225600",
            recipient_id: "77010000001",
            errors: [{ code: 131048, message: "Spam rate limit hit" }],
            biz_opaque_callback_data: JSON.stringify(
              options.callback ?? { k: "cmp", c: "campaign_1", w: "workspace_1" },
            ),
          }],
        } }],
      }],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
    providerSignatureVerified: options.verified ?? true,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(response?.status, 200);
}

test("releases the contact slot of a campaign send Meta reports as failed", async () => {
  const released: ReleaseParams[] = [];
  await handleFailedCampaignStatus({
    releaseCampaignContactSlot: async (params) => {
      released.push(params);
    },
  });

  assert.deepEqual(released, [{
    workspaceId: "workspace_1",
    campaignId: "campaign_1",
    taskId: null,
    phone: "77010000001",
  }]);
});

test("passes the task id so a campaign task send releases its own slot", async () => {
  const released: ReleaseParams[] = [];
  await handleFailedCampaignStatus(
    {
      releaseCampaignContactSlot: async (params) => {
        released.push(params);
      },
    },
    { callback: { k: "cmp", c: "campaign_1", w: "workspace_1", t: "507f1f77bcf86cd799439011" } },
  );

  assert.equal(released.length, 1);
  assert.equal(released[0]?.taskId, "507f1f77bcf86cd799439011");
});

test("releases no slot for an unsigned, foreign, unrecorded or non-failed status", async () => {
  const released: ReleaseParams[] = [];
  const releaseCampaignContactSlot = async (params: ReleaseParams) => {
    released.push(params);
  };
  await handleFailedCampaignStatus({ releaseCampaignContactSlot }, { verified: false });
  await handleFailedCampaignStatus(
    { releaseCampaignContactSlot },
    { callback: { k: "cmp", c: "campaign_1", w: "workspace_2" } },
  );
  await handleFailedCampaignStatus({ releaseCampaignContactSlot }, { status: "delivered" });
  await handleFailedCampaignStatus({
    releaseCampaignContactSlot,
    persistCampaignMessageStatusWithOutbox: async () => ({
      applied: false,
      queuedToOutbox: false,
      errorMessage: "supabase unavailable",
    }),
  });

  assert.deepEqual(released, []);
});

test("a failed slot release does not fail the status webhook", async () => {
  let persisted = 0;
  await handleFailedCampaignStatus({
    persistCampaignMessageStatusWithOutbox: async () => {
      persisted += 1;
      return { applied: true, queuedToOutbox: false };
    },
    releaseCampaignContactSlot: async () => {
      throw new Error("mongo unavailable");
    },
  });

  assert.equal(persisted, 1);
});

test("does not write a group participant's BSUID onto the group chat", async () => {
  const chatWrites: unknown[] = [];
  const handler = createWhatsAppStatusWebhookHandler(
    createDeps({
      recordWhatsAppMessageDeliveryStatus: async () => ({
        ...(await mocks.recordWhatsAppMessageDeliveryStatus()),
        chatId: "group-chat-1",
      }),
      updateChatWhatsAppUserId: async (params) => {
        chatWrites.push(["chat", params]);
      },
      updateUserWhatsAppUserId: async (params) => {
        chatWrites.push(["user", params]);
      },
    }),
  );
  const response = await handler({
    body: {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba_1",
        changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "phone_1" },
          statuses: [{
            id: "wamid.group-1",
            status: "read",
            timestamp: "1767225600",
            recipient_id: "120363000000000001",
            recipient_type: "group",
            recipient_participant_id: "15551234567",
            recipient_user_id: "US.participant-bsuid",
          }],
        } }],
      }],
    } as never,
    requestLogger: createRequestLogger(),
    supabase: createSupabaseMock(),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(response?.status, 200);
  assert.deepEqual(chatWrites, []);
});
