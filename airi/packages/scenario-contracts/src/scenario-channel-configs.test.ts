import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveWhatsAppFlowProviderId,
  resolveWhatsAppFlowProviderSource,
  resolveWhatsAppFlowActionType,
  resolveSendableWhatsAppFlowIdentity,
  resolveSendableWhatsAppFlowProviderId,
  resolveWhatsAppFlowNavigateActionPayload,
  resolveWhatsAppFlowSendMode,
  resolveWhatsAppFlowSourceBinding,
} from "./scenario-channel-configs.ts";

describe("resolveWhatsAppFlowProviderId", () => {
  it("prefers the managed provider id over stale legacy projections", () => {
    assert.equal(
      resolveWhatsAppFlowProviderId({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "digest-2",
            flowId: " managed-flow-id ",
            providerStatus: "PUBLISHED",
          },
          metaFlowId: "stale-meta-flow-id",
        },
        legacyFlowId: "stale-action-flow-id",
      }),
      "managed-flow-id",
    );
  });

  it("uses a server-authorized provider reference before legacy projections", () => {
    assert.equal(
      resolveWhatsAppFlowProviderId({
        flowConfig: {
          providerReference: {
            flowId: " provider-flow-id ",
            sourceId: "source-1",
            wabaId: "waba-1",
            providerStatus: "PUBLISHED",
          },
          metaFlowId: "stale-meta-flow-id",
        },
        legacyFlowId: "stale-action-flow-id",
      }),
      "provider-flow-id",
    );
  });

  it("falls back through the legacy metadata and action fields", () => {
    assert.equal(
      resolveWhatsAppFlowProviderId({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "digest-2",
            providerStatus: "DRAFT",
          },
          metaFlowId: " meta-flow-id ",
        },
        legacyFlowId: "action-flow-id",
      }),
      "meta-flow-id",
    );
    assert.equal(
      resolveWhatsAppFlowProviderId({ legacyFlowId: " action-flow-id " }),
      "action-flow-id",
    );
    assert.equal(resolveWhatsAppFlowProviderId({}), null);
  });
});

describe("resolveSendableWhatsAppFlowProviderId", () => {
  it("never falls back to legacy identity for a non-published managed Flow", () => {
    assert.equal(
      resolveSendableWhatsAppFlowProviderId({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "digest-2",
            flowId: "managed-flow-id",
            providerStatus: "BLOCKED",
          },
          metaFlowId: "stale-published-flow-id",
        },
        legacyFlowId: "stale-action-flow-id",
      }),
      null,
    );
  });

  it("allows a draft Flow only when send mode is draft", () => {
    assert.equal(
      resolveSendableWhatsAppFlowProviderId({
        flowConfig: {
          flowMode: "draft",
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 1,
            contentDigest: "digest-1",
            flowId: "draft-flow-id",
            providerStatus: "DRAFT",
          },
        },
      }),
      "draft-flow-id",
    );
    assert.equal(
      resolveSendableWhatsAppFlowProviderId({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 1,
            contentDigest: "digest-1",
            flowId: "draft-flow-id",
            providerStatus: "DRAFT",
          },
        },
      }),
      null,
    );
  });

  it("requires a server-authorized provider reference to be published", () => {
    const reference = {
      flowId: "provider-flow-id",
      sourceId: "source-1",
      wabaId: "waba-1",
      providerStatus: "PUBLISHED",
    } as const;

    assert.equal(
      resolveSendableWhatsAppFlowProviderId({
        flowConfig: {
          providerReference: reference,
          metaFlowId: "stale-meta-flow-id",
        },
      }),
      "provider-flow-id",
    );
    assert.equal(
      resolveSendableWhatsAppFlowProviderId({
        flowConfig: {
          providerReference: {
            ...reference,
            providerStatus: "DRAFT",
          },
          metaFlowId: "stale-meta-flow-id",
        },
        legacyFlowId: "stale-action-flow-id",
      }),
      null,
    );
  });
});

describe("resolveSendableWhatsAppFlowIdentity", () => {
  it("prefers flow_id and falls back to flow_name", () => {
    assert.deepEqual(
      resolveSendableWhatsAppFlowIdentity({
        flowConfig: {
          providerReference: {
            flowId: " provider-flow-id ",
            sourceId: "source-1",
            wabaId: "waba-1",
            flowName: "booking",
            providerStatus: "PUBLISHED",
          },
        },
      }),
      { kind: "flow_id", flow_id: "provider-flow-id" },
    );
    assert.deepEqual(
      resolveSendableWhatsAppFlowIdentity({
        flowConfig: {
          metaFlowName: " appointment_booking_v1 ",
        },
      }),
      { kind: "flow_name", flow_name: "appointment_booking_v1" },
    );
  });
});

describe("resolveWhatsAppFlowSendMode", () => {
  it("uses explicit mode, else infers draft from DRAFT status", () => {
    assert.equal(
      resolveWhatsAppFlowSendMode({
        flowMode: "published",
        metaFlowStatus: "DRAFT",
      }),
      "published",
    );
    assert.equal(
      resolveWhatsAppFlowSendMode({
        metaFlowStatus: "DRAFT",
      }),
      "draft",
    );
    assert.equal(resolveWhatsAppFlowSendMode({}), "published");
  });
});

describe("resolveWhatsAppFlowNavigateActionPayload", () => {
  it("merges configured payload with the first screen for navigate", () => {
    assert.deepEqual(
      resolveWhatsAppFlowNavigateActionPayload({
        screens: [{ id: "WELCOME", title: "Welcome", fields: [] }],
        flowActionPayload: {
          data: { product_name: "name" },
        },
      }),
      {
        screen: "WELCOME",
        data: { product_name: "name" },
      },
    );
    assert.equal(
      resolveWhatsAppFlowNavigateActionPayload({
        flowNavigationMode: "data_endpoint",
        flowActionPayload: { screen: "WELCOME" },
      }),
      undefined,
    );
  });
});

describe("resolveWhatsAppFlowSourceBinding", () => {
  it("binds a provider reference to its server-authorized source and WABA", () => {
    const flowConfig = {
      providerReference: {
        flowId: "provider-flow-id",
        sourceId: "source-a",
        wabaId: "waba-a",
        providerStatus: "PUBLISHED",
      },
    };

    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        flowConfig,
        outboundSourceId: "source-b",
        outboundWabaId: "waba-a",
      }),
      "source_mismatch",
    );
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        flowConfig,
        outboundSourceId: "source-a",
        outboundWabaId: "waba-b",
      }),
      "waba_mismatch",
    );
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        flowConfig,
        outboundSourceId: "source-a",
        outboundWabaId: "waba-a",
      }),
      "matched",
    );
  });

  it("prefers managed provisioning over a stale provider reference", () => {
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "managed-source",
            wabaId: "managed-waba",
            contentRevision: 1,
            contentDigest: "digest-1",
            flowId: "managed-flow-id",
            providerStatus: "PUBLISHED",
          },
          providerReference: {
            flowId: "stale-provider-flow-id",
            sourceId: "stale-source",
            wabaId: "stale-waba",
            providerStatus: "PUBLISHED",
          },
        },
        outboundSourceId: "managed-source",
        outboundWabaId: "managed-waba",
      }),
      "matched",
    );
  });

  it("rejects a managed Flow when the outbound source is missing or different", () => {
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        managedSourceId: "source-a",
        managedWabaId: "waba-a",
        outboundSourceId: "source-b",
        outboundWabaId: "waba-a",
      }),
      "source_mismatch",
    );
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        managedSourceId: "source-a",
        managedWabaId: "waba-a",
      }),
      "outbound_source_missing",
    );
  });

  it("distinguishes a WABA mismatch from a source mismatch", () => {
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        managedSourceId: "source-a",
        managedWabaId: "waba-a",
        outboundSourceId: "source-a",
        outboundWabaId: "waba-b",
      }),
      "waba_mismatch",
    );
  });

  it("accepts an exact managed source match and leaves legacy Flows unmanaged", () => {
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        managedSourceId: " source-a ",
        managedWabaId: " waba-a ",
        outboundSourceId: "source-a",
        outboundWabaId: "waba-a",
      }),
      "matched",
    );
    assert.equal(
      resolveWhatsAppFlowSourceBinding({
        outboundSourceId: "source-a",
      }),
      "unmanaged",
    );
  });
});

describe("resolveWhatsAppFlowProviderSource", () => {
  it("uses managed projection, provider reference, then compatibility fields", () => {
    assert.deepEqual(
      resolveWhatsAppFlowProviderSource({
        flowConfig: {
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "managed-source",
            wabaId: "managed-waba",
            contentRevision: 1,
            contentDigest: "digest-1",
            providerStatus: "PUBLISHED",
          },
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: "reference-source",
            wabaId: "reference-waba",
            providerStatus: "PUBLISHED",
          },
        },
        managedSourceId: "compatibility-source",
        managedWabaId: "compatibility-waba",
      }),
      { sourceId: "managed-source", wabaId: "managed-waba" },
    );
    assert.deepEqual(
      resolveWhatsAppFlowProviderSource({
        flowConfig: {
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: " reference-source ",
            wabaId: " reference-waba ",
            providerStatus: "PUBLISHED",
          },
        },
      }),
      { sourceId: "reference-source", wabaId: "reference-waba" },
    );
    assert.deepEqual(
      resolveWhatsAppFlowProviderSource({
        managedSourceId: " compatibility-source ",
        managedWabaId: " compatibility-waba ",
      }),
      { sourceId: "compatibility-source", wabaId: "compatibility-waba" },
    );
  });
});

describe("resolveWhatsAppFlowActionType", () => {
  for (const { label, screens } of [
    {
      label: "single-screen",
      screens: [{ id: "ONLY", title: "Only", fields: [] }],
    },
    {
      label: "multi-screen",
      screens: [
        { id: "FIRST", title: "First", fields: [] },
        { id: "SECOND", title: "Second", fields: [] },
      ],
    },
  ]) {
    it(`uses data_exchange for ${label} endpoint provider references`, () => {
      assert.equal(
        resolveWhatsAppFlowActionType({
          templateId: "provider-reference",
          ctaText: "Open",
          flowNavigationMode: "data_endpoint",
          screens,
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: "source-1",
            wabaId: "waba-1",
            providerStatus: "PUBLISHED",
            dataApiVersion: "3.0",
          },
        }),
        "data_exchange",
      );
    });
  }

  it("keeps linear local and provider Flows on navigate", () => {
    assert.equal(
      resolveWhatsAppFlowActionType({
        templateId: "local",
        ctaText: "Open",
        screens: [],
      }),
      "navigate",
    );
    assert.equal(resolveWhatsAppFlowActionType(null), "navigate");
  });
});
