import assert from "node:assert/strict";
import { it } from "node:test";
import { compileWhatsAppServiceMessage } from "./whatsapp-service-message-compiler.ts";

it("rejects legacy fallback while managed provider state is not PUBLISHED", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "local-flow",
          screens: [],
          ctaText: "Open flow",
          metaFlowId: "meta-flow-id",
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "digest-2",
            providerStatus: "DRAFT",
          },
        },
      },
    },
    recipientKind: "phone",
    sourceId: "source-1",
    wabaId: "waba-1",
  });

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: "flow_invalid", path: "message.flowConfig" }],
  });
});

it("rejects a managed Flow compiled for another outbound source", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "local-flow",
          screens: [],
          ctaText: "Open flow",
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-a",
            wabaId: "waba-a",
            contentRevision: 2,
            contentDigest: "digest-2",
            flowId: "managed-flow-id",
            providerStatus: "PUBLISHED",
          },
        },
      },
    },
    recipientKind: "phone",
    sourceId: "source-b",
    wabaId: "waba-a",
  });

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: "flow_source_mismatch", path: "message.flowConfig" }],
  });
});

it("rejects a provider-referenced Flow compiled for another outbound source", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "provider-reference",
          screens: [],
          ctaText: "Open flow",
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: "source-a",
            wabaId: "waba-a",
            providerStatus: "PUBLISHED",
          },
        },
      },
    },
    recipientKind: "phone",
    sourceId: "source-b",
    wabaId: "waba-a",
  });

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: "flow_source_mismatch", path: "message.flowConfig" }],
  });
});

it("rejects legacy fallback when a provider reference is not PUBLISHED", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "provider-reference",
          screens: [],
          ctaText: "Open flow",
          metaFlowId: "stale-flow-id",
          providerReference: {
            flowId: "provider-flow-id",
            sourceId: "source-a",
            wabaId: "waba-a",
            providerStatus: "BLOCKED",
          },
        },
      },
    },
    recipientKind: "phone",
    sourceId: "source-a",
    wabaId: "waba-a",
  });

  assert.deepEqual(result, {
    ok: false,
    diagnostics: [{ code: "flow_invalid", path: "message.flowConfig" }],
  });
});

it("compiles a draft Flow when send mode is draft", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "local-flow",
          screens: [{ id: "WELCOME", title: "Welcome", fields: [] }],
          ctaText: "Open flow",
          flowMode: "draft",
          flowActionPayload: {
            screen: "WELCOME",
            data: { product_name: "name" },
          },
          managedProvisioning: {
            operationId: "operation-1",
            sourceId: "source-1",
            wabaId: "waba-1",
            contentRevision: 2,
            contentDigest: "digest-2",
            flowId: "draft-flow-id",
            providerStatus: "DRAFT",
          },
        },
      },
    },
    recipientKind: "phone",
    sourceId: "source-1",
    wabaId: "waba-1",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.command.kind, "flow");
  if (result.command.kind !== "flow") return;
  assert.equal(result.command.flowConfig.flowMode, "draft");
  assert.deepEqual(result.command.flowConfig.flowActionPayload, {
    screen: "WELCOME",
    data: { product_name: "name" },
  });
});

it("compiles a Flow identified by name", () => {
  const result = compileWhatsAppServiceMessage({
    config: {
      version: 1,
      message: {
        kind: "flow",
        body: { mode: "fixed", text: "Complete the form" },
        flowConfig: {
          templateId: "named-flow",
          screens: [],
          ctaText: "Book",
          metaFlowName: "appointment_booking_v1",
        },
      },
    },
    recipientKind: "phone",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.command.kind, "flow");
  if (result.command.kind !== "flow") return;
  assert.equal(result.command.flowConfig.metaFlowName, "appointment_booking_v1");
});
