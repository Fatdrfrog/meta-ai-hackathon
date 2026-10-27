import { buildBulkCampaignDispatchWorkflowId } from "@icecore/temporal";

import {
  AdmittedCampaignLedgerRecoveryAmbiguousError,
  recoverAdmittedCampaignDispatch,
} from "./admitted-campaign-ledger-recovery";
import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";

const campaignId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const recipientHash = "a".repeat(64);
const immutableSnapshot = {
  workspaceId,
  campaignId,
  scenarioId: "source-scenario",
  scenarioNodeId: "source-node",
  executionSource: "ad_hoc",
  sentByUserId: "user-1",
  channel: "whatsapp" as const,
  sourceId: "source-1",
  recipient: { phone: "77010000001" },
  phoneNumberId: "phone-number-1",
  templateName: "launch",
  components: [
    {
      type: "button",
      sub_type: "flow",
      parameters: [
        {
          type: "action",
          action: { flow_token: "flow-routing-token" },
        },
      ],
    },
  ],
};

function createSupabaseFixture(overrides?: {
  history?: Record<string, unknown>;
  messages?: Array<Record<string, unknown>>;
}) {
  const history = {
    id: campaignId,
    workspace_id: workspaceId,
    scenario_id: null,
    scenario_node_id: null,
    execution_source: "ad_hoc",
    sent_by: "user-1",
    channel: "whatsapp",
    dispatch_status: "queued",
    workflow_id: buildBulkCampaignDispatchWorkflowId({
      workspaceId,
      executionId: campaignId,
    }),
    total_recipients: 1,
    requested_at: "2026-07-27T10:00:00.000Z",
    scheduled_at: null,
    dispatch_expires_at: "2026-07-27T10:15:00.000Z",
    audience_count: 1,
    audience_fingerprint: "fingerprint",
    audience_hash_version: "v1",
    audience_source_type: "failed_retry",
    audience_content_hash: createPreparedBulkCampaignContentHash([
      {
        recipientHash,
        dispatchSnapshot: immutableSnapshot,
      },
    ]),
    ...overrides?.history,
  };
  const messages = overrides?.messages || [
    {
      campaign_id: campaignId,
      scenario_id: null,
      scenario_node_id: null,
      execution_source: "ad_hoc",
      channel: "whatsapp",
      snapshot_ordinal: 0,
      recipient_hash: recipientHash,
      dispatch_snapshot: {
        ...immutableSnapshot,
        components: [
          {
            type: "button",
            sub_type: "flow",
            parameters: [
              {
                type: "action",
                action: {
                  flow_token: "flow-routing-token",
                  access_token: "must-not-survive-recovery",
                },
              },
            ],
          },
        ],
      },
    },
  ];
  const from = jest.fn((table: string) => {
    if (table === "campaign_history") {
      const query: {
        eq: jest.Mock;
        maybeSingle: jest.Mock;
      } = {
        eq: jest.fn(() => query),
        maybeSingle: jest.fn(async () => ({ data: history, error: null })),
      };
      return { select: jest.fn(() => query) };
    }
    if (table === "campaign_messages") {
      let afterOrdinal = -1;
      const query: {
        eq: jest.Mock;
        gt: jest.Mock;
        order: jest.Mock;
        limit: jest.Mock;
      } = {
        eq: jest.fn(() => query),
        gt: jest.fn((_column: string, value: number) => {
          afterOrdinal = value;
          return query;
        }),
        order: jest.fn(() => query),
        limit: jest.fn(async (limit: number) => ({
          data: messages
            .filter(row => Number(row.snapshot_ordinal) > afterOrdinal)
            .slice(0, limit),
          error: null,
        })),
      };
      return { select: jest.fn(() => query) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from };
}

describe("admitted campaign ledger recovery", () => {
  it("recovers direct retry snapshots from SQL while preserving Flow routing and stripping credentials", async () => {
    const recovered = await recoverAdmittedCampaignDispatch({
      supabase: createSupabaseFixture(),
      workspaceId,
      campaignId,
      expectedRecipientCount: 1,
      maxRecipients: 1,
      expectedChannel: "whatsapp",
      expectedScenarioId: null,
      expectedScenarioNodeId: null,
      expectedExecutionSource: "ad_hoc",
      expectedAudienceSourceType: "failed_retry",
    });

    expect(recovered).toMatchObject({
      status: "admitted",
      campaign: {
        campaignId,
        scenarioId: null,
        scenarioNodeId: null,
      },
      admittedItems: [
        {
          scenarioId: "source-scenario",
          components: [
            {
              parameters: [
                {
                  action: {
                    flow_token: "flow-routing-token",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(recovered)).not.toContain(
      "must-not-survive-recovery"
    );
  });

  it("recovers a migration-transition snapshot whose SQL ordinal is intentionally absent from the legacy content hash", async () => {
    const legacyDispatchSnapshot = {
      ...immutableSnapshot,
      generatedRecipientMessageId: "legacy-message-0",
    };
    const recovered = await recoverAdmittedCampaignDispatch({
      supabase: createSupabaseFixture({
        history: {
          audience_content_hash: createPreparedBulkCampaignContentHash([
            {
              recipientHash,
              dispatchSnapshot: legacyDispatchSnapshot,
            },
          ]),
        },
        messages: [
          {
            campaign_id: campaignId,
            scenario_id: null,
            scenario_node_id: null,
            execution_source: "ad_hoc",
            channel: "whatsapp",
            snapshot_ordinal: 0,
            recipient_hash: recipientHash,
            dispatch_snapshot: {
              ...legacyDispatchSnapshot,
              _audience_upload: { content_hash: "legacy-upload-hash" },
            },
          },
        ],
      }),
      workspaceId,
      campaignId,
      expectedRecipientCount: 1,
      maxRecipients: 1,
      expectedChannel: "whatsapp",
      expectedScenarioId: null,
      expectedScenarioNodeId: null,
      expectedExecutionSource: "ad_hoc",
      expectedAudienceSourceType: "failed_retry",
    });

    expect(recovered).toMatchObject({
      status: "admitted",
      admittedItems: [
        expect.objectContaining({
          generatedRecipientMessageId: "legacy-message-0",
        }),
      ],
    });
    expect(
      (recovered as Extract<typeof recovered, { status: "admitted" }>)
        .admittedItems[0]
    ).not.toHaveProperty("snapshotOrdinal");
  });

  it("recovers every retained item when one recipient hash owns multiple ordinals", async () => {
    const firstSnapshot = {
      ...immutableSnapshot,
      snapshotOrdinal: 0,
      generatedRecipientMessageId: "message-0",
    };
    const secondSnapshot = {
      ...immutableSnapshot,
      snapshotOrdinal: 1,
      generatedRecipientMessageId: "message-1",
    };
    const messages = [firstSnapshot, secondSnapshot].map(
      (dispatchSnapshot, snapshotOrdinal) => ({
        campaign_id: campaignId,
        scenario_id: null,
        scenario_node_id: null,
        execution_source: "ad_hoc",
        channel: "whatsapp",
        snapshot_ordinal: snapshotOrdinal,
        recipient_hash: recipientHash,
        dispatch_snapshot: dispatchSnapshot,
      })
    );
    const contentSnapshots = [firstSnapshot, secondSnapshot].map(
      (dispatchSnapshot, snapshotOrdinal) => ({
        recipientHash,
        snapshotOrdinal,
        dispatchSnapshot,
      })
    );

    const recovered = await recoverAdmittedCampaignDispatch({
      supabase: createSupabaseFixture({
        history: {
          total_recipients: 2,
          audience_count: 1,
          audience_content_hash:
            createPreparedBulkCampaignContentHash(contentSnapshots),
        },
        messages,
      }),
      workspaceId,
      campaignId,
      expectedRecipientCount: 2,
      maxRecipients: 2,
      expectedChannel: "whatsapp",
      expectedScenarioId: null,
      expectedScenarioNodeId: null,
      expectedExecutionSource: "ad_hoc",
      expectedAudienceSourceType: "failed_retry",
    });

    expect(recovered).toMatchObject({
      status: "admitted",
      campaign: {
        totalRecipients: 2,
        audience: { count: 1 },
      },
      admittedItems: [
        expect.objectContaining({
          snapshotOrdinal: 0,
          generatedRecipientMessageId: "message-0",
        }),
        expect.objectContaining({
          snapshotOrdinal: 1,
          generatedRecipientMessageId: "message-1",
        }),
      ],
    });
  });

  it("fails closed when an embedded ordinal disagrees with its SQL row", async () => {
    const mismatchedSnapshot = {
      ...immutableSnapshot,
      snapshotOrdinal: 1,
    };
    const contentSnapshots = [
      {
        recipientHash,
        snapshotOrdinal: 0,
        dispatchSnapshot: mismatchedSnapshot,
      },
    ];

    await expect(
      recoverAdmittedCampaignDispatch({
        supabase: createSupabaseFixture({
          history: {
            audience_content_hash:
              createPreparedBulkCampaignContentHash(contentSnapshots),
          },
          messages: [
            {
              campaign_id: campaignId,
              scenario_id: null,
              scenario_node_id: null,
              execution_source: "ad_hoc",
              channel: "whatsapp",
              snapshot_ordinal: 0,
              recipient_hash: recipientHash,
              dispatch_snapshot: mismatchedSnapshot,
            },
          ],
        }),
        workspaceId,
        campaignId,
        expectedRecipientCount: 1,
        maxRecipients: 1,
        expectedChannel: "whatsapp",
        expectedScenarioId: null,
        expectedScenarioNodeId: null,
        expectedExecutionSource: "ad_hoc",
        expectedAudienceSourceType: "failed_retry",
      })
    ).rejects.toBeInstanceOf(AdmittedCampaignLedgerRecoveryAmbiguousError);
  });
});
